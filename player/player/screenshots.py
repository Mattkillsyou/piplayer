"""Periodic screenshot capture via mpv IPC, upload to CMS."""
import logging
import tempfile
import time
from pathlib import Path

import requests

from . import __version__
from .config import PlayerConfig
from .mpv_client import MpvClient

log = logging.getLogger("piplayer.screenshot")


def capture_and_upload(cfg: PlayerConfig, mpv: MpvClient) -> bool:
    if not mpv.is_alive():
        return False

    fd, tmp_str = tempfile.mkstemp(suffix=".jpg", prefix="piplayer-screen-")
    import os as _os
    _os.close(fd)
    tmp = Path(tmp_str)
    try:
        reply = mpv.command("screenshot-to-file", str(tmp), "video")
        if reply is None or reply.get("error") != "success":
            log.debug("screenshot-to-file failed: %s", reply)
            return False
        if not tmp.is_file() or tmp.stat().st_size == 0:
            log.debug("screenshot file missing or empty")
            return False
        with tmp.open("rb") as f:
            r = requests.post(
                f"{cfg.cms_url}/api/screenshots/{cfg.device_id}",
                headers={
                    "Authorization": f"Bearer {cfg.device_token}",
                    "User-Agent": f"piplayer/{__version__}",
                },
                files={"file": (f"{cfg.device_id}.jpg", f, "image/jpeg")},
                timeout=30,
                verify=cfg.verify_tls,
            )
        if r.status_code != 200:
            log.warning("screenshot upload failed: HTTP %d %s", r.status_code, r.text[:200])
            return False
        return True
    except Exception:
        log.exception("screenshot capture/upload error")
        return False
    finally:
        tmp.unlink(missing_ok=True)


class ScreenshotScheduler:
    """Tracks when to take the next screenshot."""

    def __init__(self, interval_seconds: int = 60):
        self.interval = max(15, int(interval_seconds))
        self._last_attempt = 0.0

    def update_interval(self, interval_seconds: int) -> None:
        new_interval = max(15, int(interval_seconds))
        if new_interval != self.interval:
            log.info("screenshot interval updated: %ds -> %ds", self.interval, new_interval)
            self.interval = new_interval

    def due(self) -> bool:
        return time.monotonic() - self._last_attempt >= self.interval

    def mark_attempt(self) -> None:
        self._last_attempt = time.monotonic()
