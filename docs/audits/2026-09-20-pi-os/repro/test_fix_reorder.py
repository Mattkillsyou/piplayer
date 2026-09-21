import sys, os, shlex, subprocess
sys.path.insert(0, r"D:/Projection Software/piplayer-audit-pi/tools/flasher"); sys.path.insert(0, r"D:/Projection Software/piplayer-audit-pi/tools/flasher/tests")
import firstboot, test_firstboot as T

SED = "sed -i -E 's/ ?systemd\.(run|run_success_action|unit)=[^ ]*//g' \"$BOOT/cmdline.txt\""
_orig = firstboot.render_firstrun
def fixed(cfg):
    s = _orig(cfg)
    old = ('# cleanup: never run again, and leave no secrets on the FAT partition\n'
           'wipe "$BOOT/projection5000-provision.sh"\nrm -f "$BOOT/projection5000-player.tar.gz"\n' + SED + '\nfinish')
    assert old in s
    new = ('sync\n# cleanup: never run again (durable before the secrets go), then leave no secrets on the FAT partition\n'
           + SED + '\nsync\nwipe "$BOOT/projection5000-provision.sh"\nrm -f "$BOOT/projection5000-player.tar.gz"\nfinish')
    return s.replace(old, new)
firstboot.render_firstrun = fixed

# existing tests still pass with the reorder
test_render_firstrun = T.test_render_firstrun if hasattr(T, "test_render_firstrun") else None
for name in dir(T):
    if name.startswith("test_") and ("firstrun" in name or "sed_cleanup" in name or "setup_screen" in name):
        globals()[name] = getattr(T, name)

def test_second_run_after_cut_before_wipes(tmp_path):
    """Simulate: sync #1 landed, cut before sed landed -> next boot re-runs firstrun.sh with FAT copies intact."""
    boot, log1 = T._run_firstrun(tmp_path, T.cfg())
    # put the FAT files back as they were on disk at the cut point (copies present, cmdline still armed)
    (boot / "projection5000-provision.sh").write_bytes(b"#!/bin/bash\nDEVICE_TOKEN=supersecrettoken0000\n")
    (boot / firstboot.PLAYER_ARCHIVE).write_bytes(b"tarball")
    (boot / "cmdline.txt").write_text("console=tty1 rootwait " + firstboot.CMDLINE_ARGS + " cfg80211.ieee80211_regdom=US\n")
    tmp = tmp_path.as_posix(); bin_dir = tmp_path / "bin"
    s = (firstboot.render_firstrun(T.cfg())
         .replace('BOOT=/boot/firmware; [ -d "$BOOT" ] || BOOT=/boot', f"BOOT={shlex.quote(boot.as_posix())}")
         .replace("IMAGER=/usr/lib/raspberrypi-sys-mods/imager_custom", f"IMAGER={shlex.quote((bin_dir/'imager_custom').as_posix())}")
         .replace("/usr/lib/userconf-pi/userconf", (bin_dir / "userconf").as_posix())
         .replace("/usr/local/sbin/", tmp + "/sbin-").replace("/opt/", tmp + "/opt-")
         .replace("/etc/systemd/system/", tmp + "/unit-").replace("/etc/ssh/", tmp + "/etc-ssh/")
         .replace("/etc/NetworkManager/", tmp + "/etc-nm/").replace("run systemctl enable", "run true systemctl enable"))
    (boot / "firstrun.sh").write_bytes(s.encode())
    env = dict(os.environ, PATH=bin_dir.as_posix() + ":" + os.environ.get("PATH", ""), SCREEN_TTY=(tmp_path / "tty").as_posix())
    r = subprocess.run(["bash", str(boot / "firstrun.sh")], capture_output=True, text=True, timeout=60, env=env)
    log2 = (boot / "firstrun.log").read_text()[len(log1):]
    assert r.returncode == 0
    assert "install -m -> rc=0" in log2 and "rc=1" not in log2, log2
    assert "1 step(s) failed" in log2  # only the stub set_keymap, same as run one
    assert not (boot / "firstrun.sh").exists() and not (boot / "projection5000-provision.sh").exists()
