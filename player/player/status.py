import logging
import time
from dataclasses import replace
from pathlib import Path

from .config import PlayerConfig
from .mpv_client import MpvClient
from .screens import ScreenState, render_overlay_bgra, render_png

log = logging.getLogger("piplayer.status")


class StatusScreens:
    """Decides which status screen (if any) should be on the projector and pushes it to mpv."""
    OVERLAY_ID = 63
    NOWPLAYING_SECONDS = 8

    def __init__(self, cfg: PlayerConfig, mpv: MpvClient, version: str):
        self.cfg = cfg
        self.mpv = mpv
        self.version = version
        self.dir = cfg.manifest_path.parent / "screens"
        self.current: ScreenState | None = None   # what mpv shows now; None when content plays / nothing shown
        self._overlay_deadline: float | None = None
        self._last_allowed: float | None = None

    def state(self, kind: str, **fields) -> ScreenState:
        """A ScreenState with the device/console identity filled in."""
        return ScreenState(kind=kind, device_id=self.cfg.device_id, console_url=self.cfg.cms_url,
                           version=self.version, **fields)

    def show(self, state: ScreenState) -> bool:
        """Render and load the screen; a no-op when the same state (clock ignored) is already up."""
        if self.current is not None and replace(self.current, clock="") == replace(state, clock=""):
            return False
        try:
            path = render_png(state, self.dir / f"{state.kind}.png")
        except (OSError, ValueError) as e:
            # a broken install (font missing, data dir read-only) must not take the
            # sync loop down with it: content playback matters more than the screen
            log.warning("could not render status screen %s: %s", state.kind, e)
            return False
        if not self.mpv.load_replace(path, {"image-display-duration": "inf"}):
            log.warning("could not load status screen %s", state.kind)
            return False
        log.info("showing status screen: %s", state.kind)
        self.current = state
        return True

    def clear(self) -> None:
        """Content took over via a playlist push (which already replaced the screen); just forget it."""
        self.current = None

    def showing(self) -> bool:
        return self.current is not None

    def path(self) -> Path | None:
        """The PNG mpv holds for the current screen (what mpv's `path` reports)."""
        return self.dir / f"{self.current.kind}.png" if self.current is not None else None

    def now_playing(self, playlist_name: str, item_count: int, source: str | None) -> None:
        state = self.state("nowplaying", playlist_name=playlist_name, item_count=item_count, source=source)
        try:
            path, w, h = render_overlay_bgra(state, self.dir / "nowplaying.bgra")
        except (OSError, ValueError) as e:
            log.warning("could not render the now-playing overlay: %s", e)
            return
        self.mpv.command("overlay-add", self.OVERLAY_ID, 0, 0, str(path), 0, "bgra", w, h, w * 4)
        self._overlay_deadline = time.monotonic() + self.NOWPLAYING_SECONDS

    def tick(self) -> None:
        """Once a second from the main loop: take the overlay down after its deadline."""
        if self._overlay_deadline is not None and time.monotonic() >= self._overlay_deadline:
            self._overlay_deadline = None
            self.mpv.command("overlay-remove", self.OVERLAY_ID)

    def throttled(self, seconds: float = 2.0) -> bool:
        """True at most once per `seconds` (rate limit for syncing progress redraws)."""
        now = time.monotonic()
        if self._last_allowed is not None and now - self._last_allowed < seconds:
            return False
        self._last_allowed = now
        return True
