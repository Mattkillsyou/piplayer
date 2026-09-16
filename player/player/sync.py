import errno
import hashlib
import json
import logging
import re
from pathlib import Path
from typing import Callable

import requests

from . import __version__, updater
from .config import PlayerConfig

log = logging.getLogger("piplayer.sync")

SAFE_FILENAME = re.compile(r"^[A-Za-z0-9._-]+$")
PART_SUFFIX = ".part"
SYNC_ERROR_MAX_LEN = 200


class SyncError(Exception):
    pass


class SyncInterrupted(SyncError):
    """Raised when a shutdown was requested in the middle of a download/hash."""


def _never_stop() -> bool:
    return False


Progress = Callable[[dict], None]


def _no_progress(_info: dict) -> None:
    pass


def _hash_file(path: Path, should_stop: Callable[[], bool] = _never_stop) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            if should_stop():
                raise SyncInterrupted(f"stopped while hashing {path.name}")
            h.update(chunk)
    return h.hexdigest()


def load_local_manifest(cfg: PlayerConfig) -> dict | None:
    if not cfg.manifest_path.is_file():
        return None
    try:
        return json.loads(cfg.manifest_path.read_text())
    except (json.JSONDecodeError, OSError) as e:
        log.warning("failed to read local manifest: %s", e)
        return None


def _write_json_atomic(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, indent=2))
    tmp.replace(path)


def _save_local_manifest(cfg: PlayerConfig, manifest: dict) -> None:
    _write_json_atomic(cfg.manifest_path, manifest)


# --- media index: {filename: {"sha256", "size", "mtime"}} of verified files ---

def media_index_path(cfg: PlayerConfig) -> Path:
    return cfg.manifest_path.parent / "media_index.json"


def load_media_index(cfg: PlayerConfig) -> dict:
    p = media_index_path(cfg)
    if not p.is_file():
        return {}
    try:
        data = json.loads(p.read_text())
        return data if isinstance(data, dict) else {}
    except (json.JSONDecodeError, OSError) as e:
        log.warning("failed to read media index: %s", e)
        return {}


def save_media_index(cfg: PlayerConfig, index: dict) -> None:
    _write_json_atomic(media_index_path(cfg), index)


def _index_entry(path: Path, sha256: str) -> dict:
    st = path.stat()
    return {"sha256": sha256, "size": st.st_size, "mtime": st.st_mtime}


def _matches_index(path: Path, sha256: str, index: dict) -> bool:
    entry = index.get(path.name)
    if not isinstance(entry, dict) or entry.get("sha256") != sha256:
        return False
    try:
        st = path.stat()
    except OSError:
        return False
    return entry.get("size") == st.st_size and entry.get("mtime") == st.st_mtime


def fetch_manifest(cfg: PlayerConfig, status: dict | None = None, sync_error: str = "") -> dict:
    url = f"{cfg.cms_url}/api/sync/{cfg.device_id}"
    headers = {
        "Authorization": f"Bearer {cfg.device_token}",
        "User-Agent": f"piplayer/{__version__}",
    }
    params: dict[str, str] = {"player_version": updater.player_version()}
    if status:
        for k in ("current_position", "current_filename", "player_status", "camera_error", "update_status",
                  "projector_state", "projector_error"):
            v = status.get(k)
            if v is not None:
                params[k] = str(v)
    params["sync_error"] = (sync_error or "")[:SYNC_ERROR_MAX_LEN]
    r = requests.get(url, headers=headers, params=params, timeout=15, verify=cfg.verify_tls)
    r.raise_for_status()
    return r.json()


def _download_item(cfg: PlayerConfig, item: dict, should_stop: Callable[[], bool] = _never_stop,
                   on_progress: Progress = _no_progress, progress: dict | None = None) -> Path:
    """Download item into media_dir, resuming an interrupted transfer from
    <filename>.part with an HTTP Range request. Returns the final path.
    `progress` (index/total/filename) is passed through to on_progress with
    the byte counts, at most once per received chunk."""
    filename = item["filename"]
    progress = progress or {"index": 1, "total": 1, "filename": filename}
    total_bytes = item.get("size_bytes") or None
    if not SAFE_FILENAME.match(filename):
        raise SyncError(f"refusing unsafe filename: {filename}")

    cfg.media_dir.mkdir(parents=True, exist_ok=True)
    target = cfg.media_dir / filename
    part = cfg.media_dir / (filename + PART_SUFFIX)
    headers = {
        "Authorization": f"Bearer {cfg.device_token}",
        "User-Agent": f"piplayer/{__version__}",
    }

    # A .part that already holds every byte (the process died between the last
    # write and the rename) is finished locally: a Range request past the end
    # would get a 416 and restart the whole download.
    if part.is_file() and item.get("size_bytes") and part.stat().st_size == item["size_bytes"]:
        if _hash_file(part, should_stop) == item["sha256"]:
            part.replace(target)
            log.info("completed %s from its partial download", filename)
            return target
        part.unlink(missing_ok=True)

    for attempt in (1, 2):
        resume_from = part.stat().st_size if part.is_file() else 0
        req_headers = dict(headers)
        if resume_from:
            req_headers["Range"] = f"bytes={resume_from}-"
            log.info("resuming %s from byte %d", filename, resume_from)
        else:
            log.info("downloading %s (%.1f MB)", filename, (item.get("size_bytes") or 0) / 1024 / 1024)

        on_progress(dict(progress, phase="downloading", bytes_done=resume_from, bytes_total=total_bytes))
        # (connect, read) timeouts: the read timeout bounds one stalled recv, and
        # the shutdown flag is only polled between chunks, so keep it below the
        # unit's TimeoutStopSec.
        with requests.get(item["url"], headers=req_headers, stream=True, timeout=(10, 15), verify=cfg.verify_tls) as r:
            if r.status_code == 416 and resume_from:
                # our partial file is not a prefix the server can extend; start over
                log.warning("server cannot resume %s (416); restarting download", filename)
                part.unlink(missing_ok=True)
                if attempt == 1:
                    continue
                raise SyncError(f"cannot resume {filename}: HTTP 416")
            r.raise_for_status()
            hasher = hashlib.sha256()
            if r.status_code == 206 and resume_from:
                # the sha256 must cover the bytes we already have
                with part.open("rb") as f:
                    for chunk in iter(lambda: f.read(1024 * 1024), b""):
                        if should_stop():
                            raise SyncInterrupted(f"stopped while resuming {filename}")
                        hasher.update(chunk)
                mode = "ab"
            else:
                if resume_from:
                    log.info("server ignored Range for %s; restarting from byte 0", filename)
                mode = "wb"
            done = resume_from if mode == "ab" else 0
            with part.open(mode) as out:
                for chunk in r.iter_content(chunk_size=1024 * 1024):
                    if should_stop():
                        # keep the .part so the next start can resume it
                        raise SyncInterrupted(f"stopped while downloading {filename}")
                    if chunk:
                        out.write(chunk)
                        hasher.update(chunk)
                        done += len(chunk)
                        on_progress(dict(progress, phase="downloading", bytes_done=done, bytes_total=total_bytes))
        break

    actual_sha = hasher.hexdigest()
    if actual_sha != item["sha256"]:
        part.unlink(missing_ok=True)
        raise SyncError(f"sha256 mismatch for {filename}: got {actual_sha}, expected {item['sha256']}")
    part.replace(target)
    log.info("downloaded %s", filename)
    return target


def _ensure_item(cfg: PlayerConfig, item: dict, index: dict, verify: bool,
                 should_stop: Callable[[], bool], on_progress: Progress = _no_progress,
                 progress: dict | None = None) -> bool:
    """Make sure item's file is present and verified. Returns True when a
    download happened (False when the existing file was accepted)."""
    filename = item["filename"]
    if not SAFE_FILENAME.match(filename):
        raise SyncError(f"refusing unsafe filename: {filename}")
    progress = progress or {"index": 1, "total": 1, "filename": filename}
    target = cfg.media_dir / filename
    if target.is_file():
        if not verify and _matches_index(target, item["sha256"], index):
            return False
        on_progress(dict(progress, phase="verifying", bytes_done=None, bytes_total=item.get("size_bytes")))
        existing_sha = _hash_file(target, should_stop)
        if existing_sha == item["sha256"]:
            index[filename] = _index_entry(target, existing_sha)
            return False
        log.warning("hash mismatch for existing %s, redownloading", filename)
        target.unlink()
        index.pop(filename, None)
    _download_item(cfg, item, should_stop, on_progress, progress)
    index[filename] = _index_entry(target, item["sha256"])
    return True


def _is_stale_temp(name: str) -> bool:
    return name.startswith(".download_") and name.endswith(".tmp")


def cleanup_stale_temp(cfg: PlayerConfig) -> None:
    """Remove leftover .download_*.tmp files (from interrupted downloads of
    older player versions, or a SIGKILL mid-transfer)."""
    if not cfg.media_dir.is_dir():
        return
    for p in cfg.media_dir.iterdir():
        if p.is_file() and _is_stale_temp(p.name):
            log.info("removing stale temp file: %s", p.name)
            try:
                p.unlink()
            except OSError as e:
                log.warning("failed to remove %s: %s", p, e)


def _prune_stale(cfg: PlayerConfig, keep_filenames: set[str], index: dict | None = None) -> None:
    if not cfg.media_dir.is_dir():
        return
    for p in cfg.media_dir.iterdir():
        if not p.is_file():
            continue
        name = p.name
        if _is_stale_temp(name):
            log.info("removing stale temp file: %s", name)
        elif name.startswith("."):
            continue
        elif name.endswith(PART_SUFFIX):
            if name[: -len(PART_SUFFIX)] in keep_filenames:
                continue
            log.info("removing stale partial download: %s", name)
        elif name in keep_filenames:
            continue
        else:
            log.info("removing stale media: %s", name)
        try:
            p.unlink()
        except OSError as e:
            log.warning("failed to remove %s: %s", p, e)
    if index is not None:
        for name in list(index):
            if name not in keep_filenames:
                index.pop(name, None)


def _item_options(item: dict) -> dict:
    opts: dict[str, str] = {}
    eff = item.get("effective_duration_seconds")
    if item.get("media_type") == "image":
        duration_val = eff if eff is not None else 10
        opts["image-display-duration"] = str(duration_val)
    else:
        if eff is not None:
            opts["length"] = str(eff)
            if item.get("filename", "").lower().endswith(".gif"):
                # Animated GIF (the CMS classifies multi-frame GIFs as video):
                # ffmpeg's gif demuxer plays a GIF once by default, so a
                # duration longer than the animation would end early. Honour
                # the file's NETSCAPE loop count instead so `length` bounds it.
                # A GIF without that extension still plays once, natively.
                opts["demuxer-lavf-o"] = "ignore_loop=0"
    return opts


def missing_files(cfg: PlayerConfig, manifest: dict | None) -> list[str]:
    """Filenames of manifest items that are not present in media_dir."""
    playlist = (manifest or {}).get("playlist")
    if not playlist or not playlist.get("items"):
        return []
    return [it["filename"] for it in playlist["items"] if not (cfg.media_dir / it["filename"]).is_file()]


def build_mpv_items(cfg: PlayerConfig, manifest: dict, present_only: bool = True) -> list[tuple[Path, dict]]:
    """Translate manifest items into (local_path, mpv_options) tuples.
    Items whose file is not on disk (failed/incomplete download) are skipped
    when present_only is set, so a playlist can play around a missing item."""
    playlist = manifest.get("playlist")
    if not playlist or not playlist.get("items"):
        return []
    out: list[tuple[Path, dict]] = []
    for item in playlist["items"]:
        path = cfg.media_dir / item["filename"]
        if present_only and not path.is_file():
            log.warning("skipping %s: not downloaded yet", item["filename"])
            continue
        out.append((path, _item_options(item)))
    return out


def wanted_hash(cfg: PlayerConfig, manifest: dict | None) -> str:
    """Identity of the playlist that should be in mpv for this manifest: the
    CMS playlist hash, qualified by any items missing on disk (so the list is
    re-pushed once a missing item arrives)."""
    if not manifest:
        return "none"
    playlist = manifest.get("playlist")
    base = (playlist or {}).get("hash") or "none"
    missing = missing_files(cfg, manifest)
    if missing:
        return base + "|missing=" + ",".join(sorted(missing))
    return base


ENOSPC_TEXT = "no space left on device"


def _describe_error(e: BaseException) -> str:
    if isinstance(e, OSError) and e.errno == errno.ENOSPC:
        return ENOSPC_TEXT
    if isinstance(e, requests.HTTPError) and e.response is not None:
        return f"HTTP {e.response.status_code}"
    if isinstance(e, requests.RequestException):
        return type(e).__name__
    return str(e)[:80] or type(e).__name__


def _format_sync_error(failures: list[tuple[str, str]], total: int) -> str:
    if not failures:
        return ""
    if any(reason == ENOSPC_TEXT for _, reason in failures):
        # a full card fails every remaining item: the daemon keys the STORAGE
        # FULL screen off this phrase, so it goes ahead of the names and the cut
        text = f"{len(failures)} of {total} items missing: {ENOSPC_TEXT}"
    elif len(failures) == 1:
        name, reason = failures[0]
        text = f"download failed: {name}: {reason}"
    else:
        text = f"{len(failures)} of {total} items missing: " + ", ".join(n for n, _ in failures)
    if len(text) > SYNC_ERROR_MAX_LEN:
        text = text[: SYNC_ERROR_MAX_LEN - 3] + "..."
    return text


def sync_once(
    cfg: PlayerConfig,
    status: dict | None = None,
    sync_error: str = "",
    verify_all: bool = False,
    should_stop: Callable[[], bool] = _never_stop,
    on_progress: Progress | None = None,
) -> tuple[bool, dict | None, str]:
    """Fetch manifest, download deltas, prune stale.
    Returns (changed, manifest, sync_error): `changed` is True when the playlist
    hash changed or a file was (re)downloaded; `sync_error` is "" when every item
    is present and verified, else a short description for the CMS.
    A failing item does not abort the sync: the others are kept and the miss is
    retried on the next poll. With verify_all every file is re-hashed.
    on_progress, when given, is called with {phase, index (1-based), total,
    filename, bytes_done, bytes_total} as each item starts and while it downloads.
    """
    on_progress = on_progress or _no_progress
    manifest = fetch_manifest(cfg, status=status, sync_error=sync_error)
    local = load_local_manifest(cfg)

    new_hash = (manifest.get("playlist") or {}).get("hash")
    old_hash = ((local or {}).get("playlist") or {}).get("hash")
    hash_changed = local is None or new_hash != old_hash

    playlist = manifest.get("playlist")
    items = (playlist or {}).get("items") or []
    if not items:
        if hash_changed:
            log.info("device has no playlist assigned or playlist is empty")
            index = load_media_index(cfg)
            _prune_stale(cfg, keep_filenames=set(), index=index)
            save_media_index(cfg, index)
            _save_local_manifest(cfg, manifest)
        return hash_changed, manifest, ""

    index = load_media_index(cfg)
    index_before = json.dumps(index, sort_keys=True)
    if verify_all:
        log.info("verifying integrity of %d media files", len(items))

    downloaded = 0
    failures: list[tuple[str, str]] = []
    wanted: set[str] = set()
    for i, item in enumerate(items, 1):
        if should_stop():
            raise SyncInterrupted("stopped before downloading remaining items")
        filename = item.get("filename") or "?"
        wanted.add(filename)
        progress = {"index": i, "total": len(items), "filename": filename}
        try:
            if _ensure_item(cfg, item, index, verify_all, should_stop, on_progress, progress):
                downloaded += 1
        except SyncInterrupted:
            raise
        except (requests.RequestException, SyncError, OSError) as e:
            reason = _describe_error(e)
            log.warning("item %s unavailable: %s (will retry next poll)", filename, reason)
            failures.append((filename, reason))

    _prune_stale(cfg, keep_filenames=wanted, index=index)
    if json.dumps(index, sort_keys=True) != index_before:
        save_media_index(cfg, index)
    if hash_changed:
        _save_local_manifest(cfg, manifest)

    error_text = _format_sync_error(failures, len(items))
    changed = hash_changed or downloaded > 0
    if changed:
        log.info("sync complete: %d items (%d downloaded, %d missing), hash=%s",
                 len(items), downloaded, len(failures), new_hash)
    return changed, manifest, error_text
