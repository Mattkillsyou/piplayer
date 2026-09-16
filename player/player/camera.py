"""Room camera: grab one JPEG from the RTSP stream with ffmpeg every N seconds
and upload it to the CMS (POST /api/camera/<device_id>, like screenshots.py).

Runs in its own daemon thread so a hung camera never blocks the sync loop;
one capture is in flight at a time. Failures are logged at most once per
LOG_EVERY_SECONDS and surfaced to the console as `error` (sent up as the
camera_error sync param by the daemon)."""
import io
import logging
import os
import subprocess
import threading
import time

import requests

from . import __version__
from .config import CAMERA_MIN_INTERVAL, PlayerConfig

log = logging.getLogger("piplayer.camera")

CAPTURE_TIMEOUT_SECONDS = 15
MAX_JPEG_BYTES = 2 * 1024 * 1024
ERROR_MAX_LEN = 200
LOG_EVERY_SECONDS = 600


class CameraError(Exception):
    pass


def grab_jpeg(rtsp_url: str) -> bytes:
    """One frame from the stream as JPEG bytes (see config.py for the two
    PIPLAYER_CAMERA_* test hooks)."""
    snapshot_file = os.environ.get("PIPLAYER_CAMERA_SNAPSHOT_FILE")
    if snapshot_file:
        try:
            with open(snapshot_file, "rb") as f:
                data = f.read()
        except OSError as e:
            raise CameraError(f"snapshot file: {e}") from e
    else:
        ffmpeg = os.environ.get("PIPLAYER_CAMERA_FFMPEG") or "ffmpeg"
        cmd = [ffmpeg, "-nostdin", "-loglevel", "error"]
        if rtsp_url.lower().startswith("rtsp://"):
            cmd += ["-rtsp_transport", "tcp"]      # ffmpeg rejects the option on non-RTSP inputs
        cmd += ["-i", rtsp_url, "-frames:v", "1", "-q:v", "5", "-f", "image2", "-"]
        try:
            proc = subprocess.run(cmd, capture_output=True, timeout=CAPTURE_TIMEOUT_SECONDS)
        except subprocess.TimeoutExpired as e:
            raise CameraError(f"ffmpeg timed out after {CAPTURE_TIMEOUT_SECONDS}s (camera unreachable?)") from e
        except OSError as e:
            raise CameraError(f"cannot run {ffmpeg}: {e}") from e
        if proc.returncode != 0:
            detail = (proc.stderr or b"").decode("utf-8", "replace").strip().splitlines()
            raise CameraError(f"ffmpeg failed (exit {proc.returncode}): {detail[-1] if detail else 'no output'}")
        data = proc.stdout or b""
    if not data.startswith(b"\xff\xd8\xff"):
        raise CameraError("ffmpeg produced no JPEG frame")
    if len(data) > MAX_JPEG_BYTES:
        raise CameraError(f"snapshot too large ({len(data)} bytes, max {MAX_JPEG_BYTES})")
    return data


def upload(cfg: PlayerConfig, data: bytes) -> None:
    r = requests.post(
        f"{cfg.cms_url}/api/camera/{cfg.device_id}",
        headers={
            "Authorization": f"Bearer {cfg.device_token}",
            "User-Agent": f"piplayer/{__version__}",
        },
        files={"file": (f"{cfg.device_id}.jpg", io.BytesIO(data), "image/jpeg")},
        timeout=15,
        verify=cfg.verify_tls,
    )
    if r.status_code != 200:
        raise CameraError(f"upload failed: HTTP {r.status_code} {r.text[:80]}")


class CameraCapture(threading.Thread):
    """Background capture + upload loop. `error` is "" while the last cycle
    worked, else a short text for the console."""

    def __init__(self, cfg: PlayerConfig):
        super().__init__(name="camera", daemon=True)
        self.cfg = cfg
        self.interval = cfg.camera_snapshot_interval_seconds
        self.error = ""
        self._stop = threading.Event()
        self._last_log = -LOG_EVERY_SECONDS  # so the first failure is always logged

    def update_interval(self, seconds: int) -> None:
        new = max(CAMERA_MIN_INTERVAL, int(seconds))
        if new != self.interval:
            log.info("camera interval updated: %ds -> %ds", self.interval, new)
            self.interval = new

    def stop(self) -> None:
        self._stop.set()

    def capture_once(self) -> bool:
        try:
            upload(self.cfg, grab_jpeg(self.cfg.camera_rtsp_url))
        except (CameraError, requests.RequestException) as e:
            self._fail(f"{e}")
            return False
        except Exception as e:
            self._fail(f"{type(e).__name__}: {e}")
            return False
        if self.error:
            log.info("camera snapshot ok again")
        self.error = ""
        return True

    def _fail(self, text: str) -> None:
        self.error = text[:ERROR_MAX_LEN]
        now = time.monotonic()
        if now - self._last_log >= LOG_EVERY_SECONDS:
            self._last_log = now
            log.warning("camera snapshot failed: %s", self.error)

    def run(self) -> None:
        log.info("camera capture started: %s every %ds", self.cfg.camera_rtsp_url, self.interval)
        while not self._stop.is_set():
            self.capture_once()
            self._stop.wait(self.interval)
