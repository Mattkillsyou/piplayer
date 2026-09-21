import sys, os
sys.path.insert(0, r"D:\Projection Software\piplayer-audit-pi\player")
from tests.test_updater import fake_pi, commit, INSTALLER_STUB, needs_tools  # noqa

# installer stub dies with SIGKILL (and kills update-player.sh) after mv but before writing anything: power loss
KILL = 'kill -9 "$PPID"; kill -9 $$'

@needs_tools
def test_power_loss_mid_install_leaves_no_install_dir(fake_pi):
    prev = fake_pi.install.with_name("player.prev")
    sha1 = (fake_pi.install / "RELEASE").read_text().strip()
    sha2 = commit(fake_pi.repo, "0.2.1", installer=INSTALLER_STUB % KILL)
    res = fake_pi.run("update-player.sh", "main")
    print("rc", res.returncode, "stderr", res.stderr)
    print("log:", fake_pi.log())
    print("install exists:", fake_pi.install.exists(), "venv:", (fake_pi.install / ".venv/bin/python").exists())
    print("prev exists:", prev.exists(), "prev RELEASE:", (prev / "RELEASE").read_text().strip() == sha1 if prev.exists() else None)
    print("status file exists:", (fake_pi.root / "var/lib/projector-player/update-status.json").exists())
    assert prev.exists() and not fake_pi.install.exists()
