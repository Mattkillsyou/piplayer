import hashlib
import io
import json
import os
import shlex
import shutil
import subprocess
import sys
import tarfile

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
    ("name", "", "Device name"),
    ("name", "x" * 121, "Device name"),
    ("enrollment_key", "", "Enrollment key"),
    ("enrollment_key", "short-key_0123456", "Enrollment key"),
    ("enrollment_key", "k" * 129, "Enrollment key"),
    ("enrollment_key", "not base64!! 0123456789", "Enrollment key"),
    ("enrollment_key", "a=b" + "0123456789" * 3, "Enrollment key"),
    ("enrollment_key", "key\n0123456789abcdefghij", "line breaks"),
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
    ("enrollment_key", "k" * 20), ("enrollment_key", "k" * 128), ("enrollment_key", "a" * 43 + "="),
    ("enrollment_key", "aB0-_" * 8 + "=="),
])
def test_validation_accepts(field, value):
    assert firstboot.validate_cfg(cfg(**{field: value})) == []


def test_console_url_problem():
    assert firstboot.console_url_problem("https://projectors.photogen5000.com") is None
    assert firstboot.console_url_problem("http://10.0.0.5") is None
    assert "https://" in firstboot.console_url_problem("http://8.8.8.8")
    assert "https://" in firstboot.console_url_problem("http://projectors.photogen5000.com/")
    assert "http://" in firstboot.console_url_problem("ftp://x.example")


INSTALL_LINE = ('DEVICE_ID="$DEVICE_ID" DEVICE_TOKEN="$DEVICE_TOKEN" CMS_URL="$CMS_URL" '
                'bash deploy/install-player.sh')


def test_provision_contents_with_token():
    """A token on the card bypasses enrollment: no key, no /api/enroll call."""
    s = firstboot.render_provision(cfg(token="tok-en_0123456789", console_url="http://192.168.1.20:8080/"))
    assert "curl -fsS --max-time 10 \"$CONSOLE/api/health\"" in s
    assert "CONSOLE=http://192.168.1.20:8080\n" in s
    assert "\nDEVICE_ID=lobby-projector\nDEVICE_TOKEN=tok-en_0123456789\nCMS_URL=\"$CONSOLE\"\n" in s
    assert "\nENROLL_KEY=" not in s and "sample-enrollment-key" not in s and "\nDEVICE_NAME=" not in s
    assert "sleep 15" in s
    # The player comes from the card, not from GitHub (the repo is private to the Pi).
    assert "git clone" not in s and "github" not in s.lower()
    assert 'tar -xzf "$SRC" -C /opt/projection5000-src' in s
    assert "SRC=/opt/projection5000-player.tar.gz" in s
    assert INSTALL_LINE in s
    assert "-ge 20" in s and "sleep 60" in s
    assert "systemctl disable projection5000-provision.service" in s
    assert 'rm -f /usr/local/sbin/projection5000-provision.sh "$SRC"' in s
    assert "/var/log/projection5000-provision.log" in s
    # Stale image clock: wait for NTP, else seed from the console's Date header.
    assert "NTPSynchronized" in s and 'date -s "$D"' in s


def test_provision_contents_with_enrollment_key():
    key = "aB0-_" * 8
    name = "Lobby $(rm -rf /) 'Hall' \"2\""
    s = firstboot.render_provision(cfg(enrollment_key=key, name=name))
    assert "\nDEVICE_ID=lobby-projector\n" in s and f"\nENROLL_KEY={key}\n" in s
    assert "\nDEVICE_TOKEN=\nCMS_URL=\n" in s  # filled in by enroll()
    assert f"DEVICE_NAME={shlex.quote(name)}\n" in s
    assert "$(rm -rf /)" not in s.replace(shlex.quote(name), "")
    # JSON via python3 json.dumps, piped to curl (-d @-): the key never appears on a command line.
    assert 'python3 -c \'import json, os; print(json.dumps({"key": os.environ["ENROLL_KEY"], ' \
           '"device_id": os.environ["DEVICE_ID"], "name": os.environ["DEVICE_NAME"]}))\'' in s
    assert '| curl -fsS --max-time 30 -X POST "$CONSOLE/api/enroll" -H "content-type: application/json" -d @- -o "$out"' in s
    assert "json.load(sys.stdin)[\"token\"]" in s and 'json.load(sys.stdin).get("cms_url")' in s
    assert '{ [ -n "$DEVICE_TOKEN" ] || enroll; }' in s and INSTALL_LINE in s
    # The health wait comes before the first enrollment attempt.
    assert s.index('"$CONSOLE/api/health" >/dev/null') < s.index("TRIES=0")


def test_provision_with_wyze_flag():
    """wyze_configured from the console: the installer gets --with-wyze; nothing else changes."""
    plain = firstboot.render_provision(cfg())
    assert INSTALL_LINE + ")" in plain and "--with-wyze" not in plain
    s = firstboot.render_provision(cfg(with_wyze=True))
    assert INSTALL_LINE + " --with-wyze)" in s
    assert s.replace(INSTALL_LINE + " --with-wyze", INSTALL_LINE) == plain
    assert firstboot.render_provision(cfg(with_wyze=False)) == plain


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
    hostile = cfg(name="Lobby $(rm -rf /) 'Hall' \"2\" `x`", password="pa'ss $(x)", ssid="It's \"here\"")
    for name, text in (("firstrun.sh", firstboot.render_firstrun(hostile)),
                       ("provision.sh", firstboot.render_provision(hostile)),
                       ("provision-token.sh", firstboot.render_provision(cfg(token="tok-en_0123456789")))):
        p = tmp_path / name
        p.write_bytes(text.encode("utf-8"))
        subprocess.run(["bash", "-n", str(p)], check=True)


def _msys(p) -> str:
    """C:/x -> /c/x so bash tools (tar sees 'C:' as a remote host) accept the path."""
    s = str(p).replace(chr(92), "/")
    return f"/{s[0].lower()}{s[2:]}" if len(s) > 2 and s[1] == ":" else s


def _provision_harness(tmp_path, script: str, responses: list, install_fails: bool = False) -> dict:
    """Run a rendered provision.sh under bash with the world stubbed: curl answers /api/health and returns
    the queued responses for /api/enroll (an int is a curl exit code, a dict a JSON body), the player
    archive holds a stub installer that records its environment, timedatectl says the clock is synced.
    Returns the log and what the stubs recorded."""
    tmp = _msys(tmp_path)
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    rec = tmp_path / "rec"
    rec.mkdir()
    if install_fails:
        (rec / "install-fails").write_text("")

    def stub(name, body):
        p = bin_dir / name
        p.write_bytes(("#!/bin/bash\n" + body).encode())
        p.chmod(0o755)

    stub("python3", f'exec {shlex.quote(_msys(sys.executable))} "$@"\n')
    stub("timedatectl", "echo yes\n")
    stub("systemctl", f'echo "$@" >>{shlex.quote(_msys(rec))}/systemctl\n')
    for i, r in enumerate(responses, 1):
        (rec / f"resp.{i}").write_text(str(r) if isinstance(r, int) else "0\n" + json.dumps(r))
    stub("curl", "\n".join([
        f"REC={shlex.quote(_msys(rec))}",
        'out=; url=',
        'while [ $# -gt 0 ]; do case "$1" in -o) out=$2; shift;; http*) url=$1;; esac; shift; done',
        'case "$url" in */api/health) echo "$url" >>"$REC/health"; exit 0;; esac',
        'n=$(cat "$REC/count" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" >"$REC/count"',
        'cat >"$REC/body.$n"',
        'echo "$url" >>"$REC/enroll"',
        'rc=$(head -n1 "$REC/resp.$n" 2>/dev/null || echo 7)',
        '[ "$rc" = 0 ] || { echo "curl: (22) The requested URL returned error: 401" >&2; exit "$rc"; }',
        'tail -n +2 "$REC/resp.$n" >"$out"',
        "",
    ]))
    # The player archive: a stub installer that records DEVICE_ID/DEVICE_TOKEN/CMS_URL.
    installer = (f'#!/bin/bash\nprintf "%s\\n" "$DEVICE_ID" "$DEVICE_TOKEN" "$CMS_URL" >{shlex.quote(_msys(rec))}/install\n'
                 f'[ -f {shlex.quote(_msys(rec))}/install-fails ] && exit 9\nexit 0\n').encode()
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        ti = tarfile.TarInfo("player/deploy/install-player.sh")
        ti.size = len(installer)
        tar.addfile(ti, io.BytesIO(installer))
    archive = tmp_path / "player.tar.gz"
    archive.write_bytes(buf.getvalue())
    log = tmp_path / "provision.log"
    sbin = tmp_path / "sbin-provision.sh"
    sbin.write_text("copy on the pi")
    s = (script.replace("exec >>/var/log/projection5000-provision.log 2>&1", f"exec >>{shlex.quote(_msys(log))} 2>&1")
               .replace("SRC=/opt/projection5000-player.tar.gz", f"SRC={shlex.quote(_msys(archive))}")
               .replace("/opt/projection5000-src", tmp + "/src")
               .replace("/usr/local/sbin/projection5000-provision.sh", _msys(sbin))
               .replace("sleep 60", "sleep 0").replace("sleep 15", "sleep 0").replace("-ge 20", "-ge 3"))
    p = tmp_path / "provision.sh"
    p.write_bytes(s.encode())
    env = dict(os.environ, PATH=_msys(bin_dir) + ":" + os.environ.get("PATH", ""))
    r = subprocess.run(["bash", str(p)], capture_output=True, text=True, timeout=120, env=env)
    read = lambda n: (rec / n).read_text().replace("\r", "") if (rec / n).exists() else ""
    bodies = [json.loads((rec / f"body.{i}").read_text()) for i in range(1, int(read("count") or 0) + 1)]
    return {"rc": r.returncode, "log": log.read_text() + r.stderr, "bodies": bodies,
            "install": read("install").split("\n")[:3], "systemctl": read("systemctl"),
            "enroll_calls": read("enroll").count("/api/enroll"), "health_calls": read("health").count("/api/health"),
            "sbin": sbin.exists(), "archive": archive.exists(), "rec": rec}


@pytest.mark.skipif(shutil.which("bash") is None, reason="bash not available")
def test_provision_enrolls_then_installs(tmp_path):
    key = "aB0-_" * 8 + "=="
    name = "Lobby $(rm -rf /) 'Hall' \"2\" \\ é"
    s = firstboot.render_provision(cfg(enrollment_key=key, name=name))
    r = _provision_harness(tmp_path, s, [{"device_id": "lobby-projector", "token": "tok-from-console-0123456789",
                                         "cms_url": "https://console.example/"}])
    assert r["rc"] == 0, r["log"]
    assert r["health_calls"] >= 1 and r["enroll_calls"] == 1
    # The JSON the console receives is exactly the shared contract, with the hostile name intact.
    assert r["bodies"] == [{"key": key, "device_id": "lobby-projector", "name": name}]
    # The installer got the token and the cms_url from the response.
    assert r["install"] == ["lobby-projector", "tok-from-console-0123456789", "https://console.example/"]
    assert "enrolled as lobby-projector at https://console.example/" in r["log"]
    assert "install succeeded" in r["log"]
    # Secret hygiene: the script and archive are gone, the service is disabled, no secret in the log.
    assert not r["sbin"] and not r["archive"] and "disable projection5000-provision.service" in r["systemctl"]
    assert key not in r["log"] and "tok-from-console" not in r["log"]


@pytest.mark.skipif(shutil.which("bash") is None, reason="bash not available")
def test_provision_retries_enrollment_and_install(tmp_path):
    """Network flap (curl fails), then a response without a token, then success; a failing installer retries
    without enrolling again (the token is kept)."""
    s = firstboot.render_provision(cfg())
    r = _provision_harness(tmp_path, s, [22, {"detail": "odd"}, {"token": "tok-0123456789abcdef", "cms_url": ""}])
    assert r["rc"] == 0, r["log"]
    assert r["enroll_calls"] == 3 and r["log"].count("enrollment failed (curl rc=22)") == 1
    assert "enrollment failed (curl rc=0)" in r["log"]  # 200 without a token is a failure too
    assert "attempt 2 failed, retrying" in r["log"] and "install attempt 3" in r["log"]
    assert r["install"][1:] == ["tok-0123456789abcdef", "https://projectors.photogen5000.com"]  # empty cms_url: CONSOLE
    # Installer failure: retried up to the limit without re-enrolling, then gives up with instructions.
    (tmp_path / "fails").mkdir()
    r = _provision_harness(tmp_path / "fails", s, [{"token": "tok-0123456789abcdef", "cms_url": "https://c"}],
                           install_fails=True)
    assert r["rc"] == 1 and "GAVE UP after 3 attempts" in r["log"], r["log"]
    assert r["enroll_calls"] == 1 and r["sbin"] and r["archive"]  # nothing deleted: the next boot retries


@pytest.mark.skipif(shutil.which("bash") is None, reason="bash not available")
def test_provision_with_token_never_enrolls(tmp_path):
    s = firstboot.render_provision(cfg(token="tok-on-card-0123456789", console_url="http://console.local:8080"))
    r = _provision_harness(tmp_path, s, [])
    assert r["rc"] == 0, r["log"]
    assert r["enroll_calls"] == 0 and r["bodies"] == []
    assert r["install"] == ["lobby-projector", "tok-on-card-0123456789", "http://console.local:8080"]
    assert not r["sbin"] and not r["archive"]


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
