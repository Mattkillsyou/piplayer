import sys, os
sys.path.insert(0, r"D:\Projection Software\piplayer-audit-pi\tools\flasher")
sys.path.insert(0, r"D:\Projection Software\piplayer-audit-pi\tools\flasher\tests")
import firstboot
from test_firstboot import _provision_harness, cfg

def test_enroll_giveup(tmp_path):
    key = "aB0-_" * 8 + "=="
    r = _provision_harness(tmp_path, firstboot.render_provision(cfg(enrollment_key=key)), [22, 22, 22])
    print("rc", r["rc"], "enroll_calls", r["enroll_calls"])
    last = r["tty"][r["tty"].rindex("\033[2J"):]
    print("LAST SCREEN:", repr(last))
    print("BOOT LOG:", r["boot_log"])
    assert r["rc"] == 1 and r["enroll_calls"] == 3
    assert "The console did not accept this projector" in last
    assert "re-flash the card" in r["boot_log"]
    assert key not in r["boot_log"]

def test_token_giveup(tmp_path):
    r = _provision_harness(tmp_path, firstboot.render_provision(cfg(token="tok-on-card-0123456789")), [], install_fails=True)
    print("BOOT LOG:", r["boot_log"])
    assert r["rc"] == 1
    assert "tok-on-card" not in r["boot_log"]
