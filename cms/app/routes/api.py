import datetime as dt
import hashlib
import os
import re
import tempfile
from pathlib import Path

import aiofiles
from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request, UploadFile, File
from fastapi.responses import FileResponse

from .. import auth, config, db, schedules


router = APIRouter()

SAFE_FILENAME = re.compile(r"^[A-Za-z0-9._-]+$")


def _device_from_header(authorization: str | None = Header(None)) -> dict:
    return auth.authenticate_device(authorization)


def _resolve_duration(item: dict) -> float | None:
    if item.get("duration_override_seconds"):
        return float(item["duration_override_seconds"])
    if item["media_type"] == "image":
        return config.DEFAULT_IMAGE_DURATION
    return None


def _resolve_active_playlist_id(device: dict, now: dt.datetime) -> tuple[int | None, str | None]:
    """Return (playlist_id, source) where source describes how it was chosen."""
    with db.cursor() as cur:
        rows = cur.execute(
            """SELECT id, playlist_id, name, priority, start_time, end_time,
                      days_of_week, start_date, end_date
               FROM device_schedules WHERE device_id = ?""",
            (device["id"],),
        ).fetchall()
        schedule_list = [dict(r) for r in rows]
        active = schedules.pick_active(schedule_list, now)
        if active:
            return active["playlist_id"], f"schedule:{active['name']}"
        if device.get("playlist_id"):
            return device["playlist_id"], "device-default"
        if device.get("group_id"):
            grow = cur.execute("SELECT playlist_id FROM device_groups WHERE id = ?", (device["group_id"],)).fetchone()
            if grow and grow["playlist_id"]:
                return grow["playlist_id"], "group-default"
    return None, None


def _pending_commands(device_id: int) -> list[dict]:
    with db.cursor() as cur:
        rows = cur.execute(
            """SELECT id, command FROM device_commands
               WHERE device_id = ? AND completed_at IS NULL
               ORDER BY id ASC""",
            (device_id,),
        ).fetchall()
        cmds = [dict(r) for r in rows]
        if cmds:
            ids = [c["id"] for c in cmds]
            placeholders = ",".join("?" * len(ids))
            cur.execute(
                f"UPDATE device_commands SET delivered_at = datetime('now') "
                f"WHERE id IN ({placeholders}) AND delivered_at IS NULL",
                ids,
            )
    return cmds


def _manifest_for_device(device: dict, request: Request, now: dt.datetime | None = None) -> dict:
    now = now or dt.datetime.now()
    active_playlist_id, source = _resolve_active_playlist_id(device, now)

    playlist_block = None
    if active_playlist_id:
        with db.cursor() as cur:
            playlist_row = cur.execute(
                "SELECT id, name, updated_at FROM playlists WHERE id = ?",
                (active_playlist_id,),
            ).fetchone()
            items = cur.execute(
                """SELECT pi.position, pi.duration_override_seconds,
                          m.filename, m.sha256, m.size_bytes, m.duration_seconds, m.media_type
                   FROM playlist_items pi
                   JOIN media m ON m.id = pi.media_id
                   WHERE pi.playlist_id = ?
                   ORDER BY pi.position ASC""",
                (active_playlist_id,),
            ).fetchall()

        if playlist_row:
            base_url = config.PUBLIC_BASE_URL or str(request.base_url).rstrip("/")
            item_list = []
            hasher = hashlib.sha256()
            hasher.update(f"playlist:{playlist_row['id']}\n".encode())
            for it in items:
                item_dict = dict(it)
                effective_duration = _resolve_duration(item_dict)
                out = {
                    "position": item_dict["position"],
                    "filename": item_dict["filename"],
                    "sha256": item_dict["sha256"],
                    "size_bytes": item_dict["size_bytes"],
                    "media_type": item_dict["media_type"],
                    "natural_duration_seconds": item_dict["duration_seconds"],
                    "effective_duration_seconds": effective_duration,
                    "url": f"{base_url}/api/media/{item_dict['filename']}",
                }
                item_list.append(out)
                hasher.update(
                    f"{out['position']}:{out['filename']}:{out['sha256']}:{out['effective_duration_seconds']}\n".encode()
                )

            playlist_block = {
                "id": playlist_row["id"],
                "name": playlist_row["name"],
                "updated_at": playlist_row["updated_at"],
                "source": source,
                "hash": "sha256:" + hasher.hexdigest(),
                "items": item_list,
            }

    commands = _pending_commands(device["id"])

    return {
        "device": {"id": device["device_id"], "name": device["name"]},
        "playlist": playlist_block,
        "commands": commands,
        "screenshot_interval_seconds": config.SCREENSHOT_INTERVAL_SECONDS,
        "server_time": now.isoformat(timespec="seconds"),
    }


@router.get("/health")
def health():
    return {"ok": True}


@router.get("/sync/{device_id}")
def sync(
    device_id: str,
    request: Request,
    device=Depends(_device_from_header),
    current_position: int | None = Query(None),
    current_filename: str | None = Query(None),
    player_status: str | None = Query(None),
    player_version: str | None = Query(None),
):
    if device["device_id"] != device_id:
        raise HTTPException(status_code=403, detail="Token does not match device id")

    with db.cursor() as cur:
        cur.execute(
            """UPDATE devices SET
                  last_seen_at = datetime('now'),
                  last_ip = ?,
                  current_position = ?,
                  current_filename = ?,
                  player_status = ?,
                  player_version = COALESCE(?, player_version)
               WHERE id = ?""",
            (
                request.client.host if request.client else None,
                current_position,
                current_filename,
                player_status,
                player_version,
                device["id"],
            ),
        )

    return _manifest_for_device(device, request)


@router.post("/commands/{command_id}/result")
async def report_command_result(
    command_id: int,
    request: Request,
    device=Depends(_device_from_header),
):
    body = await request.json()
    result = str(body.get("result", ""))[:1000]
    with db.cursor() as cur:
        row = cur.execute(
            "SELECT id, device_id FROM device_commands WHERE id = ?",
            (command_id,),
        ).fetchone()
        if not row:
            raise HTTPException(404, "command not found")
        if row["device_id"] != device["id"]:
            raise HTTPException(403, "command belongs to another device")
        cur.execute(
            "UPDATE device_commands SET completed_at = datetime('now'), result = ? WHERE id = ?",
            (result, command_id),
        )
    return {"ok": True}


@router.post("/screenshots/{device_id}")
async def upload_screenshot(
    device_id: str,
    request: Request,
    file: UploadFile = File(...),
    device=Depends(_device_from_header),
):
    if device["device_id"] != device_id:
        raise HTTPException(403, "Token does not match device id")

    config.ensure_dirs()
    target = config.SCREENSHOT_DIR / f"{device['device_id']}.jpg"
    fd, tmp_str = tempfile.mkstemp(dir=str(config.SCREENSHOT_DIR), prefix=".upload_", suffix=".tmp")
    os.close(fd)
    tmp = Path(tmp_str)
    size = 0
    try:
        async with aiofiles.open(tmp, "wb") as out:
            while True:
                chunk = await file.read(256 * 1024)
                if not chunk:
                    break
                size += len(chunk)
                if size > config.MAX_SCREENSHOT_BYTES:
                    raise HTTPException(413, f"screenshot too large (>{config.MAX_SCREENSHOT_BYTES} bytes)")
                await out.write(chunk)
        tmp.replace(target)
        with db.cursor() as cur:
            cur.execute(
                "UPDATE devices SET last_screenshot_at = datetime('now') WHERE id = ?",
                (device["id"],),
            )
    except HTTPException:
        tmp.unlink(missing_ok=True)
        raise
    except Exception:
        tmp.unlink(missing_ok=True)
        raise
    return {"ok": True, "size_bytes": size}


@router.get("/media/{filename}")
def get_media(filename: str, request: Request, authorization: str | None = Header(None)):
    if not SAFE_FILENAME.match(filename):
        raise HTTPException(status_code=400, detail="Invalid filename")

    is_user = auth.current_user(request) is not None
    is_device = False
    if authorization:
        try:
            auth.authenticate_device(authorization)
            is_device = True
        except HTTPException:
            pass
    if not (is_user or is_device):
        raise HTTPException(status_code=401, detail="Authentication required")

    path = config.MEDIA_DIR / filename
    if not path.is_file():
        raise HTTPException(status_code=404)
    return FileResponse(path)
