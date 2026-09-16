"""Projector power: Broadlink RM4 send/learn with a fake broadlink module,
CEC via a fake cec-ctl, the projector-on/off/ir-learn commands, and the
manifest-driven auto mode (transition on change only, retry once, sync params)."""
import base64
import json
import sys
import types

import pytest

from fakes import FakeCms, FakeMpv
from player import commands, daemon, projector
from player.commands import execute_commands
from player.daemon import PlayerState, run_cycle
from player.mpv_client import MpvClient
from player.projector import Projector

PACKET = b"\x26\x00\x0a\x00" + bytes(range(16))
B64 = base64.b64encode(PACKET).decode()


class FakeRm:
    """The bits of broadlink.rm4mini the module touches."""

    def __init__(self, host="10.0.0.9"):
        self.host = (host, 80)
        self.auth_ok = True
        self.sent: list[bytes] = []
        self.fail_sends = 0            # send_data raises this many times first
        self.learning = False
        self.learned: bytes | None = None   # what check_data returns once learning
        self.checks = 0
        self.storage_full = False           # check_data raises StorageError (-5) while nothing captured

    def auth(self):
        return self.auth_ok

    def send_data(self, packet):
        if self.fail_sends:
            self.fail_sends -= 1
            raise OSError("timed out")
        self.sent.append(bytes(packet))

    def enter_learning(self):
        self.learning = True

    def check_data(self):
        self.checks += 1
        exc = sys.modules["broadlink"].exceptions
        if self.learned is None or self.checks < 3:
            if self.storage_full:
                raise exc.StorageError("The device storage is full")
            raise exc.ReadError("no data")
        return self.learned


@pytest.fixture
def rm(monkeypatch):
    """Install a fake `broadlink` package: discover() answers [rm], hello(host) answers rm."""
    dev = FakeRm()
    mod = types.ModuleType("broadlink")
    exc = types.ModuleType("broadlink.exceptions")
    exc.ReadError = type("ReadError", (Exception,), {})
    exc.StorageError = type("StorageError", (Exception,), {})
    mod.exceptions = exc
    mod.calls = []
    mod.discover = lambda timeout=10, **kw: mod.calls.append(("discover", timeout)) or ([dev] if dev.host else [])
    mod.hello = lambda host, timeout=10, **kw: mod.calls.append(("hello", host)) or dev
    monkeypatch.setitem(sys.modules, "broadlink", mod)
    monkeypatch.setitem(sys.modules, "broadlink.exceptions", exc)
    monkeypatch.setattr(projector.time, "sleep", lambda s: None)
    return dev


def block(control="broadlink", mode="manual", want=None, host=None, codes=None):
    b = {"control": control, "mode": mode, "codes": codes if codes is not None else {"power_on": B64, "power_off": B64}}
    if want:
        b["want"] = want
    if host:
        b["host"] = host
    return b


# ------------------------------------------------------------- broadlink ---

def test_send_code_discovers_when_no_host_and_hellos_the_host_otherwise(rm):
    projector.send_code(B64)
    assert rm.sent == [PACKET]
    assert sys.modules["broadlink"].calls == [("discover", 5)]
    projector.send_code(B64, host="10.0.0.9")
    assert sys.modules["broadlink"].calls[-1] == ("hello", "10.0.0.9")
    assert len(rm.sent) == 2


def test_send_code_rejects_bad_codes_and_failed_auth(rm):
    with pytest.raises(RuntimeError, match="bad IR code"):
        projector.send_code("not*base64")
    with pytest.raises(RuntimeError, match="bad IR code: empty"):
        projector.send_code("")
    rm.auth_ok = False
    with pytest.raises(RuntimeError, match="auth failed"):
        projector.send_code(B64)
    assert rm.sent == []


def test_nothing_discovered_is_a_clear_error(rm):
    rm.host = None
    with pytest.raises(RuntimeError, match="no Broadlink RM found"):
        projector.send_code(B64)


def test_learn_polls_until_the_remote_is_pressed(rm):
    rm.learned = PACKET
    assert projector.learn_code(sleep=lambda s: None) == B64
    assert rm.learning and rm.checks == 3


def test_learn_keeps_polling_through_storage_full(rm):
    rm.learned = PACKET
    rm.storage_full = True
    assert projector.learn_code(sleep=lambda s: None) == B64
    assert rm.checks == 3


def test_learn_gives_up_after_the_window(rm, monkeypatch):
    clock = [0.0]

    def sleep(s):
        clock[0] += s
    monkeypatch.setattr(projector.time, "monotonic", lambda: clock[0])
    with pytest.raises(RuntimeError, match="nothing learned in 30 s"):
        projector.learn_code(sleep=sleep)
    assert 29 <= rm.checks <= 31


# ------------------------------------------------------------------- cec ---

class Calls(list):
    fail: set = set()      # last argv words whose cec-ctl call fails


@pytest.fixture
def cec(monkeypatch):
    """Fake cec-ctl: records every argv, fails when its last word is in `cec.fail`."""
    calls = Calls()
    calls.fail = set()

    def run(cmd, **kw):
        calls.append(cmd)
        rc = 1 if cmd[-1] in calls.fail else 0
        return types.SimpleNamespace(returncode=rc, stdout="", stderr="Transmit failed" if rc else "")
    monkeypatch.setattr(projector.subprocess, "run", run)
    return calls


def test_cec_claims_playback_then_sends_image_view_on_or_standby(cec):
    projector.cec_power("on")
    projector.cec_power("off")
    assert cec == [
        ["cec-ctl", "-d", "/dev/cec0", "--playback", "-S"],
        ["cec-ctl", "-d", "/dev/cec0", "--to", "0", "--image-view-on"],
        ["cec-ctl", "-d", "/dev/cec0", "--playback", "-S"],
        ["cec-ctl", "-d", "/dev/cec0", "--to", "0", "--standby"],
    ]


def test_cec_failure_surfaces_stderr(cec):
    cec.fail.add("--standby")
    with pytest.raises(RuntimeError, match="cec-ctl --to 0 --standby failed: rc=1 Transmit failed"):
        projector.cec_power("off")


# ------------------------------------------------------- Projector state ---

def test_power_retries_once_and_records_state(rm):
    p = Projector()
    p.set_block(block())
    rm.fail_sends = 1
    assert p.power("on") == "projector on sent via broadlink"
    assert rm.sent == [PACKET] and (p.state, p.error) == ("on", "")

    rm.fail_sends = 2                          # both attempts fail: state unknown, error kept for the console
    assert p.power("off").startswith("projector-off failed: timed out")
    assert (p.state, p.error) == ("unknown", "projector off: timed out")
    assert len(rm.sent) == 1


def test_power_without_a_code_or_with_control_none_fails_cleanly(rm):
    p = Projector()
    p.set_block(block(codes={"power_on": B64}))
    assert p.power("off") == "projector-off failed: no power_off code learned yet"
    p.set_block(block(control="none"))
    assert p.power("on") == "projector-on failed: projector control is none"
    p.set_block(None)
    assert p.power("on") == "projector-on failed: projector control is none"
    assert rm.sent == []


def test_power_uses_the_block_host(rm):
    p = Projector()
    p.set_block(block(host="10.0.0.9"))
    p.power("on")
    assert sys.modules["broadlink"].calls == [("hello", "10.0.0.9")]
    p.set_block({"control": "broadlink", "broadlink_host": "10.0.0.7", "codes": {"power_on": B64}})
    p.power("on")
    assert sys.modules["broadlink"].calls[-1] == ("hello", "10.0.0.7")


def test_power_via_cec(cec):
    p = Projector()
    p.set_block(block(control="cec"))
    assert p.power("off") == "projector off sent via cec"
    assert cec[-1][-1] == "--standby" and p.state == "off"


def test_learn_returns_the_code_as_json(rm):
    p = Projector()
    p.set_block(block(host="10.0.0.9"))
    rm.learned = PACKET
    assert json.loads(p.learn("power_on")) == {"learned": "power_on", "code": B64}
    rm.learned = None
    p.set_block(block())
    rm.auth_ok = False
    assert p.learn("input_hdmi1") == "ir-learn input_hdmi1 failed: Broadlink auth failed for 10.0.0.9"


# --------------------------------------------------------------- auto mode ---

def test_auto_mode_applies_want_on_change_only(rm):
    p = Projector()
    p.set_block(block(mode="auto", want="on"))
    assert p.maybe_apply() is True
    assert p.maybe_apply() is False                  # same want: nothing sent again
    assert rm.sent == [PACKET] and p.state == "on"
    p.set_block(block(mode="auto", want="off"))
    assert p.maybe_apply() is True
    assert len(rm.sent) == 2 and p.state == "off"


def test_auto_mode_is_off_for_manual_none_or_bad_want(rm):
    p = Projector()
    for b in (block(mode="manual", want="on"), block(mode="auto", control="none", want="on"),
              block(mode="auto", want="maybe"), block(mode="auto"), None):
        p.set_block(b)
        assert p.maybe_apply() is False
    assert rm.sent == []


def test_auto_mode_failure_is_reported_not_retried_until_want_changes(rm):
    p = Projector()
    p.set_block(block(mode="auto", want="on"))
    rm.fail_sends = 5
    assert p.maybe_apply() is True
    assert (p.state, p.error) == ("unknown", "projector on: timed out")
    assert rm.fail_sends == 3                          # exactly two attempts
    assert p.maybe_apply() is False
    p.set_block(block(mode="auto", want="off"))
    rm.fail_sends = 0
    assert p.maybe_apply() is True and p.state == "off" and p.error == ""


# ---------------------------------------------------------------- commands ---

@pytest.fixture
def cms(monkeypatch):
    c = FakeCms()
    c.install(monkeypatch)
    monkeypatch.setattr(commands, "_RETRY_DELAY_SECONDS", 0)
    monkeypatch.setattr(daemon, "capture_and_upload", lambda cfg, mpv: True)
    return c


def test_projector_commands_report_their_result(cfg, cms, rm):
    p = Projector()
    p.set_block(block(host="10.0.0.9"))
    rm.learned = PACKET
    execute_commands(cfg, None, [{"id": 1, "command": "projector-on"}, {"id": 2, "command": "ir-learn:power_off"},
                                 {"id": 3, "command": "projector-off"}], lambda: None, projector=p)
    results = [r["result"] for _, r in cms.post_calls]
    assert results[0] == "projector on sent via broadlink"
    assert json.loads(results[1]) == {"learned": "power_off", "code": B64}
    assert results[2] == "projector off sent via broadlink"
    assert rm.sent == [PACKET, PACKET]
    # re-delivered: never sent twice
    execute_commands(cfg, None, [{"id": 1, "command": "projector-on"}], lambda: None, projector=p)
    assert cms.post_calls[-1][1] == {"result": "already executed: projector-on"}
    assert len(rm.sent) == 2


def test_projector_commands_without_a_projector_are_unknown(cfg, cms):
    execute_commands(cfg, None, [{"id": 4, "command": "projector-on"}, {"id": 5, "command": "ir-learn:x"}], lambda: None)
    assert [r["result"] for _, r in cms.post_calls] == ["unknown command: projector-on", "unknown command: ir-learn:x"]


# ------------------------------------------------------------------ daemon ---

def test_run_cycle_reports_projector_state_and_applies_auto_mode(cfg, cms, rm, tmp_path, monkeypatch):
    FakeMpv().install(monkeypatch)
    client = MpvClient(tmp_path / "mpv.sock")
    state = PlayerState(backoff=cfg.poll_interval_seconds)
    run_cycle(cfg, client, state)                    # no projector block: nothing sent, unknown reported
    assert cms.sync_calls[-1]["projector_state"] == "unknown"
    assert cms.sync_calls[-1]["projector_error"] == ""
    assert rm.sent == []

    cms.manifest["projector"] = block(mode="auto", want="on", host="10.0.0.9")
    run_cycle(cfg, client, state)
    assert rm.sent == [PACKET]
    run_cycle(cfg, client, state)
    assert rm.sent == [PACKET]                       # unchanged want: not repeated
    assert cms.sync_calls[-1]["projector_state"] == "on"

    cms.manifest["projector"]["want"] = "off"
    cms.manifest["commands"] = [{"id": 7, "command": "ir-learn:input_hdmi1"}]
    rm.learned = PACKET
    run_cycle(cfg, client, state)
    assert len(rm.sent) == 2 and rm.learning
    assert json.loads(cms.post_calls[-1][1]["result"])["learned"] == "input_hdmi1"

    cms.manifest["commands"] = []
    cms.manifest["projector"]["want"] = "on"
    rm.fail_sends = 2
    run_cycle(cfg, client, state)
    run_cycle(cfg, client, state)
    assert cms.sync_calls[-1]["projector_state"] == "unknown"
    assert cms.sync_calls[-1]["projector_error"] == "projector on: timed out"
