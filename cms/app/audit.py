"""Audit log helper. Call log(...) from any write route to record what changed."""
import json
import logging

from fastapi import Request

from . import db


_log = logging.getLogger("piplayer.audit")


def log(
    request: Request | None,
    user: dict | None,
    action: str,
    target_type: str | None = None,
    target_id: str | int | None = None,
    details: dict | None = None,
) -> None:
    ip = None
    if request is not None and request.client is not None:
        ip = request.client.host
    try:
        with db.cursor() as cur:
            cur.execute(
                """INSERT INTO audit_log (user_id, username, action, target_type, target_id, details, ip)
                   VALUES (?, ?, ?, ?, ?, ?, ?)""",
                (
                    user["id"] if user else None,
                    user["username"] if user else None,
                    action,
                    target_type,
                    str(target_id) if target_id is not None else None,
                    json.dumps(details) if details else None,
                    ip,
                ),
            )
    except Exception:
        _log.exception("audit log write failed for %s", action)
