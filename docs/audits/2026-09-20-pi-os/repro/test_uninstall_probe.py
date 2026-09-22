import sys, subprocess
from pathlib import Path
sys.path.insert(0, "D:/Projection Software/piplayer-audit-pi/player/tests")
from test_installer_pi import SRC, _posix

def test_uninstall(tmp_path):
    block = SRC[SRC.index('if [[ "${UNINSTALL}" == 1 ]]; then'):SRC.index("# --upgrade with a config.toml in place")]
    tmp = _posix(tmp_path)
    block = (block.replace("/etc/systemd/system/", tmp + "/unit-")
                  .replace("/etc/sudoers.d/", tmp + "/sudoers-")
                  .replace("/opt/piplayer", tmp + "/opt-piplayer")
                  .replace("/tmp/projector-mpv.sock", tmp + "/mpv.sock"))
    inst = tmp_path / "opt-piplayer" / "player"; inst.mkdir(parents=True)
    for d in ("opt-piplayer/player.prev", "opt-piplayer/src-abc", "data", "etc", "opt-piplayer/cms"):
        (tmp_path / d).mkdir(parents=True, exist_ok=True)
    units = ["projector-player.service", "projector-mpv.service", "projector-wyze-bridge.service",
             "projector-player-postcheck.service", "projector-player-postcheck.timer", "projector-cloudflared.service"]
    for u in units: (tmp_path / f"unit-{u}").write_text("x")
    (tmp_path / "sudoers-projector-player").write_text("x")
    (tmp_path / "mpv.sock").write_text("")
    keep = tmp_path / "cloudflared.list"; keep.write_text("keep")
    log = tmp_path / "calls.log"
    pre = (f'set -euo pipefail\nUNINSTALL=1\nLOG="{_posix(log)}"\nINSTALL_DIR="{_posix(inst)}"\n'
           f'DATA_DIR="{tmp}/data"\nETC_DIR="{tmp}/etc"\nUSER_NAME=projector\n')
    for c in ("systemctl", "docker", "userdel"):
        pre += f'{c}() {{ echo "{c} $*" >> "$LOG"; }}\n'
    pre += 'id() { return 0; }\ncommand() { return 0; }\n'
    res = subprocess.run(["bash", "-c", pre + block + 'echo NOTREACHED\n'], capture_output=True, text=True)
    assert res.returncode == 0, res.stderr
    assert "Player removed." in res.stdout and "NOTREACHED" not in res.stdout
    calls = log.read_text()
    for u in ["projector-player.service projector-mpv.service", "projector-wyze-bridge.service",
              "projector-player-postcheck.timer", "projector-cloudflared.service"]:
        assert f"systemctl disable --now {u}" in calls
    assert "userdel projector" in calls and "docker rm -f projector-wyze-bridge" in calls
    for u in units: assert not (tmp_path / f"unit-{u}").exists(), u
    for p in ("sudoers-projector-player", "opt-piplayer/player", "opt-piplayer/player.prev",
              "opt-piplayer/src-abc", "data", "etc", "mpv.sock"):
        assert not (tmp_path / p).exists(), p
    assert (tmp_path / "opt-piplayer" / "cms").is_dir() and keep.read_text() == "keep"
    assert "projection5000-provision" not in block
