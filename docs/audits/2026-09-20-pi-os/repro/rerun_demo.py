# Power cut between the FAT wipes and the cmdline sed landing: firstrun.sh re-runs with its sources gone.
import sys, pathlib, tempfile, os, subprocess, shlex
sys.path.insert(0, "tests"); sys.path.insert(0, ".")
import firstboot, test_firstboot as t
tmp = pathlib.Path(tempfile.mkdtemp(dir=os.environ["SP"]))
# run 1: real script but the cmdline sed "did not land" (simulate: drop the sed line)
c = t.cfg()
orig = firstboot.render_firstrun
firstboot.render_firstrun = lambda cfg: "\n".join(l for l in orig(cfg).splitlines() if not l.startswith("sed -i -E")) + "\n"
try:
    boot, log = t._run_firstrun(tmp, c)
finally:
    firstboot.render_firstrun = orig
print("after run 1: cmdline still has systemd.run:", "systemd.run=" in (boot/"cmdline.txt").read_text())
print("boot copies left:", sorted(p.name for p in boot.iterdir()))
# run 2: what the next boot would do (firstrun.sh is gone -> kernel-command-line.service ENOENT). Put the
# script back to see what a re-run finds:
(boot/"firstrun.sh").write_bytes(orig(c).replace('BOOT=/boot/firmware; [ -d "$BOOT" ] || BOOT=/boot', f"BOOT={shlex.quote(boot.as_posix())}").replace("IMAGER=/usr/lib/raspberrypi-sys-mods/imager_custom", f"IMAGER={shlex.quote((tmp/'bin'/'imager_custom').as_posix())}").replace("/usr/lib/userconf-pi/userconf", (tmp/'bin'/'userconf').as_posix()).replace("/usr/local/sbin/", tmp.as_posix()+"/sbin2-").replace("/opt/", tmp.as_posix()+"/opt2-").replace("/etc/systemd/system/", tmp.as_posix()+"/unit-").replace("/etc/ssh/", tmp.as_posix()+"/etc-ssh/").replace("/etc/NetworkManager/", tmp.as_posix()+"/etc-nm/").replace("run systemctl enable", "run true systemctl enable").encode())
env = dict(os.environ, PATH=(tmp/"bin").as_posix()+":"+os.environ["PATH"], SCREEN_TTY=(tmp/"tty").as_posix())
subprocess.run(["bash", str(boot/"firstrun.sh")], env=env, capture_output=True)
print("run 2 log tail:"); print("\n".join((boot/"firstrun.log").read_text().splitlines()[-8:]))
