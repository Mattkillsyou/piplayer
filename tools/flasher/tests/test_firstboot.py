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
    assert firstboot.valid_device_id(firstboot.derive_device_id("Lobby Projector"))
    assert not firstboot.valid_device_id("Lobby")
    assert not firstboot.valid_device_id("-a")


def test_firstrun_contents_and_quoting():
    s = firstboot.render_firstrun(cfg(password="pa'ss $(rm -rf /)", ssid="Venue WiFi"))
    assert "\r" not in s and s.startswith("#!/bin/bash\n")
    assert 'BOOT=/boot/firmware; [ -d "$BOOT" ] || BOOT=/boot' in s
    assert "set +e" in s
    assert "set_hostname lobby-projector" in s
    assert shlex.quote("pa'ss $(rm -rf /)") in s
    assert "$(rm -rf /)" not in s.replace(shlex.quote("pa'ss $(rm -rf /)"), "")
    assert "enable_ssh" in s
    assert "set_wlan 'Venue WiFi'" in s
    assert "ssid=Venue WiFi" in s
    assert "psk=it's a $ecret" in s
    assert "set_timezone America/Los_Angeles" in s
    assert "projection5000-provision.service" in s
    assert "WantedBy=multi-user.target" in s
    assert "sed -i 's| systemd.run.*||g'" in s
    assert s.rstrip("\n").endswith("exit 0")
    # Order: hostname, user, ssh, wifi, locale, provisioning, cleanup.
    marks = ["# hostname", "# user", "# ssh", "# wifi", "# locale", "# provisioning", "# cleanup"]
    positions = [s.index(m) for m in marks]
    assert positions == sorted(positions)


def test_firstrun_ethernet_only_and_hidden_and_no_ssh():
    s = firstboot.render_firstrun(cfg(ethernet_only=True, ssid="", ssh=False))
    assert "set_wlan" not in s and "nmconnection" not in s
    assert "enable_ssh" not in s and "systemctl enable ssh" not in s
    s = firstboot.render_firstrun(cfg(wifi_hidden=True))
    assert "set_wlan -h 'Venue WiFi'" in s
    assert "hidden=true" in s


def test_firstrun_validation():
    with pytest.raises(ValueError):
        firstboot.render_firstrun(cfg(ssid=""))
    with pytest.raises(ValueError):
        firstboot.render_firstrun(cfg(device_id="Bad Name"))
    with pytest.raises(ValueError):
        firstboot.render_firstrun(cfg(token=""))
    with pytest.raises(ValueError):
        firstboot.render_firstrun(cfg(ssid="a\nb"))


def test_provision_contents():
    s = firstboot.render_provision(cfg(token="tok'en", console_url="http://192.168.1.20:8080/"))
    assert "curl -fsS --max-time 10 \"$CONSOLE/api/health\"" in s
    assert "CONSOLE=http://192.168.1.20:8080\n" in s
    assert "sleep 15" in s
    assert "apt-get install -y git" in s
    assert "git clone --depth 1 https://github.com/Mattkillsyou/piplayer.git /opt/projection5000-src" in s
    assert "DEVICE_ID=lobby-projector DEVICE_TOKEN='tok'\"'\"'en' CMS_URL=http://192.168.1.20:8080 bash deploy/install-player.sh" in s
    assert "-ge 20" in s and "sleep 60" in s
    assert "systemctl disable projection5000-provision.service" in s
    assert 'rm -f /usr/local/sbin/projection5000-provision.sh "$BOOT/projection5000-provision.sh"' in s
    assert "/var/log/projection5000-provision.log" in s


def test_patch_cmdline():
    base = "console=serial0,115200 console=tty1 root=PARTUUID=abc rootfstype=ext4 fsck.repair=yes rootwait quiet"
    out = firstboot.patch_cmdline(base + "\n")
    assert out == base + " " + firstboot.CMDLINE_ARGS + "\n"
    assert out.count("\n") == 1
    # Idempotent: patching twice does not duplicate the args.
    assert firstboot.patch_cmdline(out) == out


@pytest.mark.skipif(shutil.which("bash") is None, reason="bash not available")
def test_scripts_parse_in_bash(tmp_path):
    for name, text in (("firstrun.sh", firstboot.render_firstrun(cfg())),
                       ("provision.sh", firstboot.render_provision(cfg()))):
        p = tmp_path / name
        p.write_bytes(text.encode("utf-8"))
        subprocess.run(["bash", "-n", str(p)], check=True)
