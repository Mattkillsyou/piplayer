import datetime as dt
import hashlib
import json
import logging
import math
import os
import re
import sqlite3
import tempfile
from pathlib import Path
from urllib.parse import urlsplit

from fastapi import APIRouter, Depends, Form, HTTPException, Query, Request
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, RedirectResponse
from fastapi.templating import Jinja2Templates
from python_multipart.multipart import MultipartParser, parse_options_header
from starlette.concurrency import run_in_threadpool

from .. import audit, auth, config, db, ffprobe, schedules
from .api import DEVICE_ID_RE, DEVICE_ID_RULE, resolve_active_playlist_id


log = logging.getLogger("piplayer.web")
# Every POST under this router must carry the CSRF token (require_csrf skips GET/HEAD).
router = APIRouter(dependencies=[Depends(auth.require_csrf)])

TEMPLATES_DIR = Path(__file__).parent.parent / "templates"

SAFE_NAME = re.compile(r"[^A-Za-z0-9._-]+")
MAX_FILENAME_LEN = 120
UPLOAD_TMP_MAX_AGE_SECONDS = 60 * 60

require_editor = auth.require_role("editor")
require_admin = auth.require_role("admin")

# A device that has not polled for this long is shown as offline (the player
# polls every 30 s by default and backs off to at most 300 s when the CMS is
# unreachable, in which case it cannot reach us anyway).
OFFLINE_AFTER_SECONDS = 180
LAMP_STATES = ("playing", "paused", "idle", "mpv-down")
MAX_CAMERA_URL_LEN = 2048
DASHBOARD_AUDIT_TAIL = 8


def _template_context(request: Request) -> dict:
    return {"csrf_token": auth.csrf_token(request)}


def parse_db_utc(value) -> dt.datetime | None:
    """Parse a SQLite datetime('now') string (UTC, 'YYYY-MM-DD HH:MM:SS') into an aware datetime."""
    if not value:
        return None
    if isinstance(value, dt.datetime):
        return value if value.tzinfo else value.replace(tzinfo=dt.timezone.utc)
    s = str(value).strip().replace("T", " ")
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M:%S.%f", "%Y-%m-%d %H:%M"):
        try:
            return dt.datetime.strptime(s, fmt).replace(tzinfo=dt.timezone.utc)
        except ValueError:
            continue
    return None


def local_filter(value) -> str:
    """Jinja filter: render a UTC DB timestamp in the controller's local zone, e.g. '2026-09-14 15:03 PDT'."""
    parsed = parse_db_utc(value)
    if parsed is None:
        return str(value) if value else ""
    return parsed.astimezone().strftime("%Y-%m-%d %H:%M %Z")


def age_text(seconds: float | None) -> str:
    if seconds is None:
        return "never"
    seconds = max(0, int(seconds))
    if seconds < 60:
        return f"{seconds} s ago"
    if seconds < 3600:
        return f"{seconds // 60} min ago"
    if seconds < 86400:
        return f"{seconds // 3600} h ago"
    return f"{seconds // 86400} d ago"


def local_zone_name() -> str:
    now = dt.datetime.now().astimezone()
    return now.strftime("%Z") or str(now.tzinfo)


templates = Jinja2Templates(directory=str(TEMPLATES_DIR), context_processors=[_template_context])
templates.env.globals["app_name"] = "Projection5000"
templates.env.globals["app_eyebrow"] = "Matt Brown's"
templates.env.globals["default_image_duration"] = config.DEFAULT_IMAGE_DURATION
templates.env.filters["local"] = local_filter


def _render(request: Request, name: str, status_code: int = 200, **ctx) -> HTMLResponse:
    ctx.setdefault("user", auth.current_user(request))
    return templates.TemplateResponse(request, name, ctx, status_code=status_code)


def _sanitize_filename(name: str) -> str:
    base = Path(name).name
    return SAFE_NAME.sub("_", base).strip("._") or "asset"


def _final_media_name(sha: str, original: str, ext: str) -> str:
    """'<sha16>_<sanitized original><ext>', truncated so the whole name is <= MAX_FILENAME_LEN."""
    safe = _sanitize_filename(original or "asset")
    stem = safe[: -len(ext)] if ext and safe.lower().endswith(ext) else safe
    budget = MAX_FILENAME_LEN - 17 - len(ext)
    stem = stem[:budget].strip("._") or "asset"
    return f"{sha[:16]}_{stem}{ext}"


def _form_int(value: str, field: str) -> int | None:
    """Optional integer form field: '' -> None, non-integer -> 400."""
    value = (value or "").strip()
    if not value:
        return None
    try:
        return int(value)
    except ValueError:
        raise HTTPException(400, f"{field} must be an integer")


def _client_ip(request: Request) -> str | None:
    return request.client.host if request.client else None


# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------

@router.get("/login", response_class=HTMLResponse)
def login_form(request: Request, expired: str = Query("")):
    error = "Your session expired; please sign in again" if expired else None
    return _render(request, "login.html", error=error)


@router.post("/login")
def login_submit(request: Request, username: str = Form(...), password: str = Form(...)):
    username = username.strip()
    ip = _client_ip(request)
    wait = auth.login_locked_for(ip, username)
    if wait:
        return _render(request, "login.html", status_code=429, locked=True,
                       error=f"Too many failed attempts; try again in {wait} s")
    if len(password.encode("utf-8")) > auth.MAX_PASSWORD_BYTES:
        return _render(request, "login.html", status_code=400, error=auth.PASSWORD_TOO_LONG_MSG)
    with db.cursor() as cur:
        row = cur.execute(
            "SELECT id, username, password_hash, role FROM users WHERE username = ?",
            (username,),
        ).fetchone()
    if not row:
        auth.burn_password_check(password)
    if not row or not auth.verify_password(password, row["password_hash"]):
        # Collapse anything outside printable ASCII (whitespace, control chars, newlines) so an
        # attacker-chosen username cannot plant a fake "ip=" token; the real ip= stays last.
        safe_user = re.sub(r"[^!-~]+", "_", username)[:64]
        log.warning("login failed for user=%s ip=%s", safe_user, ip)
        audit.log(request, None, "login_failed", "user", None, {"username": username})
        auth.record_login_failure(ip, username)
        return _render(request, "login.html", error="Invalid username or password")
    auth.clear_login_failures(ip, username)
    request.session.clear()  # drop the pre-login session (and its CSRF token): no fixation
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

def https_url_or_none(value) -> str | None:
    """The value as an absolute https URL, or None when empty / not one (camera_live_url)."""
    v = (value or "").strip()
    if not v or len(v) > MAX_CAMERA_URL_LEN or any(c.isspace() or ord(c) < 32 for c in v):
        return None
    try:
        parts = urlsplit(v)
    except ValueError:
        return None
    if parts.scheme != "https" or not parts.hostname:
        return None
    return v


def _decorate_device(cur, dd: dict, now: dt.datetime) -> dict:
    """Fill in the served playlist (schedule/default/group) and screenshot age for a device row."""
    pid, source = resolve_active_playlist_id(dd, now, cur)
    dd["active_playlist_id"] = pid
    dd["active_playlist_name"] = None
    dd["active_source"] = None
    if pid:
        pl = cur.execute("SELECT name FROM playlists WHERE id = ?", (pid,)).fetchone()
        dd["active_playlist_name"] = pl["name"] if pl else None
        if source.startswith("schedule:"):
            dd["active_source"] = "schedule: " + source[len("schedule:"):]
        elif source == "group-default":
            dd["active_source"] = f"group: {dd.get('group_name') or ''}"
        else:
            dd["active_source"] = "device default"
    shot = parse_db_utc(dd.get("last_screenshot_at"))
    if shot:
        age = (dt.datetime.now(dt.timezone.utc) - shot).total_seconds()
        dd["screenshot_age"] = age_text(age)
        dd["screenshot_stale"] = age > 3 * config.SCREENSHOT_INTERVAL_SECONDS
    else:
        dd["screenshot_age"] = None
        dd["screenshot_stale"] = False
    cam = parse_db_utc(dd.get("last_camera_at"))
    if cam:
        age = (dt.datetime.now(dt.timezone.utc) - cam).total_seconds()
        dd["camera_age"] = age_text(age)
        dd["camera_stale"] = age > 3 * config.CAMERA_INTERVAL_SECONDS
    else:
        dd["camera_age"] = None
        dd["camera_stale"] = False
    # Only a URL that still passes validation reaches the template (the iframe src).
    dd["camera_live_url"] = https_url_or_none(dd.get("camera_live_url"))
    seen = parse_db_utc(dd.get("last_seen_at"))
    seen_seconds = (dt.datetime.now(dt.timezone.utc) - seen).total_seconds() if seen else None
    dd["seen_age"] = age_text(seen_seconds) if seen else None
    dd["offline"] = seen_seconds is None or seen_seconds > OFFLINE_AFTER_SECONDS
    # what the status lamp shows: offline beats whatever the player last reported;
    # the value becomes a CSS class, so anything unknown from the device reads as idle
    reported = dd.get("player_status") or "idle"
    dd["lamp"] = "offline" if dd["offline"] else (reported if reported in LAMP_STATES else "idle")
    return dd


@router.get("/dashboard", response_class=HTMLResponse)
def dashboard(request: Request, user=Depends(auth.require_user)):
    now = dt.datetime.now()
    with db.cursor() as cur:
        media_stats = cur.execute(
            "SELECT COUNT(*) AS n, COALESCE(SUM(size_bytes), 0) AS bytes FROM media"
        ).fetchone()
        playlists_n = cur.execute("SELECT COUNT(*) AS n FROM playlists").fetchone()["n"]
        devices = cur.execute(
            """
            SELECT d.id, d.device_id, d.name, d.last_seen_at, d.last_ip, d.playlist_id, d.group_id,
                   d.current_position, d.current_filename, d.player_status,
                   d.last_screenshot_at, d.last_error,
                   d.last_camera_at, d.camera_error, d.camera_live_url,
                   p.name AS playlist_name, g.name AS group_name
            FROM devices d
            LEFT JOIN playlists p ON p.id = d.playlist_id
            LEFT JOIN device_groups g ON g.id = d.group_id
            ORDER BY d.name
            """
        ).fetchall()
        device_list = [_decorate_device(cur, dict(d), now) for d in devices]
        audit_tail = cur.execute(
            """SELECT username, action, target_type, target_id, ip, created_at
               FROM audit_log ORDER BY created_at DESC, id DESC LIMIT ?""",
            (DASHBOARD_AUDIT_TAIL,),
        ).fetchall()
    return _render(
        request,
        "dashboard.html",
        media_count=media_stats["n"],
        media_bytes=media_stats["bytes"],
        playlist_count=playlists_n,
        devices=device_list,
        audit_tail=[dict(r) for r in audit_tail],
        server_now=dt.datetime.now().astimezone().strftime("%Y-%m-%d %H:%M:%S"),
        zone=local_zone_name(),
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
            "FROM media ORDER BY uploaded_at DESC, id DESC"
        ).fetchall()
    return _render(request, "library.html", items=[dict(r) for r in rows], max_bytes=config.MAX_UPLOAD_BYTES)


def sweep_upload_tmp(max_age_seconds: int = UPLOAD_TMP_MAX_AGE_SECONDS) -> int:
    """Remove .upload_*.tmp files (media and screenshot dirs) older than max_age_seconds.

    A process killed mid-upload leaves one behind; nothing else ever cleans them up.
    Called at startup and before every upload."""
    removed = 0
    cutoff = dt.datetime.now().timestamp() - max_age_seconds
    for directory in (config.MEDIA_DIR, config.SCREENSHOT_DIR):
        try:
            entries = list(directory.glob(".upload_*.tmp"))
        except OSError:
            continue
        for p in entries:
            try:
                if p.stat().st_mtime < cutoff:
                    p.unlink()
                    removed += 1
            except OSError:
                pass
    if removed:
        log.info("removed %d stale upload temp file(s)", removed)
    return removed


class _UploadReceiver:
    """Callbacks for python-multipart's streaming parser: text fields are kept (small),
    the single file part is written straight to the temp file and hashed as it arrives."""

    MAX_FIELD_BYTES = 4096
    MAX_FIELDS_TOTAL_BYTES = 64 * 1024   # every non-file byte stays in RAM: bound the total ...
    MAX_PARTS = 16                       # ... and the number of parts (each costs a dict entry)
    MAX_HEADER_BYTES = 8 * 1024          # python-multipart < 0.0.27 has no header limit of its own

    def __init__(self, tmp_path: Path, max_bytes: int, allowed_extensions=None):
        self.tmp_path = tmp_path
        self.max_bytes = max_bytes
        self.allowed_extensions = allowed_extensions
        self.fields: dict[str, bytes] = {}
        self.fields_done: set[str] = set()
        self.filename: str | None = None
        self.file_seen = False
        self.ended = False
        self.parts = 0
        self.field_bytes = 0
        self.size = 0
        self.hasher = hashlib.sha256()
        self.pending: list[bytes] = []
        self.pending_len = 0
        self.error: HTTPException | None = None
        self._out = None
        self._hdr_name = b""
        self._hdr_value = b""
        self._disposition = b""
        self._name: str | None = None
        self._is_file = False

    # -- header handling --
    def on_part_begin(self):
        self._hdr_name = b""
        self._hdr_value = b""
        self._disposition = b""
        self._name = None
        self._is_file = False

    def on_header_field(self, data, start, end):
        if len(self._hdr_name) + (end - start) > self.MAX_HEADER_BYTES:
            self._fail(400, "multipart part header too large")
            return
        self._hdr_name += data[start:end]

    def on_header_value(self, data, start, end):
        if len(self._hdr_value) + (end - start) > self.MAX_HEADER_BYTES:
            self._fail(400, "multipart part header too large")
            return
        self._hdr_value += data[start:end]

    def on_header_end(self):
        if self._hdr_name.lower() == b"content-disposition":
            self._disposition = self._hdr_value
        self._hdr_name = b""
        self._hdr_value = b""

    def on_headers_finished(self):
        self.parts += 1
        if self.parts > self.MAX_PARTS:
            self._fail(400, f"too many multipart parts (max {self.MAX_PARTS})")
            return
        _, options = parse_options_header(self._disposition)
        self._name = options.get(b"name", b"").decode("utf-8", "replace")
        if b"filename" in options:
            if self.file_seen:
                self._fail(400, "only one file per upload")
                return
            self._is_file = True
            self.file_seen = True
            self.filename = options[b"filename"].decode("utf-8", "replace")
            ext = Path(self.filename).suffix.lower()
            if self.allowed_extensions is not None and ext not in self.allowed_extensions:
                # Known from the part header: reject before a single file byte is received.
                self._fail(400, f"Unsupported extension {ext}. Allowed: {sorted(self.allowed_extensions)}")
                return
            self._out = open(self.tmp_path, "wb")
        else:
            self.fields.setdefault(self._name, b"")

    # -- body handling --
    def on_part_data(self, data, start, end):
        if self.error:
            return
        chunk = data[start:end]
        if self._is_file:
            self.size += len(chunk)
            if self.size > self.max_bytes:
                self._fail(413, f"File exceeds {self.max_bytes} bytes")
                return
            self.pending.append(bytes(chunk))
            self.pending_len += len(chunk)
        else:
            self.field_bytes += len(chunk)
            if self.field_bytes > self.MAX_FIELDS_TOTAL_BYTES:
                self._fail(400, "multipart text fields too large")
                return
            cur = self.fields.get(self._name, b"")
            if len(cur) + len(chunk) <= self.MAX_FIELD_BYTES:
                self.fields[self._name] = cur + bytes(chunk)

    def on_part_end(self):
        if not self._is_file and self._name is not None:
            self.fields_done.add(self._name)

    def on_end(self):
        # Fires only on the closing "--boundary--"; a body that stops before it is incomplete.
        self.ended = True

    def _fail(self, status: int, detail: str):
        if self.error is None:
            self.error = HTTPException(status, detail)

    # -- called from the async handler between parser writes (in a worker thread) --
    def flush(self):
        if not self.pending:
            return
        data = b"".join(self.pending)
        self.pending = []
        self.pending_len = 0
        self.hasher.update(data)
        self._out.write(data)

    def close(self):
        if self._out is not None:
            self._out.close()
            self._out = None

    def field(self, name: str) -> str | None:
        raw = self.fields.get(name)
        return raw.decode("utf-8", "replace") if raw is not None else None


async def _receive_upload(request: Request, tmp_path: Path, max_bytes: int | None = None,
                          check_csrf: bool = True, allowed_extensions=None) -> _UploadReceiver:
    """Stream the multipart body into tmp_path (bytes hit disk once), enforcing max_bytes
    (MAX_UPLOAD_BYTES by default). check_csrf=False for bearer-token routes (/api/screenshots)."""
    max_bytes = config.MAX_UPLOAD_BYTES if max_bytes is None else max_bytes
    ctype = request.headers.get("content-type", "")
    media, params = parse_options_header(ctype)
    boundary = params.get(b"boundary")
    if media != b"multipart/form-data" or not boundary:
        raise HTTPException(400, "expected a multipart/form-data upload")
    length = request.headers.get("content-length")
    if length and length.isdigit() and int(length) > max_bytes + 64 * 1024:
        raise HTTPException(413, f"File exceeds {max_bytes} bytes")

    recv = _UploadReceiver(tmp_path, max_bytes, allowed_extensions)
    callbacks = {
        "on_part_begin": recv.on_part_begin,
        "on_part_data": recv.on_part_data,
        "on_part_end": recv.on_part_end,
        "on_header_field": recv.on_header_field,
        "on_header_value": recv.on_header_value,
        "on_header_end": recv.on_header_end,
        "on_headers_finished": recv.on_headers_finished,
        "on_end": recv.on_end,
    }
    try:
        parser = MultipartParser(boundary, callbacks)  # raises on an over-long boundary
    except Exception as e:
        raise HTTPException(400, f"malformed multipart body: {e}")
    csrf_checked = not check_csrf or request.headers.get("x-csrf-token") is not None
    try:
        async for chunk in request.stream():
            if chunk:
                try:
                    parser.write(chunk)
                except Exception as e:  # MultipartParseError and friends
                    raise HTTPException(400, f"malformed multipart body: {e}")
            if recv.error:
                raise recv.error
            # Reject a bad form token as soon as the field has fully arrived (the hidden
            # input precedes the file input in the form, so this is before the file body).
            if not csrf_checked and "csrf_token" in recv.fields_done:
                auth.check_csrf_value(request, recv.field("csrf_token"))
                csrf_checked = True
            if not csrf_checked and recv.file_seen:
                # The file part arrived before a valid token: do not spend disk/CPU on the body.
                raise HTTPException(403, auth.CSRF_ERROR)
            if recv.pending_len >= 1024 * 1024:
                await run_in_threadpool(recv.flush)
        try:
            parser.finalize()
        except Exception as e:
            raise HTTPException(400, f"malformed multipart body: {e}")
        if recv.error:
            raise recv.error
        await run_in_threadpool(recv.flush)
    finally:
        await run_in_threadpool(recv.close)
    if not csrf_checked:
        auth.check_csrf_value(request, recv.field("csrf_token"))
    if not recv.file_seen:
        raise HTTPException(400, "no file in upload (field 'file')")
    if not recv.ended:
        raise HTTPException(400, "incomplete upload (multipart body ended before the closing boundary)")
    return recv


def _store_upload(tmp_path: Path, recv: _UploadReceiver, media_type: str, ext: str) -> tuple[int, str]:
    """Blocking part of the upload (runs in a worker thread): dedupe, probe, rename, insert."""
    sha = recv.hasher.hexdigest()
    with db.cursor() as cur:
        existing = cur.execute("SELECT id, original_name FROM media WHERE sha256 = ?", (sha,)).fetchone()
        if existing:
            raise HTTPException(409, f"Duplicate of '{existing['original_name']}' (sha256 match)")

    probe_data = {"duration_seconds": None, "width": None, "height": None, "codec": None, "nb_frames": None}
    if ffprobe.have_ffprobe():
        try:
            probe_data = ffprobe.probe(tmp_path)
        except Exception as e:
            log.warning("ffprobe failed for %s: %s", recv.filename, e)
            kind = "video" if media_type == "video" else "an image"
            raise HTTPException(400, f"ffprobe could not read this file as {kind}")
        if probe_data.get("codec") is None or not probe_data.get("width") or not probe_data.get("height"):
            kind = "video" if media_type == "video" else "an image"
            raise HTTPException(400, f"ffprobe could not read this file as {kind} (no video stream)")
        if media_type == "video" and ffprobe.is_still_image(probe_data):
            # e.g. a PNG saved as .mp4: mpv would show it for its own image-display-duration,
            # ignoring the CMS image duration, and the row would carry no duration.
            raise HTTPException(400, "ffprobe could not read this file as video (it is a still image)")
        # An animated GIF is a short video to mpv (image-display-duration does not apply).
        if ext == ".gif" and (probe_data.get("nb_frames") or 0) > 1:
            media_type = "video"
    else:
        log.warning("ffprobe not installed; storing %s without content validation", recv.filename)

    final_name = _final_media_name(sha, recv.filename or "asset", ext)
    final_path = config.MEDIA_DIR / final_name

    # Dedupe check, row insert and the rename into place happen under one write lock so two
    # overlapping uploads of the same content cannot both pass the check; the loser blocks on
    # BEGIN IMMEDIATE, then sees the winner's row and gets a 409 (its temp file is removed by
    # the caller). The rename runs before commit: if it fails the row is rolled back and the
    # temp file is still there for the caller to clean up. Never unlink final_path here -- once
    # a row can reference it, deleting it would break the winner's upload.
    try:
        with db.cursor() as cur:
            cur.execute("BEGIN IMMEDIATE")
            existing = cur.execute("SELECT id, original_name FROM media WHERE sha256 = ?", (sha,)).fetchone()
            if existing:
                raise HTTPException(409, f"Duplicate of '{existing['original_name']}' (sha256 match)")
            cur.execute(
                """INSERT INTO media (filename, original_name, media_type, size_bytes,
                                       duration_seconds, width, height, codec, sha256)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    final_name,
                    recv.filename or final_name,
                    media_type,
                    recv.size,
                    probe_data["duration_seconds"] if media_type == "video" else None,
                    probe_data["width"],
                    probe_data["height"],
                    probe_data["codec"],
                    sha,
                ),
            )
            new_id = cur.lastrowid
            tmp_path.replace(final_path)
    except sqlite3.IntegrityError:
        raise HTTPException(409, "a file with this content or name already exists")
    return new_id, media_type


@auth.csrf_streaming
@router.post("/library/upload")
async def library_upload(request: Request, user=Depends(require_editor)):
    config.ensure_dirs()
    await run_in_threadpool(sweep_upload_tmp)
    fd, tmp_path_str = tempfile.mkstemp(dir=str(config.MEDIA_DIR), prefix=".upload_", suffix=".tmp")
    os.close(fd)
    tmp_path = Path(tmp_path_str)

    try:
        recv = await _receive_upload(request, tmp_path, allowed_extensions=config.ALLOWED_EXTENSIONS)
        ext = Path(recv.filename or "").suffix.lower()
        media_type = config.media_type_for_ext(ext)
        if media_type is None:
            raise HTTPException(400, f"Unsupported extension {ext}. Allowed: {sorted(config.ALLOWED_EXTENSIONS)}")
        if recv.size == 0:
            raise HTTPException(400, "empty file")
        new_id, media_type = await run_in_threadpool(_store_upload, tmp_path, recv, media_type, ext)
        await run_in_threadpool(
            audit.log, request, user, "upload_media", "media", new_id,
            {"filename": recv.filename, "type": media_type},
        )
    finally:
        tmp_path.unlink(missing_ok=True)

    return RedirectResponse("/library", status_code=303)


def _renumber_playlist(cur, playlist_id: int) -> None:
    rows = cur.execute(
        "SELECT id FROM playlist_items WHERE playlist_id = ? ORDER BY position, id", (playlist_id,)
    ).fetchall()
    for pos, r in enumerate(rows):
        cur.execute("UPDATE playlist_items SET position = ? WHERE id = ?", (pos, r["id"]))


@router.post("/library/{media_id}/delete")
def library_delete(media_id: int, request: Request, user=Depends(require_editor)):
    with db.cursor() as cur:
        row = cur.execute("SELECT filename, original_name FROM media WHERE id = ?", (media_id,)).fetchone()
        if not row:
            raise HTTPException(404)
        affected = [r["playlist_id"] for r in cur.execute(
            "SELECT DISTINCT playlist_id FROM playlist_items WHERE media_id = ?", (media_id,)
        ).fetchall()]
        cur.execute("DELETE FROM media WHERE id = ?", (media_id,))
        for pid in affected:
            _renumber_playlist(cur, pid)
            cur.execute("UPDATE playlists SET updated_at = datetime('now') WHERE id = ?", (pid,))
    path = config.MEDIA_DIR / row["filename"]
    path.unlink(missing_ok=True)
    audit.log(request, user, "delete_media", "media", media_id,
              {"filename": row["original_name"], "playlists": affected})
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
                   (SELECT COUNT(*) FROM devices d WHERE d.playlist_id = p.id) AS device_count,
                   (SELECT COUNT(*) FROM device_groups g WHERE g.playlist_id = p.id) AS group_count,
                   (SELECT COUNT(*) FROM device_schedules s WHERE s.playlist_id = p.id) AS schedule_count
            FROM playlists p ORDER BY p.name
            """
        ).fetchall()
    playlists = []
    for r in rows:
        p = dict(r)
        parts = []
        if p["schedule_count"]:
            parts.append(f"{p['schedule_count']} schedule rule(s) will be deleted")
        if p["device_count"]:
            parts.append(f"{p['device_count']} device default(s) will be cleared")
        if p["group_count"]:
            parts.append(f"{p['group_count']} group default(s) will be cleared")
        p["delete_confirm"] = f"Delete playlist {p['name']}?" + (" " + "; ".join(parts) + "." if parts else "")
        playlists.append(p)
    return _render(request, "playlists.html", playlists=playlists)


@router.post("/playlists")
def playlists_create(request: Request, name: str = Form(...), user=Depends(require_editor)):
    name = name.strip()
    if not name:
        raise HTTPException(400, "Name required")
    with db.cursor() as cur:
        try:
            cur.execute("INSERT INTO playlists (name) VALUES (?)", (name,))
            pid = cur.lastrowid
        except sqlite3.IntegrityError:
            raise HTTPException(409, "A playlist with that name already exists")
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
               ORDER BY pi.position, pi.id""",
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
def playlist_add_item(playlist_id: int, request: Request, media_id: str = Form(...), user=Depends(require_editor)):
    mid = _form_int(media_id, "media_id")
    if mid is None:
        raise HTTPException(400, "media_id required")
    with db.cursor() as cur:
        # Take the write lock up front so two overlapping adds cannot both read the same
        # MAX(position) (or both pass the duplicate check).
        cur.execute("BEGIN IMMEDIATE")
        if not cur.execute("SELECT id FROM playlists WHERE id = ?", (playlist_id,)).fetchone():
            raise HTTPException(404, "Playlist not found")
        if not cur.execute("SELECT id FROM media WHERE id = ?", (mid,)).fetchone():
            raise HTTPException(404, "Media not found")
        if cur.execute(
            "SELECT id FROM playlist_items WHERE playlist_id = ? AND media_id = ?",
            (playlist_id, mid),
        ).fetchone():
            raise HTTPException(409, "Already in playlist")
        cur.execute(
            """INSERT INTO playlist_items (playlist_id, media_id, position)
               SELECT ?, ?, COALESCE(MAX(position), -1) + 1 FROM playlist_items WHERE playlist_id = ?""",
            (playlist_id, mid, playlist_id),
        )
        cur.execute("UPDATE playlists SET updated_at = datetime('now') WHERE id = ?", (playlist_id,))
    audit.log(request, user, "playlist_add_item", "playlist", playlist_id, {"media_id": mid})
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
        except ValueError:
            raise HTTPException(400, "duration must be a positive number")
        if not math.isfinite(dur) or dur <= 0 or dur > 86400:
            raise HTTPException(400, "duration must be a positive number of seconds (at most 86400)")
    with db.cursor() as cur:
        updated = cur.execute(
            "UPDATE playlist_items SET duration_override_seconds = ? "
            "WHERE id = ? AND playlist_id = ?",
            (dur, item_id, playlist_id),
        ).rowcount
        if not updated:
            raise HTTPException(404, "Playlist item not found")
        cur.execute("UPDATE playlists SET updated_at = datetime('now') WHERE id = ?", (playlist_id,))
    audit.log(request, user, "playlist_set_duration", "playlist_item", item_id, {"duration": dur})
    return RedirectResponse(f"/playlists/{playlist_id}", status_code=303)


async def _json_object(request: Request) -> dict:
    try:
        body = await request.json()
    except (json.JSONDecodeError, UnicodeDecodeError, ValueError):
        raise HTTPException(400, "body must be a JSON object")
    if not isinstance(body, dict):
        raise HTTPException(400, "body must be a JSON object")
    return body


@router.post("/playlists/{playlist_id}/items/reorder")
async def playlist_reorder(playlist_id: int, request: Request, user=Depends(require_editor)):
    body = await _json_object(request)
    order = body.get("order")
    if not isinstance(order, list):
        raise HTTPException(400, "body must be {order: [item_id, ...]}")
    if not all(isinstance(x, int) and not isinstance(x, bool) for x in order):
        raise HTTPException(400, "order must be a list of integers")
    ids = list(order)

    def _apply():
        with db.cursor() as cur:
            if not cur.execute("SELECT id FROM playlists WHERE id = ?", (playlist_id,)).fetchone():
                raise HTTPException(404, "Playlist not found")
            existing = {
                r["id"] for r in cur.execute(
                    "SELECT id FROM playlist_items WHERE playlist_id = ?", (playlist_id,)
                ).fetchall()
            }
            if set(ids) != existing or len(ids) != len(existing):
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

    await run_in_threadpool(_apply)
    return JSONResponse({"ok": True})


@router.post("/playlists/{playlist_id}/items/{item_id}/delete")
def playlist_remove_item(playlist_id: int, item_id: int, request: Request, user=Depends(require_editor)):
    with db.cursor() as cur:
        deleted = cur.execute(
            "DELETE FROM playlist_items WHERE id = ? AND playlist_id = ?", (item_id, playlist_id)
        ).rowcount
        if not deleted:
            raise HTTPException(404, "Playlist item not found")
        _renumber_playlist(cur, playlist_id)
        cur.execute("UPDATE playlists SET updated_at = datetime('now') WHERE id = ?", (playlist_id,))
    audit.log(request, user, "playlist_remove_item", "playlist_item", item_id)
    return RedirectResponse(f"/playlists/{playlist_id}", status_code=303)


@router.post("/playlists/{playlist_id}/rename")
def playlist_rename(playlist_id: int, request: Request, name: str = Form(...), user=Depends(require_editor)):
    name = name.strip()
    if not name:
        raise HTTPException(400, "Name required")
    with db.cursor() as cur:
        try:
            updated = cur.execute(
                "UPDATE playlists SET name = ?, updated_at = datetime('now') WHERE id = ?", (name, playlist_id)
            ).rowcount
        except sqlite3.IntegrityError:
            raise HTTPException(409, "A playlist with that name already exists")
        if not updated:
            raise HTTPException(404, "Playlist not found")
    audit.log(request, user, "playlist_rename", "playlist", playlist_id, {"name": name})
    return RedirectResponse(f"/playlists/{playlist_id}", status_code=303)


@router.post("/playlists/{playlist_id}/delete")
def playlist_delete(playlist_id: int, request: Request, user=Depends(require_editor)):
    with db.cursor() as cur:
        row = cur.execute("SELECT name FROM playlists WHERE id = ?", (playlist_id,)).fetchone()
        if not row:
            raise HTTPException(404, "Playlist not found")
        # Record what the cascade is about to remove so the audit trail explains it.
        rules = [dict(r) for r in cur.execute(
            "SELECT id, device_id, name FROM device_schedules WHERE playlist_id = ?", (playlist_id,)
        ).fetchall()]
        devices = [r["id"] for r in cur.execute(
            "SELECT id FROM devices WHERE playlist_id = ?", (playlist_id,)).fetchall()]
        groups = [r["id"] for r in cur.execute(
            "SELECT id FROM device_groups WHERE playlist_id = ?", (playlist_id,)).fetchall()]
        cur.execute("DELETE FROM playlists WHERE id = ?", (playlist_id,))
    for rule in rules:
        audit.log(request, user, "device_schedule_delete", "device_schedule", rule["id"],
                  {"device_id": rule["device_id"], "name": rule["name"], "cascade_from_playlist": playlist_id})
    audit.log(request, user, "playlist_delete", "playlist", playlist_id,
              {"name": row["name"], "schedules_deleted": len(rules),
               "devices_cleared": devices, "groups_cleared": groups})
    return RedirectResponse("/playlists", status_code=303)


# ---------------------------------------------------------------------------
# Devices
# ---------------------------------------------------------------------------

@router.get("/devices", response_class=HTMLResponse)
def devices_page(request: Request, user=Depends(auth.require_user)):
    now = dt.datetime.now()
    can_edit = auth._role_rank(user["role"]) >= auth._role_rank("editor")
    with db.cursor() as cur:
        devices = cur.execute(
            """SELECT d.id, d.device_id, d.name, d.last_seen_at, d.last_ip,
                      d.player_version, d.current_position, d.current_filename, d.player_status,
                      d.last_screenshot_at, d.last_error,
                      d.last_camera_at, d.camera_error, d.camera_live_url,
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
            dd = _decorate_device(cur, dict(d), now)
            dd["schedule_count"] = cur.execute(
                "SELECT COUNT(*) AS n FROM device_schedules WHERE device_id = ?", (dd["id"],)
            ).fetchone()["n"]
            # Tokens are only shown to people who may install a player (editor+).
            if can_edit:
                dd["token"] = cur.execute("SELECT token FROM devices WHERE id = ?", (dd["id"],)).fetchone()["token"]
            dd["recent_commands"] = [dict(c) for c in cur.execute(
                """SELECT id, command, issued_at, delivered_at, completed_at, result, delivery_count
                   FROM device_commands WHERE device_id = ? ORDER BY id DESC LIMIT 5""",
                (dd["id"],),
            ).fetchall()]
            device_list.append(dd)

    base_url = config.PUBLIC_BASE_URL or str(request.base_url).rstrip("/")
    return _render(
        request, "devices.html",
        devices=device_list,
        playlists=[dict(p) for p in playlists],
        groups=[dict(g) for g in groups],
        public_base_url=config.PUBLIC_BASE_URL,
        install_base_url=base_url,
        can_edit=can_edit,
    )


@router.post("/devices")
def devices_create(
    request: Request, device_id: str = Form(...), name: str = Form(...),
    user=Depends(require_editor),
):
    device_id = device_id.strip().lower()
    name = name.strip()
    if not DEVICE_ID_RE.match(device_id):
        raise HTTPException(400, DEVICE_ID_RULE)
    if not name:
        raise HTTPException(400, "name required")
    token = db.new_token()
    with db.cursor() as cur:
        try:
            cur.execute("INSERT INTO devices (device_id, name, token) VALUES (?, ?, ?)", (device_id, name, token))
            new_id = cur.lastrowid
        except sqlite3.IntegrityError:
            raise HTTPException(409, "A device with that device_id already exists")
    audit.log(request, user, "register_device", "device", new_id, {"device_id": device_id, "name": name})
    return RedirectResponse("/devices", status_code=303)


def _require_row(cur, table: str, row_id: int | None, label: str) -> None:
    """404 when an optional foreign-key target does not exist (None is allowed)."""
    if row_id is None:
        return
    if not cur.execute(f"SELECT id FROM {table} WHERE id = ?", (row_id,)).fetchone():
        raise HTTPException(404, f"{label} not found")


@router.post("/devices/{device_id}/assign")
def devices_assign(device_id: int, request: Request, playlist_id: str = Form(""), user=Depends(require_editor)):
    pid = _form_int(playlist_id, "playlist_id")
    with db.cursor() as cur:
        _require_row(cur, "devices", device_id, "Device")
        _require_row(cur, "playlists", pid, "Playlist")
        cur.execute("UPDATE devices SET playlist_id = ? WHERE id = ?", (pid, device_id))
    audit.log(request, user, "device_assign_playlist", "device", device_id, {"playlist_id": pid})
    return RedirectResponse("/devices", status_code=303)


@router.post("/devices/{device_id}/group")
def devices_set_group(device_id: int, request: Request, group_id: str = Form(""), user=Depends(require_editor)):
    gid = _form_int(group_id, "group_id")
    with db.cursor() as cur:
        _require_row(cur, "devices", device_id, "Device")
        _require_row(cur, "device_groups", gid, "Group")
        cur.execute("UPDATE devices SET group_id = ? WHERE id = ?", (gid, device_id))
    audit.log(request, user, "device_set_group", "device", device_id, {"group_id": gid})
    return RedirectResponse("/devices", status_code=303)


@router.post("/devices/{device_id}/camera-url")
def devices_set_camera_url(device_id: int, request: Request, camera_live_url: str = Form(""),
                           user=Depends(require_editor)):
    """Where the console embeds the live camera view (e.g. a Cloudflare Tunnel hostname to the
    wyze-bridge player). Empty clears it; anything else must be an absolute https URL."""
    raw = camera_live_url.strip()
    url = https_url_or_none(raw)
    if raw and not url:
        raise HTTPException(400, "camera_live_url must be an absolute https:// URL")
    with db.cursor() as cur:
        _require_row(cur, "devices", device_id, "Device")
        cur.execute("UPDATE devices SET camera_live_url = ? WHERE id = ?", (url, device_id))
    audit.log(request, user, "device_set_camera_url", "device", device_id, {"camera_live_url": url})
    return RedirectResponse("/devices", status_code=303)


@router.post("/devices/{device_id}/regen-token")
def devices_regen_token(device_id: int, request: Request, user=Depends(require_editor)):
    token = db.new_token()
    with db.cursor() as cur:
        _require_row(cur, "devices", device_id, "Device")
        cur.execute("UPDATE devices SET token = ? WHERE id = ?", (token, device_id))
    audit.log(request, user, "device_regen_token", "device", device_id)
    return RedirectResponse("/devices", status_code=303)


@router.post("/devices/{device_id}/delete")
def devices_delete(device_id: int, request: Request, user=Depends(require_editor)):
    with db.cursor() as cur:
        row = cur.execute("SELECT device_id, name FROM devices WHERE id = ?", (device_id,)).fetchone()
        if not row:
            raise HTTPException(404, "Device not found")
        cur.execute("DELETE FROM devices WHERE id = ?", (device_id,))
    (config.SCREENSHOT_DIR / f"{row['device_id']}.jpg").unlink(missing_ok=True)
    (config.SCREENSHOT_DIR / f"camera_{row['device_id']}.jpg").unlink(missing_ok=True)
    audit.log(request, user, "device_delete", "device", device_id, {"device_id": row["device_id"], "name": row["name"]})
    return RedirectResponse("/devices", status_code=303)


@router.post("/devices/{device_id}/command")
def devices_send_command(
    device_id: int, request: Request, command: str = Form(...), user=Depends(require_editor),
):
    if command not in ("reboot", "force-sync", "restart-mpv"):
        raise HTTPException(400, "unknown command")
    with db.cursor() as cur:
        _require_row(cur, "devices", device_id, "Device")
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
    return FileResponse(path, media_type="image/jpeg",
                        headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"})


@router.get("/devices/{device_id}/camera")
def devices_camera(device_id: int, request: Request, user=Depends(auth.require_user)):
    with db.cursor() as cur:
        row = cur.execute("SELECT device_id FROM devices WHERE id = ?", (device_id,)).fetchone()
        if not row:
            raise HTTPException(404)
    path = config.SCREENSHOT_DIR / f"camera_{row['device_id']}.jpg"
    if not path.is_file():
        raise HTTPException(404, "no camera snapshot yet")
    return FileResponse(path, media_type="image/jpeg",
                        headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"})


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
    now = dt.datetime.now().astimezone()
    rule_list = []
    for r in rules:
        rd = dict(r)
        rd["summary"] = schedules.describe(rd)
        rd["matches_now"] = schedules.schedule_matches(rd, now.replace(tzinfo=None))
        rule_list.append(rd)
    return _render(
        request, "device_schedule.html",
        device=dict(device),
        rules=rule_list,
        playlists=[dict(p) for p in playlists],
        now=now.strftime("%Y-%m-%d %H:%M:%S %Z"),
        zone=local_zone_name(),
    )


def _parse_iso_date(value: str, field: str) -> str | None:
    value = (value or "").strip()
    if not value:
        return None
    try:
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
            raise ValueError(value)
        return dt.date.fromisoformat(value).isoformat()
    except ValueError:
        raise HTTPException(400, f"{field} must be a date in YYYY-MM-DD form")


@router.post("/devices/{device_id}/schedule")
def device_schedule_create(
    device_id: int, request: Request,
    name: str = Form(...),
    playlist_id: str = Form(...),
    priority: str = Form("0"),
    start_time: str = Form(""),
    end_time: str = Form(""),
    days_of_week: str = Form(""),
    start_date: str = Form(""),
    end_date: str = Form(""),
    user=Depends(require_editor),
):
    name = name.strip() or "Rule"
    pid = _form_int(playlist_id, "playlist_id")
    if pid is None:
        raise HTTPException(400, "playlist_id required")
    prio = _form_int(priority, "priority")
    prio = 0 if prio is None else prio
    if not 0 <= prio <= 1000:
        raise HTTPException(400, "priority must be between 0 and 1000")
    start_time = start_time.strip() or None
    end_time = end_time.strip() or None
    if start_time is not None:
        start_time = schedules.normalize_hhmm(start_time)
        if start_time is None:
            raise HTTPException(400, "start_time must be HH:MM (00:00-23:59)")
    if end_time is not None:
        end_time = schedules.normalize_hhmm(end_time)
        if end_time is None:
            raise HTTPException(400, "end_time must be HH:MM (00:00-23:59)")
    if start_time is not None and end_time is not None and start_time == end_time:
        raise HTTPException(400, "start and end must differ; use no times for all-day")
    days_of_week = days_of_week.strip()
    if days_of_week and not re.fullmatch(r"[0-6]+", days_of_week):
        raise HTTPException(400, "days_of_week must only contain digits 0-6 (0 = Monday)")
    days_of_week = "".join(sorted(set(days_of_week))) or None
    start_date = _parse_iso_date(start_date, "start_date")
    end_date = _parse_iso_date(end_date, "end_date")
    if start_date and end_date and start_date > end_date:
        raise HTTPException(400, "start_date must be on or before end_date")
    with db.cursor() as cur:
        _require_row(cur, "devices", device_id, "Device")
        _require_row(cur, "playlists", pid, "Playlist")
        cur.execute(
            """INSERT INTO device_schedules
                  (device_id, playlist_id, name, priority,
                   start_time, end_time, days_of_week, start_date, end_date)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (device_id, pid, name, prio, start_time, end_time, days_of_week, start_date, end_date),
        )
        new_id = cur.lastrowid
    audit.log(
        request, user, "device_schedule_create", "device_schedule", new_id,
        {"device_id": device_id, "name": name, "playlist_id": pid},
    )
    return RedirectResponse(f"/devices/{device_id}/schedule", status_code=303)


@router.post("/devices/{device_id}/schedule/{schedule_id}/delete")
def device_schedule_delete(device_id: int, schedule_id: int, request: Request, user=Depends(require_editor)):
    with db.cursor() as cur:
        deleted = cur.execute(
            "DELETE FROM device_schedules WHERE id = ? AND device_id = ?", (schedule_id, device_id)
        ).rowcount
        if not deleted:
            raise HTTPException(404, "Schedule rule not found")
    audit.log(request, user, "device_schedule_delete", "device_schedule", schedule_id, {"device_id": device_id})
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
        except sqlite3.IntegrityError:
            raise HTTPException(409, "A group with that name already exists")
    audit.log(request, user, "group_create", "group", new_id, {"name": name})
    return RedirectResponse("/groups", status_code=303)


@router.post("/groups/{group_id}/assign")
def groups_assign_playlist(group_id: int, request: Request, playlist_id: str = Form(""), user=Depends(require_editor)):
    pid = _form_int(playlist_id, "playlist_id")
    with db.cursor() as cur:
        _require_row(cur, "device_groups", group_id, "Group")
        _require_row(cur, "playlists", pid, "Playlist")
        cur.execute("UPDATE device_groups SET playlist_id = ? WHERE id = ?", (pid, group_id))
    audit.log(request, user, "group_assign_playlist", "group", group_id, {"playlist_id": pid})
    return RedirectResponse("/groups", status_code=303)


@router.post("/groups/{group_id}/delete")
def groups_delete(group_id: int, request: Request, user=Depends(require_editor)):
    with db.cursor() as cur:
        deleted = cur.execute("DELETE FROM device_groups WHERE id = ?", (group_id,)).rowcount
        if not deleted:
            raise HTTPException(404, "Group not found")
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
               FROM audit_log ORDER BY created_at DESC, id DESC LIMIT ?""",
            (limit,),
        ).fetchall()
    return _render(request, "audit.html", entries=[dict(r) for r in rows], limit=limit, zone=local_zone_name())


# ---------------------------------------------------------------------------
# Users (admin-only)
# ---------------------------------------------------------------------------

@router.get("/users", response_class=HTMLResponse)
def users_page(request: Request, user=Depends(require_admin)):
    with db.cursor() as cur:
        rows = cur.execute("SELECT id, username, role, created_at FROM users ORDER BY username").fetchall()
    return _render(request, "users.html", users=[dict(r) for r in rows])


def _hash_or_400(password: str) -> str:
    try:
        return auth.hash_password(password)
    except auth.PasswordTooLong:
        raise HTTPException(400, auth.PASSWORD_TOO_LONG_MSG)


# ---------------------------------------------------------------------------
# Settings (admin)
# ---------------------------------------------------------------------------

@router.get("/settings", response_class=HTMLResponse)
def settings_page(request: Request, user=Depends(require_admin)):
    return _render(request, "settings.html", enrollment_key=db.enrollment_key())


@router.post("/settings/enrollment/rotate")
def settings_rotate_enrollment_key(request: Request, user=Depends(require_admin)):
    db.rotate_enrollment_key()
    audit.log(request, user, "enrollment_key_rotated", "settings", db.ENROLLMENT_KEY)
    return RedirectResponse("/settings", status_code=303)


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
    password_hash = _hash_or_400(password)
    with db.cursor() as cur:
        try:
            cur.execute(
                "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)",
                (username, password_hash, role),
            )
            new_id = cur.lastrowid
        except sqlite3.IntegrityError:
            raise HTTPException(409, "A user with that username already exists")
    audit.log(request, user, "user_create", "user", new_id, {"username": username, "role": role})
    return RedirectResponse("/users", status_code=303)


@router.post("/users/{user_id}/role")
def users_set_role(user_id: int, request: Request, role: str = Form(...), user=Depends(require_admin)):
    if role not in ("admin", "editor", "viewer"):
        raise HTTPException(400, "invalid role")
    if user_id == user["id"] and role != "admin":
        raise HTTPException(400, "cannot demote yourself")
    with db.cursor() as cur:
        updated = cur.execute("UPDATE users SET role = ? WHERE id = ?", (role, user_id)).rowcount
        if not updated:
            raise HTTPException(404, "User not found")
    audit.log(request, user, "user_set_role", "user", user_id, {"role": role})
    return RedirectResponse("/users", status_code=303)


@router.post("/users/{user_id}/password")
def users_set_password(user_id: int, request: Request, password: str = Form(...), user=Depends(require_admin)):
    if len(password) < 6:
        raise HTTPException(400, "password must be at least 6 chars")
    password_hash = _hash_or_400(password)
    with db.cursor() as cur:
        updated = cur.execute("UPDATE users SET password_hash = ? WHERE id = ?", (password_hash, user_id)).rowcount
        if not updated:
            raise HTTPException(404, "User not found")
    audit.log(request, user, "user_set_password", "user", user_id)
    return RedirectResponse("/users", status_code=303)


@router.post("/users/{user_id}/delete")
def users_delete(user_id: int, request: Request, user=Depends(require_admin)):
    if user_id == user["id"]:
        raise HTTPException(400, "cannot delete yourself")
    with db.cursor() as cur:
        n = cur.execute("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").fetchone()["n"]
        target_role = cur.execute("SELECT role FROM users WHERE id = ?", (user_id,)).fetchone()
        if not target_role:
            raise HTTPException(404, "User not found")
        if target_role["role"] == "admin" and n <= 1:
            raise HTTPException(400, "cannot delete the last admin")
        cur.execute("DELETE FROM users WHERE id = ?", (user_id,))
    audit.log(request, user, "user_delete", "user", user_id)
    return RedirectResponse("/users", status_code=303)
