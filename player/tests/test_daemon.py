"""Main-loop state machine: offline start, mpv restart, failed push retry, re-push rules."""
import json
import logging
import time

import pytest
import requests

from fakes import FakeCms, FakeMpv
from player import daemon
from player.daemon import PlayerState, run_cycle
from player.mpv_client import MpvClient


@pytest.fixture
def mpv(monkeypatch):
    fake = FakeMpv()
    fake.install(monkeypatch)
    return fake


@pytest.fixture
def cms(monkeypatch):
    c = FakeCms()
    c.install(monkeypatch)
    monkeypatch.setattr(daemon, "capture_and_upload", lambda cfg, mpv: True)
    return c


@pytest.fixture
def client(tmp_path):
    return MpvClient(tmp_path / "mpv.sock")


def seed_local(cfg, cms, names):
    """Put a synced manifest + media on disk as if a previous run had synced them."""
    for n in names:
        cms.files[n] = n.encode() * 10
    h = cms.set_playlist(names)
    manifest = json.loads(json.dumps(cms.manifest))
    cfg.manifest_path.write_text(json.dumps(manifest))
    for n in names:
        (cfg.media_dir / n).write_bytes(cms.files[n])
    return manifest


def names(mpv):
    return [p.rsplit("\\", 1)[-1].rsplit("/", 1)[-1] for p in mpv.paths()]


def fresh_state(cfg):
    from player.sync import load_local_manifest
    return PlayerState(last_manifest=load_local_manifest(cfg), backoff=cfg.poll_interval_seconds)


# ------------------------------------------------------ offline start (F010) ---

def test_cached_manifest_is_pushed_while_cms_unreachable(cfg, cms, mpv, client):
    seed_local(cfg, cms, ["a.mp4", "b.mp4"])
    cms.unreachable = True
    state = fresh_state(cfg)
    assert run_cycle(cfg, client, state) is None
    assert names(mpv) == ["a.mp4", "b.mp4"]
    assert state.applied_hash == cms.manifest["playlist"]["hash"]
    assert state.backoff == 10
    # next offline cycles do not re-push
    n = len(mpv.commands("loadfile"))
    run_cycle(cfg, client, state)
    assert len(mpv.commands("loadfile")) == n
    assert state.backoff == 20


def test_no_cache_and_offline_does_nothing(cfg, cms, mpv, client):
    cms.unreachable = True
    state = fresh_state(cfg)
    run_cycle(cfg, client, state)
    assert mpv.commands("loadfile") == []
    assert state.last_manifest is None


def test_first_sync_online_pushes_and_logs_mpv_version(cfg, cms, mpv, client, caplog):
    cms.files["a.mp4"] = b"A" * 10
    cms.set_playlist(["a.mp4"])
    state = fresh_state(cfg)
    with caplog.at_level(logging.INFO, logger="piplayer"):
        manifest = run_cycle(cfg, client, state)
    assert manifest["playlist"]["hash"] == state.applied_hash
    assert names(mpv) == ["a.mp4"]
    assert state.mpv_pid == 1000
    assert any("mpv 0.35.1" in r.getMessage() and "1000" in r.getMessage() for r in caplog.records)


# -------------------------------------------------- mpv restart (F002/F024) ---

def test_mpv_restart_detected_by_pid_and_replayed(cfg, cms, mpv, client):
    seed_local(cfg, cms, ["a.mp4", "b.mp4"])
    state = fresh_state(cfg)
    run_cycle(cfg, client, state)
    assert names(mpv) == ["a.mp4", "b.mp4"]
    n = len(mpv.commands("loadfile"))

    # systemd restarts mpv between two polls: alive on both sides, new pid, empty playlist
    mpv.restart()
    run_cycle(cfg, client, state)
    assert names(mpv) == ["a.mp4", "b.mp4"]
    assert len(mpv.commands("loadfile")) == n + 2
    assert state.mpv_pid == mpv.pid
    assert mpv.commands("loadfile")[n]["flags"] == "replace"


def test_mpv_restart_during_cms_outage_is_replayed(cfg, cms, mpv, client):
    seed_local(cfg, cms, ["a.mp4"])
    state = fresh_state(cfg)
    run_cycle(cfg, client, state)
    cms.unreachable = True
    mpv.restart()
    run_cycle(cfg, client, state)
    assert names(mpv) == ["a.mp4"]
    cms.unreachable = False
    n = len(mpv.commands("loadfile"))
    run_cycle(cfg, client, state)
    assert len(mpv.commands("loadfile")) == n     # nothing to redo once the CMS is back


def test_mpv_down_then_back(cfg, cms, mpv, client):
    seed_local(cfg, cms, ["a.mp4"])
    state = fresh_state(cfg)
    run_cycle(cfg, client, state)
    mpv.alive = False
    run_cycle(cfg, client, state)
    assert state.mpv_pid is None
    assert cms.sync_calls[-1]["player_status"] == "mpv-down"
    mpv.restart()
    run_cycle(cfg, client, state)
    assert names(mpv) == ["a.mp4"]
    assert state.mpv_pid == mpv.pid


def test_empty_mpv_playlist_with_items_is_repushed(cfg, cms, mpv, client):
    seed_local(cfg, cms, ["a.mp4"])
    state = fresh_state(cfg)
    run_cycle(cfg, client, state)
    mpv.playlist = []          # someone cleared mpv's playlist behind our back (same pid)
    mpv.current = None
    run_cycle(cfg, client, state)
    assert names(mpv) == ["a.mp4"]


# ------------------------------------------------- failed push retry (F024) ---

def test_failed_push_is_retried_without_hash_change(cfg, cms, mpv, client):
    seed_local(cfg, cms, ["a.mp4"])
    state = fresh_state(cfg)
    run_cycle(cfg, client, state)
    h1 = state.applied_hash

    cms.files["b.mp4"] = b"B" * 10
    h2 = cms.set_playlist(["a.mp4", "b.mp4"])
    mpv.silent_commands = {"loadfile"}       # transient IPC failure while pushing h2
    run_cycle(cfg, client, state)
    assert (cfg.media_dir / "b.mp4").is_file()
    assert json.loads(cfg.manifest_path.read_text())["playlist"]["hash"] == h2
    assert state.applied_hash == h1          # not marked applied

    mpv.silent_commands = set()
    run_cycle(cfg, client, state)            # same manifest hash: still retried
    assert state.applied_hash == h2
    assert names(mpv) == ["a.mp4", "b.mp4"]
    assert mpv.current["path"].endswith("a.mp4")   # seamless: a.mp4 kept playing


def test_playlist_change_is_applied_seamlessly_by_daemon(cfg, cms, mpv, client):
    seed_local(cfg, cms, ["a.mp4", "b.mp4"])
    state = fresh_state(cfg)
    run_cycle(cfg, client, state)
    mpv.advance()                             # now playing b.mp4
    cms.files["c.mp4"] = b"C" * 10
    cms.set_playlist(["c.mp4", "b.mp4", "a.mp4"])
    n = len(mpv.requests)
    run_cycle(cfg, client, state)
    flags = [c["flags"] for c in mpv.commands("loadfile")[2:]]
    assert flags == ["append", "append"]
    assert names(mpv) == ["c.mp4", "b.mp4", "a.mp4"]
    assert mpv.current["path"].endswith("b.mp4")
    assert ["playlist-move", 0, 2] in [m["command"] for m in mpv.requests[n:]]


def test_partial_download_pushes_available_items_then_completes(cfg, cms, mpv, client):
    cms.files["a.mp4"] = b"A" * 10
    cms.files["b.mp4"] = b"B" * 10
    h = cms.set_playlist(["a.mp4", "b.mp4"])
    del cms.files["b.mp4"]
    state = fresh_state(cfg)
    run_cycle(cfg, client, state)
    assert names(mpv) == ["a.mp4"]
    assert state.applied_hash == h + "|missing=b.mp4"
    assert state.last_sync_error == "download failed: b.mp4: HTTP 404"
    run_cycle(cfg, client, state)
    assert cms.sync_calls[-1]["sync_error"] == "download failed: b.mp4: HTTP 404"
    cms.files["b.mp4"] = b"B" * 10
    run_cycle(cfg, client, state)
    assert names(mpv) == ["a.mp4", "b.mp4"]
    assert state.applied_hash == h and state.last_sync_error == ""
    run_cycle(cfg, client, state)
    assert cms.sync_calls[-1]["sync_error"] == ""


def test_unassigned_playlist_clears_mpv(cfg, cms, mpv, client):
    seed_local(cfg, cms, ["a.mp4"])
    state = fresh_state(cfg)
    run_cycle(cfg, client, state)
    cms.manifest["playlist"] = None
    run_cycle(cfg, client, state)
    assert mpv.playlist == [] and state.applied_hash == "none"
    assert not (cfg.media_dir / "a.mp4").exists()
    n = len(mpv.requests)
    run_cycle(cfg, client, state)
    assert [m["command"] for m in mpv.requests[n:] if m["command"][0] in ("stop", "playlist-clear")] == []


# ------------------------------------------------------- verify + commands ---

def test_force_sync_triggers_full_verify(cfg, cms, mpv, client, monkeypatch):
    seed_local(cfg, cms, ["a.mp4"])
    state = fresh_state(cfg)
    run_cycle(cfg, client, state)
    calls = []
    orig = daemon.sync_once

    def spy(*a, **k):
        calls.append(k.get("verify_all"))
        return orig(*a, **k)
    monkeypatch.setattr(daemon, "sync_once", spy)
    run_cycle(cfg, client, state)
    state.force_verify = True                  # what main() does after a force-sync command
    run_cycle(cfg, client, state)
    run_cycle(cfg, client, state)
    assert calls == [False, True, False]
    assert state.force_verify is False


def test_periodic_full_verify_every_24h(cfg, cms, mpv, client, monkeypatch):
    seed_local(cfg, cms, ["a.mp4"])
    state = fresh_state(cfg)
    calls = []
    orig = daemon.sync_once

    def spy(*a, **k):
        calls.append(k.get("verify_all"))
        return orig(*a, **k)
    monkeypatch.setattr(daemon, "sync_once", spy)
    run_cycle(cfg, client, state)
    state.last_full_verify = time.monotonic() - daemon.FULL_VERIFY_INTERVAL_SECONDS - 1
    run_cycle(cfg, client, state)
    run_cycle(cfg, client, state)
    assert calls == [False, True, False]


def test_force_sync_command_sets_flag_and_is_reported(cfg, cms, mpv, client, monkeypatch):
    monkeypatch.setattr(daemon, "_force_sync_now", False)
    seed_local(cfg, cms, ["a.mp4"])
    cms.manifest["commands"] = [{"id": 7, "command": "force-sync"}]
    state = fresh_state(cfg)
    run_cycle(cfg, client, state)
    assert daemon._force_sync_now is True
    assert cms.post_calls == [("http://cms.test/api/commands/7/result", {"result": "queued resync"})]


# ------------------------------------------------------ error logging (F071) ---

@pytest.mark.parametrize("status,needle", [(401, "check device_token"), (403, "does not match device_id"),
                                           (404, "HTTP 404"), (500, "HTTP 500")])
def test_http_errors_are_not_reported_as_unreachable(cfg, cms, mpv, client, caplog, status, needle):
    cms.sync_status = status
    state = fresh_state(cfg)
    with caplog.at_level(logging.WARNING, logger="piplayer"):
        run_cycle(cfg, client, state)
    msgs = [r.getMessage() for r in caplog.records]
    assert any(needle in m for m in msgs)
    assert not any("unreachable" in m for m in msgs)
    assert state.backoff == 10


def test_connection_error_is_reported_as_unreachable(cfg, cms, mpv, client, caplog):
    cms.unreachable = True
    state = fresh_state(cfg)
    with caplog.at_level(logging.WARNING, logger="piplayer"):
        run_cycle(cfg, client, state)
    assert any("CMS unreachable" in r.getMessage() for r in caplog.records)


def test_sync_crash_does_not_skip_mpv_reconcile(cfg, cms, mpv, client, monkeypatch):
    seed_local(cfg, cms, ["a.mp4"])

    def boom(*a, **k):
        raise RuntimeError("boom")
    monkeypatch.setattr(daemon, "sync_once", boom)
    state = fresh_state(cfg)
    run_cycle(cfg, client, state)
    assert names(mpv) == ["a.mp4"]
    assert state.backoff == 10
