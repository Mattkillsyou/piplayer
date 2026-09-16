import logging
import os
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
