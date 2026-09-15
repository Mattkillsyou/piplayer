"""Wire format of every IPC message, reply/event interleaving, seamless reload."""
import json
from pathlib import Path

import pytest

from fakes import FakeMpv
from player.mpv_client import MpvClient


@pytest.fixture
def mpv(monkeypatch):
    fake = FakeMpv()
    fake.install(monkeypatch)
    return fake


@pytest.fixture
def client(mpv, tmp_path):
    return MpvClient(tmp_path / "mpv.sock")


def P(name: str) -> Path:
    return Path("/var/lib/projector-player/media") / name


# ------------------------------------------------------------ wire format ---

def test_every_request_carries_a_unique_request_id(client, mpv):
    client.get_property("pid")
    client.get_property("path")
    client.command("stop")
    ids = [m["request_id"] for m in mpv.requests]
    assert all(isinstance(i, int) for i in ids)
    assert len(set(ids)) == 3
    assert ids == sorted(ids)


def test_get_property_wire_format(client, mpv):
    assert client.get_property("pid") == 1000
    assert mpv.requests[-1] == {"command": ["get_property", "pid"], "request_id": mpv.requests[-1]["request_id"]}


def test_set_property_wire_format(client, mpv):
    assert client.set_property("pause", True) is True
    assert mpv.requests[-1]["command"] == ["set_property", "pause", True]


def test_loadfile_uses_named_arguments_replace(client, mpv):
    assert client.load_replace(P("a.mp4"), {"length": "12"}) is True
    cmd = mpv.requests[-1]["command"]
    assert cmd == {"name": "loadfile", "url": str(P("a.mp4")), "flags": "replace", "options": {"length": "12"}}
    assert mpv.paths() == [str(P("a.mp4"))]
    assert mpv.playlist[0]["opts"] == {"length": "12"}


def test_loadfile_uses_named_arguments_append(client, mpv):
    client.load_replace(P("a.mp4"))
    assert client.load_append(P("b.png"), {"image-display-duration": "10"}) is True
    cmd = mpv.requests[-1]["command"]
    assert cmd == {"name": "loadfile", "url": str(P("b.png")), "flags": "append",
                   "options": {"image-display-duration": "10"}}
    # options key is always a JSON object, even when empty
    assert mpv.requests[-2]["command"]["options"] == {}


def test_loadfile_never_uses_positional_index_form(client, mpv):
    """mpv 0.35.1 (Bookworm) rejects ['loadfile', url, flags, -1, {...}]."""
    client.load_replace(P("a.mp4"), {"length": "5"})
    client.load_append(P("b.mp4"))
    for c in mpv.commands("loadfile"):
        assert isinstance(c, dict)


def test_playlist_commands_wire_format(client, mpv):
    client.load_replace(P("a.mp4"))
    client.load_append(P("b.mp4"))
    client.load_append(P("c.mp4"))
    assert client.command("playlist-move", 0, 2)["error"] == "success"
    assert mpv.requests[-1]["command"] == ["playlist-move", 0, 2]
    assert client.command("playlist-remove", 0)["error"] == "success"
    assert mpv.requests[-1]["command"] == ["playlist-remove", 0]
    assert client.command("playlist-clear")["error"] == "success"
    assert mpv.requests[-1]["command"] == ["playlist-clear"]
    assert client.command("stop")["error"] == "success"
    assert mpv.requests[-1]["command"] == ["stop"]


def test_screenshot_command_wire_format(client, mpv):
    reply = client.command("screenshot-to-file", "/tmp/x.jpg", "video")
    assert reply["error"] == "success"
    assert mpv.requests[-1]["command"] == ["screenshot-to-file", "/tmp/x.jpg", "video"]


def test_version_and_pid_helpers(client, mpv):
    assert client.get_version() == "mpv 0.35.1"
    assert client.get_pid() == 1000
    mpv.restart(pid=1234)
    assert client.get_pid() == 1234
    assert [c for c in mpv.commands("get_property")] == [
        ["get_property", "mpv-version"], ["get_property", "pid"], ["get_property", "pid"]]


def test_payload_is_newline_terminated_json(client, mpv, monkeypatch):
    raw = []
    orig = FakeMpv.handle

    def spy(self, data):
        raw.append(data)
        return orig(self, data)
    monkeypatch.setattr(FakeMpv, "handle", spy)
    client.get_property("pid")
    assert raw[0].endswith(b"\n")
    assert json.loads(raw[0]) == {"command": ["get_property", "pid"], "request_id": 1}


# --------------------------------------------------- reply/event interleaving ---

def test_events_before_reply_are_skipped(client, mpv):
    mpv.pending_events = ["end-file", "start-file", "file-loaded"]
    assert client.load_replace(P("a.mp4")) is True
    assert mpv.paths() == [str(P("a.mp4"))]


def test_event_burst_during_full_playlist_load(client, mpv):
    """Every reconnect sees the broadcast burst caused by the previous loadfile."""
    orig = mpv._exec

    def exec_with_burst(cmd):
        mpv.pending_events = ["end-file", "start-file", "playback-restart"]
        return orig(cmd)
    mpv._exec = exec_with_burst
    ok = client.load_full_playlist([(P("a.mp4"), {}), (P("b.png"), {"image-display-duration": "10"}), (P("c.mp4"), {})])
    assert ok is True
    assert mpv.paths() == [str(P("a.mp4")), str(P("b.png")), str(P("c.mp4"))]


def test_reply_for_other_request_id_is_skipped(client, mpv):
    mpv.pending_prefix = [json.dumps({"request_id": 9999, "error": "success", "data": "stale"})]
    assert client.get_property("pid") == 1000


def test_reply_split_across_recv_calls(client, mpv, monkeypatch):
    from fakes import FakeSocket
    orig_recv = FakeSocket.recv
    monkeypatch.setattr(FakeSocket, "recv", lambda self, n: orig_recv(self, 3))
    mpv.pending_events = ["end-file"]
    assert client.get_property("mpv-version") == "mpv 0.35.1"


def test_no_reply_returns_none_and_load_fails(client, mpv):
    mpv.silent_commands = {"loadfile"}
    mpv.pending_events = ["end-file"]
    assert client.load_replace(P("a.mp4")) is False
    assert client.load_full_playlist([(P("a.mp4"), {})]) is False


def test_lost_reply_is_not_retried_so_no_duplicate_entry(client, mpv):
    """mpv executed the loadfile but the reply was lost: a blind retry would
    append the item twice. The daemon re-pushes the whole playlist instead."""
    client.load_replace(P("a.mp4"))
    mpv.lost_reply_commands = {"loadfile"}
    assert client.load_append(P("b.mp4")) is False
    assert len(mpv.commands("loadfile")) == 2          # sent exactly once
    assert [e["path"] for e in mpv.playlist] == [str(P("a.mp4")), str(P("b.mp4"))]


def test_error_reply_is_returned(client, mpv):
    mpv.fail_commands = {"loadfile"}
    assert client.load_replace(P("a.mp4")) is False
    assert client.get_property("nope") is None


def test_unparsable_line_is_ignored(client, mpv):
    mpv.pending_prefix = ["{not json", ""]
    assert client.get_pid() == 1000


def test_socket_down(client, mpv):
    mpv.alive = False
    assert client.is_alive() is False
    assert client.get_property("pid") is None
    assert client.command("stop") is None


# -------------------------------------------------------- seamless reload ---

def playing(mpv, name):
    for e in mpv.playlist:
        if e["path"] == str(P(name)):
            mpv.current = e
            return
    raise AssertionError(name)


def names(mpv):
    return [Path(p).name for p in mpv.paths()]


def cmd_names(mpv, start=0):
    out = []
    for m in mpv.requests[start:]:
        c = m["command"]
        out.append(c["name"] if isinstance(c, dict) else c[0])
    return out


def test_initial_apply_is_a_full_load(client, mpv):
    assert client.apply_playlist([(P("a.mp4"), {}), (P("b.mp4"), {})]) is True
    assert names(mpv) == ["a.mp4", "b.mp4"]
    assert mpv.current["path"] == str(P("a.mp4"))
    flags = [c["flags"] for c in mpv.commands("loadfile")]
    assert flags == ["replace", "append"]


def test_seamless_reload_keeps_current_and_moves_it(client, mpv):
    items = [(P("a.mp4"), {}), (P("b.mp4"), {"length": "5"}), (P("c.mp4"), {})]
    client.apply_playlist(items)
    playing(mpv, "b.mp4")
    start = len(mpv.requests)
    # new order: c, x, b, a  (b keeps playing; target index 2)
    new = [(P("c.mp4"), {}), (P("x.mp4"), {}), (P("b.mp4"), {"length": "5"}), (P("a.mp4"), {})]
    assert client.apply_playlist(new) is True
    seq = mpv.requests[start:]
    assert seq[0]["command"] == ["get_property", "path"]
    assert seq[1]["command"] == ["playlist-clear"]
    assert seq[2]["command"] == ["get_property", "path"]   # re-check what the clear kept
    assert [c["command"] for c in seq[3:6]] == [
        {"name": "loadfile", "url": str(P("c.mp4")), "flags": "append", "options": {}},
        {"name": "loadfile", "url": str(P("x.mp4")), "flags": "append", "options": {}},
        {"name": "loadfile", "url": str(P("a.mp4")), "flags": "append", "options": {}},
    ]
    assert seq[6]["command"] == ["playlist-move", 0, 3]
    assert len(seq) == 7
    assert names(mpv) == ["c.mp4", "x.mp4", "b.mp4", "a.mp4"]
    assert mpv.current["path"] == str(P("b.mp4"))   # never interrupted
    assert "replace" not in [c.get("flags") for c in mpv.commands("loadfile")[3:]]


def test_seamless_reload_current_stays_first_no_move(client, mpv):
    client.apply_playlist([(P("a.mp4"), {}), (P("b.mp4"), {})])
    start = len(mpv.requests)
    assert client.apply_playlist([(P("a.mp4"), {}), (P("z.mp4"), {}), (P("b.mp4"), {})]) is True
    assert cmd_names(mpv, start) == ["get_property", "playlist-clear", "get_property", "loadfile", "loadfile"]
    assert names(mpv) == ["a.mp4", "z.mp4", "b.mp4"]


def test_seamless_reload_current_moves_to_end(client, mpv):
    client.apply_playlist([(P("a.mp4"), {}), (P("b.mp4"), {}), (P("c.mp4"), {})])
    playing(mpv, "a.mp4")
    start = len(mpv.requests)
    assert client.apply_playlist([(P("b.mp4"), {}), (P("c.mp4"), {}), (P("a.mp4"), {})]) is True
    assert mpv.requests[-1]["command"] == ["playlist-move", 0, 3]
    assert names(mpv) == ["b.mp4", "c.mp4", "a.mp4"]
    assert mpv.current["path"] == str(P("a.mp4"))
    assert cmd_names(mpv, start).count("playlist-clear") == 1


def test_current_changes_between_path_read_and_clear(client, mpv):
    """mpv advanced to the next entry between get_property('path') and
    playlist-clear: the kept entry is not the one the decision was made for,
    so the reload must fall back to a full load instead of mis-ordering."""
    client.apply_playlist([(P("a.mp4"), {}), (P("b.mp4"), {}), (P("c.mp4"), {})])
    playing(mpv, "a.mp4")
    orig = mpv._exec

    def exec_advancing_on_clear(cmd):
        if (cmd["name"] if isinstance(cmd, dict) else cmd[0]) == "playlist-clear":
            mpv.advance()          # a -> b right before the clear lands
        return orig(cmd)
    mpv._exec = exec_advancing_on_clear
    start = len(mpv.requests)
    new = [(P("c.mp4"), {}), (P("b.mp4"), {}), (P("a.mp4"), {})]
    assert client.apply_playlist(new) is True
    assert names(mpv) == ["c.mp4", "b.mp4", "a.mp4"]
    assert len(names(mpv)) == len(set(names(mpv)))
    assert cmd_names(mpv, start) == ["get_property", "playlist-clear", "get_property",
                                     "loadfile", "loadfile", "loadfile"]
    assert [c["flags"] for c in mpv.commands("loadfile")][-3:] == ["replace", "append", "append"]


def test_current_removed_triggers_replace(client, mpv):
    client.apply_playlist([(P("a.mp4"), {}), (P("b.mp4"), {})])
    playing(mpv, "b.mp4")
    start = len(mpv.requests)
    assert client.apply_playlist([(P("a.mp4"), {}), (P("c.mp4"), {})]) is True
    seq = cmd_names(mpv, start)
    assert seq == ["get_property", "loadfile", "loadfile"]
    assert mpv.requests[start + 1]["command"]["flags"] == "replace"
    assert names(mpv) == ["a.mp4", "c.mp4"]
    assert mpv.current["path"] == str(P("a.mp4"))


def test_idle_mpv_gets_full_load(client, mpv):
    client.apply_playlist([(P("a.mp4"), {})])
    mpv.restart()          # idle, no path
    start = len(mpv.requests)
    assert client.apply_playlist([(P("a.mp4"), {}), (P("b.mp4"), {})]) is True
    assert mpv.requests[start + 1]["command"]["flags"] == "replace"
    assert names(mpv) == ["a.mp4", "b.mp4"]


def test_empty_list_clears_and_stops(client, mpv):
    client.apply_playlist([(P("a.mp4"), {})])
    start = len(mpv.requests)
    assert client.apply_playlist([]) is True
    assert cmd_names(mpv, start) == ["playlist-clear", "stop"]
    assert mpv.playlist == []


def test_option_change_on_current_item_applies_on_next_play(client, mpv):
    client.apply_playlist([(P("a.png"), {"image-display-duration": "10"}), (P("b.mp4"), {})])
    playing(mpv, "a.png")
    start = len(mpv.requests)
    new = [(P("a.png"), {"image-display-duration": "30"}), (P("b.mp4"), {})]
    assert client.apply_playlist(new) is True
    # no replace: a.png keeps playing at its place with the old options; nothing is duplicated
    assert cmd_names(mpv, start) == ["get_property", "playlist-clear", "get_property", "loadfile"]
    assert names(mpv) == ["a.png", "b.mp4"]
    assert mpv.playlist[0]["opts"] == {"image-display-duration": "10"}   # still playing, old options
    # while a.png (index 0) is still playing the entry is left alone
    assert client.remove_stale_entry() is True
    assert names(mpv) == ["a.png", "b.mp4"]
    # once playback moved on, the entry is swapped for one with the new options, in place
    mpv.advance()
    start = len(mpv.requests)
    assert client.remove_stale_entry() is True
    assert cmd_names(mpv, start) == ["get_property", "playlist-remove", "loadfile", "get_property", "playlist-move"]
    assert mpv.requests[start + 1]["command"] == ["playlist-remove", 0]
    assert mpv.requests[start + 4]["command"] == ["playlist-move", 1, 0]
    assert names(mpv) == ["a.png", "b.mp4"]
    assert mpv.playlist[0]["opts"] == {"image-display-duration": "30"}
    assert mpv.current["path"] == str(P("b.mp4"))
    n = len(mpv.requests)
    assert client.remove_stale_entry() is True
    assert len(mpv.requests) == n   # nothing more sent


def test_failed_append_during_seamless_reload_returns_false(client, mpv):
    client.apply_playlist([(P("a.mp4"), {}), (P("b.mp4"), {})])
    mpv.silent_commands = {"loadfile"}
    assert client.apply_playlist([(P("a.mp4"), {}), (P("c.mp4"), {})]) is False
    assert mpv.current["path"] == str(P("a.mp4"))   # still playing
    mpv.silent_commands = set()
    assert client.apply_playlist([(P("a.mp4"), {}), (P("c.mp4"), {})]) is True
    assert names(mpv) == ["a.mp4", "c.mp4"]


def test_unknown_options_after_restart_are_treated_as_identical(client, mpv, tmp_path):
    """A freshly started daemon has no record of the options mpv was loaded
    with: the playing entry is kept (never interrupted) and swapped for one
    carrying the manifest's options once playback moves on."""
    client.apply_playlist([(P("a.mp4"), {}), (P("b.mp4"), {"length": "3"})])
    playing(mpv, "b.mp4")
    fresh = MpvClient(tmp_path / "mpv.sock")
    start = len(mpv.requests)
    assert fresh.apply_playlist([(P("a.mp4"), {}), (P("b.mp4"), {"length": "3"})]) is True
    assert cmd_names(mpv, start) == ["get_property", "playlist-clear", "get_property", "loadfile", "playlist-move"]
    assert names(mpv) == ["a.mp4", "b.mp4"]
    assert mpv.current["path"] == str(P("b.mp4"))
    mpv.advance()
    assert fresh.remove_stale_entry() is True
    assert names(mpv) == ["a.mp4", "b.mp4"]
    assert mpv.playlist[1]["opts"] == {"length": "3"}


# ------------------------------------------------------- startup socket wait ---

def test_wait_for_socket_stops_early_on_shutdown(client, mpv, monkeypatch):
    """A SIGTERM during the 60 s startup wait must end the wait promptly (the
    unit's TimeoutStopSec would otherwise SIGKILL the daemon)."""
    mpv.alive = False
    calls = []
    monkeypatch.setattr("player.mpv_client.time.sleep", lambda s: calls.append(s))
    assert client.wait_for_socket(max_wait_s=60.0, should_stop=lambda: len(calls) >= 3) is False
    assert len(calls) == 3


def test_wait_for_socket_returns_true_when_alive(client, mpv):
    assert client.wait_for_socket(max_wait_s=1.0, should_stop=lambda: True) is True
