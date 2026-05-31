import hashlib
import json
import logging
import os
import re
import tempfile
from pathlib import Path

import requests

from . import __version__
from .config import PlayerConfig

log = logging.getLogger("piplayer.sync")

SAFE_FILENAME = re.compile(r"^[A-Za-z0-9._-]+$")


class SyncError(Exception):
    pass


def _hash_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
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


def _save_local_manifest(cfg: PlayerConfig, manifest: dict) -> None:
    cfg.manifest_path.parent.mkdir(parents=True, exist_ok=True)
    tmp = cfg.manifest_path.with_suffix(cfg.manifest_path.suffix + ".tmp")
    tmp.write_text(json.dumps(manifest, indent=2))
    tmp.replace(cfg.manifest_path)


def fetch_manifest(cfg: PlayerConfig, status: dict | None = None) -> dict:
    url = f"{cfg.cms_url}/api/sync/{cfg.device_id}"
    headers = {
        "Authorization": f"Bearer {cfg.device_token}",
        "User-Agent": f"piplayer/{__version__}",
    }
    params: dict[str, str] = {"player_version": __version__}
    if status:
        for k in ("current_position", "current_filename", "player_status"):
            v = status.get(k)
            if v is not None:
                params[k] = str(v)
    r = requests.get(url, headers=headers, params=params, timeout=15, verify=cfg.verify_tls)
    r.raise_for_status()
    return r.json()


def _download_item(cfg: PlayerConfig, item: dict) -> Path:
    filename = item["filename"]
    if not SAFE_FILENAME.match(filename):
        raise SyncError(f"refusing unsafe filename: {filename}")

    target = cfg.media_dir / filename
    if target.is_file():
        existing_sha = _hash_file(target)
        if existing_sha == item["sha256"]:
            return target
        log.warning("hash mismatch for existing %s, redownloading", filename)
        target.unlink()

    cfg.media_dir.mkdir(parents=True, exist_ok=True)
    headers = {
        "Authorization": f"Bearer {cfg.device_token}",
        "User-Agent": f"piplayer/{__version__}",
    }

    fd, tmp_path_str = tempfile.mkstemp(dir=str(cfg.media_dir), prefix=".download_", suffix=".tmp")
    os.close(fd)
    tmp_path = Path(tmp_path_str)
    try:
        log.info("downloading %s (%.1f MB)", filename, (item.get("size_bytes") or 0) / 1024 / 1024)
        with requests.get(item["url"], headers=headers, stream=True, timeout=60, verify=cfg.verify_tls) as r:
            r.raise_for_status()
            hasher = hashlib.sha256()
            with tmp_path.open("wb") as out:
                for chunk in r.iter_content(chunk_size=1024 * 1024):
                    if chunk:
                        out.write(chunk)
                        hasher.update(chunk)
        actual_sha = hasher.hexdigest()
        if actual_sha != item["sha256"]:
            raise SyncError(f"sha256 mismatch for {filename}: got {actual_sha}, expected {item['sha256']}")
        tmp_path.replace(target)
        log.info("downloaded %s", filename)
        return target
    except Exception:
        tmp_path.unlink(missing_ok=True)
        raise


def _prune_stale(cfg: PlayerConfig, keep_filenames: set[str]) -> None:
    if not cfg.media_dir.is_dir():
        return
    for p in cfg.media_dir.iterdir():
        if not p.is_file():
            continue
        if p.name.startswith("."):
            continue
        if p.name not in keep_filenames:
            log.info("removing stale media: %s", p.name)
            try:
                p.unlink()
            except OSError as e:
                log.warning("failed to remove %s: %s", p, e)


def build_mpv_items(cfg: PlayerConfig, manifest: dict) -> list[tuple[Path, dict]]:
    """Translate manifest items into (local_path, mpv_options) tuples."""
    playlist = manifest.get("playlist")
    if not playlist or not playlist.get("items"):
        return []
    out: list[tuple[Path, dict]] = []
    for item in playlist["items"]:
        path = cfg.media_dir / item["filename"]
        opts: dict[str, str] = {}
        eff = item.get("effective_duration_seconds")
        if item.get("media_type") == "image":
            duration_val = eff if eff is not None else 10
            opts["image-display-duration"] = str(duration_val)
        else:
            if eff is not None:
                opts["length"] = str(eff)
        out.append((path, opts))
    return out


def sync_once(cfg: PlayerConfig, status: dict | None = None) -> tuple[bool, dict | None]:
    """Fetch manifest, download deltas, prune stale. Returns (changed, manifest).
    Caller is responsible for pushing the new playlist into mpv when changed=True.
    """
    manifest = fetch_manifest(cfg, status=status)
    local = load_local_manifest(cfg)

    new_hash = (manifest.get("playlist") or {}).get("hash")
    old_hash = (local or {}).get("playlist", {}).get("hash") if local else None

    if new_hash == old_hash:
        return False, manifest

    playlist = manifest.get("playlist")
    if not playlist or not playlist.get("items"):
        log.info("device has no playlist assigned or playlist is empty")
        _prune_stale(cfg, keep_filenames=set())
        _save_local_manifest(cfg, manifest)
        return True, manifest

    keep: set[str] = set()
    for item in playlist["items"]:
        _download_item(cfg, item)
        keep.add(item["filename"])

    _prune_stale(cfg, keep_filenames=keep)
    _save_local_manifest(cfg, manifest)
    log.info("sync complete: %d items, hash=%s", len(playlist["items"]), new_hash)
    return True, manifest
