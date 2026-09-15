import logging
import secrets
import sys
import threading
import time

import bcrypt
from fastapi import Request, HTTPException, status

from . import db, config


_log = logging.getLogger("piplayer.auth")

# bcrypt only looks at the first 72 bytes; bcrypt >= 5 raises instead of truncating.
MAX_PASSWORD_BYTES = 72
PASSWORD_TOO_LONG_MSG = f"password must be at most {MAX_PASSWORD_BYTES} bytes (UTF-8)"


class PasswordTooLong(ValueError):
    pass


def check_password_length(password: str) -> None:
    if len(password.encode("utf-8")) > MAX_PASSWORD_BYTES:
        raise PasswordTooLong(PASSWORD_TOO_LONG_MSG)


def hash_password(password: str) -> str:
    check_password_length(password)
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt(rounds=12)).decode("utf-8")


def verify_password(password: str, password_hash: str) -> bool:
    try:
        return bcrypt.checkpw(password.encode("utf-8"), password_hash.encode("utf-8"))
    except ValueError:
        return False


_dummy_hash: str | None = None


def burn_password_check(password: str) -> None:
    """Spend one bcrypt verification when the username does not exist, so a failed login
    takes the same time whether or not the user is real (no username enumeration)."""
    global _dummy_hash
    if _dummy_hash is None:
        _dummy_hash = bcrypt.hashpw(b"dummy", bcrypt.gensalt(rounds=12)).decode("utf-8")
    verify_password(password, _dummy_hash)


def ensure_admin_user() -> tuple[str, str | None, bool]:
    """Ensure at least one admin user exists.

    Returns (username, generated_password_or_None, created). The password is only
    returned when it was generated here; a value taken from PIPLAYER_ADMIN_PASSWORD
    is never handed back (so it never reaches the log)."""
    with db.cursor() as cur:
        row = cur.execute("SELECT COUNT(*) AS n FROM users").fetchone()
        if row["n"] > 0:
            return (config.DEFAULT_ADMIN_USERNAME, None, False)
        from_env = bool(config.DEFAULT_ADMIN_PASSWORD)
        password = config.DEFAULT_ADMIN_PASSWORD or secrets.token_urlsafe(16)
        try:
            password_hash = hash_password(password)
        except PasswordTooLong:
            _log.error("PIPLAYER_ADMIN_PASSWORD is longer than %d bytes; shorten it and restart",
                       MAX_PASSWORD_BYTES)
            sys.exit(1)
        cur.execute(
            "INSERT INTO users (username, password_hash, role) VALUES (?, ?, 'admin')",
            (config.DEFAULT_ADMIN_USERNAME, password_hash),
        )
        return (config.DEFAULT_ADMIN_USERNAME, None if from_env else password, True)


def current_user(request: Request) -> dict | None:
    user_id = request.session.get("user_id")
    if not user_id:
        return None
    with db.cursor() as cur:
        row = cur.execute("SELECT id, username, role FROM users WHERE id = ?", (user_id,)).fetchone()
        return dict(row) if row else None


def require_user(request: Request) -> dict:
    user = current_user(request)
    if not user:
        raise HTTPException(status_code=status.HTTP_303_SEE_OTHER, headers={"Location": "/login"})
    return user


def _role_rank(role: str) -> int:
    return {"viewer": 0, "editor": 1, "admin": 2}.get(role, 0)


def require_role(min_role: str):
    """Dependency factory. Use as `Depends(require_role('editor'))`."""

    def _dep(request: Request) -> dict:
        user = require_user(request)
        if _role_rank(user["role"]) < _role_rank(min_role):
            raise HTTPException(403, f"requires {min_role} role")
        return user

    return _dep


# ---------------------------------------------------------------------------
# CSRF
# ---------------------------------------------------------------------------

CSRF_ERROR = "CSRF token missing or invalid"


def csrf_token(request: Request) -> str:
    """Per-session CSRF token, created on first use (so the login page has one too)."""
    token = request.session.get("csrf")
    if not token:
        token = secrets.token_urlsafe(32)
        request.session["csrf"] = token
    return token


def check_csrf_value(request: Request, supplied: str | None) -> None:
    expected = request.session.get("csrf")
    # Compare bytes: compare_digest raises TypeError on non-ASCII str, which would be a 500.
    if not expected or not supplied or not secrets.compare_digest(str(supplied).encode("utf-8"),
                                                                  expected.encode("utf-8")):
        raise HTTPException(403, CSRF_ERROR)


def csrf_streaming(endpoint):
    """Mark a handler that reads request.stream() itself; require_csrf then leaves a
    multipart body untouched and the handler calls check_csrf_value on the csrf_token part."""
    endpoint._csrf_streaming = True
    return endpoint


async def require_csrf(request: Request) -> None:
    """Dependency for every POST under the web router: the token comes from the
    X-CSRF-Token header or the csrf_token form field. Safe methods are not checked."""
    if request.method in ("GET", "HEAD", "OPTIONS"):
        return
    if not request.session.get("user_id") and request.url.path != "/login":
        # Session gone (expired, logged out elsewhere, restart without a secret key): the
        # endpoint would answer 303 -> /login anyway; do not leave a form on a JSON 403.
        raise HTTPException(status_code=status.HTTP_303_SEE_OTHER, headers={"Location": "/login?expired=1"})
    if request.url.path == "/login" and not request.session.get("csrf"):
        # Stale login form (no session at all): hand out a fresh one instead of a JSON 403.
        raise HTTPException(status_code=status.HTTP_303_SEE_OTHER, headers={"Location": "/login?expired=1"})
    supplied = request.headers.get("x-csrf-token")
    if supplied is None:
        ctype = request.headers.get("content-type", "").lower()
        if ctype.startswith("multipart/form-data") and getattr(request.scope.get("endpoint"), "_csrf_streaming", False):
            return
        if ctype.startswith("application/x-www-form-urlencoded") or ctype.startswith("multipart/form-data"):
            form = await request.form()
            supplied = form.get("csrf_token")
            if not isinstance(supplied, str):
                supplied = None
    check_csrf_value(request, supplied)


# ---------------------------------------------------------------------------
# Failed-login throttle (per ip+username, in memory)
# ---------------------------------------------------------------------------

LOGIN_MAX_FAILURES = 5
LOGIN_LOCK_SECONDS = 30
_login_failures: dict[tuple[str, str], list[float]] = {}
_login_lock = threading.Lock()


def _login_key(ip: str | None, username: str) -> tuple[str, str]:
    return (ip or "-", username)


def login_locked_for(ip: str | None, username: str) -> int:
    """Seconds remaining on the lock for this ip+username, 0 when not locked."""
    key = _login_key(ip, username)
    now = time.monotonic()
    with _login_lock:
        stamps = _login_failures.get(key)
        if not stamps:
            return 0
        stamps = [t for t in stamps if now - t < LOGIN_LOCK_SECONDS]
        if stamps:
            _login_failures[key] = stamps
        else:
            _login_failures.pop(key, None)
        if len(stamps) >= LOGIN_MAX_FAILURES:
            return max(1, int(LOGIN_LOCK_SECONDS - (now - stamps[-1])) + 1)
        return 0


def record_login_failure(ip: str | None, username: str) -> None:
    key = _login_key(ip, username)
    now = time.monotonic()
    with _login_lock:
        stamps = [t for t in _login_failures.get(key, []) if now - t < LOGIN_LOCK_SECONDS]
        stamps.append(now)
        _login_failures[key] = stamps
        # Keep the table bounded if someone sprays usernames.
        if len(_login_failures) > 10000:
            for k in [k for k, v in _login_failures.items() if not v or now - v[-1] >= LOGIN_LOCK_SECONDS]:
                _login_failures.pop(k, None)


def clear_login_failures(ip: str | None, username: str) -> None:
    with _login_lock:
        _login_failures.pop(_login_key(ip, username), None)


def authenticate_device(authorization: str | None) -> dict:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Missing bearer token")
    token = authorization.split(" ", 1)[1].strip()
    with db.cursor() as cur:
        row = cur.execute(
            "SELECT id, device_id, name, playlist_id, group_id FROM devices WHERE token = ?",
            (token,),
        ).fetchone()
    if not row:
        raise HTTPException(status_code=401, detail="Invalid device token")
    return dict(row)
