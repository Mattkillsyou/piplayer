"""Remote updates: script invocation shape, update-status.json reporting, nightly window."""
import json
import os
import shutil
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
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


# ------------------------------------------- the scripts in a fake root ---
# update-player.sh / update-os.sh run end to end as a normal user: PIPLAYER_ROOT
# prefixes every absolute path, the "remote" is a local git repo whose
# install-player.sh is a stub that writes RELEASE, and systemctl / apt-get are
# PATH shims that log their calls. Only real systemd and apt stay Pi-only.

DEPLOY = Path(__file__).resolve().parents[1] / "deploy"


def posix(p):
    s = str(p).replace("\\", "/")
    return f"/{s[0].lower()}{s[2:]}" if len(s) > 1 and s[1] == ":" else s


def git(repo, *args):
    cmd = ["git", "-C", str(repo), "-c", "user.name=t", "-c", "user.email=t@t", *args]
    return subprocess.run(cmd, check=True, capture_output=True, text=True).stdout.strip()


INSTALLER_STUB = """#!/usr/bin/env bash
set -e
[[ "$1" == --upgrade ]] || { echo "expected --upgrade, got $*" >&2; exit 2; }
%s
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
D="${PIPLAYER_ROOT}/opt/piplayer/player"
mkdir -p "$D/deploy"
cp -r "$SRC/player" "$D/"
cp "$SRC"/deploy/*.sh "$D/deploy/"
echo "${PIPLAYER_RELEASE_SHA}" > "$D/RELEASE"
echo "stub install-player.sh --upgrade ${PIPLAYER_RELEASE_SHA}"
"""

SHIMS = {
    "python3": '#!/usr/bin/env bash\nexec "%s" "$@"\n' % posix(sys.executable),
    "systemctl": '#!/usr/bin/env bash\necho "systemctl $*" >> "${SHIM_LOG}"\n'
                 'case "$1" in is-active) echo "${FAKE_ACTIVE:-active}";; show) echo "${FAKE_RESTARTS:-0}";; esac\n',
    "apt-get": '#!/usr/bin/env bash\necho "apt-get $*" >> "${SHIM_LOG}"\n'
               '[[ "${FAKE_APT_RC:-0}" == 0 ]] || exit "${FAKE_APT_RC}"\n'
               '[[ "$*" == *upgrade* ]] && echo "3 upgraded, 0 newly installed, 0 to remove and 0 not upgraded."\nexit 0\n',
}


@pytest.fixture
def fake_pi(tmp_path):
    """Fake root with RELEASE at the repo's first commit; .run(script, *args, **env) executes a deploy script."""
    shims = tmp_path / "bin"
    shims.mkdir()
    for name, body in SHIMS.items():
        (shims / name).write_text(body)
        (shims / name).chmod(0o755)
    repo = tmp_path / "repo"
    (repo / "player" / "player").mkdir(parents=True)
    (repo / "player" / "deploy").mkdir()
    (repo / "player" / "player" / "__init__.py").write_text('__version__ = "0.2.0"\n')
    for name in ("update-player.sh", "update-os.sh"):
        shutil.copy(DEPLOY / name, repo / "player" / "deploy" / name)
    (repo / "player" / "deploy" / "install-player.sh").write_text(INSTALLER_STUB % "")
    git(repo, "init", "-q", "-b", "main")
    git(repo, "add", ".")
    git(repo, "commit", "-q", "-m", "one")
    root = tmp_path / "root"
    install = root / "opt" / "piplayer" / "player"
    (install / "deploy").mkdir(parents=True)
    (install / "RELEASE").write_text(git(repo, "rev-parse", "HEAD") + "\n")
    shutil.copy(DEPLOY / "update-os.sh", install / "deploy" / "update-os.sh")
    shim_log = tmp_path / "shim.log"
    shim_log.write_text("")

    def run(script, *args, **extra):
        env = {**os.environ, "PATH": posix(shims) + os.pathsep + os.environ.get("PATH", ""),
               "PIPLAYER_ROOT": posix(root), "PIPLAYER_REPO_URL": posix(repo),
               "PIPLAYER_UPDATE_DETACHED": "1", "SHIM_LOG": posix(shim_log), **extra}
        return subprocess.run(["bash", posix(DEPLOY / script), *args], env=env, capture_output=True, text=True)

    data = root / "var" / "lib" / "projector-player"
    return SimpleNamespace(run=run, root=root, repo=repo, shim_log=shim_log, install=install,
                           status=lambda: json.loads((data / "update-status.json").read_text()),
                           log=lambda: (data / "update.log").read_text())


def commit(repo, text, branch=None, installer=None):
    if branch:
        git(repo, "checkout", "-q", "-b", branch)
    (repo / "player" / "player" / "__init__.py").write_text(f'__version__ = "{text}"\n')
    if installer is not None:
        (repo / "player" / "deploy" / "install-player.sh").write_text(installer)
    git(repo, "commit", "-qam", text)
    return git(repo, "rev-parse", "HEAD")


needs_tools = pytest.mark.skipif(shutil.which("bash") is None or shutil.which("git") is None,
                                 reason="bash and git needed")


@needs_tools
def test_update_player_script_end_to_end_in_a_fake_root(fake_pi):
    release = fake_pi.install / "RELEASE"
    prev = fake_pi.install.with_name("player.prev")
    sha1 = release.read_text().strip()

    # already at the ref: nothing touched, nothing restarted
    res = fake_pi.run("update-player.sh", "main")
    assert res.returncode == 0, res.stderr + fake_pi.log()
    st = fake_pi.status()
    assert (st["ref"], st["ok"], st["message"], st["previous_version"]) == ("main", True, f"already at {sha1}", sha1)
    assert not prev.exists()
    assert fake_pi.shim_log.read_text() == ""
    assert not list(fake_pi.install.parent.glob("src-*"))

    # one commit ahead: .prev kept, RELEASE advanced, timer armed then service restarted
    sha2 = commit(fake_pi.repo, "0.2.1")
    res = fake_pi.run("update-player.sh", "main")
    assert res.returncode == 0, res.stderr + fake_pi.log()
    st = fake_pi.status()
    assert st["ok"] is True and st["message"] == f"updated {sha1} -> {sha2}"
    assert release.read_text().strip() == sha2
    assert (prev / "RELEASE").read_text().strip() == sha1
    assert fake_pi.shim_log.read_text().splitlines() == [
        "systemctl restart projector-player-postcheck.timer", "systemctl restart projector-player.service"]
    assert f"stub install-player.sh --upgrade {sha2}" in fake_pi.log()

    # post-check: healthy service leaves everything alone
    fake_pi.shim_log.write_text("")
    res = fake_pi.run("update-player.sh", "--postcheck", FAKE_ACTIVE="active", FAKE_RESTARTS="1")
    assert res.returncode == 0, res.stderr
    assert "post-check ok: projector-player.service active, 1 restarts" in fake_pi.log()
    assert release.read_text().strip() == sha2 and prev.exists()

    # post-check: crash-looping service rolls back to .prev
    res = fake_pi.run("update-player.sh", "--postcheck", FAKE_ACTIVE="failed", FAKE_RESTARTS="5")
    assert res.returncode == 0, res.stderr
    assert release.read_text().strip() == sha1
    assert not prev.exists()
    st = fake_pi.status()
    assert st["ok"] is False and st["ref"] == sha2 and st["previous_version"] == sha1
    assert st["message"] == f"rolled back to {sha1}: player failed with 5 restarts after the update"
    assert fake_pi.shim_log.read_text().splitlines()[-2:] == [
        "systemctl reset-failed projector-player.service", "systemctl restart projector-player.service"]

    # a failing installer restores .prev and reports the failure
    sha3 = commit(fake_pi.repo, "broken", branch="broken", installer=INSTALLER_STUB % "exit 1")
    res = fake_pi.run("update-player.sh", "broken")
    assert res.returncode == 1
    st = fake_pi.status()
    assert st["ok"] is False and st["message"].startswith("install-player.sh --upgrade failed")
    assert st["ref"] == "broken" and sha3 != sha1
    assert release.read_text().strip() == sha1
    assert not prev.exists()
    assert not list(fake_pi.install.parent.glob("src-*"))

    # a sha instead of a branch, with --then-os: the player update chains into update-os.sh
    fake_pi.shim_log.write_text("")
    res = fake_pi.run("update-player.sh", sha2, "--then-os")
    assert res.returncode == 0, res.stderr + fake_pi.log()
    assert f"status: ok=true updated {sha1} -> {sha2}" in fake_pi.log()
    assert fake_pi.status()["ref"] == "os" and fake_pi.status()["ok"] is True
    assert fake_pi.shim_log.read_text().splitlines()[-3:] == [
        "apt-get update", "apt-get -y -o Dpkg::Options::=--force-confold upgrade", "apt-get -y autoremove"]

    # unknown ref, and a second argument the script does not know
    assert fake_pi.run("update-player.sh", "no-such-ref").returncode == 1
    assert fake_pi.status()["message"] == "ref not found: no-such-ref"
    assert "Unknown argument" in fake_pi.run("update-player.sh", "main", "--bogus").stderr


@needs_tools
def test_update_os_script_in_a_fake_root(fake_pi):
    res = fake_pi.run("update-os.sh")
    assert res.returncode == 0, res.stderr + fake_pi.log()
    st = fake_pi.status()
    assert (st["ref"], st["ok"], st["previous_version"], st["reboot_required"]) == ("os", True, None, False)
    assert st["message"] == "3 upgraded, 0 newly installed, 0 to remove and 0 not upgraded."
    (fake_pi.root / "var" / "run").mkdir(parents=True)
    (fake_pi.root / "var" / "run" / "reboot-required").write_text("")
    assert fake_pi.run("update-os.sh").returncode == 0
    st = fake_pi.status()
    assert st["reboot_required"] is True and st["message"].endswith("; reboot required")
    assert fake_pi.run("update-os.sh", FAKE_APT_RC="100").returncode == 1
    st = fake_pi.status()
    assert st["ok"] is False and st["message"].startswith("apt failed at line") and st["reboot_required"] is False
