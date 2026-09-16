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
from player.screens import layout
from player.status import StatusScreens


@pytest.fixture
def mpv(monkeypatch):
    fake = FakeMpv()
    fake.install(monkeypatch)
    return fake


@pytest.fixture
def screens(cfg, client, monkeypatch):
    s = StatusScreens(cfg, client, "0.2.0")
    monkeypatch.setattr(s, "throttled", lambda seconds=2.0: True)   # every progress event counts in tests
    return s


def screen_loads(mpv):
    """Basenames of the status screen PNGs loaded so far, in order."""
    return [c["url"].replace("\\", "/").rsplit("/", 1)[-1] for c in mpv.commands("loadfile")
            if c["url"].endswith(".png")]


def screen_texts(screens):
    return [t["text"] for t in layout(screens.current)]


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


def test_no_cache_and_offline_shows_offline_screen(cfg, cms, mpv, client, screens):
    cms.unreachable = True
    state = fresh_state(cfg)
    run_cycle(cfg, client, state, screens=screens)
    assert screen_loads(mpv) == ["offline.png"]
    assert state.last_manifest is None
    assert state.last_failure == "unreachable"
    assert screens.current.kind == "offline" and "no cached content" in screen_texts(screens)
    run_cycle(cfg, client, state, screens=screens)
    assert screen_loads(mpv) == ["offline.png"]      # same screen: not reloaded


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


# ------------------------------------------------------------ status screens ---

def test_unassigned_device_shows_pairing_screen_without_clearing_mpv(cfg, cms, mpv, client, screens):
    state = fresh_state(cfg)
    run_cycle(cfg, client, state, screens=screens)
    assert screen_loads(mpv) == ["pairing.png"]
    assert screens.current.kind == "pairing" and "assign a playlist to this device in the console" in screen_texts(screens)
    assert mpv.commands("stop") == [] and mpv.commands("playlist-clear") == []
    mpv.restart()                                   # new mpv instance starts black: screen is re-shown
    run_cycle(cfg, client, state, screens=screens)
    assert screen_loads(mpv) == ["pairing.png", "pairing.png"]


def test_empty_playlist_shows_waiting_with_next_rule(cfg, cms, mpv, client, screens):
    cms.manifest["playlist"] = {"id": 1, "name": "Day", "source": "device-default", "hash": "sha256:x", "items": []}
    cms.manifest["next_rule"] = {"name": "Night", "playlist": "After hours", "starts_at": "2026-01-06T22:00:00+00:00"}
    state = fresh_state(cfg)
    run_cycle(cfg, client, state, screens=screens)
    assert screens.current.kind == "waiting"
    texts = screen_texts(screens)
    assert "playlist Day has no items" in texts
    assert "next: Night \u00b7 After hours at Tue 22:00" in texts
    cms.manifest["playlist"] = None                  # rules exist but none active: still waiting, not pairing
    run_cycle(cfg, client, state, screens=screens)
    assert screens.current.kind == "waiting" and "no schedule rule is active" in screen_texts(screens)


def test_rejected_token_shows_error_screen(cfg, cms, mpv, client, screens):
    cms.sync_status = 401
    state = fresh_state(cfg)
    run_cycle(cfg, client, state, screens=screens)
    assert state.last_failure == "token"
    assert screen_loads(mpv) == ["error.png"]
    assert screens.current.kind == "error" and screens.current.reason == "token"
    assert "the console refused this device's token" in screen_texts(screens)


def test_content_replaces_status_screen_and_announces_now_playing(cfg, cms, mpv, client, screens):
    cms.unreachable = True
    state = fresh_state(cfg)
    run_cycle(cfg, client, state, screens=screens)
    assert screens.current.kind == "offline"
    cms.unreachable = False
    cms.files["a.mp4"] = b"A" * 10
    cms.files["b.mp4"] = b"B" * 10
    cms.set_playlist(["a.mp4", "b.mp4"])
    run_cycle(cfg, client, state, screens=screens)
    assert "syncing.png" in screen_loads(mpv)            # progress shown while the offline screen was up
    assert names(mpv) == ["a.mp4", "b.mp4"] and mpv.current["path"].endswith("a.mp4")
    assert screens.current is None
    assert [o[0] for o in mpv.overlays] == ["overlay-add"]
    assert mpv.overlays[0][1] == StatusScreens.OVERLAY_ID
    # a playlist change while playing announces again; an unchanged poll does not
    run_cycle(cfg, client, state, screens=screens)
    assert len(mpv.overlays) == 1
    cms.files["c.mp4"] = b"C" * 10
    cms.set_playlist(["a.mp4", "b.mp4", "c.mp4"])
    run_cycle(cfg, client, state, screens=screens)
    assert names(mpv) == ["a.mp4", "b.mp4", "c.mp4"]
    assert [o[0] for o in mpv.overlays] == ["overlay-add", "overlay-add"]


def test_syncing_screen_never_interrupts_playing_content(cfg, cms, mpv, client, screens):
    seed_local(cfg, cms, ["a.mp4"])
    state = fresh_state(cfg)
    run_cycle(cfg, client, state, screens=screens)
    assert names(mpv) == ["a.mp4"] and screens.current is None
    n = len(mpv.commands("loadfile"))
    cms.files["b.mp4"] = b"B" * 10
    cms.set_playlist(["a.mp4", "b.mp4"])
    run_cycle(cfg, client, state, screens=screens)
    assert (cfg.media_dir / "b.mp4").is_file()
    assert names(mpv) == ["a.mp4", "b.mp4"] and mpv.current["path"].endswith("a.mp4")
    assert not any(c["url"].endswith(".png") for c in mpv.commands("loadfile")[n:])
    assert screens.current is None
    assert cms.sync_calls[-1]["player_status"] == "playing"


def test_status_screen_is_reported_as_idle_not_playing(cfg, cms, mpv, client, screens):
    state = fresh_state(cfg)
    run_cycle(cfg, client, state, screens=screens)      # pairing screen up
    run_cycle(cfg, client, state, screens=screens)
    assert cms.sync_calls[-1]["player_status"] == "idle"
    assert "current_filename" not in cms.sync_calls[-1]


def test_enospc_during_download_shows_storage_full(cfg, cms, mpv, client, screens, monkeypatch):
    import errno
    from player import sync as sync_mod
    cms.files["a.mp4"] = b"A" * 10
    cms.set_playlist(["a.mp4"])

    def full(*a, **k):
        raise OSError(errno.ENOSPC, "No space left on device")
    monkeypatch.setattr(sync_mod, "_download_item", full)
    state = fresh_state(cfg)
    run_cycle(cfg, client, state, screens=screens)
    assert state.storage_full is True
    assert screens.current.kind == "error" and screens.current.reason == "storage"
    assert "1 of 1 items missing: no space left on device" in screen_texts(screens)
    assert mpv.commands("stop") == []
    cms.files["b.mp4"] = b"B" * 10                      # a full card fails every item: still STORAGE FULL
    cms.set_playlist(["a.mp4", "b.mp4"])
    run_cycle(cfg, client, state, screens=screens)
    assert state.storage_full is True
    assert screens.current.reason == "storage" and "2 of 2 items missing: no space left on device" in screen_texts(screens)


def test_every_item_failing_shows_error_screen(cfg, cms, mpv, client, screens):
    cms.files["a.mp4"] = b"A" * 10
    cms.set_playlist(["a.mp4"])
    cms.files.clear()                                   # download 404s
    state = fresh_state(cfg)
    run_cycle(cfg, client, state, screens=screens)
    assert screens.current.kind == "error" and screens.current.reason == "other"
    assert "download failed: a.mp4: HTTP 404" in screen_texts(screens)
    cms.files["a.mp4"] = b"A" * 10                      # file appears: content takes over
    run_cycle(cfg, client, state, screens=screens)
    assert names(mpv) == ["a.mp4"] and screens.current is None


def test_mpv_idle_for_four_cycles_shows_player_fault(cfg, cms, mpv, client, screens, caplog):
    seed_local(cfg, cms, ["a.mp4", "b.mp4"])
    state = fresh_state(cfg)
    run_cycle(cfg, client, state, screens=screens)
    n = len(mpv.commands("loadfile"))
    with caplog.at_level(logging.WARNING, logger="piplayer"):
        for _ in range(4):
            mpv.current = None                           # every entry keeps failing to start
            run_cycle(cfg, client, state, screens=screens)
    loads = mpv.commands("loadfile")[n:]
    assert [c["flags"] for c in loads[:2]] == ["replace", "append"]   # the one re-push after two idle cycles
    assert [x for x in screen_loads(mpv) if x != "syncing.png"] == ["error.png"]   # (cycle 1 verified the unindexed files)
    assert screens.current.reason == "player" and "mpv could not start any of 2 items" in screen_texts(screens)
    assert sum("player fault screen" in r.getMessage() for r in caplog.records) == 1
    m = len(mpv.commands("loadfile"))
    run_cycle(cfg, client, state, screens=screens)       # stays on the fault screen, no more re-pushes
    assert len(mpv.commands("loadfile")) == m
    cms.files["c.mp4"] = b"C" * 10                       # a playlist change pushes content again
    cms.set_playlist(["c.mp4"])
    run_cycle(cfg, client, state, screens=screens)
    assert names(mpv) == ["c.mp4"] and screens.current is None


def test_unassign_then_reassign_same_playlist_resumes_content(cfg, cms, mpv, client, screens):
    seed_local(cfg, cms, ["a.mp4"])
    state = fresh_state(cfg)
    run_cycle(cfg, client, state, screens=screens)
    assert names(mpv) == ["a.mp4"]
    h = cms.manifest["playlist"]["hash"]
    saved = dict(cms.manifest["playlist"])
    cms.manifest["playlist"] = None                     # unassigned: media pruned, pairing screen up
    run_cycle(cfg, client, state, screens=screens)
    assert screens.current.kind == "pairing" and names(mpv) == ["pairing.png"]
    cms.manifest["playlist"] = saved                    # the very same playlist (same hash) comes back
    assert cms.manifest["playlist"]["hash"] == h
    run_cycle(cfg, client, state, screens=screens)
    assert names(mpv) == ["a.mp4"] and screens.current is None
    assert state.applied_hash == h
    assert [o[0] for o in mpv.overlays][-1] == "overlay-add"


def test_verify_all_while_fault_screen_does_not_strand_syncing_screen(cfg, cms, mpv, client, screens):
    seed_local(cfg, cms, ["a.mp4", "b.mp4"])
    state = fresh_state(cfg)
    run_cycle(cfg, client, state, screens=screens)
    for _ in range(4):
        mpv.current = None
        run_cycle(cfg, client, state, screens=screens)
    assert screens.current.reason == "player"
    state.force_verify = True                           # daily verify_all (or a force-sync) while on the fault screen
    run_cycle(cfg, client, state, screens=screens)
    assert "syncing.png" in screen_loads(mpv)[-2:]      # progress was shown over the fault screen...
    assert screens.current is None and names(mpv) == ["a.mp4", "b.mp4"]   # ...then the content was pushed again
    mpv.current = None                                  # still cannot start: the fault screen returns
    run_cycle(cfg, client, state, screens=screens)
    assert screens.current.reason == "player"
    for _ in range(3):
        run_cycle(cfg, client, state, screens=screens)  # mpv shows the PNG fine: nothing is re-rendered
    assert screens.current.reason == "player" and screen_loads(mpv)[-1] == "error.png"


def test_player_fault_retries_content_slowly(cfg, cms, mpv, client, screens):
    seed_local(cfg, cms, ["a.mp4"])
    state = fresh_state(cfg)
    run_cycle(cfg, client, state, screens=screens)
    for _ in range(4):
        mpv.current = None                              # no display: not even the fault PNG starts
        run_cycle(cfg, client, state, screens=screens)
    assert screens.current.reason == "player" and names(mpv) == ["error.png"]
    n = len(mpv.commands("loadfile"))
    cycles = 0
    while names(mpv) == ["error.png"]:                  # display fixed: mpv now plays whatever it is given
        run_cycle(cfg, client, state, screens=screens)
        cycles += 1
        assert cycles <= daemon.FAULT_RETRY_CYCLES
    assert names(mpv) == ["a.mp4"] and mpv.current["path"].endswith("a.mp4")
    assert screens.current is None
    assert len(mpv.commands("loadfile")) == n + 1       # exactly one retry push
    for _ in range(3):
        run_cycle(cfg, client, state, screens=screens)  # and it stays on content
    assert names(mpv) == ["a.mp4"] and screens.current is None and state.idle_streak == 0


def test_partial_push_failure_does_not_keep_screen_flag(cfg, cms, mpv, client, screens, monkeypatch):
    state = fresh_state(cfg)
    run_cycle(cfg, client, state, screens=screens)      # pairing screen up
    cms.files["a.mp4"] = b"A" * 10
    cms.files["b.mp4"] = b"B" * 10
    cms.set_playlist(["a.mp4", "b.mp4"])
    real_append = MpvClient.load_append
    monkeypatch.setattr(MpvClient, "load_append", lambda self, path, options=None: False)
    run_cycle(cfg, client, state, screens=screens)
    assert names(mpv) == ["a.mp4"]                      # the first item replaced the PNG before the append failed
    assert state.applied_hash is None and screens.current is None
    assert cms.sync_calls[-1]["player_status"] == "idle"
    monkeypatch.setattr(MpvClient, "load_append", real_append)
    run_cycle(cfg, client, state, screens=screens)
    assert names(mpv) == ["a.mp4", "b.mp4"]
    assert cms.sync_calls[-1]["player_status"] == "playing"


def test_syncing_screen_is_not_rendered_while_mpv_is_down(cfg, cms, mpv, client, screens):
    cms.files["a.mp4"] = b"A" * 10
    cms.set_playlist(["a.mp4"])
    mpv.alive = False
    state = fresh_state(cfg)
    run_cycle(cfg, client, state, screens=screens)
    assert (cfg.media_dir / "a.mp4").is_file()
    assert screens.current is None and not (screens.dir / "syncing.png").exists()
    assert mpv.commands("loadfile") == []
    mpv.restart()
    run_cycle(cfg, client, state, screens=screens)
    assert names(mpv) == ["a.mp4"]


# ------------------------------------------------------------- room camera ---

def test_camera_error_is_sent_only_when_a_camera_is_configured(cfg, cms, mpv, client):
    from player.camera import CameraCapture
    import dataclasses
    state = fresh_state(cfg)
    run_cycle(cfg, client, state)
    assert "camera_error" not in cms.sync_calls[-1]

    cam_cfg = dataclasses.replace(cfg, camera_source="rtsp", camera_rtsp_url="rtsp://cam/1")
    cam = CameraCapture(cam_cfg)                 # not started: only the status plumbing is exercised
    run_cycle(cam_cfg, client, state, camera=cam)
    assert cms.sync_calls[-1]["camera_error"] == ""     # an empty value clears the console's last error
    cam.error = "ffmpeg timed out after 15s"
    run_cycle(cam_cfg, client, state, camera=cam)
    assert cms.sync_calls[-1]["camera_error"] == "ffmpeg timed out after 15s"


def test_manifest_camera_interval_updates_the_capture_cadence(cfg, cms, mpv, client):
    from player.camera import CameraCapture
    cam = CameraCapture(cfg)
    assert cam.interval == 10
    cms.manifest["camera_interval_seconds"] = 3          # below the floor
    run_cycle(cfg, client, fresh_state(cfg), camera=cam)
    assert cam.interval == 5
    cms.manifest["camera_interval_seconds"] = "bogus"    # a bad field is logged, not fatal
    assert run_cycle(cfg, client, fresh_state(cfg), camera=cam) is not None
    assert cam.interval == 5
