import os
import sys
from dataclasses import dataclass
from pathlib import Path

try:
    import tomllib
except ModuleNotFoundError:
    import tomli as tomllib  # type: ignore


DEFAULT_CONFIG_PATH = Path(os.environ.get("PIPLAYER_CONFIG", "/etc/projector-player/config.toml"))


@dataclass(frozen=True)
class PlayerConfig:
    device_id: str
    device_token: str
    cms_url: str
    media_dir: Path
    manifest_path: Path
    mpv_socket: Path
    poll_interval_seconds: int
    verify_tls: bool


def _env_or(default: str | None, *keys: str) -> str | None:
    for k in keys:
        v = os.environ.get(k)
        if v:
            return v
    return default


def load(path: Path = DEFAULT_CONFIG_PATH) -> PlayerConfig:
    data: dict = {}
    if path.is_file():
        with path.open("rb") as f:
            data = tomllib.load(f)

    device_id = _env_or(data.get("device_id"), "DEVICE_ID", "PIPLAYER_DEVICE_ID")
    device_token = _env_or(data.get("device_token"), "DEVICE_TOKEN", "PIPLAYER_DEVICE_TOKEN")
    cms_url = _env_or(data.get("cms_url"), "CMS_URL", "PIPLAYER_CMS_URL")
    media_dir = Path(_env_or(data.get("media_dir"), "PIPLAYER_MEDIA_DIR") or "/var/lib/projector-player/media")
    manifest_path = Path(_env_or(data.get("manifest_path"), "PIPLAYER_MANIFEST_PATH") or "/var/lib/projector-player/manifest.json")
    mpv_socket = Path(_env_or(data.get("mpv_socket"), "PIPLAYER_MPV_SOCKET") or "/tmp/projector-mpv.sock")
    poll = int(_env_or(data.get("poll_interval_seconds"), "PIPLAYER_POLL") or "30")
    verify_tls_raw = _env_or(str(data.get("verify_tls", True)), "PIPLAYER_VERIFY_TLS") or "true"
    verify_tls = verify_tls_raw.lower() not in ("0", "false", "no")

    missing = [k for k, v in {"device_id": device_id, "device_token": device_token, "cms_url": cms_url}.items() if not v]
    if missing:
        print(f"ERROR: missing required config: {missing}", file=sys.stderr)
        print(f"Provide via {path} or env vars (DEVICE_ID, DEVICE_TOKEN, CMS_URL).", file=sys.stderr)
        sys.exit(2)

    return PlayerConfig(
        device_id=device_id,
        device_token=device_token,
        cms_url=cms_url.rstrip("/"),
        media_dir=media_dir,
        manifest_path=manifest_path,
        mpv_socket=mpv_socket,
        poll_interval_seconds=max(5, poll),
        verify_tls=verify_tls,
    )
