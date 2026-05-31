import datetime as dt
import hashlib
import logging
import os
import re
import tempfile
from pathlib import Path

import aiofiles
from fastapi import APIRouter, Depends, Form, HTTPException, Query, Request, UploadFile, File
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, RedirectResponse
from fastapi.templating import Jinja2Templates

from .. import audit, auth, config, db, ffprobe, schedules


log = logging.getLogger("piplayer.web")
router = APIRouter()

TEMPLATES_DIR = Path(__file__).parent.parent / "templates"
templates = Jinja2Templates(directory=str(TEMPLATES_DIR))
templates.env.globals["app_name"] = "PiPlayer"
templates.env.globals["default_image_duration"] = config.DEFAULT_IMAGE_DURATION

SAFE_NAME = re.compile(r"[^A-Za-z0-9._-]+")

require_editor = auth.require_role("editor")
require_admin = auth.require_role("admin")


def _render(request: Request, name: str, **ctx) -> HTMLResponse:
    ctx.setdefault("user", auth.current_user(request))
    return templates.TemplateResponse(request, name, ctx)


def _sanitize_filename(name: str) -> str:
    base = Path(name).name
    return SAFE_NAME.sub("_", base).strip("._") or "asset"


# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------

@router.get("/login", response_class=HTMLResponse)
def login_form(request: Request):
    return _render(request, "login.html", error=None)


@router.post("/login")
def login_submit(request: Request, username: str = Form(...), password: str = Form(...)):
    with db.cursor() as cur:
        row = cur.execute(
            "SELECT id, username, password_hash, role FROM users WHERE username = ?",
            (username,),
        ).fetchone()
    if not row or not auth.verify_password(password, row["password_hash"]):
        return _render(request, "login.html", error="Invalid username or password")
    request.session["user_id"] = row["id"]
    audit.log(request, dict(row), "login")
    return RedirectResponse("/dashboard", status_code=303)


@router.post("/logout")
def logout(request: Request):
    user = auth.current_user(request)
    audit.log(request, user, "logout")
    request.session.clear()
    return RedirectResponse("/login", status_code=303)


# ---------------------------------------------------------------------------
# Dashboard
# ---------------------------------------------------------------------------

@router.get("/dashboard", response_class=HTMLResponse)
def dashboard(request: Request, user=Depends(auth.require_user)):
    with db.cursor() as cur:
        media_stats = cur.execute(
            "SELECT COUNT(*) AS n, COALESCE(SUM(size_bytes), 0) AS bytes FROM media"
        ).fetchone()
        playlists_n = cur.execute("SELECT COUNT(*) AS n FROM playlists").fetchone()["n"]
        devices = cur.execute(
            """
            SELECT d.id, d.device_id, d.name, d.last_seen_at, d.last_ip,
                   d.current_position, d.current_filename, d.player_status,
                   d.last_screenshot_at,
                   p.name AS playlist_name, g.name AS group_name
            FROM devices d
            LEFT JOIN playlists p ON p.id = d.playlist_id
            LEFT JOIN device_groups g ON g.id = d.group_id
            ORDER BY d.name
            """
        ).fetchall()
    return _render(
        request,
        "dashboard.html",
        media_count=media_stats["n"],
        media_bytes=media_stats["bytes"],
        playlist_count=playlists_n,
        devices=[dict(d) for d in devices],
    )


# ---------------------------------------------------------------------------
# Library
# ---------------------------------------------------------------------------

@router.get("/library", response_class=HTMLResponse)
def library_page(request: Request, user=Depends(auth.require_user)):
    with db.cursor() as cur:
        rows = cur.execute(
            "SELECT id, original_name, filename, media_type, size_bytes, duration_seconds, "
            "       width, height, codec, uploaded_at "
            "FROM media ORDER BY uploaded_at DESC"
        ).fetchall()
    return _render(request, "library.html", items=[dict(r) for r in rows], max_bytes=config.MAX_UPLOAD_BYTES)


@router.post("/library/upload")
async def library_upload(request: Request, file: UploadFile = File(...), user=Depends(require_editor)):
    ext = Path(file.filename or "").suffix.lower()
    media_type = config.media_type_for_ext(ext)
    if media_type is None:
        raise HTTPException(400, f"Unsupported extension {ext}. Allowed: {sorted(config.ALLOWED_EXTENSIONS)}")

    config.ensure_dirs()
    fd, tmp_path_str = tempfile.mkstemp(dir=str(config.MEDIA_DIR), prefix=".upload_", suffix=".tmp")
    os.close(fd)
    tmp_path = Path(tmp_path_str)

    hasher = hashlib.sha256()
    size = 0
    try:
        async with aiofiles.open(tmp_path, "wb") as out:
            while True:
                chunk = await file.read(1024 * 1024)
                if not chunk:
                    break
                size += len(chunk)
                if size > config.MAX_UPLOAD_BYTES:
                    raise HTTPException(413, f"File exceeds {config.MAX_UPLOAD_BYTES} bytes")
                hasher.update(chunk)
                await out.write(chunk)
        sha = hasher.hexdigest()

        with db.cursor() as cur:
            existing = cur.execute("SELECT id, original_name FROM media WHERE sha256 = ?", (sha,)).fetchone()
            if existing:
                raise HTTPException(409, f"Duplicate of '{existing['original_name']}' (sha256 match)")

        probe_data = {"duration_seconds": None, "width": None, "height": None, "codec": None}
        if ffprobe.have_ffprobe():
            try:
                probe_data = ffprobe.probe(tmp_path)
            except Exception as e:
                log.warning("ffprobe failed for %s: %s", file.filename, e)

        safe_orig = _sanitize_filename(file.filename or "asset")
        final_name = f"{sha[:16]}_{safe_orig}"
        if Path(final_name).suffix.lower() != ext:
            final_name = f"{sha[:16]}_{safe_orig}{ext}"
        final_path = config.MEDIA_DIR / final_name
        tmp_path.replace(final_path)

        with db.cursor() as cur:
            cur.execute(
                """INSERT INTO media (filename, original_name, media_type, size_bytes,
                                       duration_seconds, width, height, codec, sha256)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    final_name,
                    file.filename or final_name,
                    media_type,
                    size,
                    probe_data["duration_seconds"] if media_type == "video" else None,
                    probe_data["width"],
                    probe_data["height"],
                    probe_data["codec"],
                    sha,
                ),
            )
            new_id = cur.lastrowid
        audit.log(request, user, "upload_media", "media", new_id, {"filename": file.filename, "type": media_type})
    except HTTPException:
        tmp_path.unlink(missing_ok=True)
        raise
    except Exception:
        tmp_path.unlink(missing_ok=True)
        raise

    return RedirectResponse("/library", status_code=303)


@router.post("/library/{media_id}/delete")
def library_delete(media_id: int, request: Request, user=Depends(require_editor)):
    with db.cursor() as cur:
        row = cur.execute("SELECT filename, original_name FROM media WHERE id = ?", (media_id,)).fetchone()
        if not row:
            raise HTTPException(404)
        cur.execute("DELETE FROM media WHERE id = ?", (media_id,))
    path = config.MEDIA_DIR / row["filename"]
    path.unlink(missing_ok=True)
    audit.log(request, user, "delete_media", "media", media_id, {"filename": row["original_name"]})
    return RedirectResponse("/library", status_code=303)


# ---------------------------------------------------------------------------
# Playlists
# ---------------------------------------------------------------------------

@router.get("/playlists", response_class=HTMLResponse)
def playlists_page(request: Request, user=Depends(auth.require_user)):
    with db.cursor() as cur:
        rows = cur.execute(
            """
            SELECT p.id, p.name, p.updated_at,
                   (SELECT COUNT(*) FROM playlist_items pi WHERE pi.playlist_id = p.id) AS item_count,
                   (SELECT COUNT(*) FROM devices d WHERE d.playlist_id = p.id) AS device_count
            FROM playlists p ORDER BY p.name
            """
        ).fetchall()
    return _render(request, "playlists.html", playlists=[dict(r) for r in rows])


@router.post("/playlists")
def playlists_create(request: Request, name: str = Form(...), user=Depends(require_editor)):
    name = name.strip()
    if not name:
        raise HTTPException(400, "Name required")
    with db.cursor() as cur:
        try:
            cur.execute("INSERT INTO playlists (name) VALUES (?)", (name,))
            pid = cur.lastrowid
        except Exception as e:
            raise HTTPException(409, f"Playlist name already in use: {e}")
    audit.log(request, user, "create_playlist", "playlist", pid, {"name": name})
    return RedirectResponse(f"/playlists/{pid}", status_code=303)


@router.get("/playlists/{playlist_id}", response_class=HTMLResponse)
def playlists_edit(playlist_id: int, request: Request, user=Depends(auth.require_user)):
    with db.cursor() as cur:
        playlist = cur.execute("SELECT id, name FROM playlists WHERE id = ?", (playlist_id,)).fetchone()
        if not playlist:
            raise HTTPException(404)
        items = cur.execute(
            """SELECT pi.id, pi.position, pi.duration_override_seconds,
                      m.id AS media_id, m.original_name, m.media_type,
                      m.duration_seconds, m.filename
               FROM playlist_items pi
               JOIN media m ON m.id = pi.media_id
               WHERE pi.playlist_id = ?
               ORDER BY pi.position""",
            (playlist_id,),
        ).fetchall()
        available = cur.execute(
            """SELECT m.id, m.original_name, m.media_type, m.duration_seconds
               FROM media m
               WHERE m.id NOT IN (SELECT media_id FROM playlist_items WHERE playlist_id = ?)
               ORDER BY m.original_name""",
            (playlist_id,),
        ).fetchall()
    return _render(
        request, "playlist_edit.html",
        playlist=dict(playlist),
        items=[dict(i) for i in items],
        available=[dict(a) for a in available],
    )


@router.post("/playlists/{playlist_id}/items")
def playlist_add_item(playlist_id: int, request: Request, media_id: int = Form(...), user=Depends(require_editor)):
    with db.cursor() as cur:
        if not cur.execute("SELECT id FROM playlists WHERE id = ?", (playlist_id,)).fetchone():
            raise HTTPException(404, "Playlist not found")
        if not cur.execute("SELECT id FROM media WHERE id = ?", (media_id,)).fetchone():
            raise HTTPException(404, "Media not found")
        if cur.execute(
            "SELECT id FROM playlist_items WHERE playlist_id = ? AND media_id = ?",
            (playlist_id, media_id),
        ).fetchone():
            raise HTTPException(409, "Already in playlist")
        max_pos = cur.execute(
            "SELECT COALESCE(MAX(position), -1) AS m FROM playlist_items WHERE playlist_id = ?",
            (playlist_id,),
        ).fetchone()["m"]
        cur.execute(
            "INSERT INTO playlist_items (playlist_id, media_id, position) VALUES (?, ?, ?)",
            (playlist_id, media_id, max_pos + 1),
        )
        cur.execute("UPDATE playlists SET updated_at = datetime('now') WHERE id = ?", (playlist_id,))
    audit.log(request, user, "playlist_add_item", "playlist", playlist_id, {"media_id": media_id})
    return RedirectResponse(f"/playlists/{playlist_id}", status_code=303)


@router.post("/playlists/{playlist_id}/items/{item_id}/duration")
def playlist_set_duration(
    playlist_id: int, item_id: int, request: Request,
    duration: str = Form(""), user=Depends(require_editor),
):
    dur: float | None = None
    if duration.strip():
        try:
            dur = float(duration.strip())
            if dur <= 0:
                raise ValueError("must be positive")
        except ValueError:
            raise HTTPException(400, "duration must be a positive number")
    with db.cursor() as cur:
        cur.execute(
            "UPDATE playlist_items SET duration_override_seconds = ? "
            "WHERE id = ? AND playlist_id = ?",
            (dur, item_id, playlist_id),
        )
        cur.execute("UPDATE playlists SET updated_at = datetime('now') WHERE id = ?", (playlist_id,))
    audit.log(request, user, "playlist_set_duration", "playlist_item", item_id, {"duration": dur})
    return RedirectResponse(f"/playlists/{playlist_id}", status_code=303)


@router.post("/playlists/{playlist_id}/items/reorder")
async def playlist_reorder(playlist_id: int, request: Request, user=Depends(require_editor)):
    body = await request.json()
    order = body.get("order")
    if not isinstance(order, list):
        raise HTTPException(400, "body must be {order: [item_id, ...]}")
    try:
        ids = [int(x) for x in order]
    except (TypeError, ValueError):
        raise HTTPException(400, "order must be a list of integers")

    with db.cursor() as cur:
        existing = {
            r["id"] for r in cur.execute(
                "SELECT id FROM playlist_items WHERE playlist_id = ?", (playlist_id,)
            ).fetchall()
        }
        if set(ids) != existing:
            raise HTTPException(400, "order must contain exactly the current items of this playlist")
        for item_id in ids:
            cur.execute(
                "UPDATE playlist_items SET position = position + 10000 WHERE id = ? AND playlist_id = ?",
                (item_id, playlist_id),
            )
        for pos, item_id in enumerate(ids):
            cur.execute(
                "UPDATE playlist_items SET position = ? WHERE id = ? AND playlist_id = ?",
                (pos, item_id, playlist_id),
            )
        cur.execute("UPDATE playlists SET updated_at = datetime('now') WHERE id = ?", (playlist_id,))
    audit.log(request, user, "playlist_reorder", "playlist", playlist_id, {"order": ids})
    return JSONResponse({"ok": True})


@router.post("/playlists/{playlist_id}/items/{item_id}/delete")
def playlist_remove_item(playlist_id: int, item_id: int, request: Request, user=Depends(require_editor)):
    with db.cursor() as cur:
        cur.execute("DELETE FROM playlist_items WHERE id = ? AND playlist_id = ?", (item_id, playlist_id))
        cur.execute("UPDATE playlists SET updated_at = datetime('now') WHERE id = ?", (playlist_id,))
    audit.log(request, user, "playlist_remove_item", "playlist_item", item_id)
    return RedirectResponse(f"/playlists/{playlist_id}", status_code=303)


@router.post("/playlists/{playlist_id}/rename")
def playlist_rename(playlist_id: int, request: Request, name: str = Form(...), user=Depends(require_editor)):
    name = name.strip()
    if not name:
        raise HTTPException(400, "Name required")
    with db.cursor() as cur:
        cur.execute("UPDATE playlists SET name = ?, updated_at = datetime('now') WHERE id = ?", (name, playlist_id))
    audit.log(request, user, "playlist_rename", "playlist", playlist_id, {"name": name})
    return RedirectResponse(f"/playlists/{playlist_id}", status_code=303)


@router.post("/playlists/{playlist_id}/delete")
def playlist_delete(playlist_id: int, request: Request, user=Depends(require_editor)):
    with db.cursor() as cur:
        cur.execute("DELETE FROM playlists WHERE id = ?", (playlist_id,))
    audit.log(request, user, "playlist_delete", "playlist", playlist_id)
    return RedirectResponse("/playlists", status_code=303)


# ---------------------------------------------------------------------------
# Devices
# ---------------------------------------------------------------------------

@router.get("/devices", response_class=HTMLResponse)
def devices_page(request: Request, user=Depends(auth.require_user)):
    now = dt.datetime.now()
    with db.cursor() as cur:
        devices = cur.execute(
            """SELECT d.id, d.device_id, d.name, d.token, d.last_seen_at, d.last_ip,
                      d.player_version, d.current_position, d.current_filename, d.player_status,
                      d.last_screenshot_at,
                      p.id AS playlist_id, p.name AS playlist_name,
                      g.id AS group_id, g.name AS group_name
               FROM devices d
               LEFT JOIN playlists p ON p.id = d.playlist_id
               LEFT JOIN device_groups g ON g.id = d.group_id
               ORDER BY d.name"""
        ).fetchall()
        playlists = cur.execute("SELECT id, name FROM playlists ORDER BY name").fetchall()
        groups = cur.execute("SELECT id, name FROM device_groups ORDER BY name").fetchall()

        device_list = []
        for d in devices:
            dd = dict(d)
            sched_rows = cur.execute(
                """SELECT id, playlist_id, name, priority, start_time, end_time,
                          days_of_week, start_date, end_date
                   FROM device_schedules WHERE device_id = ?""",
                (dd["id"],),
            ).fetchall()
            active = schedules.pick_active([dict(s) for s in sched_rows], now)
            if active:
                pl = cur.execute("SELECT name FROM playlists WHERE id = ?", (active["playlist_id"],)).fetchone()
                dd["active_playlist_name"] = pl["name"] if pl else None
                dd["active_source"] = f"schedule: {active['name']}"
            elif dd["playlist_name"]:
                dd["active_playlist_name"] = dd["playlist_name"]
                dd["active_source"] = "device default"
            elif dd["group_name"]:
                grow = cur.execute("SELECT name FROM playlists WHERE id = (SELECT playlist_id FROM device_groups WHERE id = ?)", (dd["group_id"],)).fetchone()
                dd["active_playlist_name"] = grow["name"] if grow else None
                dd["active_source"] = f"group: {dd['group_name']}"
            else:
                dd["active_playlist_name"] = None
                dd["active_source"] = None
            dd["schedule_count"] = len(sched_rows)
            device_list.append(dd)

    return _render(
        request, "devices.html",
        devices=device_list,
        playlists=[dict(p) for p in playlists],
        groups=[dict(g) for g in groups],
        public_base_url=config.PUBLIC_BASE_URL,
    )


@router.post("/devices")
def devices_create(
    request: Request, device_id: str = Form(...), name: str = Form(...),
    user=Depends(require_editor),
):
    device_id = device_id.strip().lower()
    name = name.strip()
    if not re.match(r"^[a-z0-9][a-z0-9-]{0,62}$", device_id):
        raise HTTPException(400, "device_id must be lowercase alphanumeric + hyphens, 1-63 chars")
    if not name:
        raise HTTPException(400, "name required")
    token = db.new_token()
    with db.cursor() as cur:
        try:
            cur.execute("INSERT INTO devices (device_id, name, token) VALUES (?, ?, ?)", (device_id, name, token))
            new_id = cur.lastrowid
        except Exception as e:
            raise HTTPException(409, f"device_id already in use: {e}")
    audit.log(request, user, "register_device", "device", new_id, {"device_id": device_id, "name": name})
    return RedirectResponse("/devices", status_code=303)


@router.post("/devices/{device_id}/assign")
def devices_assign(device_id: int, request: Request, playlist_id: str = Form(""), user=Depends(require_editor)):
    pid = int(playlist_id) if playlist_id else None
    with db.cursor() as cur:
        cur.execute("UPDATE devices SET playlist_id = ? WHERE id = ?", (pid, device_id))
    audit.log(request, user, "device_assign_playlist", "device", device_id, {"playlist_id": pid})
    return RedirectResponse("/devices", status_code=303)


@router.post("/devices/{device_id}/group")
def devices_set_group(device_id: int, request: Request, group_id: str = Form(""), user=Depends(require_editor)):
    gid = int(group_id) if group_id else None
    with db.cursor() as cur:
        cur.execute("UPDATE devices SET group_id = ? WHERE id = ?", (gid, device_id))
    audit.log(request, user, "device_set_group", "device", device_id, {"group_id": gid})
    return RedirectResponse("/devices", status_code=303)


@router.post("/devices/{device_id}/regen-token")
def devices_regen_token(device_id: int, request: Request, user=Depends(require_editor)):
    token = db.new_token()
    with db.cursor() as cur:
        cur.execute("UPDATE devices SET token = ? WHERE id = ?", (token, device_id))
    audit.log(request, user, "device_regen_token", "device", device_id)
    return RedirectResponse("/devices", status_code=303)


@router.post("/devices/{device_id}/delete")
def devices_delete(device_id: int, request: Request, user=Depends(require_editor)):
    with db.cursor() as cur:
        cur.execute("DELETE FROM devices WHERE id = ?", (device_id,))
    audit.log(request, user, "device_delete", "device", device_id)
    return RedirectResponse("/devices", status_code=303)


@router.post("/devices/{device_id}/command")
def devices_send_command(
    device_id: int, request: Request, command: str = Form(...), user=Depends(require_editor),
):
    if command not in ("reboot", "force-sync", "restart-mpv"):
        raise HTTPException(400, "unknown command")
    with db.cursor() as cur:
        cur.execute(
            "INSERT INTO device_commands (device_id, command, issued_by) VALUES (?, ?, ?)",
            (device_id, command, user["id"]),
        )
        new_id = cur.lastrowid
    audit.log(request, user, "device_send_command", "device", device_id, {"command": command, "command_id": new_id})
    return RedirectResponse("/devices", status_code=303)


@router.get("/devices/{device_id}/screenshot")
def devices_screenshot(device_id: int, request: Request, user=Depends(auth.require_user)):
    with db.cursor() as cur:
        row = cur.execute("SELECT device_id FROM devices WHERE id = ?", (device_id,)).fetchone()
        if not row:
            raise HTTPException(404)
    path = config.SCREENSHOT_DIR / f"{row['device_id']}.jpg"
    if not path.is_file():
        raise HTTPException(404, "no screenshot yet")
    return FileResponse(path, headers={"Cache-Control": "no-store"})


# ---------------------------------------------------------------------------
# Device schedules
# ---------------------------------------------------------------------------

@router.get("/devices/{device_id}/schedule", response_class=HTMLResponse)
def device_schedule_page(device_id: int, request: Request, user=Depends(auth.require_user)):
    with db.cursor() as cur:
        device = cur.execute("SELECT id, device_id, name, playlist_id FROM devices WHERE id = ?", (device_id,)).fetchone()
        if not device:
            raise HTTPException(404)
        rules = cur.execute(
            """SELECT s.id, s.playlist_id, s.name, s.priority, s.start_time, s.end_time,
                      s.days_of_week, s.start_date, s.end_date,
                      p.name AS playlist_name
               FROM device_schedules s
               LEFT JOIN playlists p ON p.id = s.playlist_id
               WHERE s.device_id = ?
               ORDER BY s.priority DESC, s.id""",
            (device_id,),
        ).fetchall()
        playlists = cur.execute("SELECT id, name FROM playlists ORDER BY name").fetchall()
    now = dt.datetime.now()
    rule_list = []
    for r in rules:
        rd = dict(r)
        rd["summary"] = schedules.describe(rd)
        rd["matches_now"] = schedules.schedule_matches(rd, now)
        rule_list.append(rd)
    return _render(
        request, "device_schedule.html",
        device=dict(device),
        rules=rule_list,
        playlists=[dict(p) for p in playlists],
        now=now.isoformat(timespec="seconds"),
    )


@router.post("/devices/{device_id}/schedule")
def device_schedule_create(
    device_id: int, request: Request,
    name: str = Form(...),
    playlist_id: int = Form(...),
    priority: int = Form(0),
    start_time: str = Form(""),
    end_time: str = Form(""),
    days_of_week: str = Form(""),
    start_date: str = Form(""),
    end_date: str = Form(""),
    user=Depends(require_editor),
):
    name = name.strip() or "Rule"
    start_time = start_time.strip() or None
    end_time = end_time.strip() or None
    days_of_week = "".join(sorted(set(c for c in days_of_week if c in "0123456"))) or None
    start_date = start_date.strip() or None
    end_date = end_date.strip() or None
    with db.cursor() as cur:
        cur.execute(
            """INSERT INTO device_schedules
                  (device_id, playlist_id, name, priority,
                   start_time, end_time, days_of_week, start_date, end_date)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (device_id, playlist_id, name, priority, start_time, end_time, days_of_week, start_date, end_date),
        )
        new_id = cur.lastrowid
    audit.log(
        request, user, "device_schedule_create", "device_schedule", new_id,
        {"device_id": device_id, "name": name, "playlist_id": playlist_id},
    )
    return RedirectResponse(f"/devices/{device_id}/schedule", status_code=303)


@router.post("/devices/{device_id}/schedule/{schedule_id}/delete")
def device_schedule_delete(device_id: int, schedule_id: int, request: Request, user=Depends(require_editor)):
    with db.cursor() as cur:
        cur.execute("DELETE FROM device_schedules WHERE id = ? AND device_id = ?", (schedule_id, device_id))
    audit.log(request, user, "device_schedule_delete", "device_schedule", schedule_id)
    return RedirectResponse(f"/devices/{device_id}/schedule", status_code=303)


# ---------------------------------------------------------------------------
# Device groups
# ---------------------------------------------------------------------------

@router.get("/groups", response_class=HTMLResponse)
def groups_page(request: Request, user=Depends(auth.require_user)):
    with db.cursor() as cur:
        groups = cur.execute(
            """SELECT g.id, g.name,
                      g.playlist_id, p.name AS playlist_name,
                      (SELECT COUNT(*) FROM devices d WHERE d.group_id = g.id) AS device_count
               FROM device_groups g
               LEFT JOIN playlists p ON p.id = g.playlist_id
               ORDER BY g.name"""
        ).fetchall()
        playlists = cur.execute("SELECT id, name FROM playlists ORDER BY name").fetchall()
    return _render(
        request, "groups.html",
        groups=[dict(g) for g in groups],
        playlists=[dict(p) for p in playlists],
    )


@router.post("/groups")
def groups_create(request: Request, name: str = Form(...), user=Depends(require_editor)):
    name = name.strip()
    if not name:
        raise HTTPException(400, "Name required")
    with db.cursor() as cur:
        try:
            cur.execute("INSERT INTO device_groups (name) VALUES (?)", (name,))
            new_id = cur.lastrowid
        except Exception as e:
            raise HTTPException(409, f"Group name already in use: {e}")
    audit.log(request, user, "group_create", "group", new_id, {"name": name})
    return RedirectResponse("/groups", status_code=303)


@router.post("/groups/{group_id}/assign")
def groups_assign_playlist(group_id: int, request: Request, playlist_id: str = Form(""), user=Depends(require_editor)):
    pid = int(playlist_id) if playlist_id else None
    with db.cursor() as cur:
        cur.execute("UPDATE device_groups SET playlist_id = ? WHERE id = ?", (pid, group_id))
    audit.log(request, user, "group_assign_playlist", "group", group_id, {"playlist_id": pid})
    return RedirectResponse("/groups", status_code=303)


@router.post("/groups/{group_id}/delete")
def groups_delete(group_id: int, request: Request, user=Depends(require_editor)):
    with db.cursor() as cur:
        cur.execute("DELETE FROM device_groups WHERE id = ?", (group_id,))
    audit.log(request, user, "group_delete", "group", group_id)
    return RedirectResponse("/groups", status_code=303)


# ---------------------------------------------------------------------------
# Audit log
# ---------------------------------------------------------------------------

@router.get("/audit", response_class=HTMLResponse)
def audit_page(request: Request, user=Depends(auth.require_user), limit: int = Query(200, ge=1, le=1000)):
    with db.cursor() as cur:
        rows = cur.execute(
            """SELECT id, user_id, username, action, target_type, target_id, details, ip, created_at
               FROM audit_log ORDER BY created_at DESC LIMIT ?""",
            (limit,),
        ).fetchall()
    return _render(request, "audit.html", entries=[dict(r) for r in rows], limit=limit)


# ---------------------------------------------------------------------------
# Users (admin-only)
# ---------------------------------------------------------------------------

@router.get("/users", response_class=HTMLResponse)
def users_page(request: Request, user=Depends(require_admin)):
    with db.cursor() as cur:
        rows = cur.execute("SELECT id, username, role, created_at FROM users ORDER BY username").fetchall()
    return _render(request, "users.html", users=[dict(r) for r in rows])


@router.post("/users")
def users_create(
    request: Request, username: str = Form(...), password: str = Form(...), role: str = Form("editor"),
    user=Depends(require_admin),
):
    username = username.strip()
    if not username or len(password) < 6:
        raise HTTPException(400, "username required and password must be at least 6 chars")
    if role not in ("admin", "editor", "viewer"):
        raise HTTPException(400, "role must be admin, editor, or viewer")
    with db.cursor() as cur:
        try:
            cur.execute(
                "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)",
                (username, auth.hash_password(password), role),
            )
            new_id = cur.lastrowid
        except Exception as e:
            raise HTTPException(409, f"username already in use: {e}")
    audit.log(request, user, "user_create", "user", new_id, {"username": username, "role": role})
    return RedirectResponse("/users", status_code=303)


@router.post("/users/{user_id}/role")
def users_set_role(user_id: int, request: Request, role: str = Form(...), user=Depends(require_admin)):
    if role not in ("admin", "editor", "viewer"):
        raise HTTPException(400, "invalid role")
    if user_id == user["id"] and role != "admin":
        raise HTTPException(400, "cannot demote yourself")
    with db.cursor() as cur:
        cur.execute("UPDATE users SET role = ? WHERE id = ?", (role, user_id))
    audit.log(request, user, "user_set_role", "user", user_id, {"role": role})
    return RedirectResponse("/users", status_code=303)


@router.post("/users/{user_id}/password")
def users_set_password(user_id: int, request: Request, password: str = Form(...), user=Depends(require_admin)):
    if len(password) < 6:
        raise HTTPException(400, "password must be at least 6 chars")
    with db.cursor() as cur:
        cur.execute("UPDATE users SET password_hash = ? WHERE id = ?", (auth.hash_password(password), user_id))
    audit.log(request, user, "user_set_password", "user", user_id)
    return RedirectResponse("/users", status_code=303)


@router.post("/users/{user_id}/delete")
def users_delete(user_id: int, request: Request, user=Depends(require_admin)):
    if user_id == user["id"]:
        raise HTTPException(400, "cannot delete yourself")
    with db.cursor() as cur:
        n = cur.execute("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").fetchone()["n"]
        target_role = cur.execute("SELECT role FROM users WHERE id = ?", (user_id,)).fetchone()
        if target_role and target_role["role"] == "admin" and n <= 1:
            raise HTTPException(400, "cannot delete the last admin")
        cur.execute("DELETE FROM users WHERE id = ?", (user_id,))
    audit.log(request, user, "user_delete", "user", user_id)
    return RedirectResponse("/users", status_code=303)
