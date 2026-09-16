"""Remote updates: script invocation shape, update-status.json reporting, nightly window."""
import json
import os
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest

from player import updater
from player.daemon import PlayerState

TZ = timezone(timedelta(hours=-7))
SCRIPT = "/opt/piplayer/player/deploy/update-player.sh"


@pytest.fixture
def runs(monkeypatch):
    """Capture subprocess.run calls instead of invoking sudo; rc via runs.rc."""
    calls = SimpleNamespace(args=[], rc=0)

    def fake_run(cmd, **kw):
        calls.args.append(list(cmd))
        return SimpleNamespace(returncode=calls.rc, stderr="sudo: a password is required\n" if calls.rc else "")
    monkeypatch.setattr(updater.subprocess, "run", fake_run)
    return calls


def write_status(cfg, **fields):
    st = {"ref": "main", "started": "2026-09-14T03:05:00Z", "finished": "2026-09-14T03:07:30Z",
          "ok": True, "message": "updated abc -> def", "previous_version": "abc"}
    st.update(fields)
    updater.status_path(cfg).write_text(json.dumps(st))
    return st


# ------------------------------------------------------------ invocation ---

def test_update_commands_run_the_scripts_with_the_manifest_ref(runs):
    assert updater.run_command("update-player", {"release": "v6.0"}) == "update-player v6.0 started"
    assert updater.run_command("update-all", {"release": "v6.0"}) == "update-player v6.0 started"
    assert updater.run_command("update-os", {"release": "v6.0"}) == "update-os started"
    assert updater.run_command("update-player", None) == "update-player main started"
    assert runs.args == [
        ["sudo", "-n", SCRIPT, "v6.0"],
        ["sudo", "-n", SCRIPT, "v6.0", "--then-os"],
        ["sudo", "-n", "/opt/piplayer/player/deploy/update-os.sh"],
        ["sudo", "-n", SCRIPT, "main"],
    ]


def test_bad_ref_never_reaches_sudo(runs):
    assert updater.run_command("update-player", {"release": "--upload-pack=evil"}).startswith("update-player failed: bad ref")
    assert updater.run_command("update-player", {"release": "a b"}).startswith("update-player failed: bad ref")
    assert runs.args == []


def test_nonzero_exit_is_a_failure(runs):
    runs.rc = 1
    assert updater.run_update_player("main") == "update-player main failed: rc=1 sudo: a password is required"


def test_player_version_carries_the_release_sha(tmp_path, monkeypatch):
    monkeypatch.setattr(updater, "RELEASE_PATH", tmp_path / "RELEASE")
    assert updater.player_version() == "0.2.0"
    (tmp_path / "RELEASE").write_text("1a2b3c4d5e6f7890\n")
    assert updater.player_version() == "0.2.0+1a2b3c4"


# ------------------------------------------------------- status reporting ---

def test_status_file_is_reported_once(cfg):
    assert updater.pending_status(cfg) is None
    st = write_status(cfg)
    pending = updater.pending_status(cfg)
    assert json.loads(pending.param) == st
    assert pending.reboot is False
    assert len(pending.param) <= updater.STATUS_PARAM_MAX_LEN
    updater.mark_reported(cfg, pending)
    assert updater.pending_status(cfg) is None      # a daemon restart does not re-send it

    # the next script run rewrites the file: reported again
    write_status(cfg, ok=False, message="install-player.sh --upgrade failed")
    os.utime(updater.status_path(cfg), (2_000_000_000, 2_000_000_000))
    again = updater.pending_status(cfg)
    assert json.loads(again.param)["ok"] is False


def test_status_param_is_capped_at_500_chars(cfg):
    write_status(cfg, message="x" * 900)
    pending = updater.pending_status(cfg)
    assert len(pending.param) <= 500
    assert json.loads(pending.param)["ref"] == "main"


def test_update_os_status_asks_for_a_reboot(cfg):
    write_status(cfg, ref="os", previous_version=None, message="3 upgraded; reboot required", reboot_required=True)
    pending = updater.pending_status(cfg)
    assert pending.reboot is True
    assert "reboot_required" not in json.loads(pending.param)   # the console's contract has the six keys only


def test_corrupt_status_file_is_ignored(cfg):
    updater.status_path(cfg).write_text("{nope")
    assert updater.pending_status(cfg) is None
    updater.status_path(cfg).write_text("[1, 2]")
    assert updater.pending_status(cfg) is None


# ------------------------------------------------------------ auto window ---

def at(h, m):
    return datetime(2026, 9, 14, h, m, tzinfo=TZ)


def test_window_membership_including_midnight_wrap():
    assert updater.in_window("03:00-05:00", at(3, 0))
    assert updater.in_window("03:00-05:00", at(4, 59))
    assert not updater.in_window("03:00-05:00", at(5, 0))
    assert not updater.in_window("03:00-05:00", at(14, 0))
    assert updater.in_window("23:00-01:00", at(23, 30))
    assert updater.in_window("23:00-01:00", at(0, 30))
    assert not updater.in_window("23:00-01:00", at(2, 0))
    assert not updater.in_window("garbage", at(3, 0))
    assert not updater.in_window("25:00-26:00", at(3, 0))


def test_auto_update_due_rules():
    nightly = {"release": "main", "auto": "nightly", "window": "03:00-05:00"}
    assert not updater.auto_update_due(None, at(3, 30), None)
    assert not updater.auto_update_due({"auto": "off", "window": "03:00-05:00"}, at(3, 30), None)
    assert updater.auto_update_due(nightly, at(3, 30), None)
    assert not updater.auto_update_due(nightly, at(9, 0), None)
    assert not updater.auto_update_due(nightly, at(3, 30), at(3, 10))   # 20 min ago
    assert not updater.auto_update_due(nightly, at(3, 30), at(3, 30) - timedelta(hours=19))
    assert updater.auto_update_due(nightly, at(3, 30), at(3, 30) - timedelta(hours=20))
    assert updater.auto_update_due({"auto": "nightly"}, at(4, 0), None)      # window defaults to 03:00-05:00


def test_nightly_update_runs_once_per_window(cfg, runs):
    update = {"release": "v6.0", "auto": "nightly", "window": "03:00-05:00"}
    state = PlayerState()
    assert updater.maybe_auto_update(cfg, update, state, now=at(3, 10)) is True
    assert runs.args == [["sudo", "-n", SCRIPT, "v6.0"]]
    # every later poll in the same window: nothing (in-memory guard)
    assert updater.maybe_auto_update(cfg, update, state, now=at(3, 11)) is False
    assert updater.maybe_auto_update(cfg, update, state, now=at(4, 59)) is False
    # the script restarted the daemon: fresh state, but update-status.json says it just ran
    write_status(cfg, started=at(3, 10).astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"))
    assert updater.maybe_auto_update(cfg, update, PlayerState(), now=at(3, 20)) is False
    # next night
    assert updater.maybe_auto_update(cfg, update, PlayerState(), now=at(3, 10) + timedelta(days=1)) is True
    assert len(runs.args) == 2


def test_an_update_os_run_does_not_delay_the_nightly_player_update(cfg, runs):
    update = {"release": "main", "auto": "nightly", "window": "03:00-05:00"}
    write_status(cfg, ref="os", started="2026-09-14T09:00:00Z")
    assert updater.last_player_update_started(cfg) is None
    assert updater.maybe_auto_update(cfg, update, PlayerState(), now=at(3, 10) + timedelta(days=1)) is True


def test_auto_off_or_missing_update_block_never_runs(cfg, runs):
    assert updater.maybe_auto_update(cfg, None, PlayerState(), now=at(3, 10)) is False
    assert updater.maybe_auto_update(cfg, {"auto": "off"}, PlayerState(), now=at(3, 10)) is False
    assert runs.args == []
