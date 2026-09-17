"""Camera zero-config: the console keeps each device's camera settings (and
the Wyze account) and the player pulls them from
GET /api/camera-config/<device_id> on start and whenever the manifest's
`camera_config_version` differs from the one applied last. Applying writes
the bridge's credentials to /var/lib/projector-player/wyze.env (mode 600,
next to manifest.json), restarts projector-wyze-bridge.service when the
credentials changed, and re-points the capture thread; the daemon itself is
never restarted. A manifest without the key leaves config.toml in charge,
and a console answer of source "none" falls back to config.toml too (the
console cannot switch off a hand-configured camera)."""
import logging
import os
import subprocess

import requests

from . import __version__
from .camera import CameraCapture
from .config import CAMERA_SOURCES, PlayerConfig, WYZE_BRIDGE_RTSP

log = logging.getLogger("piplayer.camera_config")

# wyze.env line -> key in the endpoint's `wyze` object
WYZE_ENV_KEYS = (("WYZE_EMAIL", "email"), ("WYZE_PASSWORD", "password"), ("API_ID", "api_id"), ("API_KEY", "api_key"))
BRIDGE_UNIT = "projector-wyze-bridge.service"


def wyze_env_path(cfg: PlayerConfig):
    return cfg.manifest_path.parent / "wyze.env"


def fetch(cfg: PlayerConfig) -> dict:
    r = requests.get(
        f"{cfg.cms_url}/api/camera-config/{cfg.device_id}",
        headers={"Authorization": f"Bearer {cfg.device_token}", "User-Agent": f"piplayer/{__version__}"},
        timeout=15, verify=cfg.verify_tls,
    )
    r.raise_for_status()
    data = r.json()
    return data if isinstance(data, dict) else {}


def rtsp_url(data: dict) -> str:
    """The stream URL the console's answer describes, "" for none/unknown."""
    source = str(data.get("source") or "none").lower()
    if source == "rtsp":
        return str(data.get("rtsp_url") or "")
    if source == "wyze":
        camera = str((data.get("wyze") or {}).get("camera") or "").strip()
        return WYZE_BRIDGE_RTSP.format(name=camera.lower().replace(" ", "-")) if camera else ""
    return ""


def render_wyze_env(wyze: dict) -> str:
    return "".join(f"{line}={str(wyze.get(key) or '').strip()}\n" for line, key in WYZE_ENV_KEYS)


def write_private(p, text: str) -> bool:
    """Write a 0600 file atomically when its content changed; True when it did.
    Shared with tunnel.py (tunnel.token)."""
    try:
        if p.is_file() and p.read_text() == text:
            return False
    except OSError:
        pass
    tmp = p.with_suffix(p.suffix + ".tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(text)
    os.chmod(tmp, 0o600)
    tmp.replace(p)
    return True


def write_wyze_env(cfg: PlayerConfig, wyze: dict) -> bool:
    """Write wyze.env (0600) when its content changed; True when it did."""
    return write_private(wyze_env_path(cfg), render_wyze_env(wyze))


def restart_bridge() -> str:
    res = subprocess.run(["sudo", "-n", "/bin/systemctl", "restart", BRIDGE_UNIT],
                         capture_output=True, text=True, timeout=30)
    if res.returncode == 0:
        return "bridge restarted"
    return f"bridge restart failed: rc={res.returncode} {res.stderr.strip()[:200]}"


def apply(cfg: PlayerConfig, data: dict, camera: CameraCapture) -> str:
    """Bring the credentials file, the bridge and the capture thread in line
    with the console's answer. Returns the stream URL now in use."""
    source = str(data.get("source") or "none").lower()
    if source not in CAMERA_SOURCES:
        log.warning("camera config: unknown source %r, treating as none", source)
        source = "none"
    if source == "wyze" and isinstance(data.get("wyze"), dict):
        if write_wyze_env(cfg, data["wyze"]):
            log.info("camera config: wyze.env updated, %s", restart_bridge())
    url = rtsp_url(data)
    if not url:                      # nothing (usable) on the console: config.toml's camera, if any
        source, url = cfg.camera_source, cfg.camera_rtsp_url
    camera.set_source(source if url else "none", url)
    return url


def maybe_apply(cfg: PlayerConfig, manifest: dict, camera: CameraCapture, state) -> bool:
    """Fetch + apply when the manifest's camera_config_version differs from
    state.camera_config_version (None at start: the first manifest always
    fetches). A failed fetch or apply is logged, surfaced as camera.error and
    retried next cycle; the daemon never dies over it. Returns True when a
    config was applied."""
    version = manifest.get("camera_config_version")
    if not isinstance(version, int) or version == state.camera_config_version:
        return False
    try:
        data = fetch(cfg)
    except (requests.RequestException, ValueError) as e:
        log.warning("camera config fetch failed (will retry): %s", e)
        return False
    try:
        apply(cfg, data, camera)
    except (OSError, subprocess.SubprocessError) as e:   # wyze.env write or a slow bridge restart (first docker pull)
        log.warning("camera config apply failed (will retry): %s", e)
        camera.error = f"camera config: {e}"[:200]
        return False
    state.camera_config_version = version
    log.info("camera config v%s applied: source=%s", version, camera.source)
    return True
