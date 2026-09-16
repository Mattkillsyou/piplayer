"""Remote commands: report-before-execute, retries, executed_commands.json dedupe."""
import json

import pytest

from fakes import FakeCms
from player import commands
from player.commands import execute_commands, executed_ids_path, load_executed_ids


def ids(cfg):
    return [e["id"] for e in load_executed_ids(cfg)]


@pytest.fixture
def cms(monkeypatch):
    c = FakeCms()
    c.install(monkeypatch)
    monkeypatch.setattr(commands, "_RETRY_DELAY_SECONDS", 0)
    return c


@pytest.fixture
def actions(monkeypatch):
    """Record the order of side effects (reports vs. actions) instead of running sudo."""
    log = []
    monkeypatch.setattr(commands, "_run_reboot", lambda: log.append("reboot") or "reboot issued")
    monkeypatch.setattr(commands, "_run_restart_mpv", lambda: log.append("restart-mpv") or "mpv restart issued")
    return log


def test_reboot_is_reported_before_it_runs(cfg, cms, monkeypatch):
    order = []

    def post(url, **kw):
        order.append(("post", kw["json"]["result"]))
        return cms.post(url, **kw)
    monkeypatch.setattr(commands.requests, "post", post)
    monkeypatch.setattr(commands, "_run_reboot", lambda: order.append(("action", "reboot")) or "reboot issued")

    execute_commands(cfg, None, [{"id": 5, "command": "reboot"}], lambda: None)
    assert order == [("post", "executing reboot"), ("action", "reboot")]
    assert ids(cfg) == [5]


def test_restart_mpv_is_reported_before_it_runs(cfg, cms, actions):
    execute_commands(cfg, None, [{"id": 6, "command": "restart-mpv"}], lambda: None)
    assert cms.post_calls == [("http://cms.test/api/commands/6/result", {"result": "executing mpv restart"})]
    assert actions == ["restart-mpv"]


def test_failed_action_result_is_reported_afterwards(cfg, cms, monkeypatch):
    monkeypatch.setattr(commands, "_run_reboot",
                        lambda: "reboot failed: rc=1 sudo: a password is required")
    execute_commands(cfg, None, [{"id": 8, "command": "reboot"}], lambda: None)
    assert [r["result"] for _, r in cms.post_calls] == ["executing reboot", "reboot failed: rc=1 sudo: a password is required"]


def test_report_is_retried_twice(cfg, cms, actions):
    cms.post_failures_left = 2
    execute_commands(cfg, None, [{"id": 9, "command": "reboot"}], lambda: None)
    assert cms.post_failures_left == 0
    assert [r["result"] for _, r in cms.post_calls] == ["executing reboot"]
    assert actions == ["reboot"]


def test_action_runs_even_if_every_report_fails(cfg, cms, actions):
    cms.post_failures_left = 3
    execute_commands(cfg, None, [{"id": 10, "command": "reboot"}], lambda: None)
    assert actions == ["reboot"]
    assert cms.post_calls == []
    assert ids(cfg) == [10]


def test_redelivered_command_is_never_executed_twice(cfg, cms, actions):
    """Lost result report -> CMS re-delivers the id after the reboot; it must not reboot again."""
    cms.post_failures_left = 3
    execute_commands(cfg, None, [{"id": 11, "command": "reboot"}], lambda: None)
    assert actions == ["reboot"]
    # fresh process after the reboot, same id delivered again
    execute_commands(cfg, None, [{"id": 11, "command": "reboot"}, {"id": 12, "command": "force-sync"}], lambda: None)
    assert actions == ["reboot"]
    assert [(u, r["result"]) for u, r in cms.post_calls] == [
        ("http://cms.test/api/commands/11/result", "already executed: reboot"),
        ("http://cms.test/api/commands/12/result", "queued resync"),
    ]
    assert ids(cfg) == [11, 12]


def test_force_sync_and_unknown_commands(cfg, cms):
    flag = []
    execute_commands(cfg, None, [{"id": 1, "command": "force-sync"}, {"id": 2, "command": "dance"}], lambda: flag.append(1))
    assert flag == [1]
    assert [r["result"] for _, r in cms.post_calls] == ["queued resync", "unknown command: dance"]
    assert ids(cfg) == [1, 2]


def test_executed_ledger_lives_next_to_manifest_and_is_capped(cfg, cms):
    assert executed_ids_path(cfg) == cfg.manifest_path.parent / "executed_commands.json"
    cmds = [{"id": i, "command": "force-sync"} for i in range(1, 251)]
    execute_commands(cfg, None, cmds, lambda: None)
    raw = json.loads(executed_ids_path(cfg).read_text())
    assert len(raw) == 200 and raw[0] == {"id": 51, "issued_at": None} and raw[-1]["id"] == 250


def test_corrupt_ledger_is_tolerated(cfg, cms, actions):
    executed_ids_path(cfg).parent.mkdir(exist_ok=True)
    executed_ids_path(cfg).write_text("{not json")
    execute_commands(cfg, None, [{"id": 3, "command": "restart-mpv"}], lambda: None)
    assert actions == ["restart-mpv"]
    assert ids(cfg) == [3]


def test_reused_id_after_cms_db_reset_is_executed(cfg, cms, actions):
    """Command ids restart from 1 when the controller's DB is recreated/restored;
    a different issued_at marks the re-used id as a new command."""
    execute_commands(cfg, None, [{"id": 1, "command": "reboot", "issued_at": "2026-09-01 10:00:00"}], lambda: None)
    assert actions == ["reboot"]
    # same id re-delivered (lost result) -> not repeated
    execute_commands(cfg, None, [{"id": 1, "command": "reboot", "issued_at": "2026-09-01 10:00:00"}], lambda: None)
    assert actions == ["reboot"]
    # DB restored from an old backup: id 1 is a brand-new command
    execute_commands(cfg, None, [{"id": 1, "command": "reboot", "issued_at": "2026-09-14 08:30:00"}], lambda: None)
    assert actions == ["reboot", "reboot"]
    assert load_executed_ids(cfg) == [
        {"id": 1, "issued_at": "2026-09-01 10:00:00"},
        {"id": 1, "issued_at": "2026-09-14 08:30:00"},
    ]


def test_ledger_without_issued_at_falls_back_to_id_only(cfg, cms, actions):
    """Legacy ledgers (bare ids) and a CMS that sends no issued_at keep the old dedupe."""
    executed_ids_path(cfg).parent.mkdir(exist_ok=True)
    executed_ids_path(cfg).write_text("[4]")
    execute_commands(cfg, None, [{"id": 4, "command": "reboot", "issued_at": "2026-09-14 08:30:00"},
                                 {"id": 5, "command": "restart-mpv"}], lambda: None)
    assert actions == ["restart-mpv"]
    execute_commands(cfg, None, [{"id": 5, "command": "restart-mpv"}], lambda: None)
    assert actions == ["restart-mpv"]
    assert ids(cfg) == [4, 5]


# ------------------------------------------------------------ remote updates ---

def test_update_commands_are_reported_before_the_script_runs(cfg, cms, monkeypatch):
    from player import updater
    order = []

    def post(url, **kw):
        order.append(("post", kw["json"]["result"]))
        return cms.post(url, **kw)
    monkeypatch.setattr(commands.requests, "post", post)
    monkeypatch.setattr(updater, "run_command",
                        lambda action, update: order.append(("run", action, (update or {}).get("release"))) or f"{action} started")

    execute_commands(cfg, None, [{"id": 20, "command": "update-player"}, {"id": 21, "command": "update-all"},
                                 {"id": 22, "command": "update-os"}], lambda: None, update={"release": "v6.0"})
    assert order == [
        ("post", "executing update-player"), ("run", "update-player", "v6.0"),
        ("post", "executing update-all"), ("run", "update-all", "v6.0"),
        ("post", "executing update-os"), ("run", "update-os", "v6.0"),
    ]
    assert ids(cfg) == [20, 21, 22]


def test_update_that_fails_to_start_is_reported(cfg, cms, monkeypatch):
    from player import updater
    monkeypatch.setattr(updater, "run_command", lambda action, update: "update-player main failed: rc=1 sudo: a password is required")
    execute_commands(cfg, None, [{"id": 23, "command": "update-player"}], lambda: None)
    assert [r["result"] for _, r in cms.post_calls] == [
        "executing update-player", "update-player main failed: rc=1 sudo: a password is required"]
    # re-delivered (lost report): never run twice
    execute_commands(cfg, None, [{"id": 23, "command": "update-player"}], lambda: None)
    assert cms.post_calls[-1][1] == {"result": "already executed: update-player"}
