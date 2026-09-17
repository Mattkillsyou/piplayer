"""Auto tunnel: the manifest's `tunnel.token` lands in tunnel.token (0600) and
projector-cloudflared.service is restarted only when the file changed; the
installer's cloudflared block and unit/sudoers wiring."""
import os
import shutil
import subprocess
from pathlib import Path
from types import SimpleNamespace

import pytest

from fakes import FakeCms, FakeMpv
from player import tunnel
from player.daemon import PlayerState, run_cycle
from player.mpv_client import MpvClient

TOKEN = "eyJhIjoiYWNjdCIsInQiOiJ0dW4iLCJzIjoic2VjIn0"
RESTART = ["sudo", "-n", "/bin/systemctl", "restart", "projector-cloudflared.service"]


@pytest.fixture
def cms(monkeypatch):
    c = FakeCms()
    c.install(monkeypatch)
    return c


@pytest.fixture
def mpv(monkeypatch):
    fake = FakeMpv()
    fake.install(monkeypatch)
    return fake


@pytest.fixture
def client(cfg, mpv):
    return MpvClient(cfg.mpv_socket)


@pytest.fixture
def runs(monkeypatch):
    calls = SimpleNamespace(args=[], rc=0)

    def fake_run(cmd, **kw):
        calls.args.append(list(cmd))
        return SimpleNamespace(returncode=calls.rc, stderr="sudo: a password is required\n" if calls.rc else "")
    monkeypatch.setattr(tunnel.subprocess, "run", fake_run)
    return calls


def test_token_written_0600_next_to_the_manifest_and_only_on_change(cfg):
    p = tunnel.token_path(cfg)
    assert p == cfg.manifest_path.parent / "tunnel.token"
    assert tunnel.write_token(cfg, TOKEN) is True
    assert p.read_text() == TOKEN + "\n"
    if os.name != "nt":
        assert oct(p.stat().st_mode & 0o777) == "0o600"
    assert tunnel.write_token(cfg, TOKEN) is False
    assert tunnel.write_token(cfg, " " + TOKEN + "\n") is False       # whitespace is not a change
    assert tunnel.write_token(cfg, "other") is True
    assert not p.with_suffix(".token.tmp").exists()


def test_maybe_apply_restarts_cloudflared_only_when_the_token_changes(cfg, runs):
    assert tunnel.maybe_apply(cfg, {}) is False
    assert tunnel.maybe_apply(cfg, {"tunnel": None}) is False
    assert tunnel.maybe_apply(cfg, {"tunnel": {"hostname": "dev-1-cam.example"}}) is False
    assert tunnel.maybe_apply(cfg, {"tunnel": "bogus"}) is False
    assert runs.args == [] and not tunnel.token_path(cfg).exists()

    manifest = {"tunnel": {"token": TOKEN, "hostname": "dev-1-cam.example"}}
    assert tunnel.maybe_apply(cfg, manifest) is True
    assert tunnel.token_path(cfg).read_text() == TOKEN + "\n" and runs.args == [RESTART]
    assert tunnel.maybe_apply(cfg, manifest) is False               # same token: nothing
    assert runs.args == [RESTART]
    # the key disappearing leaves the file alone (feature off, not "tear down")
    assert tunnel.maybe_apply(cfg, {}) is False
    assert tunnel.token_path(cfg).exists()
    # a rotated token: rewritten + restarted; a failing restart is reported, not raised
    runs.rc = 1
    assert tunnel.maybe_apply(cfg, {"tunnel": {"token": "new"}}) is True
    assert tunnel.token_path(cfg).read_text() == "new\n" and runs.args == [RESTART, RESTART]


def test_write_failure_is_logged_and_retried(cfg, runs, monkeypatch):
    tunnel.token_path(cfg).mkdir()          # the rename onto a directory fails
    assert tunnel.maybe_apply(cfg, {"tunnel": {"token": TOKEN}}) is False
    assert runs.args == []

    def slow_run(cmd, **kw):
        raise subprocess.TimeoutExpired(cmd, kw.get("timeout"))
    monkeypatch.setattr(tunnel.subprocess, "run", slow_run)
    tunnel.token_path(cfg).rmdir()
    assert tunnel.maybe_apply(cfg, {"tunnel": {"token": TOKEN}}) is True   # written; the slow restart is only logged


def test_daemon_applies_the_manifest_token(cfg, cms, mpv, client, runs):
    state = PlayerState(backoff=5)
    run_cycle(cfg, client, state)
    assert runs.args == [] and not tunnel.token_path(cfg).exists()   # no key: feature off
    cms.manifest["tunnel"] = {"token": TOKEN, "hostname": "dev-1-cam.example"}
    assert run_cycle(cfg, client, state) is not None
    assert tunnel.token_path(cfg).read_text() == TOKEN + "\n" and runs.args == [RESTART]
    run_cycle(cfg, client, state)
    assert runs.args == [RESTART]
    # the token is never echoed back to the console nor cached in the manifest
    assert all(TOKEN not in str(p) for p in cms.sync_calls)
    assert TOKEN not in cfg.manifest_path.read_text()


# ------------------------------------------------------ deploy files ---

DEPLOY = Path(__file__).resolve().parents[1] / "deploy"


def test_unit_runs_cloudflared_with_the_token_file_and_tolerates_its_absence():
    unit = (DEPLOY / "projector-cloudflared.service").read_text()
    assert "ConditionPathExists=/var/lib/projector-player/tunnel.token" in unit
    assert 'TUNNEL_TOKEN="$(cat /var/lib/projector-player/tunnel.token)"' in unit
    assert "/usr/bin/cloudflared --no-autoupdate tunnel run" in unit
    assert "User=projector" in unit
    installer = (DEPLOY / "install-player.sh").read_text()
    assert "NOPASSWD: /bin/systemctl restart projector-cloudflared.service" in installer
    assert "NOPASSWD: /usr/bin/systemctl restart projector-cloudflared.service" in installer
    assert 'cp "${SRC_DIR}/deploy/projector-cloudflared.service" /etc/systemd/system/projector-cloudflared.service' in installer
    assert "systemctl enable projector-mpv.service projector-player.service projector-cloudflared.service" in installer


def _posix(p):
    s = str(p).replace("\\", "/")
    return f"/{s[0].lower()}{s[2:]}" if s[1:2] == ":" else s


@pytest.mark.skipif(shutil.which("bash") is None, reason="bash not available")
@pytest.mark.parametrize("case", ["present", "apt", "deb", "offline"])
def test_installer_cloudflared_block(tmp_path, case):
    """Idempotent: an installed cloudflared is left alone; else the Cloudflare
    apt repo, and the GitHub .deb for the dpkg architecture when that fails;
    both failing is a warning, not an installer (or --upgrade) failure."""
    src = (DEPLOY / "install-player.sh").read_text()
    block = src[src.index('echo "==> Installing cloudflared'):src.index('echo "==> Installing Docker for the Wyze bridge"')]
    block = block[:block.rindex("if [[")]          # drop the opening line of the wyze block that follows
    log = tmp_path / "calls.log"
    keyring, aptlist = tmp_path / "cloudflare-main.gpg", tmp_path / "cloudflared.list"
    env = {"CLOUDFLARED_KEYRING": _posix(keyring), "CLOUDFLARED_LIST": _posix(aptlist),
           "LOG": _posix(log), "TMPDIR": _posix(tmp_path), "FAKE_APT_RC": "0" if case == "apt" else "1",
           "FAKE_DPKG_RC": "1" if case == "offline" else "0"}
    prelude = "set -euo pipefail\n" + "".join(f'{k}="{v}"\n' for k, v in env.items())
    prelude += 'curl() { echo "curl $*" >> "$LOG"; }\n'
    prelude += 'dpkg() { echo "dpkg $*" >> "$LOG"; [[ "$1" == --print-architecture ]] && echo arm64; [[ "${FAKE_DPKG_RC}" == 0 ]]; }\n'
    prelude += 'apt-get() { echo "apt-get $*" >> "$LOG"; [[ "${FAKE_APT_RC}" == 0 ]]; }\n'
    if case == "present":
        prelude += 'cloudflared() { echo "cloudflared version 2025.1.0"; }\n'
    res = subprocess.run(["bash", "-c", prelude + block], capture_output=True, text=True)
    assert res.returncode == 0, res.stderr
    calls = log.read_text() if log.exists() else ""
    if case == "present":
        assert calls == "" and "already installed (cloudflared version 2025.1.0)" in res.stdout
    elif case == "apt":
        assert "apt-get install -y cloudflared" in calls and "dpkg -i" not in calls
        assert aptlist.read_text() == f"deb [signed-by={_posix(keyring)}] https://pkg.cloudflare.com/cloudflared any main\n"
    else:
        assert "cloudflared-linux-arm64.deb" in calls and "dpkg -i " in calls
        assert not aptlist.exists() and "GitHub releases" in res.stdout
        assert not list(tmp_path.glob("*.deb"))          # the downloaded .deb is removed
        assert ("WARNING: cloudflared could not be installed" in res.stderr) == (case == "offline")


@pytest.mark.skipif(shutil.which("bash") is None, reason="bash not available")
def test_installer_parses():
    res = subprocess.run(["bash", "-n", str(DEPLOY / "install-player.sh")], capture_output=True, text=True)
    assert res.returncode == 0, res.stderr
