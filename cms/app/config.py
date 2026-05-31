import os
import secrets
from pathlib import Path


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

SCREENSHOT_INTERVAL_SECONDS = int(os.environ.get("PIPLAYER_SCREENSHOT_INTERVAL", "60"))
MAX_SCREENSHOT_BYTES = int(os.environ.get("PIPLAYER_MAX_SCREENSHOT_BYTES", str(5 * 1024 * 1024)))

MAX_UPLOAD_BYTES = int(os.environ.get("PIPLAYER_MAX_UPLOAD_BYTES", str(5 * 1024 * 1024 * 1024)))
VIDEO_EXTENSIONS = {".mp4", ".mov", ".m4v", ".mkv", ".webm"}
IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"}
ALLOWED_EXTENSIONS = VIDEO_EXTENSIONS | IMAGE_EXTENSIONS
DEFAULT_IMAGE_DURATION = float(os.environ.get("PIPLAYER_DEFAULT_IMAGE_DURATION", "10"))


def media_type_for_ext(ext: str) -> str | None:
    ext = ext.lower()
    if ext in VIDEO_EXTENSIONS:
        return "video"
    if ext in IMAGE_EXTENSIONS:
        return "image"
    return None

SECRET_KEY = os.environ.get("PIPLAYER_SECRET_KEY") or secrets.token_urlsafe(32)
SESSION_COOKIE = "piplayer_session"
SESSION_MAX_AGE = 60 * 60 * 24 * 14

DEFAULT_ADMIN_USERNAME = os.environ.get("PIPLAYER_ADMIN_USERNAME", "admin")
DEFAULT_ADMIN_PASSWORD = os.environ.get("PIPLAYER_ADMIN_PASSWORD")

PUBLIC_BASE_URL = os.environ.get("PIPLAYER_PUBLIC_BASE_URL", "").rstrip("/")


def ensure_dirs() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    MEDIA_DIR.mkdir(parents=True, exist_ok=True)
    SCREENSHOT_DIR.mkdir(parents=True, exist_ok=True)
