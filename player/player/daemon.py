import logging
import signal
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path

import requests

from . import __version__
from .commands import execute_commands
from .config import load as load_config, PlayerConfig
from .mpv_client import MpvClient
from .screenshots import ScreenshotScheduler, capture_and_upload
from .sync import (
    SyncError, SyncInterrupted, build_mpv_items, cleanup_stale_temp,
    load_local_manifest, missing_files, sync_once, wanted_hash,
)


log = logging.getLogger("piplayer")

# Re-hash every media file this often even when nothing changed (SD-card rot).
FULL_VERIFY_INTERVAL_SECONDS = 24 * 3600


def _setup_logging() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        stream=sys.stdout,
    )


_stop = False
_force_sync_now = False


def _handle_signal(signum, frame):
    global _stop
    log.info("received signal %s, stopping", signum)
    _stop = True


def _stop_requested() -> bool:
    return _stop


def _gather_mpv_status(mpv: MpvClient, manifest: dict | None) -> dict:
    if not mpv.is_alive():
        return {"player_status": "mpv-down"}
    pos = mpv.get_property("playlist-pos")
    paused = mpv.get_property("pause")
    idle = mpv.get_property("idle-active")
    current_path = mpv.get_property("path")

    status: dict[str, object] = {}
    if pos is not None and pos >= 0:
        status["current_position"] = pos
    if current_path:
        status["current_filename"] = Path(str(current_path)).name
    elif manifest and manifest.get("playlist") and pos is not None and pos >= 0:
        items = manifest["playlist"].get("items") or []
        if 0 <= pos < len(items):
            status["current_filename"] = items[pos]["filename"]

    if idle:
        status["player_status"] = "idle"
    elif paused:
        status["player_status"] = "paused"
    else:
        status["player_status"] = "playing"
    return status


def _push_playlist(cfg: PlayerConfig, mpv: MpvClient, manifest: dict) -> bool:
    items = build_mpv_items(cfg, manifest)
    if not items:
        log.info("no items to play; clearing mpv playlist")
    return mpv.apply_playlist(items)


def _force_sync():
    global _force_sync_now
    _force_sync_now = True


def _describe_http_error(e: requests.HTTPError) -> str:
    resp = e.response
    status = resp.status_code if resp is not None else None
    url = resp.url if resp is not None else ""
    if status == 401:
        return f"CMS rejected request (HTTP 401 Unauthorized) - check device_token in config: {url}"
    if status == 403:
        return f"CMS rejected request (HTTP 403 Forbidden) - device_token does not match device_id: {url}"
    if status == 404:
        return f"not found on CMS (HTTP 404) - check cms_url/device_id: {url}"
    return f"CMS returned HTTP {status}: {e}"


@dataclass
class PlayerState:
    """Everything the sync loop carries from one cycle to the next."""
    last_manifest: dict | None = None
    applied_hash: str | None = None      # wanted_hash() of the playlist mpv currently holds
    mpv_pid: int | None = None           # pid of the mpv instance we last talked to
    last_sync_error: str = ""
    backoff: int = 30
    force_verify: bool = False
    last_full_verify: float = field(default_factory=time.monotonic)
    idle_cycles: int = 0                 # consecutive cycles mpv sat idle with entries queued


def _reconcile_mpv(cfg: PlayerConfig, mpv: MpvClient, state: PlayerState) -> None:
    """Make mpv's playlist match the last known manifest. Runs every cycle,
    whether or not the CMS sync succeeded, so a locally cached manifest is
    pushed at startup while offline and after every mpv restart."""
    if not mpv.is_alive():
        if state.mpv_pid is not None:
            log.warning("mpv not responding; will push playlist when it is back")
            state.mpv_pid = None
        return

    pid = mpv.get_pid()
    if pid is not None and pid != state.mpv_pid:
        version = mpv.get_version() or "unknown version"
        if state.mpv_pid is None and state.applied_hash is None:
            log.info("connected to %s (pid %s)", version, pid)
        else:
            log.info("mpv restarted: %s (pid %s); re-pushing playlist", version, pid)
        state.mpv_pid = pid
        state.applied_hash = None

    manifest = state.last_manifest
    if manifest is None:
        return

    wanted = wanted_hash(cfg, manifest)
    need_push = wanted != state.applied_hash
    items = (manifest.get("playlist") or {}).get("items") or []
    # only items on disk can be pushed: with every file missing, the one
    # clear+stop already done is left alone until a file arrives (wanted_hash
    # changes then) instead of being repeated every poll
    if not need_push and items and len(missing_files(cfg, manifest)) < len(items):
        count = mpv.get_property("playlist-count")
        if count == 0:
            log.warning("mpv playlist is empty but the manifest has items; re-pushing")
            need_push = True
        elif count and mpv.get_property("idle-active"):
            # mpv gives up on a playlist once every entry failed to start (e.g.
            # no display connected at boot) and sits idle with the entries still
            # queued; loop-playlist does not retry them. Two cycles in a row
            # rules out a transition between files.
            state.idle_cycles += 1
            if state.idle_cycles >= 2:
                log.warning("mpv is idle with %s entries queued (every entry failed to play?); re-pushing", count)
                need_push = True
        else:
            state.idle_cycles = 0

    if need_push:
        state.idle_cycles = 0
        if _push_playlist(cfg, mpv, manifest):
            state.applied_hash = wanted
        else:
            log.warning("playlist push failed; will retry next iteration")
    elif not mpv.remove_stale_entry():
        state.applied_hash = None   # mpv's playlist drifted from the manifest: full re-push next cycle


def run_cycle(cfg: PlayerConfig, mpv: MpvClient, state: PlayerState,
              screenshot: ScreenshotScheduler | None = None) -> dict | None:
    """One iteration of the main loop: sync with the CMS (tolerating failure),
    then unconditionally reconcile mpv, then screenshots/commands if the sync
    succeeded. Returns the manifest fetched this cycle (None on failure)."""
    status = _gather_mpv_status(mpv, state.last_manifest)
    manifest = None
    verify_all = state.force_verify or (
        time.monotonic() - state.last_full_verify >= FULL_VERIFY_INTERVAL_SECONDS
    )
    try:
        _changed, manifest, state.last_sync_error = sync_once(
            cfg, status=status, sync_error=state.last_sync_error,
            verify_all=verify_all, should_stop=_stop_requested,
        )
        state.backoff = cfg.poll_interval_seconds
        state.last_manifest = manifest
        if verify_all:
            state.last_full_verify = time.monotonic()
            state.force_verify = False
        if state.last_sync_error:
            log.warning("sync incomplete: %s", state.last_sync_error)
    except SyncInterrupted as e:
        log.info("sync interrupted: %s", e)
        return None
    except requests.HTTPError as e:
        log.warning("%s (will retry)", _describe_http_error(e))
        state.backoff = min(state.backoff * 2, 300)
    except requests.RequestException as e:
        log.warning("CMS unreachable: %s (will retry)", e)
        state.backoff = min(state.backoff * 2, 300)
    except SyncError as e:
        log.error("sync error: %s", e)
        state.backoff = min(state.backoff * 2, 300)
    except Exception:
        log.exception("unexpected error in sync loop")
        state.backoff = min(state.backoff * 2, 300)

    # mpv state check + push decision run every cycle regardless of the sync outcome
    try:
        _reconcile_mpv(cfg, mpv, state)
    except Exception:
        log.exception("unexpected error while updating mpv")

    if manifest is None or _stop_requested():
        return manifest

    # A bad field in a foreign/old CMS manifest must not crash-loop the daemon
    try:
        # Server may have nudged our screenshot cadence
        if screenshot is not None and manifest.get("screenshot_interval_seconds"):
            screenshot.update_interval(int(manifest["screenshot_interval_seconds"]))

        # Take + upload screenshot if due
        if screenshot is not None and screenshot.due() and mpv.is_alive():
            screenshot.mark_attempt()
            capture_and_upload(cfg, mpv)

        # Execute any pending commands from the server
        commands = manifest.get("commands") or []
        if commands and not _stop_requested():
            execute_commands(cfg, mpv, commands, _force_sync)
            if any(isinstance(c, dict) and c.get("command") == "restart-mpv" for c in commands):
                # the new mpv instance starts idle: re-push now rather than
                # leaving the screen black until the next poll
                mpv.wait_for_socket(max_wait_s=10.0, should_stop=_stop_requested)
                _reconcile_mpv(cfg, mpv, state)
    except Exception:
        log.exception("unexpected error after sync")
    return manifest


def main() -> int:
    global _force_sync_now
    _setup_logging()
    signal.signal(signal.SIGTERM, _handle_signal)
    signal.signal(signal.SIGINT, _handle_signal)

    cfg = load_config()
    log.info("piplayer v%s starting", __version__)
    log.info("device_id=%s cms=%s poll=%ds", cfg.device_id, cfg.cms_url, cfg.poll_interval_seconds)

    mpv = MpvClient(cfg.mpv_socket)
    log.info("waiting for mpv socket at %s", cfg.mpv_socket)
    mpv_ready = mpv.wait_for_socket(max_wait_s=60.0, should_stop=_stop_requested)
    if _stop:
        log.info("piplayer stopped")
        return 0
    if not mpv_ready:
        log.warning("mpv socket did not appear in 60s; will keep retrying")

    screenshot = ScreenshotScheduler(interval_seconds=60)
    cleanup_stale_temp(cfg)

    state = PlayerState(
        last_manifest=load_local_manifest(cfg),
        backoff=cfg.poll_interval_seconds,
    )
    if state.last_manifest:
        log.info("loaded cached manifest from %s", cfg.manifest_path)

    while not _stop:
        run_cycle(cfg, mpv, state, screenshot)

        # Sleep, but break early if a force-sync command was queued
        for _ in range(state.backoff):
            if _stop or _force_sync_now:
                break
            time.sleep(1)
        if _force_sync_now:
            log.info("force-sync requested; running a full integrity check now")
            _force_sync_now = False
            state.force_verify = True

    log.info("piplayer stopped")
    return 0


if __name__ == "__main__":
    sys.exit(main())
