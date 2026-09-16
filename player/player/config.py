import os
import signal
import sys
import time
from dataclasses import dataclass
from pathlib import Path

try:
    import tomllib
except ModuleNotFoundError:
    import tomli as tomllib  # type: ignore


DEFAULT_CONFIG_PATH = Path(os.environ.get("PIPLAYER_CONFIG", "/etc/projector-player/config.toml"))

# On a fatal config error the daemon pauses before exiting so that systemd's
# Restart=always does not spin the journal every 5 s on an unconfigured
# (freshly imaged) Pi. Set to 0 in tests.
CONFIG_ERROR_WAIT_SECONDS = 30


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
    # [camera] table (see load()); source "none" disables the capture thread
    camera_source: str = "none"
    camera_rtsp_url: str = ""
    camera_wyze_camera: str = ""
    camera_snapshot_interval_seconds: int = 10
    camera_live_url: str = ""


CAMERA_SOURCES = ("none", "rtsp", "wyze")
CAMERA_MIN_INTERVAL = 5
# The mrlt8/wyze-bridge container (see deploy/projector-wyze-bridge.service)
# serves each camera at rtsp://127.0.0.1:8554/<name>, the name lowercased with
# spaces turned into dashes.
WYZE_BRIDGE_RTSP = "rtsp://127.0.0.1:8554/{name}"

# Test-only hooks read by camera.py (never set on a real Pi):
#   PIPLAYER_CAMERA_FFMPEG         path to the ffmpeg binary (default "ffmpeg");
#                                  a fake can be injected here by the e2e run.
#   PIPLAYER_CAMERA_SNAPSHOT_FILE  when set, each capture reads this JPEG
#                                  instead of running ffmpeg at all.


def _env_or(default: str | None, *keys: str) -> str | None:
    for k in keys:
        v = os.environ.get(k)
        if v:
            return v
    return default


def _fail(*lines: str) -> None:
    for line in lines:
        print(f"ERROR: {line}", file=sys.stderr)
    if CONFIG_ERROR_WAIT_SECONDS > 0:
        print(f"Waiting {CONFIG_ERROR_WAIT_SECONDS}s before exiting (fix the config, then "
              f"'systemctl restart projector-player').", file=sys.stderr)
        sys.stderr.flush()
        # The daemon's own SIGTERM/SIGINT handlers only set a flag the main
        # loop checks; during this wait that would swallow `systemctl stop`
        # until TimeoutStopSec kills us. Let the default action terminate.
        signal.signal(signal.SIGTERM, signal.SIG_DFL)
        signal.signal(signal.SIGINT, signal.SIG_DFL)
        time.sleep(CONFIG_ERROR_WAIT_SECONDS)
    sys.exit(2)


def load(path: Path = DEFAULT_CONFIG_PATH) -> PlayerConfig:
    data: dict = {}
    if path.is_file():
        try:
            with path.open("rb") as f:
                data = tomllib.load(f)
        except tomllib.TOMLDecodeError as e:
            _fail(f"config file {path} is not valid TOML: {e}",
                  "Each key must appear once, e.g.:  device_id = \"lobby-projector\"")
        except OSError as e:
            _fail(f"cannot read config file {path}: {e}")
    elif not any(os.environ.get(k) for k in ("DEVICE_ID", "PIPLAYER_DEVICE_ID")):
        _fail(f"config file not found: {path}",
              "This Pi has not been configured yet. Create the file (see deploy/install-player.sh) "
              "or set DEVICE_ID, DEVICE_TOKEN and CMS_URL in the environment.")

    device_id = _env_or(data.get("device_id"), "DEVICE_ID", "PIPLAYER_DEVICE_ID")
    device_token = _env_or(data.get("device_token"), "DEVICE_TOKEN", "PIPLAYER_DEVICE_TOKEN")
    cms_url = _env_or(data.get("cms_url"), "CMS_URL", "PIPLAYER_CMS_URL")
    media_dir = Path(_env_or(data.get("media_dir"), "PIPLAYER_MEDIA_DIR") or "/var/lib/projector-player/media")
    manifest_path = Path(_env_or(data.get("manifest_path"), "PIPLAYER_MANIFEST_PATH") or "/var/lib/projector-player/manifest.json")
    mpv_socket = Path(_env_or(data.get("mpv_socket"), "PIPLAYER_MPV_SOCKET") or "/tmp/projector-mpv.sock")
    poll_raw = _env_or(str(data.get("poll_interval_seconds", "")), "PIPLAYER_POLL") or "30"
    try:
        poll = int(poll_raw)
    except ValueError:
        _fail(f"poll_interval_seconds (or PIPLAYER_POLL) must be an integer, got {poll_raw!r}")
    verify_tls_raw = _env_or(str(data.get("verify_tls", True)), "PIPLAYER_VERIFY_TLS") or "true"
    verify_tls = verify_tls_raw.lower() not in ("0", "false", "no")

    camera = data.get("camera") or {}
    if not isinstance(camera, dict):
        _fail("[camera] must be a table (a [camera] header followed by its keys)")
    camera_source = str(_env_or(camera.get("source"), "PIPLAYER_CAMERA_SOURCE") or "none").lower()
    camera_rtsp_url = str(_env_or(camera.get("rtsp_url"), "PIPLAYER_CAMERA_RTSP_URL") or "")
    camera_wyze = str(_env_or(camera.get("wyze_camera"), "PIPLAYER_CAMERA_WYZE_CAMERA") or "")
    camera_live_url = str(_env_or(camera.get("live_url"), "PIPLAYER_CAMERA_LIVE_URL") or "")
    camera_interval_raw = _env_or(str(camera.get("snapshot_interval_seconds", "")),
                                  "PIPLAYER_CAMERA_SNAPSHOT_INTERVAL") or "10"
    try:
        camera_interval = int(camera_interval_raw)
    except ValueError:
        _fail(f"[camera] snapshot_interval_seconds (or PIPLAYER_CAMERA_SNAPSHOT_INTERVAL) must be an "
              f"integer, got {camera_interval_raw!r}")
    if camera_source not in CAMERA_SOURCES:
        _fail(f"[camera] source must be one of {', '.join(CAMERA_SOURCES)}, got {camera_source!r}")
    if camera_source == "wyze":
        if not camera_wyze:
            _fail("[camera] source = 'wyze' needs wyze_camera (the camera name from the Wyze app)")
        camera_rtsp_url = WYZE_BRIDGE_RTSP.format(name=camera_wyze.strip().lower().replace(" ", "-"))
    elif camera_source == "rtsp" and not camera_rtsp_url:
        _fail("[camera] source = 'rtsp' needs rtsp_url (e.g. rtsp://user:pass@192.168.1.20:554/stream1)")

    missing = [k for k, v in {"device_id": device_id, "device_token": device_token, "cms_url": cms_url}.items() if not v]
    if missing:
        _fail(f"missing required config: {missing}",
              f"Provide via {path} or env vars (DEVICE_ID, DEVICE_TOKEN, CMS_URL).")

    return PlayerConfig(
        device_id=str(device_id),
        device_token=str(device_token),
        cms_url=str(cms_url).rstrip("/"),
        media_dir=media_dir,
        manifest_path=manifest_path,
        mpv_socket=mpv_socket,
        poll_interval_seconds=max(5, poll),
        verify_tls=verify_tls,
        camera_source=camera_source,
        camera_rtsp_url=camera_rtsp_url,
        camera_wyze_camera=camera_wyze,
        camera_snapshot_interval_seconds=max(CAMERA_MIN_INTERVAL, camera_interval),
        camera_live_url=camera_live_url,
    )
