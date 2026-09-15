import hashlib
import shlex
import subprocess
import shutil

import pytest

import firstboot


def cfg(**over):
    c = firstboot.sample_config()
    c.update(over)
    return c


def test_derive_device_id():
    assert firstboot.derive_device_id("Lobby Projector") == "lobby-projector"
    assert firstboot.derive_device_id("  --Hall #2 (East)!  ") == "hall-2-east"
    assert firstboot.derive_device_id("x" * 100) == "x" * 63
    assert firstboot.derive_device_id("a" * 62 + "-bb") == "a" * 62
    assert firstboot.derive_device_id("Café Étage") == "cafe-etage"
    assert firstboot.derive_device_id("Übersicht İstanbul") == "ubersicht-istanbul"
    assert firstboot.derive_device_id("---") == ""
    assert firstboot.valid_device_id(firstboot.derive_device_id("Lobby Projector"))
    assert not firstboot.valid_device_id("Lobby")
    assert not firstboot.valid_device_id("-a")
    assert not firstboot.valid_device_id("hall-2-")  # systemd strips the trailing hyphen
    assert not firstboot.valid_device_id("lobby-projector\n")  # $ would match before a trailing newline
    assert firstboot.valid_device_id("a") and firstboot.valid_device_id("a" * 63)
    assert not firstboot.valid_device_id("a" * 64)


def test_firstrun_contents_and_quoting():
    s = firstboot.render_firstrun(cfg(password="pa'ss $(rm -rf /)", ssid="Venue WiFi"))
    assert "\r" not in s and s.startswith("#!/bin/bash\n")
    assert 'BOOT=/boot/firmware; [ -d "$BOOT" ] || BOOT=/boot' in s
    assert "set +e" in s
    assert 'run "$IMAGER" set_hostname lobby-projector' in s
    assert shlex.quote("pa'ss $(rm -rf /)") in s
    assert "$(rm -rf /)" not in s.replace(shlex.quote("pa'ss $(rm -rf /)"), "")
    assert 'run "$IMAGER" enable_ssh' in s
    # The passphrase is pre-hashed (PBKDF2, as Raspberry Pi Imager does): the card never holds it.
    psk = hashlib.pbkdf2_hmac("sha1", b"it's a $ecret", b"Venue WiFi", 4096, 32).hex()
    assert f"set_wlan 'Venue WiFi' {psk} US" in s
    assert "ssid=Venue WiFi" in s
    assert f"psk={psk}" in s
    assert "$ecret" not in s
    assert 'run "$IMAGER" set_timezone America/Los_Angeles' in s
    assert "projection5000-provision.service" in s
    assert "WantedBy=multi-user.target" in s
    # Token-wise cmdline cleanup keeps the cfg80211.ieee80211_regdom=CC raspi-config appends after our args.
    assert "sed -i -E 's/ ?systemd\\.(run|run_success_action|unit)=[^ ]*//g' \"$BOOT/cmdline.txt\"" in s
    # Secrets are zero-filled before unlink and moved off the FAT partition on the first boot.
    assert 'wipe "$BOOT/projection5000-provision.sh"' in s
    assert 'wipe "$BOOT/firstrun.sh"' in s
    assert 'install -m 0700 "$BOOT/projection5000-provision.sh" /usr/local/sbin/projection5000-provision.sh' in s
    assert 'install -m 0600 "$BOOT/projection5000-player.tar.gz" /opt/projection5000-player.tar.gz' in s
    assert 'rm -f "$BOOT/projection5000-player.tar.gz"' in s
    # Every step logs its exit status and a success marker is left behind.
    assert "rc=$rc" in s and 'touch "$BOOT/firstrun.ok"' in s
    assert s.rstrip("\n").endswith("finish")
    # Order: hostname, user, ssh, wifi, locale, provisioning, cleanup.
    marks = ["# hostname", "# user", "# ssh", "# wifi", "# locale", "# provisioning", "# cleanup"]
    positions = [s.index(m) for m in marks]
    assert positions == sorted(positions)


def test_wifi_psk_rules():
    hexkey = "ab" * 32
    assert firstboot.wifi_psk("x", hexkey) == hexkey  # a 64-hex key is passed through
    assert firstboot.wifi_psk("x", "") == ""  # open network
    assert firstboot.wifi_psk("Venue", "pass\\word1") == hashlib.pbkdf2_hmac(
        "sha1", b"pass\\word1", b"Venue", 4096, 32).hex()
    s = firstboot.render_firstrun(cfg(wifi_password="pass\\word1"))
    assert "pass\\word1" not in s
    s = firstboot.render_firstrun(cfg(wifi_password=""))
    assert "set_wlan 'Venue WiFi' '' US" in s and "[wifi-security]" not in s


def test_firstrun_ethernet_only_and_hidden_and_no_ssh():
    s = firstboot.render_firstrun(cfg(ethernet_only=True, ssid="", ssh=False))
    assert "set_wlan" not in s and "nmconnection" not in s
    assert "enable_ssh" not in s and "systemctl enable ssh" not in s
    s = firstboot.render_firstrun(cfg(wifi_hidden=True))
    assert "set_wlan -h 'Venue WiFi'" in s
    assert "hidden=true" in s


def test_sed_cleanup_keeps_regdom(tmp_path):
    """The exact sed from firstrun.sh, run on what cmdline.txt looks like after raspi-config appended
    the regulatory domain: only the systemd.* tokens go."""
    if shutil.which("bash") is None or shutil.which("sed") is None:
        pytest.skip("bash/sed not available")
    line = "console=tty1 root=PARTUUID=abc rootwait " + firstboot.CMDLINE_ARGS + " cfg80211.ieee80211_regdom=US\n"
    p = tmp_path / "cmdline.txt"
    p.write_text(line)
    script = [ln for ln in firstboot.render_firstrun(cfg()).splitlines() if ln.startswith("sed -i -E")][0]
    subprocess.run(["bash", "-c", f'BOOT={shlex.quote(str(tmp_path))}; {script}'], check=True)
    assert p.read_text() == "console=tty1 root=PARTUUID=abc rootwait cfg80211.ieee80211_regdom=US\n"
    p.write_text(firstboot.CMDLINE_ARGS + "\n")  # no leading space: still nothing left over
    subprocess.run(["bash", "-c", f'BOOT={shlex.quote(str(tmp_path))}; {script}'], check=True)
    assert p.read_text().strip() == ""


@pytest.mark.parametrize("field,value,fragment", [
    ("ssid", "", "SSID is required"),
    ("ssid", "a\nb", "line breaks"),
    ("ssid", " Lead", "start or end with a space"),
    ("ssid", "C:\\net", "backslash"),
    ("ssid", "-h", "not allowed"),
    ("ssid", "x" * 33, "1-32 bytes"),
    ("wifi_password", "1234567", "8-63 characters"),
    ("wifi_password", "é" * 40, "8-63 characters"),
    ("wifi_password", "a\nb12345", "line breaks"),
    ("wifi_country", "UK", "use GB"),
    ("wifi_country", "1!", "ISO 3166"),
    ("wifi_country", "EU", "ISO 3166"),
    ("device_id", "Bad Name", "device_id"),
    ("device_id", "hall-2-", "device_id"),
    ("device_id", "abc\n", "line breaks"),
    ("username", "root", "not be root"),
    ("username", "Matt", "Pi username"),
    ("username", "Matt Brown", "Pi username"),
    ("username", " pi ", "Pi username"),
    ("username", "pi\n", "line breaks"),
    ("username", "a" * 33, "Pi username"),
    ("password", "", "Pi password is required"),
    ("password", "sec\nret", "line breaks"),
    ("token", "", "Device token"),
    ("token", "tok'en", "Device token"),
    ("token", 'to"k\\en-0123456789', "Device token"),
    ("token", "short", "Device token"),
    ("console_url", "projectors.photogen5000.com", "http:// or https://"),
    ("console_url", "http://projectors.photogen5000.com", "https://"),
    ("timezone", "Europe/Londn ", "Timezone"),
    ("timezone", "America/Los Angeles", "Timezone"),
    ("timezone", "Mars/Phobos/X/Y", "Timezone"),
    ("keymap", "us/dvorak", "Keyboard layout"),
    ("keymap", "u&s", "Keyboard layout"),
])
def test_validation_rejects(field, value, fragment):
    problems = firstboot.validate_cfg(cfg(**{field: value}))
    assert any(fragment in p for p in problems), problems
    with pytest.raises(ValueError):
        firstboot.render_firstrun(cfg(**{field: value}))


@pytest.mark.parametrize("field,value", [
    ("wifi_password", ""), ("wifi_password", "12345678"), ("wifi_password", "x" * 63), ("wifi_password", "ab" * 32),
    ("wifi_password", "--hidden"), ("wifi_country", "gb"), ("wifi_country", "DE"), ("username", "matt-b2"),
    ("timezone", "UTC"), ("timezone", "America/Argentina/Buenos_Aires"), ("timezone", "Etc/GMT+1"),
    ("console_url", "http://192.168.1.20:8080"), ("console_url", "http://console.local"),
    ("console_url", "http://localhost:8080"), ("console_url", "http://controller:8080"),
    ("console_url", "https://projectors.photogen5000.com"), ("token", "A-z_0123456789ab"),
])
def test_validation_accepts(field, value):
    assert firstboot.validate_cfg(cfg(**{field: value})) == []


def test_console_url_problem():
    assert firstboot.console_url_problem("https://projectors.photogen5000.com") is None
    assert firstboot.console_url_problem("http://10.0.0.5") is None
    assert "https://" in firstboot.console_url_problem("http://8.8.8.8")
    assert "https://" in firstboot.console_url_problem("http://projectors.photogen5000.com/")
    assert "http://" in firstboot.console_url_problem("ftp://x.example")


def test_provision_contents():
    s = firstboot.render_provision(cfg(token="tok-en_0123456789", console_url="http://192.168.1.20:8080/"))
    assert "curl -fsS --max-time 10 \"$CONSOLE/api/health\"" in s
    assert "CONSOLE=http://192.168.1.20:8080\n" in s
    assert "sleep 15" in s
    # The player comes from the card, not from GitHub (the repo is private to the Pi).
    assert "git clone" not in s and "github" not in s.lower()
    assert 'tar -xzf "$SRC" -C /opt/projection5000-src' in s
    assert "SRC=/opt/projection5000-player.tar.gz" in s
    assert "DEVICE_ID=lobby-projector DEVICE_TOKEN=tok-en_0123456789 CMS_URL=http://192.168.1.20:8080 bash deploy/install-player.sh" in s
    assert "-ge 20" in s and "sleep 60" in s
    assert "systemctl disable projection5000-provision.service" in s
    assert 'rm -f /usr/local/sbin/projection5000-provision.sh "$SRC"' in s
    assert "/var/log/projection5000-provision.log" in s
    # Stale image clock: wait for NTP, else seed from the console's Date header.
    assert "NTPSynchronized" in s and 'date -s "$D"' in s
    s = firstboot.render_provision(cfg(console_url="https://projectors.photogen5000.com"))
    assert "CMS_URL=https://projectors.photogen5000.com bash" in s


def test_patch_cmdline():
    base = "console=serial0,115200 console=tty1 root=PARTUUID=abc rootfstype=ext4 fsck.repair=yes rootwait quiet"
    out = firstboot.patch_cmdline(base + "\n")
    assert out == base + " " + firstboot.CMDLINE_ARGS + "\n"
    assert out.count("\n") == 1
    # Idempotent: patching twice does not duplicate the args.
    assert firstboot.patch_cmdline(out) == out
    # CRLF, no trailing newline, multi-line and tabs all collapse to one LF-terminated line.
    assert firstboot.patch_cmdline(base + "\r\n") == out
    assert firstboot.patch_cmdline(base) == out
    assert firstboot.patch_cmdline(base.replace(" quiet", "\nquiet\t")) == out
    # Older args in the middle are removed.
    assert firstboot.patch_cmdline("a systemd.run=/x systemd.unit=y b") == "a b " + firstboot.CMDLINE_ARGS + "\n"
    with pytest.raises(ValueError):
        firstboot.patch_cmdline("")
    with pytest.raises(ValueError):
        firstboot.patch_cmdline("  \n")


@pytest.mark.skipif(shutil.which("bash") is None, reason="bash not available")
def test_scripts_parse_in_bash(tmp_path):
    for name, text in (("firstrun.sh", firstboot.render_firstrun(cfg())),
                       ("provision.sh", firstboot.render_provision(cfg()))):
        p = tmp_path / name
        p.write_bytes(text.encode("utf-8"))
        subprocess.run(["bash", "-n", str(p)], check=True)


@pytest.mark.skipif(shutil.which("bash") is None, reason="bash not available")
def test_firstrun_wipes_itself_and_logs_rc(tmp_path):
    """Run the rendered firstrun.sh with stubbed tools: it must finish, log each step's rc, zero-fill and
    remove the secret-bearing files, and write firstrun.ok."""
    boot = tmp_path / "boot"
    boot.mkdir()
    s = firstboot.render_firstrun(cfg())
    # Point the script at the temp tree: BOOT, a fake imager and a stub userconf; the real coreutils
    # (openssl, install, dd, stat, sed, ...) do the work. Forward slashes: bash on Windows (Git Bash).
    tmp = tmp_path.as_posix()
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    imager = bin_dir / "imager_custom"
    imager.write_text('#!/bin/bash\necho "imager $1"\n[ "$1" = set_keymap ] && exit 3\nexit 0\n')
    imager.chmod(0o755)
    s = (s.replace('BOOT=/boot/firmware; [ -d "$BOOT" ] || BOOT=/boot', f"BOOT={shlex.quote(boot.as_posix())}")
          .replace("IMAGER=/usr/lib/raspberrypi-sys-mods/imager_custom", f"IMAGER={shlex.quote(imager.as_posix())}")
          .replace("/usr/lib/userconf-pi/userconf", (bin_dir / "userconf").as_posix())
          .replace("/usr/local/sbin/", tmp + "/sbin-")
          .replace("/opt/", tmp + "/opt-")
          .replace("/etc/systemd/system/", tmp + "/unit-")
          .replace("run systemctl enable", "run true systemctl enable"))
    (bin_dir / "userconf").write_text("#!/bin/bash\nexit 0\n")
    (bin_dir / "userconf").chmod(0o755)
    firstrun = boot / "firstrun.sh"
    firstrun.write_bytes(s.encode())
    provision = boot / "projection5000-provision.sh"
    provision.write_bytes(b"#!/bin/bash\nDEVICE_TOKEN=supersecrettoken0000\n")
    (boot / firstboot.PLAYER_ARCHIVE).write_bytes(b"tarball")
    (boot / "cmdline.txt").write_text("console=tty1 rootwait " + firstboot.CMDLINE_ARGS + " cfg80211.ieee80211_regdom=US\n")
    r = subprocess.run(["bash", str(firstrun)], capture_output=True, text=True, timeout=60)
    log = (boot / "firstrun.log").read_text()
    assert r.returncode == 0, log + r.stderr
    assert "set_hostname -> rc=0" in log and "set_keymap -> rc=3" in log and "userconf pi -> rc=0" in log, log
    assert "firstrun done" in log and "1 step(s) failed" in log
    assert not (boot / "firstrun.ok").exists()  # one step failed: no success marker
    assert not firstrun.exists() and not provision.exists() and not (boot / firstboot.PLAYER_ARCHIVE).exists()
    assert (tmp_path / "sbin-projection5000-provision.sh").read_bytes() == b"#!/bin/bash\nDEVICE_TOKEN=supersecrettoken0000\n"
    assert (tmp_path / "opt-projection5000-player.tar.gz").read_bytes() == b"tarball"
    assert (boot / "cmdline.txt").read_text() == "console=tty1 rootwait cfg80211.ieee80211_regdom=US\n"
    # No secret is left in the log.
    assert "correct horse battery" not in log and "supersecret" not in log and "$ecret" not in log


def test_wipe_zero_fills_before_unlink(tmp_path):
    """The wipe helper overwrites the bytes in place (a plain rm leaves them in the free FAT clusters)."""
    if shutil.which("bash") is None:
        pytest.skip("bash not available")
    f = tmp_path / "secret.sh"
    f.write_bytes(b"WIFI=hunter2hunter2\n" * 50)
    wipe = [ln for ln in firstboot.render_firstrun(cfg()).splitlines() if ln.startswith("wipe()")][0]
    # Replace rm with a copy so the zero-filled content can be inspected.
    script = wipe.replace('rm -f "$1"', 'cp "$1" "$1.after"; rm -f "$1"') + f"\nwipe {shlex.quote(str(f))}\n"
    subprocess.run(["bash", "-c", script], check=True)
    after = (tmp_path / "secret.sh.after").read_bytes()
    assert len(after) == 20 * 50 and after == b"\0" * len(after)
    assert not f.exists()
