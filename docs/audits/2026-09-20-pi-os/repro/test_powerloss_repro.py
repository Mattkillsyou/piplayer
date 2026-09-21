import sys, json
sys.path.insert(0, r"D:/Projection Software/piplayer-audit-pi/player")
from tests.test_updater import fake_pi, commit, INSTALLER_STUB, needs_tools  # noqa

@needs_tools
def test_kill_mid_install(fake_pi):
    prev = fake_pi.install.with_name("player.prev")
    sha1 = (fake_pi.install / "RELEASE").read_text().strip()
    commit(fake_pi.repo, "0.2.1", installer=INSTALLER_STUB % "kill -9 $PPID; sleep 1; exit 1")
    res = fake_pi.run("update-player.sh", "main")
    print("rc", res.returncode)
    print("install exists", fake_pi.install.exists(), "prev exists", prev.exists())
    print("status exists", (fake_pi.root / "var/lib/projector-player/update-status.json").exists())
    print("shim log", repr(fake_pi.shim_log.read_text()))
    print("log:\n" + fake_pi.log())
    assert not fake_pi.install.exists() and prev.exists()
    # the only recovery path: --postcheck, which needs the timer to fire
    res = fake_pi.run("update-player.sh", "--postcheck", FAKE_ACTIVE="failed", FAKE_RESTARTS="0")
    print("after postcheck: install", fake_pi.install.exists(), "prev", prev.exists(), "RELEASE", (fake_pi.install / "RELEASE").read_text().strip() == sha1)
    print(fake_pi.status())
