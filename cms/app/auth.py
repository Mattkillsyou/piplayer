import bcrypt
from fastapi import Request, HTTPException, status

from . import db, config


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt(rounds=12)).decode("utf-8")


def verify_password(password: str, password_hash: str) -> bool:
    try:
        return bcrypt.checkpw(password.encode("utf-8"), password_hash.encode("utf-8"))
    except ValueError:
        return False


def ensure_admin_user() -> tuple[str, str | None]:
    """Ensure at least one admin user exists. Returns (username, generated_password_or_None)."""
    import secrets as _secrets

    with db.cursor() as cur:
        row = cur.execute("SELECT COUNT(*) AS n FROM users").fetchone()
        if row["n"] > 0:
            return (config.DEFAULT_ADMIN_USERNAME, None)
        password = config.DEFAULT_ADMIN_PASSWORD or _secrets.token_urlsafe(16)
        cur.execute(
            "INSERT INTO users (username, password_hash, role) VALUES (?, ?, 'admin')",
            (config.DEFAULT_ADMIN_USERNAME, hash_password(password)),
        )
        return (config.DEFAULT_ADMIN_USERNAME, password)


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
