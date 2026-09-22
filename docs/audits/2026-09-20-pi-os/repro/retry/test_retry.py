import sys, os
from datetime import datetime, timedelta, timezone
sys.path.insert(0, r"D:\Projection Software\piplayer-audit-pi\player\tests")
sys.path.insert(0, r"D:\Projection Software\piplayer-audit-pi\player")
from test_updater import fake_pi, commit, needs_tools  # noqa
from player import updater

def test_rolled_back_sha_is_retried(fake_pi):
    release = fake_pi.install / "RELEASE"
    sha1 = release.read_text().strip()
    sha2 = commit(fake_pi.repo, "0.2.1")
    assert fake_pi.run("update-player.sh", "main").returncode == 0
    assert release.read_text().strip() == sha2
    assert fake_pi.run("update-player.sh", "--postcheck", FAKE_ACTIVE="failed", FAKE_RESTARTS="5").returncode == 0
    assert release.read_text().strip() == sha1
    st = fake_pi.status()
    assert st["ok"] is False
    # next night: the daemon's gate
    started = datetime.fromisoformat(st["started"].replace("Z", "+00:00"))
    nightly = {"release": "main", "auto": "nightly", "window": "03:00-05:00"}
    tomorrow = (started + timedelta(hours=24)).replace(hour=3, minute=30)
    assert updater.auto_update_due(nightly, tomorrow, started)
    # and the script happily reinstalls the same sha
    res = fake_pi.run("update-player.sh", "main")
    assert res.returncode == 0, res.stderr + fake_pi.log()
    st = fake_pi.status()
    assert st["ok"] is True and st["message"] == f"updated {sha1} -> {sha2}"
    assert release.read_text().strip() == sha2
    print("\nLOG:\n" + fake_pi.log())
