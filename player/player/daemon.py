import logging
import signal
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

import requests

from . import __version__, camera_config, updater
from .camera import CameraCapture
from .commands import _run_reboot, execute_commands
from .config import load as load_config, PlayerConfig
from .mpv_client import MpvClient
from .projector import Projector
from .screenshots import ScreenshotScheduler, capture_and_upload
from .status import StatusScreens
from .sync import (
    SyncError, SyncInterrupted, build_mpv_items, cleanup_stale_temp,
    load_local_manifest, missing_files, sync_once, wanted_hash,
)


log = logging.getLogger("piplayer")

# Re-hash every media file this often even when nothing changed (SD-card rot).
FULL_VERIFY_INTERVAL_SECONDS = 24 * 3600
# While the player-fault screen is up, try the content again every this many
# cycles (a display plugged in later, a transient vo failure) instead of never.
FAULT_RETRY_CYCLES = 10


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
    idle_streak: int = 0                 # same, but not reset by the idle re-push (player fault detection)
    last_failure: str | None = None      # why the last sync failed: token | unreachable | http | sync (None: it worked)
    failure_text: str = ""
    last_contact: float | None = None    # monotonic time of the last successful sync
    storage_full: bool = False           # a download hit ENOSPC during the last sync
    last_auto_update: datetime | None = None   # when this daemon last started a nightly update-player
    camera_config_version: int | None = None   # manifest camera_config_version applied last (None: fetch on start)
    projector: Projector = field(default_factory=Projector)   # power state/error + last auto `want` applied


def _age_text(since: float | None) -> str:
    if since is None:
        return "never"
    s = int(time.monotonic() - since)
    if s < 60:
        return f"{s} s ago"
    if s < 3600:
        return f"{s // 60} min ago"
    return f"{s // 3600} h ago"


def _device_name(manifest: dict | None) -> str:
    return str(((manifest or {}).get("device") or {}).get("name") or "")


def _failure_screen(state: PlayerState, screens: StatusScreens, manifest: dict | None) -> bool:
    """Screen for a sync that could not fetch the manifest or any media. Returns
    False when the failure kind has no screen of its own."""
    name = _device_name(manifest)
    if state.last_failure == "token":
        screens.show(screens.state("error", device_name=name, reason="token"))
    elif state.last_failure == "unreachable":
        screens.show(screens.state("offline", device_name=name, cached=False, last_contact=_age_text(state.last_contact)))
    elif state.storage_full:
        screens.show(screens.state("error", device_name=name, reason="storage", message=state.last_sync_error))
    elif state.last_failure in ("http", "sync"):
        screens.show(screens.state("error", device_name=name, reason="other", message=state.failure_text))
    else:
        return False
    return True


def _idle_screen(state: PlayerState, screens: StatusScreens, manifest: dict) -> None:
    """Manifest known but nothing playable: say why."""
    playlist = manifest.get("playlist")
    name = _device_name(manifest)
    next_rule = manifest.get("next_rule") or None
    if playlist is None and not next_rule:
        screens.show(screens.state("pairing", device_name=name))
    elif not (playlist or {}).get("items"):
        screens.show(screens.state("waiting", device_name=name, playlist_name=(playlist or {}).get("name"),
                                   next_rule=next_rule))
    elif not _failure_screen(state, screens, manifest):
        screens.show(screens.state("error", device_name=name, reason="other",
                                   message=state.last_sync_error or state.failure_text or "no media could be downloaded"))


def _reconcile_mpv(cfg: PlayerConfig, mpv: MpvClient, state: PlayerState,
                   screens: StatusScreens | None = None) -> None:
    """Make mpv's playlist match the last known manifest. Runs every cycle,
    whether or not the CMS sync succeeded, so a locally cached manifest is
    pushed at startup while offline and after every mpv restart. With
    `screens`, a status screen is shown whenever there is nothing to play."""
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
        if screens is not None:
            screens.clear()       # the new instance starts black; the right screen is re-shown below

    manifest = state.last_manifest
    if manifest is None:
        if screens is not None:
            _failure_screen(state, screens, None)   # before the first sync the boot screen stays up
        return

    wanted = wanted_hash(cfg, manifest)
    need_push = wanted != state.applied_hash
    items = (manifest.get("playlist") or {}).get("items") or []
    # only items on disk can be pushed: with every file missing, the one
    # clear+stop already done is left alone until a file arrives (wanted_hash
    # changes then) instead of being repeated every poll
    if not need_push and items and len(missing_files(cfg, manifest)) < len(items):
        count = mpv.get_property("playlist-count")
        # the fault screen (if mpv managed to show it) counts as idle so the
        # streak keeps running and the slow retry below fires
        on_fault = screens is not None and screens.current is not None and screens.current.reason == "player"
        if count == 0:
            log.warning("mpv playlist is empty but the manifest has items; re-pushing")
            need_push = True
        elif count and (on_fault or mpv.get_property("idle-active")):
            # mpv gives up on a playlist once every entry failed to start (e.g.
            # no display connected at boot) and sits idle with the entries still
            # queued; loop-playlist does not retry them. Two cycles in a row
            # rules out a transition between files.
            state.idle_cycles += 1
            state.idle_streak += 1
            if screens is not None and state.idle_streak % FAULT_RETRY_CYCLES == 0:
                log.warning("retrying the playlist after the player fault (%s idle cycles)", state.idle_streak)
                need_push = True
            elif screens is not None and state.idle_streak >= 4:
                # the re-push did not help either: stop retrying and say so on screen
                message = f"mpv could not start any of {len(items)} items"
                if screens.show(screens.state("error", device_name=_device_name(manifest), reason="player", message=message)):
                    log.warning("%s; showing the player fault screen", message)
            elif state.idle_cycles >= 2:
                log.warning("mpv is idle with %s entries queued (every entry failed to play?); re-pushing", count)
                need_push = True
        else:
            state.idle_cycles = 0
            state.idle_streak = 0

    if need_push:
        state.idle_cycles = 0
        if screens is not None and not build_mpv_items(cfg, manifest):
            # nothing on disk to push: a status screen instead of a black mpv.
            # The screen replaces whatever mpv held, so applied_hash is dropped:
            # this is re-evaluated every cycle and the same playlist coming back
            # later (unassign/reassign, schedule gap) is pushed again
            _idle_screen(state, screens, manifest)
            state.applied_hash = None
            return
        was_screen = screens is not None and screens.showing()
        previous = state.applied_hash
        if _push_playlist(cfg, mpv, manifest):
            state.applied_hash = wanted
            if screens is not None:
                screens.clear()
                if was_screen or (previous is not None and previous != wanted):
                    playlist = manifest.get("playlist") or {}
                    screens.now_playing(str(playlist.get("name") or ""), len(items), playlist.get("source"))
        else:
            log.warning("playlist push failed; will retry next iteration")
            if was_screen and mpv.get_property("path") != str(screens.path()):
                screens.clear()     # the first item did load: content is on screen, not the PNG
    elif not mpv.remove_stale_entry():
        state.applied_hash = None   # mpv's playlist drifted from the manifest: full re-push next cycle


def run_cycle(cfg: PlayerConfig, mpv: MpvClient, state: PlayerState,
              screenshot: ScreenshotScheduler | None = None,
              screens: StatusScreens | None = None,
              camera: CameraCapture | None = None) -> dict | None:
    """One iteration of the main loop: sync with the CMS (tolerating failure),
    then unconditionally reconcile mpv, then screenshots/commands if the sync
    succeeded. Returns the manifest fetched this cycle (None on failure)."""
    status = _gather_mpv_status(mpv, state.last_manifest)
    if screens is not None and screens.showing() and status.get("player_status") == "playing":
        status = {"player_status": "idle"}      # a status screen is not content
    if camera is not None:
        status["camera_error"] = camera.error   # "" clears the console's last error
    status["projector_state"] = state.projector.state
    status["projector_error"] = state.projector.error     # "" clears the console's last error
    pending_update = updater.pending_status(cfg)     # outcome of the last update-*.sh run, reported once
    if pending_update is not None:
        status["update_status"] = pending_update.param
    manifest = None
    on_progress = None
    if screens is not None:
        def on_progress(info: dict) -> None:
            # syncing progress goes on screen only when nothing is playing, at most every 2 s
            if not screens.throttled():
                return
            count = mpv.get_property("playlist-count")
            if count is None:
                return                  # mpv down: nothing to draw on, do not render for nothing
            if not screens.showing() and count and not mpv.get_property("idle-active"):
                return
            shown = screens.show(screens.state(
                "syncing", device_name=_device_name(state.last_manifest), phase=info["phase"],
                progress_done=info["index"], progress_total=info["total"], current_file=info["filename"],
                bytes_done=info.get("bytes_done"), bytes_total=info.get("bytes_total"),
            ))
            if shown:
                state.applied_hash = None   # the screen replaced mpv's playlist: re-push after the sync
    verify_all = state.force_verify or (
        time.monotonic() - state.last_full_verify >= FULL_VERIFY_INTERVAL_SECONDS
    )
    try:
        _changed, manifest, state.last_sync_error = sync_once(
            cfg, status=status, sync_error=state.last_sync_error,
            verify_all=verify_all, should_stop=_stop_requested, on_progress=on_progress,
        )
        state.backoff = cfg.poll_interval_seconds
        state.last_manifest = manifest
        state.last_failure, state.failure_text = None, ""
        state.last_contact = time.monotonic()
        state.storage_full = "no space left" in state.last_sync_error
        if pending_update is not None:
            updater.mark_reported(cfg, pending_update)
            if pending_update.reboot:
                log.info("update-os left reboot-required; status reported, rebooting: %s", _run_reboot())
                return manifest
        if verify_all:
            state.last_full_verify = time.monotonic()
            state.force_verify = False
        if state.last_sync_error:
            log.warning("sync incomplete: %s", state.last_sync_error)
    except SyncInterrupted as e:
        log.info("sync interrupted: %s", e)
        return None
    except requests.HTTPError as e:
        state.failure_text = _describe_http_error(e)
        status_code = e.response.status_code if e.response is not None else None
        state.last_failure = "token" if status_code in (401, 403) else "http"
        log.warning("%s (will retry)", state.failure_text)
        state.backoff = min(state.backoff * 2, 300)
    except requests.RequestException as e:
        state.last_failure, state.failure_text = "unreachable", str(e)
        log.warning("CMS unreachable: %s (will retry)", e)
        state.backoff = min(state.backoff * 2, 300)
    except SyncError as e:
        state.last_failure, state.failure_text = "sync", str(e)
        log.error("sync error: %s", e)
        state.backoff = min(state.backoff * 2, 300)
    except Exception as e:
        state.last_failure, state.failure_text = "sync", f"{type(e).__name__}: {e}"
        log.exception("unexpected error in sync loop")
        state.backoff = min(state.backoff * 2, 300)

    # mpv state check + push decision run every cycle regardless of the sync outcome
    try:
        _reconcile_mpv(cfg, mpv, state, screens)
    except Exception:
        log.exception("unexpected error while updating mpv")

    if manifest is None or _stop_requested():
        return manifest

    # A bad field in a foreign/old CMS manifest must not crash-loop the daemon
    try:
        # Server may have nudged our screenshot cadence
        if screenshot is not None and manifest.get("screenshot_interval_seconds"):
            screenshot.update_interval(int(manifest["screenshot_interval_seconds"]))
        if camera is not None and manifest.get("camera_interval_seconds"):
            camera.update_interval(int(manifest["camera_interval_seconds"]))
        if camera is not None:
            camera_config.maybe_apply(cfg, manifest, camera, state)

        # Take + upload screenshot if due
        if screenshot is not None and screenshot.due() and mpv.is_alive():
            screenshot.mark_attempt()
            capture_and_upload(cfg, mpv)

        # Execute any pending commands from the server
        state.projector.set_block(manifest.get("projector"))
        commands = manifest.get("commands") or []
        if commands and not _stop_requested():
            execute_commands(cfg, mpv, commands, _force_sync, update=manifest.get("update"),
                             projector=state.projector)
            if any(isinstance(c, dict) and c.get("command") == "restart-mpv" for c in commands):
                # the new mpv instance starts idle: re-push now rather than
                # leaving the screen black until the next poll
                mpv.wait_for_socket(max_wait_s=10.0, should_stop=_stop_requested)
                _reconcile_mpv(cfg, mpv, state, screens)
        updater.maybe_auto_update(cfg, manifest.get("update"), state)
        state.projector.maybe_apply()
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
    screens = StatusScreens(cfg, mpv, __version__)
    # always started: idles until config.toml or the console (camera_config) names a stream
    camera = CameraCapture(cfg)
    camera.start()
    cleanup_stale_temp(cfg)

    state = PlayerState(
        last_manifest=load_local_manifest(cfg),
        backoff=cfg.poll_interval_seconds,
    )
    if state.last_manifest:
        log.info("loaded cached manifest from %s", cfg.manifest_path)
    elif mpv_ready:
        screens.show(screens.state("boot"))

    while not _stop:
        run_cycle(cfg, mpv, state, screenshot, screens, camera)

        # Sleep, but break early if a force-sync command was queued
        for _ in range(state.backoff):
            if _stop or _force_sync_now:
                break
            time.sleep(1)
            screens.tick()
        if _force_sync_now:
            log.info("force-sync requested; running a full integrity check now")
            _force_sync_now = False
            state.force_verify = True

    camera.stop()
    log.info("piplayer stopped")
    return 0


if __name__ == "__main__":
    sys.exit(main())
