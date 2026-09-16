import base64
import datetime as dt
import hashlib
import json
import logging
import os
import re
import secrets
import tempfile
from pathlib import Path

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request
from fastapi.responses import FileResponse
from starlette.concurrency import run_in_threadpool

from .. import audit, auth, config, db, schedules


log = logging.getLogger("piplayer.api")
router = APIRouter()

SAFE_FILENAME = re.compile(r"^[A-Za-z0-9._-]+$")
DEVICE_ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,62}$")
DEVICE_ID_RULE = "device_id must be lowercase alphanumeric + hyphens, 1-63 chars"
MAX_DEVICE_NAME_LEN = 120
NOSNIFF = {"X-Content-Type-Options": "nosniff"}
JPEG_MAGIC = b"\xff\xd8\xff"
MAX_COMMAND_DELIVERIES = 5
MAX_SYNC_ERROR_LEN = 200
MAX_UPDATE_REF_LEN = 100
PROJECTOR_STATES = ("on", "off", "unknown")
# A Broadlink packet is 16 bytes of header + the pulses; the player reports it as base64.
IR_CODE_RE = re.compile(r"^[A-Za-z0-9+/]{20,4000}={0,2}$")


def _device_from_header(authorization: str | None = Header(None)) -> dict:
    return auth.authenticate_device(authorization)


def _resolve_duration(item: dict) -> float | None:
    if item.get("duration_override_seconds"):
        return float(item["duration_override_seconds"])
    if item["media_type"] == "image":
        return config.DEFAULT_IMAGE_DURATION
    return None


def resolve_active_playlist_id(device: dict, now: dt.datetime, cur=None) -> tuple[int | None, str | None]:
    """Return (playlist_id, source) where source describes how it was chosen.

    Shared by the sync manifest, the Devices page and the dashboard so they agree.
    `device` needs id, playlist_id, group_id. Pass an open cursor to reuse a connection."""
    if cur is None:
        with db.cursor() as own:
            return resolve_active_playlist_id(device, now, own)
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


def ir_codes(raw) -> dict[str, str]:
    """The stored projector_ir_codes JSON as {name: base64} with only the known names; {} for
    NULL / junk (a hand-edited row must never break a sync or the Devices page)."""
    try:
        parsed = json.loads(raw) if raw else {}
    except ValueError:
        return {}
    if not isinstance(parsed, dict):
        return {}
    return {n: parsed[n] for n in db.IR_CODE_NAMES if isinstance(parsed.get(n), str) and parsed[n]}


def projector_want(device: dict, now: dt.datetime, cur,
                   lead_minutes: int | None = None, idle_minutes: int | None = None) -> str:
    """"on" | "off" for a device's projector in auto mode: on while a playlist is served, from
    lead_minutes before the next schedule rule starts, and until nothing has been served for
    idle_minutes; off otherwise. Same clock and rules as the manifest's playlist."""
    lead = config.PROJECTOR_LEAD_MINUTES if lead_minutes is None else lead_minutes
    idle = config.PROJECTOR_IDLE_MINUTES if idle_minutes is None else idle_minutes
    if resolve_active_playlist_id(device, now, cur)[0]:
        return "on"
    rows = cur.execute(
        """SELECT id, playlist_id, name, priority, start_time, end_time, days_of_week, start_date, end_date
           FROM device_schedules WHERE device_id = ?""",
        (device["id"],),
    ).fetchall()
    upcoming = schedules.next_start([dict(r) for r in rows], now)
    if upcoming and upcoming[1] - now.replace(second=0, microsecond=0, tzinfo=None) <= dt.timedelta(minutes=lead):
        return "on"
    # ponytail: one pick_active per idle minute (default 10) rather than a "last end" solver
    for back in range(1, idle + 1):
        if resolve_active_playlist_id(device, now - dt.timedelta(minutes=back), cur)[0]:
            return "on"
    return "off"


def _projector_block(device: dict, now: dt.datetime) -> dict | None:
    """Manifest `projector` key (player/player/projector.py), None when the device has no
    projector control (absence = feature off). `want` is what auto mode follows; manual mode only
    acts on the projector-on / projector-off commands."""
    control = device.get("projector_control")
    if not control or control == "none":
        return None
    with db.cursor() as cur:
        want = projector_want(device, now, cur)
    mode = device.get("projector_power_mode")
    return {
        "control": control,
        "mode": mode if mode in db.PROJECTOR_MODES else "manual",
        "want": want,
        "codes": ir_codes(device.get("projector_ir_codes")),
        "broadlink_host": device.get("broadlink_host") or None,
    }


def _pending_commands(device_id: int) -> list[dict]:
    """Commands not yet completed, each handed out at most MAX_COMMAND_DELIVERIES times.

    A command the player never reports on (lost result POST, crash) is closed as
    undeliverable instead of being re-sent forever (a lost 'reboot' result must not
    reboot the Pi on every boot)."""
    with db.cursor() as cur:
        rows = cur.execute(
            """SELECT id, command, issued_at, delivery_count FROM device_commands
               WHERE device_id = ? AND completed_at IS NULL
               ORDER BY id ASC""",
            (device_id,),
        ).fetchall()
        cmds = []
        for r in rows:
            if r["delivery_count"] >= MAX_COMMAND_DELIVERIES:
                cur.execute(
                    """UPDATE device_commands
                       SET completed_at = datetime('now'),
                           result = ?
                       WHERE id = ? AND completed_at IS NULL""",
                    (f"undeliverable: no result after {MAX_COMMAND_DELIVERIES} deliveries", r["id"]),
                )
                log.warning("command %d (%s) for device %d closed as undeliverable", r["id"], r["command"], device_id)
                continue
            cur.execute(
                """UPDATE device_commands
                   SET delivered_at = COALESCE(delivered_at, datetime('now')),
                       delivery_count = delivery_count + 1
                   WHERE id = ?""",
                (r["id"],),
            )
            # issued_at lets the player tell a re-used id (DB restored/recreated) from a repeat.
            cmds.append({"id": r["id"], "command": r["command"], "issued_at": r["issued_at"]})
    return cmds


def _manifest_for_device(device: dict, request: Request, now: dt.datetime | None = None) -> dict:
    now = now or dt.datetime.now()
    active_playlist_id, source = resolve_active_playlist_id(device, now)

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
                   ORDER BY pi.position ASC, pi.id ASC""",
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

    # Nothing to play right now: tell the player when the next schedule rule
    # starts so its standby screen can say so.
    next_rule = None
    if playlist_block is None or not playlist_block["items"]:
        with db.cursor() as cur:
            rows = cur.execute(
                """SELECT s.id, s.playlist_id, s.name, s.priority, s.start_time, s.end_time,
                          s.days_of_week, s.start_date, s.end_date, p.name AS playlist_name
                   FROM device_schedules s LEFT JOIN playlists p ON p.id = s.playlist_id
                   WHERE s.device_id = ?""",
                (device["id"],),
            ).fetchall()
        upcoming = schedules.next_start([dict(r) for r in rows], now)
        if upcoming:
            rule, starts_at = upcoming
            next_rule = {
                "name": rule["name"],
                "playlist": rule.get("playlist_name"),
                "starts_at": starts_at.astimezone().isoformat(timespec="minutes"),
            }

    return {
        "device": {"id": device["device_id"], "name": device["name"]},
        "playlist": playlist_block,
        "next_rule": next_rule,
        "commands": commands,
        "screenshot_interval_seconds": config.SCREENSHOT_INTERVAL_SECONDS,
        "camera_interval_seconds": config.CAMERA_INTERVAL_SECONDS,
        # Remote updates (player/player/updater.py): git ref to install, off|nightly, local HH:MM-HH:MM.
        "update": {"release": config.PLAYER_RELEASE, "auto": config.AUTO_UPDATE, "window": config.AUTO_UPDATE_WINDOW},
        # Projector power: null when the device has no projector control; otherwise {control, mode,
        # want, codes, broadlink_host} (auto mode follows `want`, see projector_want).
        "projector": _projector_block(device, now),
        # Local wall-clock with UTC offset, e.g. 2026-09-14T15:03:07-07:00 (schedules use this clock).
        "server_time": now.astimezone().isoformat(timespec="seconds"),
    }


@router.get("/health")
def health():
    return {"ok": True}


@router.post("/enroll")
async def enroll(request: Request):
    """Zero-touch enrollment: a freshly flashed Pi trades the enrollment key for its device token.

    No session, no CSRF (device API family). Wrong keys are throttled per IP like logins.
    The token is never logged."""
    ip = request.client.host if request.client else None
    wait = auth.login_locked_for(ip, auth.ENROLL_SLOT, auth.ENROLL_MAX_FAILURES, auth.ENROLL_LOCK_SECONDS)
    if wait:
        raise HTTPException(429, f"too many failed attempts; try again in {wait} s",
                            headers={"Retry-After": str(wait)})
    try:
        body = await request.json()
    except (json.JSONDecodeError, UnicodeDecodeError, ValueError):
        raise HTTPException(400, "body must be a JSON object")
    if not isinstance(body, dict):
        raise HTTPException(400, "body must be a JSON object")
    key = body.get("key")
    expected = await run_in_threadpool(db.enrollment_key)
    if not isinstance(key, str) or not secrets.compare_digest(key.encode("utf-8"), expected.encode("utf-8")):
        log.warning("enroll failed: invalid enrollment key ip=%s", ip)
        auth.record_login_failure(ip, auth.ENROLL_SLOT, auth.ENROLL_LOCK_SECONDS)
        raise HTTPException(401, "invalid enrollment key")
    auth.clear_login_failures(ip, auth.ENROLL_SLOT)

    device_id = str(body.get("device_id") or "").strip().lower()
    if not DEVICE_ID_RE.match(device_id):
        raise HTTPException(400, DEVICE_ID_RULE)
    name = str(body.get("name") or "").strip()
    if not 1 <= len(name) <= MAX_DEVICE_NAME_LEN:
        raise HTTPException(400, f"name must be 1-{MAX_DEVICE_NAME_LEN} chars")

    def _upsert() -> tuple[int, str, str, dict]:
        with db.cursor() as cur:
            row = cur.execute("SELECT id, name, token FROM devices WHERE device_id = ?", (device_id,)).fetchone()
            if row:
                # Re-flashing a card must keep the console's view of that device: same row, same
                # token, same group/playlist (the Settings defaults apply to the first enrollment only).
                if row["name"] != name:
                    cur.execute("UPDATE devices SET name = ? WHERE id = ?", (name, row["id"]))
                return row["id"], row["token"], "device_reenrolled", {}
            token = db.new_token()
            defaults = db.enroll_defaults(cur)
            cur.execute(
                "INSERT INTO devices (device_id, name, token, group_id, playlist_id) VALUES (?, ?, ?, ?, ?)",
                (device_id, name, token, defaults["enroll_group_id"], defaults["enroll_playlist_id"]),
            )
            applied = {"group_id": defaults["enroll_group_id"], "playlist_id": defaults["enroll_playlist_id"]}
            return cur.lastrowid, token, "device_enrolled", applied

    row_id, token, action, applied = await run_in_threadpool(_upsert)
    audit.log(request, None, action, "device", row_id, {"device_id": device_id, "name": name, **applied})
    log.info("%s device_id=%s ip=%s", action, device_id, ip)
    cms_url = config.PUBLIC_BASE_URL or str(request.base_url).rstrip("/")
    return {"device_id": device_id, "token": token, "cms_url": cms_url}


@router.get("/sync/{device_id}")
def sync(
    device_id: str,
    request: Request,
    device=Depends(_device_from_header),
    current_position: int | None = Query(None),
    current_filename: str | None = Query(None),
    player_status: str | None = Query(None),
    player_version: str | None = Query(None),
    sync_error: str | None = Query(None),
    camera_error: str | None = Query(None),
    update_status: str | None = Query(None),
    projector_state: str | None = Query(None),
    projector_error: str | None = Query(None),
):
    if device["device_id"] != device_id:
        raise HTTPException(status_code=403, detail="Token does not match device id")

    # Empty string = last sync fully succeeded; store NULL so the UI can test truthiness.
    last_error = (sync_error or "").strip()[:MAX_SYNC_ERROR_LEN] or None
    # camera_error works the same way for the player's last camera capture.
    cam_error = (camera_error or "").strip()[:MAX_SYNC_ERROR_LEN] or None
    # projector_state (on | off | unknown) is kept when the player does not send one (no
    # projector control); projector_error clears like camera_error.
    proj_state = projector_state if projector_state in PROJECTOR_STATES else None
    proj_error = (projector_error or "").strip()[:MAX_SYNC_ERROR_LEN] or None
    with db.cursor() as cur:
        cur.execute(
            """UPDATE devices SET
                  last_seen_at = datetime('now'),
                  last_ip = ?,
                  current_position = ?,
                  current_filename = ?,
                  player_status = ?,
                  player_version = COALESCE(?, player_version),
                  last_error = ?,
                  camera_error = ?,
                  projector_power_state = COALESCE(?, projector_power_state),
                  projector_error = ?
               WHERE id = ?""",
            (
                request.client.host if request.client else None,
                current_position,
                current_filename,
                player_status,
                player_version,
                last_error,
                cam_error,
                proj_state,
                proj_error,
                device["id"],
            ),
        )
        status = _parse_update_status(update_status)
        if status:
            cur.execute(
                """UPDATE devices SET last_update_at = COALESCE(?, datetime('now')), last_update_ok = ?,
                                      last_update_message = ?, last_update_ref = ?
                   WHERE id = ?""",
                (status["finished"], status["ok"], status["message"], status["ref"], device["id"]),
            )
    if status:
        audit.log(request, None, "device_update_reported", "device", device["id"],
                  {"device_id": device["device_id"], "ref": status["ref"], "ok": bool(status["ok"]),
                   "message": status["message"]})

    return _manifest_for_device(device, request)


def _parse_update_status(raw: str | None) -> dict | None:
    """update_status = the JSON of /var/lib/projector-player/update-status.json
    ({ref, started, finished, ok, message, previous_version}) that the daemon reports on its first
    sync after update-player.sh / update-os.sh restarted it. Absent = nothing new; anything that is
    not a JSON object is dropped (the manifest must still be served). `finished` (the Pi's clock,
    ISO 8601) becomes last_update_at when parseable, else the report time."""
    if not raw:
        return None
    try:
        body = json.loads(raw)
    except ValueError:
        body = None
    if not isinstance(body, dict):
        log.warning("ignoring malformed update_status %r", raw[:80])
        return None
    finished = None
    try:
        finished = dt.datetime.fromisoformat(str(body.get("finished") or ""))
    except ValueError:
        pass
    if finished is not None:
        finished = (finished.astimezone(dt.timezone.utc) if finished.tzinfo else finished).strftime("%Y-%m-%d %H:%M:%S")
    return {
        "ok": 1 if body.get("ok") in (True, 1) else 0,
        "message": str(body.get("message") or "").strip()[:MAX_SYNC_ERROR_LEN] or None,
        "ref": str(body.get("ref") or "").strip()[:MAX_UPDATE_REF_LEN] or None,
        "finished": finished,
    }


@router.post("/commands/{command_id}/result")
async def report_command_result(
    command_id: int,
    request: Request,
    device=Depends(_device_from_header),
):
    try:
        body = await request.json()
    except (json.JSONDecodeError, UnicodeDecodeError, ValueError):
        raise HTTPException(400, "body must be a JSON object")
    if not isinstance(body, dict):
        raise HTTPException(400, "body must be a JSON object")
    result = str(body.get("result", ""))[:1000]
    learned = None

    def _store():
        nonlocal learned
        with db.cursor() as cur:
            row = cur.execute(
                "SELECT id, device_id, command FROM device_commands WHERE id = ?",
                (command_id,),
            ).fetchone()
            if not row:
                raise HTTPException(404, "command not found")
            if row["device_id"] != device["id"]:
                raise HTTPException(403, "command belongs to another device")
            learned = _store_learned_code(cur, device["id"], row["command"], body)
            cur.execute(
                "UPDATE device_commands SET completed_at = datetime('now'), result = ? WHERE id = ?",
                (f"learned {learned}" if learned else result, command_id),
            )

    await run_in_threadpool(_store)
    if learned:
        audit.log(request, None, "device_ir_code_learned", "device", device["id"],
                  {"device_id": device["device_id"], "name": learned})
    return {"ok": True}


def _learned_code(body: dict) -> str | None:
    """The base64 packet in an ir-learn result: `code`, a JSON result {"learned", "code"} (what
    player/player/projector.py sends) or a bare base64 `result`. A failure text never matches."""
    raw = body.get("result")
    nested = None
    if isinstance(raw, str) and raw.lstrip().startswith("{"):
        try:
            nested = json.loads(raw).get("code")
        except (ValueError, AttributeError):
            nested = None
    for v in (body.get("code"), nested, raw):
        if isinstance(v, str) and IR_CODE_RE.match(v.strip()):
            try:
                base64.b64decode(v.strip(), validate=True)
            except ValueError:
                continue
            return v.strip()
    return None


def _store_learned_code(cur, device_row_id: int, command: str, body: dict) -> str | None:
    """ir-learn:<name>: file the learned packet under <name> in projector_ir_codes (only the
    known names; a timeout / failure result leaves the stored codes alone). Returns the name."""
    if not command.startswith("ir-learn:"):
        return None
    name = command[len("ir-learn:"):]
    code = _learned_code(body) if name in db.IR_CODE_NAMES else None
    if not code:
        return None
    row = cur.execute("SELECT projector_ir_codes FROM devices WHERE id = ?", (device_row_id,)).fetchone()
    codes = {**ir_codes(row["projector_ir_codes"] if row else None), name: code}
    cur.execute("UPDATE devices SET projector_ir_codes = ? WHERE id = ?", (json.dumps(codes), device_row_id))
    return name


async def _receive_jpeg(request: Request, target: Path, max_bytes: int, what: str) -> int:
    """Multipart JPEG upload shared by /api/screenshots and /api/camera: streamed to a temp file
    next to `target` with the size cap enforced as bytes arrive, magic-checked, then renamed
    into place. Returns the size in bytes."""
    from .web import _receive_upload  # web imports this module; bind at call time

    config.ensure_dirs()
    fd, tmp_str = tempfile.mkstemp(dir=str(target.parent), prefix=".upload_", suffix=".tmp")
    os.close(fd)
    tmp = Path(tmp_str)
    try:
        # Streamed straight to tmp with the size cap enforced as bytes arrive (no spool to /tmp).
        recv = await _receive_upload(request, tmp, max_bytes=max_bytes, check_csrf=False)
        size = recv.size
        with open(tmp, "rb") as f:
            magic = f.read(len(JPEG_MAGIC))
        if size == 0 or magic != JPEG_MAGIC:
            raise HTTPException(400, f"{what} must be a JPEG image")
        tmp.replace(target)
    finally:
        tmp.unlink(missing_ok=True)
    return size


@router.post("/screenshots/{device_id}")
async def upload_screenshot(
    device_id: str,
    request: Request,
    device=Depends(_device_from_header),
):
    if device["device_id"] != device_id:
        raise HTTPException(403, "Token does not match device id")
    target = config.SCREENSHOT_DIR / f"{device['device_id']}.jpg"
    size = await _receive_jpeg(request, target, config.MAX_SCREENSHOT_BYTES, "screenshot")

    def _mark():
        with db.cursor() as cur:
            cur.execute(
                "UPDATE devices SET last_screenshot_at = datetime('now') WHERE id = ?",
                (device["id"],),
            )

    await run_in_threadpool(_mark)
    return {"ok": True, "size_bytes": size}


@router.post("/camera/{device_id}")
async def upload_camera(
    device_id: str,
    request: Request,
    device=Depends(_device_from_header),
):
    """Room camera snapshot (player/player/camera.py): same protocol as screenshots, stored at
    SCREENSHOT_DIR/camera_<device_id>.jpg; stamps last_camera_at and clears camera_error."""
    if device["device_id"] != device_id:
        raise HTTPException(403, "Token does not match device id")
    target = config.SCREENSHOT_DIR / f"camera_{device['device_id']}.jpg"
    size = await _receive_jpeg(request, target, config.MAX_CAMERA_BYTES, "camera snapshot")

    def _mark():
        with db.cursor() as cur:
            cur.execute(
                "UPDATE devices SET last_camera_at = datetime('now'), camera_error = NULL WHERE id = ?",
                (device["id"],),
            )

    await run_in_threadpool(_mark)
    return {"ok": True, "size_bytes": size}


def _device_may_fetch(device: dict, filename: str, request: Request) -> bool:
    """A device token only unlocks the files in that device's currently served playlist."""
    with db.cursor() as cur:
        pid, _ = resolve_active_playlist_id(device, dt.datetime.now(), cur)
        if not pid:
            return False
        row = cur.execute(
            """SELECT 1 FROM playlist_items pi JOIN media m ON m.id = pi.media_id
               WHERE pi.playlist_id = ? AND m.filename = ? LIMIT 1""",
            (pid, filename),
        ).fetchone()
    return row is not None


@router.api_route("/media/{filename}", methods=["GET", "HEAD"])
def get_media(filename: str, request: Request, authorization: str | None = Header(None)):
    if not SAFE_FILENAME.match(filename):
        raise HTTPException(status_code=400, detail="Invalid filename")

    is_user = auth.current_user(request) is not None
    device = None
    if authorization:
        try:
            device = auth.authenticate_device(authorization)
        except HTTPException:
            device = None
    if not (is_user or device):
        raise HTTPException(status_code=401, detail="Authentication required")
    if not is_user and not _device_may_fetch(device, filename, request):
        raise HTTPException(status_code=403, detail="file is not in this device's playlist")

    path = config.MEDIA_DIR / filename
    if not path.is_file():
        raise HTTPException(status_code=404)
    # FileResponse honours Range requests (206), which the player relies on to resume downloads.
    return FileResponse(path, headers=NOSNIFF)
