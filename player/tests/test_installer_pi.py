"""install-player.sh per-model behaviour, run under bash with fake commands and
a fake /proc: pi_caps, the camera-bridge gate (Docker + wyze only on arm64
with enough RAM) and the mpv.conf hwdec line for VideoCore IV boards."""
import shutil
import subprocess
from pathlib import Path

import pytest

from test_tunnel import DEPLOY, _posix

pytestmark = pytest.mark.skipif(shutil.which("bash") is None, reason="bash not available")

SRC = (DEPLOY / "install-player.sh").read_text()
PLAYER_ROOT = DEPLOY.parent

BOARDS = {
    # name: (dpkg arch, uname -m, MemTotal kB, model string, device-tree compatible)
    "pi4": ("arm64", "aarch64", 3885000, "Raspberry Pi 4 Model B Rev 1.5", "raspberrypi,4-model-b\0brcm,bcm2711\0"),
    "pi5": ("arm64", "aarch64", 7975000, "Raspberry Pi 5 Model B Rev 1.0", "raspberrypi,5-model-b\0brcm,bcm2712\0"),
    "pi3": ("arm64", "aarch64", 935000, "Raspberry Pi 3 Model B Plus Rev 1.3", "raspberrypi,3-model-b-plus\0brcm,bcm2837\0"),
    "zero2": ("arm64", "aarch64", 430000, "Raspberry Pi Zero 2 W Rev 1.0", "raspberrypi,model-zero-2-w\0brcm,bcm2837\0"),
    "pi2": ("armhf", "armv7l", 935000, "Raspberry Pi 2 Model B Rev 1.1", "raspberrypi,2-model-b\0brcm,bcm2836\0"),
    "zero": ("armhf", "armv6l", 430000, "Raspberry Pi Zero W Rev 1.1", "raspberrypi,model-zero-w\0brcm,bcm2835\0"),
}


# /proc/asound/cards per board: the 3.5 mm jack probes first everywhere it exists (Pi 5 has none)
SOUND_CARDS = {
    "pi5": ["vc4hdmi0", "vc4hdmi1"],
    "pi4": ["Headphones", "vc4hdmi0", "vc4hdmi1"],
    "pi3": ["Headphones", "vc4hdmi"], "zero2": ["Headphones", "vc4hdmi"],
    "pi2": ["Headphones", "vc4hdmi"], "zero": ["Headphones", "vc4hdmi"],
}
HDMI_CARD = {"pi5": "vc4hdmi0", "pi4": "vc4hdmi0", "pi3": "vc4hdmi", "zero2": "vc4hdmi", "pi2": "vc4hdmi", "zero": "vc4hdmi"}


def fake_proc(tmp_path, board):
    arch, machine, mem_kb, model, compat = BOARDS[board]
    proc = tmp_path / "proc"
    (proc / "device-tree").mkdir(parents=True)
    (proc / "asound").mkdir()
    (proc / "meminfo").write_text(f"MemTotal:       {mem_kb} kB\nMemFree:         100000 kB\n")
    (proc / "device-tree" / "model").write_bytes(model.encode() + b"\0")
    (proc / "device-tree" / "compatible").write_bytes(compat.encode())
    (proc / "asound" / "cards").write_text("".join(
        f" {i} [{name:<15}]: {'bcm2835_headpho' if name == 'Headphones' else 'vc4-hdmi'} - {name}\n"
        f"                      {name}\n" for i, name in enumerate(SOUND_CARDS[board])))
    prelude = f'PROC_ROOT="{_posix(proc)}"\n'
    prelude += f'dpkg() {{ [[ "$1" == --print-architecture ]] && echo {arch}; }}\n'
    prelude += f'uname() {{ echo {machine}; }}\n'
    return prelude


def run_bash(script):
    res = subprocess.run(["bash", "-c", script], capture_output=True, text=True)
    assert res.returncode == 0, res.stderr
    return res


def caps_and_wyze_blocks():
    """pi_caps, the call + camera gate, and the Docker/wyze block that the gate controls."""
    fn = SRC[SRC.index("pi_caps() {"):]
    fn = fn[:fn.index("\n}\n") + 3]
    gate = SRC[SRC.index("\npi_caps\n"):SRC.index('echo "==> Installing system dependencies"')]
    wyze = SRC[SRC.index('if [[ "${WITH_WYZE}" == 1 ]]; then\n    echo "==> Installing Docker'):SRC.index('echo "==> Installing systemd units"')]
    return fn + gate + wyze


@pytest.mark.parametrize("board", ["pi4", "pi3", "zero2", "pi2", "zero"])
def test_camera_bridge_only_on_arm64_with_enough_ram(tmp_path, board):
    arch, _machine, mem_kb, model, _compat = BOARDS[board]
    supported = board in ("pi4", "pi3")
    log = tmp_path / "calls.log"
    data = tmp_path / "data"
    data.mkdir()
    prelude = "set -euo pipefail\n" + fake_proc(tmp_path, board)
    prelude += f'LOG="{_posix(log)}"\nDATA_DIR="{_posix(data)}"\nETC_DIR="{_posix(tmp_path)}"\nUSER_NAME=projector\n'
    prelude += "CAMERA_MIN_MEM_KB=900000\nWITH_WYZE=1\n"
    for cmd in ("docker", "systemctl", "curl"):
        prelude += f'{cmd}() {{ echo "{cmd} $*" >> "$LOG"; }}\n'
    prelude += "chown() { :; }\n"
    res = run_bash(prelude + caps_and_wyze_blocks() + '\necho "WITH_WYZE=${WITH_WYZE} CAMERA_SUPPORTED=${CAMERA_SUPPORTED}"\n')
    calls = log.read_text() if log.exists() else ""
    mb = mem_kb // 1024
    assert f"==> This is a {model} ({arch}, {mb} MB)" in res.stdout
    if supported:
        assert "Camera bridge: not supported" not in res.stdout
        assert "docker pull mrlt8/wyze-bridge:latest" in calls and "systemctl enable --now docker.service" in calls
        assert "WITH_WYZE=1 CAMERA_SUPPORTED=1" in res.stdout
        assert "no Wyze credentials given" in res.stdout          # the rest of the wyze block ran
    else:
        assert f"Camera bridge: not supported on {model} ({arch}, {mb} MB)" in res.stdout
        assert calls == ""                                        # no Docker, no pull
        assert "WITH_WYZE=0 CAMERA_SUPPORTED=0" in res.stdout


def screen_block():
    """The setup-screen functions (SCREEN_TTY, screen_init, screen), as the installer defines them."""
    start = SRC.index('SCREEN_TTY="${SCREEN_TTY:-/dev/tty1}"')
    return SRC[start:SRC.index("\n}\n", SRC.index("screen() {", start)) + 3]


def test_setup_screen_survives_a_missing_tty_and_draws_centred(tmp_path):
    """Under set -euo pipefail the screen calls are no-ops without /dev/tty1 (nothing printed, exit 0); with
    a tty they clear it and centre the brand, the step and the dim hint on the console width (80 fallback)."""
    calls = "screen_init\nscreen \"Setting up this projector\" \"Step 3 of 4: installing the player (about 10 minutes)\"\n"
    res = run_bash("set -euo pipefail\nSCREEN_TTY=/nonexistent/tty1\n" + screen_block() + calls + "echo end\n")
    assert res.stdout.strip() == "end" and res.stderr == ""
    tty = tmp_path / "tty"
    tty.write_text("")
    # setterm/setfont are not on this PATH: their failure must be swallowed too
    res = run_bash(f'set -euo pipefail\nSCREEN_TTY="{_posix(tty)}"\n' + screen_block() + calls + "echo end\n")
    assert res.stdout.strip() == "end"
    out = tty.read_text()
    assert out.startswith("\033[2J\033[H") and out.index("MATT BROWN'S") < out.index("PROJECTION5000")
    assert "\n" + " " * 34 + "MATT BROWN'S\n" in out          # (80 - 12) / 2
    assert "\n\033[2m" + " " * 13 + "Step 3 of 4: installing the player (about 10 minutes)\n" in out
    assert "Setting up this projector" in out
    # the installer calls it on a fresh install (start and end) and not on an upgrade
    assert SRC.index('if [[ "${UPGRADE}" == 0 ]]; then\n    screen_init') < SRC.index("apt-get update")
    assert SRC.index('screen "Setting up this projector" "Step 4 of 4: connecting to the console"') < SRC.index('echo "==> Starting services"')


def test_apt_repairs_an_interrupted_dpkg_before_installing():
    """A power cut mid-apt (first boot or a nightly upgrade) leaves dpkg interrupted, and every later apt-get
    refuses to run; both scripts repair first and never wait on a debconf prompt (they run unattended)."""
    assert SRC.index("export DEBIAN_FRONTEND=noninteractive") < SRC.index("dpkg --configure -a || true") < SRC.index("apt-get update")
    assert SRC.index("apt-get -y -f install || true") < SRC.index("apt-get update")
    os_src = (DEPLOY / "update-os.sh").read_text()
    assert os_src.index("export DEBIAN_FRONTEND=noninteractive") < os_src.index("dpkg --configure -a || true") < os_src.index("\n    apt-get update")


def test_uninstall_unmasks_getty_before_enabling_it(tmp_path):
    """firstrun.sh masks getty@tty1 (no login prompt on the HDMI console); --uninstall must unmask it first,
    since enable/start are refused on a masked unit."""
    block = SRC[SRC.index('echo "==> Re-enabling the login prompt on tty1"'):SRC.index('echo "==> Removing player files')]
    log = tmp_path / "calls.log"
    res = run_bash(f'set -euo pipefail\nLOG="{_posix(log)}"\nsystemctl() {{ echo "systemctl $*" >> "$LOG"; }}\n' + block)
    assert "Re-enabling the login prompt" in res.stdout
    assert log.read_text().splitlines() == ["systemctl unmask getty@tty1.service", "systemctl enable getty@tty1.service",
                                            "systemctl start getty@tty1.service"]


def test_pi_caps_off_a_pi(tmp_path):
    """No device-tree, no dpkg: the installer still runs (unknown board, camera off)."""
    fn = caps_and_wyze_blocks()
    fn = fn[:fn.index("\n}\n") + 3]
    prelude = f'set -euo pipefail\nPROC_ROOT="{_posix(tmp_path / "nowhere")}"\nCAMERA_MIN_MEM_KB=900000\n'
    prelude += "dpkg() { return 1; }\nuname() { echo x86_64; }\n"
    res = run_bash(prelude + fn + '\npi_caps\necho "${PI_MODEL}|${PI_ARCH}|${PI_MEM_MB}|${PI_SOC}|${CAMERA_SUPPORTED}|${PI_HDMI_CARD}"\n')
    assert res.stdout.strip() == "unknown board|unknown|0||0|"


@pytest.mark.parametrize("board", ["pi5", "pi4", "pi3", "pi2", "zero", "zero2"])
def test_mpv_conf_gets_hwdec_on_videocore_iv_boards(tmp_path, board):
    _arch, _machine, _mem, model, compat = BOARDS[board]
    block = SRC[SRC.index('echo "==> Installing mpv kiosk config"'):SRC.index('echo "==> Creating virtualenv"')]
    data = tmp_path / "data"
    (data / ".config" / "mpv").mkdir(parents=True)
    prelude = "set -euo pipefail\n" + fake_proc(tmp_path, board)
    prelude += f'DATA_DIR="{_posix(data)}"\nSRC_DIR="{_posix(PLAYER_ROOT)}"\nUSER_NAME=projector\nchown() {{ :; }}\n'
    prelude += "CAMERA_MIN_MEM_KB=900000\n"
    fn = caps_and_wyze_blocks()
    fn = fn[:fn.index("\n}\n") + 3]
    res = run_bash(prelude + fn + "\npi_caps\n" + block)
    conf = (data / ".config" / "mpv" / "mpv.conf").read_text()
    dist = (DEPLOY / "mpv.conf").read_text()
    assert conf.startswith(dist)
    # sound goes to the HDMI card by name: ALSA's default is the 3.5 mm jack on every board that has one
    audio = f"\nao=alsa\naudio-device=alsa/default:CARD={HDMI_CARD[board]}\n"
    assert conf.count(audio) == 1 and conf.count("\naudio-device=") == 1     # the dist only has it in a comment
    assert f"sound to HDMI (ALSA card {HDMI_CARD[board]})" in res.stdout
    if board in ("pi3", "pi2", "zero", "zero2"):
        assert conf.splitlines()[-1] == "hwdec=v4l2m2m-copy"
        assert conf.count("\nhwdec=v4l2m2m-copy\n") == 1 and model in conf     # the dist only has it in a comment
        assert f"{model}: hwdec=v4l2m2m-copy" in res.stdout
        assert conf.index(audio) < conf.index("\nhwdec=v4l2m2m-copy\n")
    else:
        assert conf.endswith(audio) and "v4l2m2m" not in res.stdout
    # an upgrade leaves a per-Pi file alone (only the .dist copy is refreshed)
    (data / ".config" / "mpv" / "mpv.conf").write_text("vo=drm\n")
    run_bash(prelude + fn + "\npi_caps\n" + block)
    assert (data / ".config" / "mpv" / "mpv.conf").read_text() == "vo=drm\n"
    assert (data / ".config" / "mpv" / "mpv.conf.dist").read_text() == dist
