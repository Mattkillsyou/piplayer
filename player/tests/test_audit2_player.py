"""Second-audit fixes: seamless option change without replay, re-push gating,
idle-with-entries recovery, crash guards, stop responsiveness, .part
completion, IPC deadline/EOF paths, screenshot upload, restart-mpv re-push."""
import json
import logging
import shutil
import subprocess
from pathlib import Path

import pytest

from fakes import FakeCms, FakeMpv
from player import daemon
from player.daemon import PlayerState, run_cycle
from player.mpv_client import MpvClient
from player.screenshots import ScreenshotScheduler, capture_and_upload
from player.sync import _download_item

MEDIA = Path("/var/lib/projector-player/media")
JPEG = b"\xff\xd8\xff\xe0" + b"\x00" * 64


def P(name):
    return MEDIA / name


@pytest.fixture
def mpv(monkeypatch):
    fake = FakeMpv()
    fake.install(monkeypatch)
    return fake


@pytest.fixture
def cms(monkeypatch):
    c = FakeCms()
    c.install(monkeypatch)
    return c


@pytest.fixture
def client(tmp_path):
    return MpvClient(tmp_path / "mpv.sock")


def names(mpv):
    return [Path(p).name for p in mpv.paths()]


def cmd_names(mpv, start=0):
    out = []
    for m in mpv.requests[start:]:
        c = m["command"]
        out.append(c["name"] if isinstance(c, dict) else c[0])
    return out


def playing(mpv, name):
    for e in mpv.playlist:
        if e["path"] == str(P(name)):
            mpv.current = e
            return
    raise AssertionError(name)


def seed_local(cfg, cms, names_, **item_kw):
    for n in names_:
        cms.files[n] = n.encode() * 10
    cms.set_playlist(names_, **item_kw)
    cfg.manifest_path.write_text(json.dumps(cms.manifest))
    for n in names_:
        (cfg.media_dir / n).write_bytes(cms.files[n])


def fresh_state(cfg):
    from player.sync import load_local_manifest
    return PlayerState(last_manifest=load_local_manifest(cfg), backoff=cfg.poll_interval_seconds)


# ------------------------------------------- S002: no back-to-back replay ---

def play_through(mpv, client, n):
    """Advance playback n times, letting the daemon's per-poll hook run each time."""
    seen = []
    for _ in range(n):
        mpv.advance()
        seen.append(Path(mpv.current["path"]).name)
        assert client.remove_stale_entry() is True
    return seen


def test_option_change_mid_list_keeps_order_and_never_replays(client, mpv):
    client.apply_playlist([(P("a.mp4"), {}), (P("b.png"), {"image-display-duration": "10"}), (P("c.mp4"), {})])
    playing(mpv, "b.png")
    assert client.apply_playlist([(P("a.mp4"), {}), (P("b.png"), {"image-display-duration": "30"}), (P("c.mp4"), {})])
    assert names(mpv) == ["a.mp4", "b.png", "c.mp4"]           # exact order, no duplicate
    assert mpv.current["path"].endswith("b.png")               # never interrupted
    # b -> c -> a -> b(new options) -> c: the change lands when b comes around again
    assert play_through(mpv, client, 4) == ["c.mp4", "a.mp4", "b.png", "c.mp4"]
    assert names(mpv) == ["a.mp4", "b.png", "c.mp4"]
    assert mpv.playlist[1]["opts"] == {"image-display-duration": "30"}
    assert len(mpv.commands("playlist-remove")) == 1


def test_option_change_on_first_item_plays_the_rest_before_repeating(client, mpv):
    client.apply_playlist([(P("logo.png"), {"image-display-duration": "10"}), (P("promo.mp4"), {})])
    playing(mpv, "logo.png")
    assert client.apply_playlist([(P("logo.png"), {"image-display-duration": "30"}), (P("promo.mp4"), {})])
    assert play_through(mpv, client, 3) == ["promo.mp4", "logo.png", "promo.mp4"]
    assert names(mpv) == ["logo.png", "promo.mp4"]
    assert mpv.playlist[0]["opts"] == {"image-display-duration": "30"}


def test_option_change_on_last_item_is_not_replayed(client, mpv):
    client.apply_playlist([(P("a.mp4"), {}), (P("b.png"), {"image-display-duration": "10"})])
    playing(mpv, "b.png")
    assert client.apply_playlist([(P("a.mp4"), {}), (P("b.png"), {"image-display-duration": "5"})])
    assert play_through(mpv, client, 3) == ["a.mp4", "b.png", "a.mp4"]
    assert names(mpv) == ["a.mp4", "b.png"]
    assert mpv.playlist[1]["opts"] == {"image-display-duration": "5"}


def test_option_change_on_single_item_loop_applies_after_one_more_play(client, mpv):
    """A one-item loop never leaves index 0, so the fresh entry is queued right away."""
    client.apply_playlist([(P("a.png"), {"image-display-duration": "10"})])
    assert client.apply_playlist([(P("a.png"), {"image-display-duration": "30"})])
    assert [e["opts"]["image-display-duration"] for e in mpv.playlist] == ["10", "30"]
    assert client.remove_stale_entry() is True          # still on the old entry
    assert len(mpv.playlist) == 2
    mpv.advance()
    assert client.remove_stale_entry() is True
    assert [e["opts"]["image-display-duration"] for e in mpv.playlist] == ["30"]
    assert mpv.current is mpv.playlist[0]


def test_option_change_then_playlist_change_before_swap(client, mpv):
    """A second edit lands while the old entry is still playing: the later
    reload rebuilds from the manifest and the pending swap is dropped."""
    client.apply_playlist([(P("a.mp4"), {}), (P("b.mp4"), {"length": "3"})])
    playing(mpv, "b.mp4")
    assert client.apply_playlist([(P("a.mp4"), {}), (P("b.mp4"), {"length": "9"})])
    assert client.apply_playlist([(P("c.mp4"), {}), (P("b.mp4"), {"length": "9"})])
    assert names(mpv) == ["c.mp4", "b.mp4"]
    assert mpv.current["path"] == str(P("b.mp4"))
    mpv.advance()
    assert client.remove_stale_entry() is True
    assert names(mpv) == ["c.mp4", "b.mp4"]
    assert mpv.playlist[1]["opts"] == {"length": "9"}


def test_failed_swap_forces_a_full_repush_by_daemon(cfg, cms, mpv, client, monkeypatch):
    monkeypatch.setattr(daemon, "capture_and_upload", lambda cfg, mpv: True)
    seed_local(cfg, cms, ["a.png", "b.png"], media_type="image")
    state = fresh_state(cfg)
    run_cycle(cfg, client, state)
    cms.set_playlist(["a.png", "b.png"], media_type="image", duration=25)
    run_cycle(cfg, client, state)                       # a.png playing: swap pending
    assert client._stale is not None
    mpv.advance()
    mpv.lost_reply_commands = {"loadfile"}              # re-add reply lost
    run_cycle(cfg, client, state)
    assert state.applied_hash is None
    mpv.lost_reply_commands = set()
    run_cycle(cfg, client, state)                       # full re-push repairs the loop
    assert names(mpv) == ["a.png", "b.png"]
    assert all(e["opts"] == {"image-display-duration": "25"} for e in mpv.playlist)
    assert state.applied_hash == cms.manifest["playlist"]["hash"]


# ------------------------------- S011: option changed while daemon was down ---

def test_option_changed_while_daemon_was_down_is_applied(cfg, cms, mpv, client, tmp_path, monkeypatch):
    monkeypatch.setattr(daemon, "capture_and_upload", lambda cfg, mpv: True)
    seed_local(cfg, cms, ["a.png", "b.png"], media_type="image", duration=40)
    state = fresh_state(cfg)
    run_cycle(cfg, client, state)
    mpv.advance()                                       # now playing b.png
    # daemon restarts (mpv keeps running); meanwhile b.png's duration changed
    cms.set_playlist(["a.png", "b.png"], media_type="image", duration=50)
    fresh = MpvClient(tmp_path / "mpv.sock")
    state2 = fresh_state(cfg)
    run_cycle(cfg, fresh, state2)
    assert mpv.current["path"].endswith("b.png")
    assert mpv.playlist[1]["opts"] == {"image-display-duration": "40"}   # still the playing entry
    mpv.advance()
    run_cycle(cfg, fresh, state2)
    assert names(mpv) == ["a.png", "b.png"]
    assert mpv.playlist[1]["opts"] == {"image-display-duration": "50"}


# ------------------------------------- S003: all items missing, no thrash ---

def test_all_items_missing_is_pushed_once_then_quiet(cfg, cms, mpv, client, monkeypatch, caplog):
    monkeypatch.setattr(daemon, "capture_and_upload", lambda cfg, mpv: True)
    cms.files["a.mp4"] = b"A" * 10
    cms.files["b.mp4"] = b"B" * 10
    cms.set_playlist(["a.mp4", "b.mp4"])
    cms.files.clear()                                   # every download 404s
    state = fresh_state(cfg)
    run_cycle(cfg, client, state)
    assert cmd_names(mpv).count("playlist-clear") == 1 and cmd_names(mpv).count("stop") == 1
    n = len(mpv.requests)
    caplog.clear()
    with caplog.at_level(logging.WARNING, logger="piplayer"):
        run_cycle(cfg, client, state)
        run_cycle(cfg, client, state)
    assert cmd_names(mpv, n).count("playlist-clear") == 0 and cmd_names(mpv, n).count("stop") == 0
    msgs = [r.getMessage() for r in caplog.records]
    assert not any("re-pushing" in m for m in msgs)
    assert not any("not downloaded yet" in m for m in msgs)
    assert sum("sync incomplete" in m for m in msgs) == 2
    # a file arriving still triggers a push
    cms.files["a.mp4"] = b"A" * 10
    run_cycle(cfg, client, state)
    assert names(mpv) == ["a.mp4"]


# ------------------------------- X001: mpv idle with entries still queued ---

def test_idle_with_entries_queued_is_repushed_after_two_cycles(cfg, cms, mpv, client, monkeypatch, caplog):
    monkeypatch.setattr(daemon, "capture_and_upload", lambda cfg, mpv: True)
    seed_local(cfg, cms, ["a.mp4", "b.mp4"])
    state = fresh_state(cfg)
    run_cycle(cfg, client, state)
    n = len(mpv.commands("loadfile"))
    mpv.current = None            # every entry failed to start (no display at boot): idle, count == 2
    run_cycle(cfg, client, state)
    assert len(mpv.commands("loadfile")) == n           # one idle cycle could be a file transition
    assert state.idle_cycles == 1
    with caplog.at_level(logging.WARNING, logger="piplayer"):
        run_cycle(cfg, client, state)
    assert len(mpv.commands("loadfile")) == n + 2
    assert mpv.commands("loadfile")[n]["flags"] == "replace"
    assert mpv.current["path"].endswith("a.mp4")
    assert any("idle with 2 entries queued" in r.getMessage() for r in caplog.records)
    assert state.idle_cycles == 0
    run_cycle(cfg, client, state)
    assert len(mpv.commands("loadfile")) == n + 2       # playing again: no further push


def test_idle_counter_resets_when_playback_resumes(cfg, cms, mpv, client, monkeypatch):
    monkeypatch.setattr(daemon, "capture_and_upload", lambda cfg, mpv: True)
    seed_local(cfg, cms, ["a.mp4"])
    state = fresh_state(cfg)
    run_cycle(cfg, client, state)
    mpv.current = None
    run_cycle(cfg, client, state)
    mpv.current = mpv.playlist[0]
    run_cycle(cfg, client, state)
    assert state.idle_cycles == 0
    mpv.current = None
    run_cycle(cfg, client, state)
    assert state.idle_cycles == 1 and len(mpv.commands("loadfile")) == 1


# ----------------------------------- S025: bad manifest fields do not crash ---

@pytest.mark.parametrize("field,value", [("screenshot_interval_seconds", "abc"),
                                         ("screenshot_interval_seconds", "60.5"),
                                         ("commands", [None]),
                                         ("commands", "reboot")])
def test_malformed_manifest_tail_fields_are_logged_not_fatal(cfg, cms, mpv, client, monkeypatch, caplog, field, value):
    monkeypatch.setattr(daemon, "capture_and_upload", lambda cfg, mpv: True)
    seed_local(cfg, cms, ["a.mp4"])
    cms.manifest[field] = value
    state = fresh_state(cfg)
    with caplog.at_level(logging.WARNING, logger="piplayer"):
        manifest = run_cycle(cfg, client, state, ScreenshotScheduler(60))
    assert manifest is not None
    assert names(mpv) == ["a.mp4"]
    assert any(r.levelno >= logging.WARNING for r in caplog.records)
    assert run_cycle(cfg, client, state, ScreenshotScheduler(60)) is not None


def test_non_dict_command_entries_are_skipped_not_fatal(cfg, cms, mpv, client, monkeypatch):
    monkeypatch.setattr(daemon, "capture_and_upload", lambda cfg, mpv: True)
    monkeypatch.setattr(daemon, "_force_sync_now", False)
    seed_local(cfg, cms, ["a.mp4"])
    cms.manifest["commands"] = [None, "x", {"id": 3, "command": "force-sync"}]
    state = fresh_state(cfg)
    run_cycle(cfg, client, state)
    assert cms.post_calls == [("http://cms.test/api/commands/3/result", {"result": "queued resync"})]


# ------------------------------------- S014: stop responsiveness / timeouts ---

def test_stop_request_skips_screenshot_and_commands(cfg, cms, mpv, client, monkeypatch):
    calls = []
    monkeypatch.setattr(daemon, "capture_and_upload", lambda cfg, mpv: calls.append("shot"))
    monkeypatch.setattr(daemon, "execute_commands", lambda *a: calls.append("cmd"))
    seed_local(cfg, cms, ["a.mp4"])
    cms.manifest["commands"] = [{"id": 1, "command": "force-sync"}]
    orig = daemon.sync_once

    def sync_then_sigterm(*a, **k):
        out = orig(*a, **k)
        monkeypatch.setattr(daemon, "_stop", True)      # SIGTERM lands right after the sync
        return out
    monkeypatch.setattr(daemon, "sync_once", sync_then_sigterm)
    state = fresh_state(cfg)
    assert run_cycle(cfg, client, state, ScreenshotScheduler(15)) is not None
    assert calls == []
    assert names(mpv) == ["a.mp4"]          # reconcile still ran


def test_network_read_timeouts_fit_inside_the_stop_grace_period(cfg, cms, mpv, monkeypatch):
    seen = {}
    orig_get, orig_post = cms.get, cms.post

    def get(url, **kw):
        seen[url] = kw.get("timeout")
        return orig_get(url, **kw)

    def post(url, **kw):
        seen[url] = kw.get("timeout")
        return orig_post(url, **kw)
    import player.sync as sync_mod
    import player.screenshots as shot_mod
    monkeypatch.setattr(sync_mod.requests, "get", get)
    monkeypatch.setattr(shot_mod.requests, "post", post)
    cms.files["a.mp4"] = b"A" * 10
    cms.set_playlist(["a.mp4"])
    mpv.screenshot_bytes = JPEG
    state = fresh_state(cfg)
    run_cycle(cfg, MpvClient(cfg.mpv_socket), state, ScreenshotScheduler(15))
    unit = Path(__file__).resolve().parents[1] / "deploy" / "projector-player.service"
    stop_sec = int(next(l for l in unit.read_text().splitlines() if l.startswith("TimeoutStopSec=")).split("=")[1])
    for url, t in seen.items():
        read = t[1] if isinstance(t, tuple) else t
        assert read is not None and read < stop_sec, (url, t)
    assert seen["http://cms.test/api/media/a.mp4"] == (10, 15)
    assert seen["http://cms.test/api/screenshots/dev-1"] == 15


# ---------------------------------- S026: a complete .part is not re-fetched ---

def test_complete_part_file_is_finished_locally(cfg, cms):
    cms.files["big.mp4"] = b"Z" * 3000
    item = cms.item("big.mp4")
    part = cfg.media_dir / "big.mp4.part"
    part.write_bytes(cms.files["big.mp4"])      # died between the last write and the rename
    assert _download_item(cfg, item) == cfg.media_dir / "big.mp4"
    assert cms.media_calls == []                 # no GET at all
    assert (cfg.media_dir / "big.mp4").read_bytes() == cms.files["big.mp4"]
    assert not part.exists()


def test_complete_but_corrupt_part_file_is_redownloaded(cfg, cms):
    cms.files["big.mp4"] = b"Z" * 3000
    item = cms.item("big.mp4")
    (cfg.media_dir / "big.mp4.part").write_bytes(b"Y" * 3000)
    assert _download_item(cfg, item) == cfg.media_dir / "big.mp4"
    assert [h.get("Range") for _, h in cms.media_calls] == [None]   # from byte 0, no 416 round trip
    assert (cfg.media_dir / "big.mp4").read_bytes() == cms.files["big.mp4"]


# ------------------------------ S032: reply deadline and EOF in the IPC reader ---

def test_event_flood_without_reply_hits_the_deadline(client, mpv, monkeypatch, caplog):
    mpv.silent_commands = {"get_property"}
    mpv.recv_on_empty = "events"
    clock = iter(range(0, 10_000))
    monkeypatch.setattr("player.mpv_client.time.monotonic", lambda: float(next(clock)))
    with caplog.at_level(logging.WARNING, logger="piplayer.mpv"):
        assert client.get_property("pid") is None
    assert any("no reply to" in r.getMessage() and "within" in r.getMessage() for r in caplog.records)
    assert client._ids is not None                       # client still usable
    mpv.silent_commands = set()
    mpv.recv_on_empty = None
    assert client.get_property("pid") == 1000


def test_eof_before_reply_returns_none_with_warning(client, mpv, caplog):
    mpv.silent_commands = {"loadfile"}
    mpv.recv_on_empty = "eof"
    with caplog.at_level(logging.WARNING, logger="piplayer.mpv"):
        assert client.load_replace(P("a.mp4")) is False
    assert any("no reply to" in r.getMessage() for r in caplog.records)


# ------------------------------------------- S040: screenshot capture/upload ---

def test_capture_and_upload_sends_jpeg_multipart_with_bearer(cfg, cms, mpv, tmp_path):
    mpv.screenshot_bytes = JPEG
    assert capture_and_upload(cfg, MpvClient(cfg.mpv_socket)) is True
    cmd = mpv.commands("screenshot-to-file")[0]
    assert cmd[2] == "video" and cmd[1].endswith(".jpg")
    assert not Path(cmd[1]).exists()                     # temp file removed
    (url, headers, files) = cms.upload_calls[0]
    assert url == "http://cms.test/api/screenshots/dev-1"
    assert headers["Authorization"] == "Bearer tok"
    assert files == {"file": ("dev-1.jpg", JPEG, "image/jpeg")}


def test_capture_and_upload_reports_failures(cfg, cms, mpv):
    client = MpvClient(cfg.mpv_socket)
    assert capture_and_upload(cfg, client) is False      # mpv wrote nothing
    assert cms.upload_calls == []
    mpv.screenshot_bytes = JPEG
    cms.post_status = 400
    assert capture_and_upload(cfg, client) is False
    mpv.fail_commands = {"screenshot-to-file"}
    cms.post_status = 200
    assert capture_and_upload(cfg, client) is False
    assert len(cms.upload_calls) == 1
    mpv.alive = False
    assert capture_and_upload(cfg, client) is False


def test_run_cycle_uploads_when_screenshot_is_due(cfg, cms, mpv):
    seed_local(cfg, cms, ["a.mp4"])
    mpv.screenshot_bytes = JPEG
    cms.manifest["screenshot_interval_seconds"] = 120
    sched = ScreenshotScheduler(15)
    state = fresh_state(cfg)
    run_cycle(cfg, MpvClient(cfg.mpv_socket), state, sched)
    assert len(cms.upload_calls) == 1
    assert sched.interval == 120
    run_cycle(cfg, MpvClient(cfg.mpv_socket), state, sched)
    assert len(cms.upload_calls) == 1                    # not due again yet


# ------------------------------- S042: restart-mpv re-pushes in the same cycle ---

def test_restart_mpv_command_repushes_without_waiting_for_next_poll(cfg, cms, mpv, client, monkeypatch):
    import player.commands as cmd_mod
    monkeypatch.setattr(daemon, "capture_and_upload", lambda cfg, mpv: True)
    monkeypatch.setattr(cmd_mod, "_RETRY_DELAY_SECONDS", 0)

    def fake_restart():
        mpv.restart()
        return "mpv restart issued"
    monkeypatch.setattr(cmd_mod, "_run_restart_mpv", fake_restart)
    seed_local(cfg, cms, ["a.mp4", "b.mp4"])
    state = fresh_state(cfg)
    run_cycle(cfg, client, state)
    old_pid = state.mpv_pid
    cms.manifest["commands"] = [{"id": 5, "command": "restart-mpv"}]
    run_cycle(cfg, client, state)
    assert mpv.pid != old_pid and state.mpv_pid == mpv.pid
    assert names(mpv) == ["a.mp4", "b.mp4"]              # re-pushed within this cycle
    assert mpv.current["path"].endswith("a.mp4")
    assert cms.post_calls[-1] == ("http://cms.test/api/commands/5/result", {"result": "executing mpv restart"})


# ------------------------------ S004: installer keeps per-Pi config edits ---

@pytest.mark.skipif(shutil.which("bash") is None, reason="bash not available")
def test_installer_preserves_mpv_conf_and_config_extras(tmp_path):
    script = Path(__file__).resolve().parents[1] / "deploy" / "install-player.sh"
    src = script.read_text()
    mpv_block = src[src.index('echo "==> Installing mpv kiosk config"'):src.index('echo "==> Creating virtualenv"')]
    cfg_block = src[src.index('echo "==> Writing config file'):src.index('chmod 600 "${ETC_DIR}/config.toml"')]
    data = tmp_path / "data"
    etc = tmp_path / "etc"
    (data / ".config" / "mpv").mkdir(parents=True)
    etc.mkdir()
    shipped = script.parent / "mpv.conf"
    (data / ".config" / "mpv" / "mpv.conf").write_text("vo=drm\nhwdec=v4l2m2m-copy\n")
    (etc / "config.toml").write_text('device_id = "old"\ndevice_token = "old"\ncms_url = "http://old"\n'
                                     'media_dir = "/x"\nmanifest_path = "/y"\nmpv_socket = "/z"\n'
                                     'poll_interval_seconds = 15\n# note\nverify_tls = false\n')

    def posix(p):
        return str(p).replace("\\", "/").replace("C:", "/c").replace("D:", "/d")
    env = {"SRC_DIR": posix(script.parent.parent), "DATA_DIR": posix(data), "ETC_DIR": posix(etc),
           "USER_NAME": "nobody", "DEVICE_ID": "new", "DEVICE_TOKEN": "tok", "CMS_URL": "http://cms"}
    prelude = "".join(f'{k}="{v}"\n' for k, v in env.items()) + "chown() { :; }\n"
    res = subprocess.run(["bash", "-c", prelude + mpv_block + cfg_block], capture_output=True, text=True)
    assert res.returncode == 0, res.stderr
    assert (data / ".config" / "mpv" / "mpv.conf").read_text() == "vo=drm\nhwdec=v4l2m2m-copy\n"
    assert (data / ".config" / "mpv" / "mpv.conf.dist").read_text() == shipped.read_text()
    assert "mpv.conf.dist" in res.stdout
    conf = (etc / "config.toml").read_text()
    assert 'device_id = "new"' in conf and 'cms_url = "http://cms"' in conf
    assert "poll_interval_seconds = 15" in conf and "verify_tls = false" in conf
    assert conf.count("poll_interval_seconds") == 1 and "old" not in conf
    # a fresh install gets the shipped mpv.conf and the default poll interval
    shutil.rmtree(data / ".config" / "mpv")
    (data / ".config" / "mpv").mkdir()
    (etc / "config.toml").unlink()
    res = subprocess.run(["bash", "-c", prelude + mpv_block + cfg_block], capture_output=True, text=True)
    assert res.returncode == 0, res.stderr
    assert (data / ".config" / "mpv" / "mpv.conf").read_text() == shipped.read_text()
    assert not (data / ".config" / "mpv" / "mpv.conf.dist").exists()
    assert "poll_interval_seconds = 30" in (etc / "config.toml").read_text()
