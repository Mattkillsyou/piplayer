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
    )
