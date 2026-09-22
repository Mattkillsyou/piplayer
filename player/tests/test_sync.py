"""sync_once: null-playlist manifest, per-item tolerance, Range resume, hash cache, pruning."""
import json
import os

import pytest
import requests

from fakes import FakeCms, sha256
from player import sync
from player.sync import (
    SyncError, SyncInterrupted, build_mpv_items, cleanup_stale_temp, load_media_index,
    missing_files, sync_once, wanted_hash,
)


@pytest.fixture
def cms(monkeypatch):
    c = FakeCms()
    c.install(monkeypatch)
    return c


def write_manifest(cfg, manifest):
    cfg.manifest_path.write_text(json.dumps(manifest))


def local_manifest(cfg):
    return json.loads(cfg.manifest_path.read_text())


# ------------------------------------------------------- null playlist (F003) ---

def test_null_playlist_manifest_does_not_crash(cfg, cms):
    cms.files["a.mp4"] = b"A" * 100
    cms.set_playlist(["a.mp4"])
    changed, manifest, err = sync_once(cfg)
    assert changed and err == ""
    assert (cfg.media_dir / "a.mp4").read_bytes() == b"A" * 100

    # operator unassigns the playlist -> manifest with "playlist": null is saved
    cms.manifest["playlist"] = None
    changed, manifest, err = sync_once(cfg)
    assert changed is True
    assert local_manifest(cfg)["playlist"] is None
    assert not (cfg.media_dir / "a.mp4").exists()

    # the next polls must keep working with the null manifest on disk ...
    changed, manifest, err = sync_once(cfg)
    assert (changed, err) == (False, "")
    assert manifest["playlist"] is None

    # ... and a newly assigned playlist must sync again
    cms.files["b.mp4"] = b"B" * 50
    cms.set_playlist(["b.mp4"])
    changed, manifest, err = sync_once(cfg)
    assert changed is True and err == ""
    assert (cfg.media_dir / "b.mp4").is_file()


def test_fresh_device_with_no_playlist(cfg, cms):
    changed, manifest, err = sync_once(cfg)
    assert manifest["playlist"] is None and err == ""
    assert local_manifest(cfg)["playlist"] is None
    assert wanted_hash(cfg, manifest) == "none"
    assert build_mpv_items(cfg, manifest) == []


# ------------------------------------------------------ sync_error reporting ---

def test_sync_error_param_sent_on_every_sync(cfg, cms):
    sync_once(cfg, sync_error="")
    assert cms.sync_calls[-1]["sync_error"] == ""
    assert cms.sync_calls[-1]["player_version"] == "0.2.0"
    sync_once(cfg, sync_error="download failed: a.mp4: HTTP 404")
    assert cms.sync_calls[-1]["sync_error"] == "download failed: a.mp4: HTTP 404"
    sync_once(cfg, sync_error="x" * 500)
    assert len(cms.sync_calls[-1]["sync_error"]) == 200


def test_status_fields_are_sent(cfg, cms):
    sync_once(cfg, status={"current_position": 2, "current_filename": "a.mp4", "player_status": "playing"})
    p = cms.sync_calls[-1]
    assert p["current_position"] == "2" and p["current_filename"] == "a.mp4" and p["player_status"] == "playing"


def test_http_error_on_manifest_propagates(cfg, cms):
    cms.sync_status = 401
    with pytest.raises(requests.HTTPError) as ei:
        sync_once(cfg)
    assert ei.value.response.status_code == 401


# ------------------------------------------------ per-item tolerance (F030) ---

def test_failing_item_does_not_abort_sync(cfg, cms):
    cms.files["a.mp4"] = b"A" * 10
    cms.files["b.mp4"] = b"B" * 10
    cms.files["c.mp4"] = b"C" * 10
    cms.set_playlist(["a.mp4", "b.mp4", "c.mp4"])
    del cms.files["b.mp4"]                          # b.mp4 exists in the manifest only (404)
    changed, manifest, err = sync_once(cfg)
    assert changed is True
    assert err == "download failed: b.mp4: HTTP 404"
    assert (cfg.media_dir / "a.mp4").is_file() and (cfg.media_dir / "c.mp4").is_file()
    assert missing_files(cfg, manifest) == ["b.mp4"]
    # playlist to push is made of what is on disk
    assert [p.name for p, _ in build_mpv_items(cfg, manifest)] == ["a.mp4", "c.mp4"]
    assert wanted_hash(cfg, manifest) == manifest["playlist"]["hash"] + "|missing=b.mp4"
    # manifest was still saved so later edits are applied
    assert local_manifest(cfg)["playlist"]["hash"] == manifest["playlist"]["hash"]

    # next poll retries only the miss and reports it again
    n_media = len(cms.media_calls)
    changed, manifest, err = sync_once(cfg)
    assert [c[0] for c in cms.media_calls[n_media:]] == ["b.mp4"]
    assert err == "download failed: b.mp4: HTTP 404"
    assert changed is False

    # file appears on the server -> downloaded, error cleared, list changes
    cms.files["b.mp4"] = b"B" * 10
    cms.manifest["playlist"]["items"][1]["sha256"] = sha256(b"B" * 10)
    changed, manifest, err = sync_once(cfg)
    assert changed is True and err == ""
    assert wanted_hash(cfg, manifest) == manifest["playlist"]["hash"]


def test_multiple_failures_summary_text(cfg, cms):
    cms.files["a.mp4"] = b"A"
    cms.files["b.mp4"] = b"B"
    cms.files["c.mp4"] = b"C"
    cms.set_playlist(["a.mp4", "b.mp4", "c.mp4"])
    del cms.files["a.mp4"]
    del cms.files["b.mp4"]
    changed, manifest, err = sync_once(cfg)
    assert err == "2 of 3 items missing: a.mp4, b.mp4"
    assert (cfg.media_dir / "c.mp4").is_file()


def test_sha_mismatch_is_reported_and_partial_removed(cfg, cms):
    cms.files["a.mp4"] = b"A" * 10
    cms.set_playlist(["a.mp4"])
    cms.manifest["playlist"]["items"][0]["sha256"] = "f" * 64
    changed, manifest, err = sync_once(cfg)
    assert err.startswith("download failed: a.mp4: sha256 mismatch")
    assert not (cfg.media_dir / "a.mp4").exists()
    assert not (cfg.media_dir / "a.mp4.part").exists()


def test_unsafe_filename_is_a_per_item_failure(cfg, cms):
    cms.files["ok.mp4"] = b"x"
    cms.set_playlist(["ok.mp4"])
    bad = dict(cms.manifest["playlist"]["items"][0], filename="../etc/passwd", position=1)
    cms.manifest["playlist"]["items"].append(bad)
    changed, manifest, err = sync_once(cfg)
    assert "../etc/passwd" in err
    assert (cfg.media_dir / "ok.mp4").is_file()


# ------------------------------------------------------ Range resume (F030) ---

def test_dropped_download_resumes_in_place_with_range(cfg, cms):
    data = bytes(range(256)) * 1000   # 256 000 bytes
    cms.files["big.mp4"] = data
    cms.set_playlist(["big.mp4"])
    cms.drop_after["big.mp4"] = 100_000
    changed, manifest, err = sync_once(cfg)
    # every connection drops after 100 000 bytes: the transfer picks up where it
    # stopped, in the same sync, with a Range request per resume
    assert err == "" and changed is True
    assert [h.get("Range") for _, h in cms.media_calls] == [None, "bytes=100000-", "bytes=200000-"]
    assert (cfg.media_dir / "big.mp4").read_bytes() == data
    assert not (cfg.media_dir / "big.mp4.part").exists()


def test_persistently_dropping_download_is_bounded_and_resumed_next_poll(cfg, cms):
    data = bytes(range(256)) * 100    # 25 600 bytes
    cms.files["big.mp4"] = data
    cms.set_playlist(["big.mp4"])
    cms.drop_after["big.mp4"] = 4_000
    changed, manifest, err = sync_once(cfg)
    assert err == "download failed: big.mp4: ConnectionError"
    assert len(cms.media_calls) == sync.DOWNLOAD_ATTEMPTS
    part = cfg.media_dir / "big.mp4.part"
    assert part.is_file() and part.stat().st_size == 4_000 * sync.DOWNLOAD_ATTEMPTS
    assert not (cfg.media_dir / "big.mp4").exists()

    # the connection is fine now: the next poll resumes from the .part (hashing what it holds first)
    del cms.drop_after["big.mp4"]
    changed, manifest, err = sync_once(cfg)
    assert err == "" and changed is True
    name, headers = cms.media_calls[-1]
    assert name == "big.mp4" and headers["Range"] == f"bytes={4_000 * sync.DOWNLOAD_ATTEMPTS}-"
    assert (cfg.media_dir / "big.mp4").read_bytes() == data
    assert not part.exists()


def test_read_timeout_mid_transfer_resumes_too(cfg, cms, monkeypatch):
    data = b"T" * 3000
    cms.files["t.mp4"] = data
    cms.set_playlist(["t.mp4"])
    real_get = cms.get
    ranges = []

    def stalling(first: bytes):
        yield first
        raise requests.ReadTimeout("read timed out")     # what requests raises for a silent socket

    def get(url, headers=None, **kw):
        r = real_get(url, headers=headers, **kw)
        if "/api/media/" in url:
            ranges.append(headers.get("Range"))
            if len(ranges) == 1:
                r.iter_content = lambda chunk_size=1: stalling(data[:1000])
        return r

    monkeypatch.setattr(sync.requests, "get", get)
    changed, manifest, err = sync_once(cfg)
    assert err == ""
    assert ranges == [None, "bytes=1000-"]
    assert (cfg.media_dir / "t.mp4").read_bytes() == data


def test_server_answering_200_to_range_restarts_from_scratch(cfg, cms):
    data = b"Q" * 5000
    cms.files["q.mp4"] = data
    cms.set_playlist(["q.mp4"])
    (cfg.media_dir / "q.mp4.part").write_bytes(b"garbage!")
    cms.ignore_range = True
    changed, manifest, err = sync_once(cfg)
    assert err == ""
    assert cms.media_calls[-1][1]["Range"] == "bytes=8-"
    assert (cfg.media_dir / "q.mp4").read_bytes() == data


def test_stale_part_larger_than_file_is_restarted(cfg, cms):
    data = b"S" * 100
    cms.files["s.mp4"] = data
    cms.set_playlist(["s.mp4"])
    (cfg.media_dir / "s.mp4.part").write_bytes(b"x" * 500)
    changed, manifest, err = sync_once(cfg)
    assert err == ""
    assert [h.get("Range") for _, h in cms.media_calls] == ["bytes=500-", None]
    assert (cfg.media_dir / "s.mp4").read_bytes() == data


def test_stop_flag_aborts_download_and_keeps_part(cfg, cms):
    data = b"Z" * (3 * 1024 * 1024)
    cms.files["z.mp4"] = data
    cms.set_playlist(["z.mp4"])
    calls = {"n": 0}

    def should_stop():
        calls["n"] += 1
        return calls["n"] > 3       # fires after the first chunk was written
    with pytest.raises(SyncInterrupted):
        sync_once(cfg, should_stop=should_stop)
    part = cfg.media_dir / "z.mp4.part"
    assert part.is_file() and 0 < part.stat().st_size < len(data)
    assert not (cfg.media_dir / "z.mp4").exists()
    # next start resumes it
    changed, manifest, err = sync_once(cfg)
    assert err == "" and cms.media_calls[-1][1]["Range"].startswith("bytes=")
    assert (cfg.media_dir / "z.mp4").read_bytes() == data


def test_stop_flag_aborts_hashing(cfg, cms):
    data = b"H" * (3 * 1024 * 1024)
    cms.files["h.mp4"] = data
    cms.set_playlist(["h.mp4"])
    (cfg.media_dir / "h.mp4").write_bytes(data)     # present but not in the index -> hashed
    with pytest.raises(SyncInterrupted):
        sync_once(cfg, should_stop=lambda: True)


# ---------------------------------------------------- hash cache (F028/F057) ---

def test_verified_download_is_recorded_in_media_index(cfg, cms):
    cms.files["a.mp4"] = b"A" * 10
    cms.set_playlist(["a.mp4"])
    sync_once(cfg)
    idx = load_media_index(cfg)
    st = (cfg.media_dir / "a.mp4").stat()
    assert idx == {"a.mp4": {"sha256": sha256(b"A" * 10), "size": st.st_size, "mtime": st.st_mtime}}
    assert (cfg.manifest_path.parent / "media_index.json").is_file()


def test_unchanged_files_are_not_rehashed_on_reorder(cfg, cms, monkeypatch):
    cms.files["a.mp4"] = b"A" * 10
    cms.files["b.mp4"] = b"B" * 10
    cms.set_playlist(["a.mp4", "b.mp4"])
    sync_once(cfg)
    hashed = []
    orig = sync._hash_file
    monkeypatch.setattr(sync, "_hash_file", lambda p, *a, **k: hashed.append(p.name) or orig(p, *a, **k))
    cms.set_playlist(["b.mp4", "a.mp4"])         # new hash, no new bytes
    changed, manifest, err = sync_once(cfg)
    assert changed is True and err == ""
    assert hashed == []
    assert cms.media_calls[2:] == []
    # unchanged poll: nothing hashed either
    sync_once(cfg)
    assert hashed == []


def test_touched_file_is_rehashed_and_corruption_repaired(cfg, cms, monkeypatch):
    cms.files["a.mp4"] = b"A" * 10
    cms.set_playlist(["a.mp4"])
    sync_once(cfg)
    target = cfg.media_dir / "a.mp4"
    target.write_bytes(b"corrupt!!!")             # same size, new mtime
    os.utime(target, (1, 1))
    hashed = []
    orig = sync._hash_file
    monkeypatch.setattr(sync, "_hash_file", lambda p, *a, **k: hashed.append(p.name) or orig(p, *a, **k))
    changed, manifest, err = sync_once(cfg)      # hash unchanged, still repaired (F057 cheap check)
    assert hashed == ["a.mp4"]
    assert target.read_bytes() == b"A" * 10 and err == "" and changed is True


def test_deleted_file_is_redownloaded_without_hash_change(cfg, cms):
    cms.files["a.mp4"] = b"A" * 10
    cms.set_playlist(["a.mp4"])
    sync_once(cfg)
    (cfg.media_dir / "a.mp4").unlink()
    changed, manifest, err = sync_once(cfg)
    assert changed is True and (cfg.media_dir / "a.mp4").is_file()


def test_verify_all_rehashes_every_file(cfg, cms, monkeypatch):
    cms.files["a.mp4"] = b"A" * 10
    cms.files["b.mp4"] = b"B" * 10
    cms.set_playlist(["a.mp4", "b.mp4"])
    sync_once(cfg)
    # bit-rot with size and mtime preserved
    target = cfg.media_dir / "b.mp4"
    st = target.stat()
    target.write_bytes(b"B" * 9 + b"X")
    os.utime(target, (st.st_atime, st.st_mtime))
    hashed = []
    orig = sync._hash_file
    monkeypatch.setattr(sync, "_hash_file", lambda p, *a, **k: hashed.append(p.name) or orig(p, *a, **k))
    sync_once(cfg)
    assert hashed == []                          # index matches: not detected by the cheap check
    changed, manifest, err = sync_once(cfg, verify_all=True)
    assert sorted(hashed) == ["a.mp4", "b.mp4"]
    assert target.read_bytes() == b"B" * 10 and err == "" and changed is True


def test_existing_file_without_index_entry_is_hashed_once(cfg, cms, monkeypatch):
    cms.files["a.mp4"] = b"A" * 10
    cms.set_playlist(["a.mp4"])
    (cfg.media_dir / "a.mp4").write_bytes(b"A" * 10)   # e.g. upgraded from an older player
    hashed = []
    orig = sync._hash_file
    monkeypatch.setattr(sync, "_hash_file", lambda p, *a, **k: hashed.append(p.name) or orig(p, *a, **k))
    sync_once(cfg)
    assert hashed == ["a.mp4"] and cms.media_calls == []
    sync_once(cfg)
    assert hashed == ["a.mp4"]
    assert "a.mp4" in load_media_index(cfg)


# --------------------------------------------------------- pruning (F029) ---

def test_prune_removes_stale_media_parts_and_temp_files(cfg, cms):
    cms.files["a.mp4"] = b"A"
    cms.set_playlist(["a.mp4"])
    (cfg.media_dir / "old.mp4").write_bytes(b"old")
    (cfg.media_dir / "old.mp4.part").write_bytes(b"old")
    (cfg.media_dir / "a.mp4.part").write_bytes(b"")   # belongs to a current item: kept
    (cfg.media_dir / ".download_abc123.tmp").write_bytes(b"orphan")
    (cfg.media_dir / ".hidden").write_bytes(b"keep")
    idx_path = cfg.manifest_path.parent / "media_index.json"
    cfg.manifest_path.parent.mkdir(exist_ok=True)
    idx_path.write_text(json.dumps({"old.mp4": {"sha256": "x", "size": 3, "mtime": 0}}))
    sync_once(cfg)
    present = sorted(p.name for p in cfg.media_dir.iterdir())
    assert present == [".hidden", "a.mp4"]
    assert load_media_index(cfg) == {"a.mp4": load_media_index(cfg)["a.mp4"]}


def test_cleanup_stale_temp_at_startup(cfg):
    (cfg.media_dir / ".download_zzz.tmp").write_bytes(b"x")
    (cfg.media_dir / "keep.mp4").write_bytes(b"x")
    (cfg.media_dir / "keep.mp4.part").write_bytes(b"x")
    cleanup_stale_temp(cfg)
    assert sorted(p.name for p in cfg.media_dir.iterdir()) == ["keep.mp4", "keep.mp4.part"]


def test_build_mpv_items_options(cfg, cms):
    cms.files["v.mp4"] = b"v"
    cms.files["i.png"] = b"i"
    cms.files["w.mp4"] = b"w"
    cms.set_playlist(["v.mp4"])
    items = [cms.item("v.mp4", position=0), cms.item("i.png", "image", duration=7, position=1),
             cms.item("w.mp4", duration=12.5, position=2)]
    cms.manifest["playlist"]["items"] = items
    sync_once(cfg)
    out = build_mpv_items(cfg, cms.manifest)
    assert [(p.name, o) for p, o in out] == [
        ("v.mp4", {}), ("i.png", {"image-display-duration": "7"}), ("w.mp4", {"length": "12.5"})]
    assert [p.name for p, _ in build_mpv_items(cfg, {"playlist": {"items": [{"filename": "nope.mp4"}]}}, present_only=False)] == ["nope.mp4"]


def test_animated_gif_loops_to_fill_its_duration(cfg, cms):
    """Multi-frame GIFs arrive as media_type=video; a duration override must
    make the GIF loop (ignore_loop=0) so `length` can bound it. A still GIF is
    an ordinary image and an animated one without override plays natively."""
    items = [{"filename": "anim.gif", "media_type": "video", "effective_duration_seconds": 10},
             {"filename": "once.gif", "media_type": "video", "effective_duration_seconds": None},
             {"filename": "still.gif", "media_type": "image", "effective_duration_seconds": 10}]
    out = build_mpv_items(cfg, {"playlist": {"items": items}}, present_only=False)
    assert [o for _, o in out] == [
        {"length": "10", "demuxer-lavf-o": "ignore_loop=0"},
        {},
        {"image-display-duration": "10"}]


# ------------------------------------------------- progress callback + ENOSPC ---

def test_on_progress_reports_each_item_and_bytes(cfg, cms):
    cms.files["a.mp4"] = b"A" * 10
    cms.files["b.mp4"] = b"B" * 10
    cms.set_playlist(["a.mp4", "b.mp4"])
    (cfg.media_dir / "a.mp4").write_bytes(cms.files["a.mp4"])    # present but not indexed: gets verified
    seen = []
    sync_once(cfg, on_progress=seen.append)
    assert seen[0] == {"phase": "verifying", "index": 1, "total": 2, "filename": "a.mp4", "bytes_done": None, "bytes_total": 10}
    assert seen[1] == {"phase": "downloading", "index": 2, "total": 2, "filename": "b.mp4", "bytes_done": 0, "bytes_total": 10}
    assert seen[-1]["bytes_done"] == 10 and seen[-1]["filename"] == "b.mp4"


def test_enospc_is_reported_as_no_space_left(cfg, cms, monkeypatch):
    import errno
    cms.files["a.mp4"] = b"A" * 10
    cms.set_playlist(["a.mp4"])

    def full(*a, **k):
        raise OSError(errno.ENOSPC, "No space left on device")
    monkeypatch.setattr(sync, "_download_item", full)
    changed, manifest, err = sync_once(cfg)
    assert err == "1 of 1 items missing: no space left on device"
    # a full card fails every remaining item: the phrase must survive the summary form too
    cms.files["b.mp4"] = b"B" * 10
    cms.set_playlist(["a.mp4", "b.mp4"])
    changed, manifest, err = sync_once(cfg)
    assert err == "2 of 2 items missing: no space left on device"
