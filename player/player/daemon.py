import logging
import signal
import sys
import time
from pathlib import Path

import requests

from . import __version__
from .commands import execute_commands
from .config import load as load_config, PlayerConfig
from .mpv_client import MpvClient
from .screenshots import ScreenshotScheduler, capture_and_upload
from .sync import SyncError, build_mpv_items, load_local_manifest, sync_once


log = logging.getLogger("piplayer")


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
        mpv.command("playlist-clear")
        mpv.command("stop")
        return True
    return mpv.load_full_playlist(items)


def _force_sync():
    global _force_sync_now
    _force_sync_now = True


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
    mpv_ready = mpv.wait_for_socket(max_wait_s=60.0)
    if not mpv_ready:
        log.warning("mpv socket did not appear in 60s; will keep retrying")

    screenshot = ScreenshotScheduler(interval_seconds=60)

    backoff = cfg.poll_interval_seconds
    loaded_hash: str | None = None
    last_mpv_alive = False
    last_manifest: dict | None = load_local_manifest(cfg)

    while not _stop:
        try:
            status = _gather_mpv_status(mpv, last_manifest)
            changed, manifest = sync_once(cfg, status=status)
            backoff = cfg.poll_interval_seconds
            last_manifest = manifest

            mpv_alive = mpv.is_alive()
            mpv_just_came_back = mpv_alive and not last_mpv_alive
            last_mpv_alive = mpv_alive

            new_hash = (manifest.get("playlist") or {}).get("hash") if manifest else None

            need_push = False
            if changed:
                need_push = True
            elif mpv_just_came_back and last_manifest:
                log.info("mpv came back online; re-pushing last known playlist")
                need_push = True
            elif loaded_hash is None and mpv_alive and last_manifest and last_manifest.get("playlist"):
                need_push = True

            if need_push and manifest:
                if not mpv_alive:
                    log.warning("mpv not responding; will push on next iteration")
                else:
                    if _push_playlist(cfg, mpv, manifest):
                        loaded_hash = new_hash

            # Server may have nudged our screenshot cadence
            if manifest and manifest.get("screenshot_interval_seconds"):
                screenshot.update_interval(int(manifest["screenshot_interval_seconds"]))

            # Take + upload screenshot if due
            if screenshot.due() and mpv_alive:
                screenshot.mark_attempt()
                capture_and_upload(cfg, mpv)

            # Execute any pending commands from the server
            commands = manifest.get("commands") or [] if manifest else []
            if commands:
                execute_commands(cfg, mpv, commands, _force_sync)
        except requests.RequestException as e:
            log.warning("CMS unreachable: %s (will retry)", e)
            backoff = min(backoff * 2, 300)
        except SyncError as e:
            log.error("sync error: %s", e)
            backoff = min(backoff * 2, 300)
        except Exception:
            log.exception("unexpected error in sync loop")
            backoff = min(backoff * 2, 300)

        # Sleep, but break early if a force-sync command was queued
        for _ in range(backoff):
            if _stop or _force_sync_now:
                break
            time.sleep(1)
        if _force_sync_now:
            log.info("force-sync requested; running another cycle now")
            _force_sync_now = False

    log.info("piplayer stopped")
    return 0


if __name__ == "__main__":
    sys.exit(main())
