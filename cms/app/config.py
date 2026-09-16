import logging
import os
import re
import secrets
import sys
from pathlib import Path


_log = logging.getLogger("piplayer.config")


def _env_number(name: str, default: str, cast):
    """Parse a numeric PIPLAYER_* variable; a typo must not become a traceback + restart loop."""
    raw = os.environ.get(name, default)
    try:
        return cast(raw)
    except (TypeError, ValueError):
        _log.error("%s must be a number (got %r); fix /etc/projector-cms/env and restart", name, raw)
        sys.exit(1)


def _env_int(name: str, default: int) -> int:
    return _env_number(name, str(default), int)


def _env_float(name: str, default: float) -> float:
    return _env_number(name, str(default), float)


def _env_bool(name: str, default: bool = False) -> bool:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    return raw.strip().lower() in ("1", "true", "yes", "on")


def _data_dir() -> Path:
    env = os.environ.get("PIPLAYER_DATA_DIR")
    if env:
        return Path(env)
    if os.name == "nt":
        return Path.cwd() / "data"
    return Path("/var/lib/projector-cms")


DATA_DIR = _data_dir()
MEDIA_DIR = DATA_DIR / "media"
SCREENSHOT_DIR = DATA_DIR / "screenshots"
DB_PATH = DATA_DIR / "cms.db"

SCREENSHOT_INTERVAL_SECONDS = _env_int("PIPLAYER_SCREENSHOT_INTERVAL", 60)
MAX_SCREENSHOT_BYTES = _env_int("PIPLAYER_MAX_SCREENSHOT_BYTES", 5 * 1024 * 1024)
# Room camera snapshots (player/player/camera.py): a Wyze / RTSP frame every N seconds, 5 s floor.
CAMERA_INTERVAL_SECONDS = max(5, _env_int("PIPLAYER_CAMERA_INTERVAL", 10))
MAX_CAMERA_BYTES = _env_int("PIPLAYER_MAX_CAMERA_BYTES", 2 * 1024 * 1024)

MAX_UPLOAD_BYTES = _env_int("PIPLAYER_MAX_UPLOAD_BYTES", 5 * 1024 * 1024 * 1024)
VIDEO_EXTENSIONS = {".mp4", ".mov", ".m4v", ".mkv", ".webm"}
IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"}
ALLOWED_EXTENSIONS = VIDEO_EXTENSIONS | IMAGE_EXTENSIONS
DEFAULT_IMAGE_DURATION = _env_float("PIPLAYER_DEFAULT_IMAGE_DURATION", 10)

# Audit rows older than this are pruned at startup; 0 (default) keeps everything, so an
# in-place upgrade never deletes history the operator did not choose to drop.
AUDIT_RETENTION_DAYS = _env_int("PIPLAYER_AUDIT_RETENTION_DAYS", 0)

# Remote updates (manifest "update" key; player/player/updater.py). The cloud console keeps
# these in Settings; here they come from /etc/projector-cms/env.
# Same shape the cloud console enforces (cloud/src/db.js GIT_REF_RE): a bad ref would be served in
# every manifest and make every update-player run fail on the Pi with "bad ref".
GIT_REF_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$")


def _env_ref(name: str, default: str) -> str:
    """Git tag, branch or sha for update-player; a typo must not start a CMS that breaks every update."""
    raw = os.environ.get(name, "").strip() or default
    if not GIT_REF_RE.match(raw) or ".." in raw:
        _log.error("%s must be a git tag, branch or sha (got %r); fix /etc/projector-cms/env and restart", name, raw)
        sys.exit(1)
    return raw


PLAYER_RELEASE = _env_ref("PIPLAYER_PLAYER_RELEASE", "main")
# off | nightly (truthy spellings count as nightly)
AUTO_UPDATE = "nightly" if _env_bool("PIPLAYER_AUTO_UPDATE") or os.environ.get("PIPLAYER_AUTO_UPDATE", "").strip().lower() == "nightly" else "off"
AUTO_UPDATE_WINDOW_RE = re.compile(r"^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$")


def _env_window(name: str, default: str) -> str:
    """'HH:MM-HH:MM' local wall-clock window for nightly updates; a typo must not start a broken CMS."""
    raw = os.environ.get(name, "").strip() or default
    if not AUTO_UPDATE_WINDOW_RE.match(raw):
        _log.error("%s must look like 03:00-05:00 (got %r); fix /etc/projector-cms/env and restart", name, raw)
        sys.exit(1)
    return raw


AUTO_UPDATE_WINDOW = _env_window("PIPLAYER_AUTO_UPDATE_WINDOW", "03:00-05:00")


def media_type_for_ext(ext: str) -> str | None:
    ext = ext.lower()
    if ext in VIDEO_EXTENSIONS:
        return "video"
    if ext in IMAGE_EXTENSIONS:
        return "image"
    return None

SECRET_KEY = os.environ.get("PIPLAYER_SECRET_KEY")
SECRET_KEY_GENERATED = not SECRET_KEY
if SECRET_KEY_GENERATED:
    SECRET_KEY = secrets.token_urlsafe(32)
SESSION_COOKIE = "piplayer_session"
SESSION_MAX_AGE = 60 * 60 * 24 * 14
# Secure cookie flag. Off by default because the Tailscale / LAN paths are plain http;
# set PIPLAYER_HTTPS_ONLY=1 when the CMS is only ever reached through an HTTPS front-end.
HTTPS_ONLY = _env_bool("PIPLAYER_HTTPS_ONLY", False)

DEFAULT_ADMIN_USERNAME = os.environ.get("PIPLAYER_ADMIN_USERNAME", "admin")
DEFAULT_ADMIN_PASSWORD = os.environ.get("PIPLAYER_ADMIN_PASSWORD")

PUBLIC_BASE_URL = os.environ.get("PIPLAYER_PUBLIC_BASE_URL", "").rstrip("/")


def ensure_dirs() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    MEDIA_DIR.mkdir(parents=True, exist_ok=True)
    SCREENSHOT_DIR.mkdir(parents=True, exist_ok=True)
