"""Zero-touch enrollment: POST /api/enroll (device API family) and the admin
Settings page that shows / rotates the enrollment key."""
import logging

import pytest

from cms_helpers import create_device, create_user, login, one, post, query
from cms_support import ADMIN_USERNAME

# starlette's TestClient reports every request from this host, so the per-IP enroll
# throttle is shared by the whole suite; every test starts and ends with it cleared.
TESTCLIENT_IP = "testclient"


@pytest.fixture(autouse=True)
def _clear_enroll_throttle(cms):
    cms.auth.clear_login_failures(TESTCLIENT_IP, cms.auth.ENROLL_SLOT)
    yield
    cms.auth.clear_login_failures(TESTCLIENT_IP, cms.auth.ENROLL_SLOT)


def enroll(client, cms, device_id, name, key=None):
    body = {"key": cms.db.enrollment_key() if key is None else key, "device_id": device_id, "name": name}
    return client.post("/api/enroll", json=body)


def test_key_is_generated_at_startup_and_stable(cms):
    row = one("SELECT value FROM settings WHERE key = 'enrollment_key'")
    assert len(row["value"]) >= 32
    assert cms.db.enrollment_key() == row["value"]


def test_enroll_creates_device_and_audits(client, cms, tok):
    r = enroll(client, cms, f"pi-{tok}", f"Lobby {tok}")
    assert r.status_code == 200, r.text[:300]
    body = r.json()
    assert set(body) == {"device_id", "token", "cms_url"}
    assert body["device_id"] == f"pi-{tok}"
    assert body["cms_url"].startswith("http") and not body["cms_url"].endswith("/")
    row = one("SELECT id, name, token FROM devices WHERE device_id = ?", (f"pi-{tok}",))
    assert row["token"] == body["token"] and row["name"] == f"Lobby {tok}"
    a = query("SELECT * FROM audit_log WHERE action = 'device_enrolled' AND target_id = ?", (str(row["id"]),))
    assert len(a) == 1 and a[0]["ip"] and f"pi-{tok}" in a[0]["details"] and a[0]["user_id"] is None
    assert body["token"] not in (a[0]["details"] or "")


def test_reenroll_keeps_token_and_updates_name(client, cms, tok):
    first = enroll(client, cms, f"Pi-{tok}", "Old name").json()  # device_id is lowercased
    again = enroll(client, cms, f"pi-{tok}", "New name")
    assert again.status_code == 200
    assert again.json()["token"] == first["token"]
    row = one("SELECT id, name FROM devices WHERE device_id = ?", (f"pi-{tok}",))  # still exactly one row
    assert row["name"] == "New name"
    a = query("SELECT * FROM audit_log WHERE action = 'device_reenrolled' AND target_id = ?", (str(row["id"]),))
    assert len(a) == 1
    # the returned token works for the device API
    s = client.get(f"/api/sync/pi-{tok}", headers={"Authorization": f"Bearer {first['token']}"})
    assert s.status_code == 200


def test_enroll_manually_registered_device_returns_its_token(admin, client, cms, tok):
    dev = create_device(admin, f"manual-{tok}", "Manual")
    r = enroll(client, cms, f"manual-{tok}", "Manual")
    assert r.status_code == 200 and r.json()["token"] == dev["token"]


@pytest.mark.parametrize("key", ["wrong-key", "", None, 123])
def test_wrong_or_missing_key_is_401(client, cms, tok, key):
    body = {"device_id": f"pi-{tok}", "name": "x"}
    if key is not None:
        body["key"] = key
    r = client.post("/api/enroll", json=body)
    assert r.status_code == 401, r.text[:300]
    assert r.json() == {"detail": "invalid enrollment key"}
    assert query("SELECT id FROM devices WHERE device_id = ?", (f"pi-{tok}",)) == []


def test_enroll_needs_no_csrf_or_session(client, cms, tok):
    # a JSON POST with no cookie and no X-CSRF-Token header succeeds (api router, not web router)
    r = client.post("/api/enroll", json={"key": cms.db.enrollment_key(), "device_id": f"nocsrf-{tok}", "name": "n"})
    assert r.status_code == 200


@pytest.mark.parametrize("content", [b"not json", b"[]", b'"str"'])
def test_bad_body_is_400(client, content):
    r = client.post("/api/enroll", content=content, headers={"Content-Type": "application/json"})
    assert r.status_code == 400 and "detail" in r.json()


@pytest.mark.parametrize("device_id", ["", "-bad", "has space", "UPPER_case", "a" * 64, "ünïcode"])
def test_bad_device_id_is_400(client, cms, device_id):
    r = enroll(client, cms, device_id, "name")
    assert r.status_code == 400, r.text[:300]
    assert "device_id" in r.json()["detail"]


@pytest.mark.parametrize("name", ["", "   ", "n" * 121])
def test_bad_name_is_400(client, cms, tok, name):
    r = enroll(client, cms, f"pi-{tok}", name)
    assert r.status_code == 400, r.text[:300]
    assert "name" in r.json()["detail"]
    assert query("SELECT id FROM devices WHERE device_id = ?", (f"pi-{tok}",)) == []


def test_validation_failures_do_not_count_toward_throttle(client, cms, tok):
    for _ in range(cms.auth.ENROLL_MAX_FAILURES + 1):
        assert enroll(client, cms, "-bad", "x").status_code == 400
    assert enroll(client, cms, f"ok-{tok}", "x").status_code == 200


def test_wrong_keys_are_throttled_per_ip(client, cms, tok):
    codes = [enroll(client, cms, f"pi-{tok}", "x", key="wrong").status_code
             for _ in range(cms.auth.ENROLL_MAX_FAILURES + 1)]
    assert codes[:-1] == [401] * cms.auth.ENROLL_MAX_FAILURES, codes
    assert codes[-1] == 429
    # the lock applies to the right key too, with a Retry-After hint
    r = enroll(client, cms, f"pi-{tok}", "x")
    assert r.status_code == 429 and r.headers.get("retry-after")
    # ...and clears once the failures expire
    cms.auth.clear_login_failures(TESTCLIENT_IP, cms.auth.ENROLL_SLOT)
    assert enroll(client, cms, f"pi-{tok}", "x").status_code == 200


def test_successful_enroll_clears_failure_count(client, cms, tok):
    for _ in range(cms.auth.ENROLL_MAX_FAILURES - 1):
        enroll(client, cms, f"pi-{tok}", "x", key="wrong")
    assert enroll(client, cms, f"pi-{tok}", "x").status_code == 200
    for _ in range(cms.auth.ENROLL_MAX_FAILURES - 1):
        assert enroll(client, cms, f"pi-{tok}", "x", key="wrong").status_code == 401


def test_enroll_never_logs_the_token_or_key(client, cms, caplog, tok):
    with caplog.at_level(logging.DEBUG):
        r = enroll(client, cms, f"quiet-{tok}", "Quiet")
    assert r.status_code == 200
    token = r.json()["token"]
    assert not any(token in rec.getMessage() for rec in caplog.records)
    assert not any(cms.db.enrollment_key() in rec.getMessage() for rec in caplog.records)


def test_cms_url_honours_public_base_url(client, cms, monkeypatch, tok):
    monkeypatch.setattr(cms.config, "PUBLIC_BASE_URL", "https://cms.example.net")
    r = enroll(client, cms, f"pub-{tok}", "x")
    assert r.json()["cms_url"] == "https://cms.example.net"


# ---------------------------------------------------------------------------
# Settings page
# ---------------------------------------------------------------------------

def test_settings_page_is_admin_only(client, admin, make_client, tok):
    assert client.get("/settings", follow_redirects=False).status_code == 303
    create_user(admin, f"ed-{tok}", "pw123456", "editor")
    ed = make_client()
    assert login(ed, f"ed-{tok}", "pw123456").status_code == 303
    assert ed.get("/settings").status_code == 403
    assert post(ed, "/settings/enrollment/rotate").status_code == 403
    assert 'href="/settings"' not in ed.get("/dashboard").text
    assert 'href="/settings"' in admin.get("/dashboard").text


def test_settings_page_shows_key_and_rotates(admin, client, cms, tok):
    old = cms.db.enrollment_key()
    page = admin.get("/settings")
    assert page.status_code == 200 and old in page.text and "Rotate" in page.text
    r = post(admin, "/settings/enrollment/rotate")
    assert r.status_code == 303 and r.headers["location"] == "/settings"
    new = cms.db.enrollment_key()
    assert new != old and len(new) >= 32
    assert new in admin.get("/settings").text and old not in admin.get("/settings").text
    a = query("SELECT * FROM audit_log WHERE action = 'enrollment_key_rotated' ORDER BY id DESC LIMIT 1")
    assert a and a[0]["username"] == ADMIN_USERNAME and new not in (a[0]["details"] or "")
    # the old key stops working, the new one enrolls
    assert enroll(client, cms, f"rot-{tok}", "x", key=old).status_code == 401
    assert enroll(client, cms, f"rot-{tok}", "x", key=new).status_code == 200


def test_rotate_requires_csrf(admin):
    r = admin.post("/settings/enrollment/rotate", follow_redirects=False)
    assert r.status_code == 403
