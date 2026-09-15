"""Login hardening (contract 13 / F034 / F013 / F033), /openapi.json (F062),
startup logging (contracts 12 + 13) and the numeric env-var helper (F056)."""
import logging
import os
import re
import subprocess
import sys
import tempfile
import shutil

import pytest

from cms_helpers import create_user, csrf_token, login, post, query
from cms_support import ADMIN_PASSWORD, ADMIN_USERNAME, CMS_ROOT


def test_openapi_schema_is_not_served(client, admin):
    assert client.get("/openapi.json").status_code == 404
    assert admin.get("/openapi.json").status_code == 404
    assert client.get("/docs").status_code == 404
    assert client.get("/redoc").status_code == 404


# ---------------------------------------------------------------------------
# bcrypt 72-byte limit (F013)
# ---------------------------------------------------------------------------

LONG_PASSWORD = "p" * 73
LONG_UTF8 = "é" * 40  # 40 chars but 80 bytes


def test_create_user_with_long_password_is_400(admin, tok):
    for pw in (LONG_PASSWORD, LONG_UTF8):
        r = post(admin, "/users", {"username": f"long-{tok}", "password": pw, "role": "viewer"})
        assert r.status_code == 400, f"{r.status_code} {r.text[:300]}"
        assert "72" in r.json()["detail"]
    assert query("SELECT id FROM users WHERE username = ?", (f"long-{tok}",)) == []


def test_set_long_password_is_400(admin, tok):
    u = create_user(admin, f"long2-{tok}", "pw123456", "viewer")
    r = post(admin, f"/users/{u['id']}/password", {"password": LONG_PASSWORD})
    assert r.status_code == 400
    assert "72" in r.json()["detail"]


def test_login_with_long_password_never_500s(client):
    r = login(client, ADMIN_USERNAME, LONG_PASSWORD)
    assert r.status_code in (200, 400, 429), r.status_code
    assert r.status_code != 303


def test_hash_password_rejects_over_72_bytes(cms):
    with pytest.raises((ValueError, Exception)) as ei:
        cms.auth.hash_password(LONG_PASSWORD)
    assert "72" in str(ei.value)
    # 72 bytes exactly is fine
    h = cms.auth.hash_password("x" * 72)
    assert cms.auth.verify_password("x" * 72, h)


# ---------------------------------------------------------------------------
# Failed logins: logged, audited, throttled (F034)
# ---------------------------------------------------------------------------

def test_failed_login_is_logged_and_audited(client, caplog, tok):
    username = f"ghost-{tok}"
    with caplog.at_level(logging.WARNING):
        r = login(client, username, "wrong-password")
    assert r.status_code == 200  # login page re-rendered with an error
    assert "Invalid username or password" in r.text
    msgs = [rec.getMessage() for rec in caplog.records if rec.levelno >= logging.WARNING]
    assert any(re.search(rf"login failed for user={re.escape(username)} ip=\S+", m) for m in msgs), msgs
    rows = query("SELECT * FROM audit_log WHERE action = 'login_failed' ORDER BY id DESC")
    assert rows, "no login_failed audit row"
    assert any(username in (row["details"] or "") for row in rows)
    assert not any("wrong-password" in (row["details"] or "") for row in rows), "password must not be audited"


def test_failed_login_for_existing_user_is_audited_with_username(admin, make_client, caplog, tok):
    username = f"real-{tok}"
    create_user(admin, username, "correct-pw", "viewer")
    c = make_client()
    with caplog.at_level(logging.WARNING):
        r = login(c, username, "incorrect")
    assert r.status_code == 200
    assert any(f"login failed for user={username}" in rec.getMessage() for rec in caplog.records)
    row = query("SELECT details FROM audit_log WHERE action = 'login_failed' ORDER BY id DESC LIMIT 1")[0]
    assert username in row["details"]


def test_login_throttle_locks_after_five_failures(admin, make_client, tok):
    username = f"throttle-{tok}"
    create_user(admin, username, "correct-pw", "viewer")
    c = make_client()
    codes = []
    for _ in range(6):
        codes.append(login(c, username, "incorrect").status_code)
    assert 429 not in codes[:4], codes
    assert codes[-1] == 429, f"6th failed attempt should be throttled: {codes}"
    assert 500 not in codes
    # the lock applies to the correct password too, and to a fresh session from the same IP
    assert login(c, username, "correct-pw").status_code == 429
    fresh = make_client()
    assert login(fresh, username, "correct-pw").status_code == 429
    # another username from the same IP is unaffected
    assert login(fresh, ADMIN_USERNAME, ADMIN_PASSWORD).status_code == 303


def test_successful_login_is_audited(client):
    login(client, ADMIN_USERNAME, ADMIN_PASSWORD)
    rows = query("SELECT username FROM audit_log WHERE action = 'login' ORDER BY id DESC LIMIT 1")
    assert rows and rows[0]["username"] == ADMIN_USERNAME


# ---------------------------------------------------------------------------
# Startup logging (contracts 12 + 13, F033 / F054)
# ---------------------------------------------------------------------------

def test_startup_does_not_print_env_password_and_warns_about_secret_key(cms):
    messages = [r.getMessage() for r in cms.startup_records]
    joined = "\n".join(messages)
    assert ADMIN_PASSWORD not in joined, "the PIPLAYER_ADMIN_PASSWORD value was written to the log"
    assert "generated password" not in joined.lower(), "env-supplied password logged as 'generated'"
    assert re.search(r"admin user .*created from PIPLAYER_ADMIN_PASSWORD", joined), messages
    warns = [r for r in cms.startup_records if r.levelno >= logging.WARNING]
    assert any("PIPLAYER_SECRET_KEY" in r.getMessage() for r in warns), \
        "no WARNING about PIPLAYER_SECRET_KEY being unset"


def _run_import(env_overrides):
    """Import app.main in a subprocess with a throwaway data dir; return (rc, output)."""
    data_dir = tempfile.mkdtemp(prefix="piplayer-envtest-")
    env = dict(os.environ)
    env.pop("PIPLAYER_SECRET_KEY", None)
    env["PIPLAYER_DATA_DIR"] = data_dir
    env["PIPLAYER_ADMIN_PASSWORD"] = "test1234"
    env.update(env_overrides)
    try:
        p = subprocess.run(
            [sys.executable, "-c", "import app.main"],
            cwd=str(CMS_ROOT), env=env, capture_output=True, text=True, timeout=120,
        )
    finally:
        shutil.rmtree(data_dir, ignore_errors=True)
    return p.returncode, (p.stdout or "") + (p.stderr or "")


@pytest.mark.parametrize("var", ["PIPLAYER_SCREENSHOT_INTERVAL", "PIPLAYER_MAX_UPLOAD_BYTES",
                                 "PIPLAYER_MAX_SCREENSHOT_BYTES", "PIPLAYER_DEFAULT_IMAGE_DURATION"])
def test_bad_numeric_env_var_exits_cleanly_naming_the_variable(var):
    rc, out = _run_import({var: "abc"})
    assert rc == 1, f"expected exit 1, got {rc}:\n{out[-800:]}"
    assert var in out, out[-800:]
    assert "Traceback" not in out, out[-800:]


def test_long_admin_password_env_is_a_clear_startup_error():
    rc, out = _run_import({"PIPLAYER_ADMIN_PASSWORD": "p" * 80})
    # a log-and-continue refactor would boot the CMS with an unusable admin: must exit 1
    assert rc == 1, f"expected exit 1, got {rc}:\n{out[-800:]}"
    assert "Traceback" not in out, out[-800:]
    assert "PIPLAYER_ADMIN_PASSWORD" in out and "72" in out, out[-800:]


def test_generated_password_banner_only_when_generated():
    rc, out = _run_import({"PIPLAYER_ADMIN_PASSWORD": ""})
    assert rc == 0, out[-800:]
    assert "generated password" in out.lower()
    rc, out = _run_import({})
    assert rc == 0, out[-800:]
    assert "test1234" not in out
    assert re.search(r"admin user .*created from PIPLAYER_ADMIN_PASSWORD", out), out[-800:]


# ---------------------------------------------------------------------------
# Session cookie flags (contract 12)
# ---------------------------------------------------------------------------

def _session_middleware_kwargs(app):
    from starlette.middleware.sessions import SessionMiddleware

    for m in app.user_middleware:
        if m.cls is SessionMiddleware:
            return dict(m.kwargs)
    raise AssertionError("SessionMiddleware not installed")


def test_session_cookie_is_lax_and_not_secure_by_default(cms, client):
    kwargs = _session_middleware_kwargs(cms.app)
    assert kwargs.get("same_site") == "lax"
    assert not kwargs.get("https_only", False)
    r = login(client, ADMIN_USERNAME, ADMIN_PASSWORD)
    cookie = r.headers.get("set-cookie", "")
    assert "piplayer_session=" in cookie
    assert "samesite=lax" in cookie.lower()
    assert "httponly" in cookie.lower()
    assert "secure" not in cookie.lower().replace("samesite", "")


def test_service_unit_only_trusts_configured_proxy_ips():
    """Contract 12: uvicorn must not honour X-Forwarded-* from arbitrary hosts."""
    unit = (CMS_ROOT / "deploy" / "projector-cms.service").read_text(encoding="utf-8")
    exec_line = next(line for line in unit.splitlines() if line.startswith("ExecStart="))
    assert "--proxy-headers" in exec_line
    assert "--forwarded-allow-ips=${PIPLAYER_FORWARDED_ALLOW_IPS}" in exec_line
    assert "Environment=PIPLAYER_FORWARDED_ALLOW_IPS=127.0.0.1" in unit
    assert "*" not in exec_line


def test_https_only_env_marks_the_session_cookie_secure():
    code = (
        "import app.main as m\n"
        "from starlette.middleware.sessions import SessionMiddleware\n"
        "print('HTTPS_ONLY=', [mw.kwargs.get('https_only') for mw in m.app.user_middleware if mw.cls is SessionMiddleware])\n"
    )
    data_dir = tempfile.mkdtemp(prefix="piplayer-envtest-")
    env = dict(os.environ)
    env["PIPLAYER_DATA_DIR"] = data_dir
    env["PIPLAYER_ADMIN_PASSWORD"] = "test1234"
    env["PIPLAYER_HTTPS_ONLY"] = "1"
    try:
        p = subprocess.run([sys.executable, "-c", code], cwd=str(CMS_ROOT), env=env,
                           capture_output=True, text=True, timeout=120)
    finally:
        shutil.rmtree(data_dir, ignore_errors=True)
    assert p.returncode == 0, p.stderr[-800:]
    assert "HTTPS_ONLY= [True]" in p.stdout, p.stdout + p.stderr[-800:]
