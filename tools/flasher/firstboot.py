"""First-boot files for a Projection5000 player card.

Pure functions. Every operator-supplied value is passed through shlex.quote
before it lands in a shell script. Output uses LF line endings, UTF-8, no BOM.
"""
import re
import shlex

DEVICE_ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,62}$")
GITHUB_REPO = "https://github.com/Mattkillsyou/piplayer.git"
CMDLINE_ARGS = ("systemd.run=/boot/firmware/firstrun.sh "
                "systemd.run_success_action=reboot "
                "systemd.unit=kernel-command-line.target")

DEFAULTS = {
    "username": "pi",
    "ssh": True,
    "ethernet_only": False,
    "wifi_hidden": False,
    "wifi_country": "US",
    "timezone": "America/Los_Angeles",
    "keymap": "us",
}


def derive_device_id(name: str) -> str:
    """'Lobby Projector' -> 'lobby-projector'. Lowercase, non [a-z0-9] runs become one hyphen."""
    s = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    return s[:63].rstrip("-")


def valid_device_id(device_id: str) -> bool:
    return bool(DEVICE_ID_RE.match(device_id))


def _cfg(cfg: dict) -> dict:
    full = dict(DEFAULTS)
    full.update(cfg)
    for key in ("device_id", "password", "console_url", "token"):
        if not full.get(key):
            raise ValueError(f"cfg[{key!r}] is required")
    if not valid_device_id(full["device_id"]):
        raise ValueError(f"invalid device_id {full['device_id']!r}")
    if not full["ethernet_only"] and not full.get("ssid"):
        raise ValueError("cfg['ssid'] is required unless ethernet_only")
    for key in ("ssid", "wifi_password"):
        if "\n" in (full.get(key) or ""):
            raise ValueError(f"cfg[{key!r}] must not contain newlines")
    full["wifi_country"] = full["wifi_country"].upper()
    return full


def render_firstrun(cfg: dict) -> str:
    c = _cfg(cfg)
    q = shlex.quote
    dev = q(c["device_id"])
    user = q(c["username"])
    lines = [
        "#!/bin/bash",
        "# Projection5000 first-boot configuration. Runs once as root, then deletes itself.",
        "set +e",
        'BOOT=/boot/firmware; [ -d "$BOOT" ] || BOOT=/boot',
        'exec >>"$BOOT/firstrun.log" 2>&1',
        'echo "firstrun start $(date)"',
        "IMAGER=/usr/lib/raspberrypi-sys-mods/imager_custom",
        "",
        "# hostname",
        'if [ -x "$IMAGER" ]; then',
        f'  "$IMAGER" set_hostname {dev}',
        "else",
        '  CURRENT_HOSTNAME=$(tr -d " \\t\\n\\r" </etc/hostname)',
        f"  echo {dev} >/etc/hostname",
        f'  sed -i "s/127.0.1.1.*$CURRENT_HOSTNAME/127.0.1.1\\t{c["device_id"]}/g" /etc/hosts',
        "fi",
        "",
        "# user",
        f"HASH=$(printf %s {q(c['password'])} | openssl passwd -6 -stdin)",
        "if [ -f /usr/lib/userconf-pi/userconf ]; then",
        f'  /usr/lib/userconf-pi/userconf {user} "$HASH"',
        "else",
        f"  id -u {user} >/dev/null 2>&1 || useradd -m -G sudo,video,render,audio,input,tty -s /bin/bash {user}",
        f'  printf "%s:%s\\n" {user} "$HASH" | chpasswd -e',
        "  systemctl disable userconfig 2>/dev/null",
        "  rm -f /etc/xdg/autostart/piwiz.desktop",
        "fi",
        "",
    ]
    if c["ssh"]:
        lines += [
            "# ssh",
            'if [ -x "$IMAGER" ]; then "$IMAGER" enable_ssh; else systemctl enable ssh; fi',
            "",
        ]
    if not c["ethernet_only"]:
        lines += _wifi_lines(c)
    lines += [
        "# locale",
        'if [ -x "$IMAGER" ]; then',
        f'  "$IMAGER" set_keymap {q(c["keymap"])}',
        f'  "$IMAGER" set_timezone {q(c["timezone"])}',
        "else",
        f"  raspi-config nonint do_configure_keyboard {q(c['keymap'])}",
        f"  timedatectl set-timezone {q(c['timezone'])}",
        "fi",
        "",
        "# provisioning service: installs the player once the network is up",
        'install -m 0700 "$BOOT/projection5000-provision.sh" /usr/local/sbin/projection5000-provision.sh',
        "cat >/etc/systemd/system/projection5000-provision.service <<'EOF'",
        "[Unit]",
        "Description=Projection5000 first-boot install",
        "After=network-online.target",
        "Wants=network-online.target",
        "",
        "[Service]",
        "Type=simple",
        "ExecStart=/usr/local/sbin/projection5000-provision.sh",
        "",
        "[Install]",
        "WantedBy=multi-user.target",
        "EOF",
        "systemctl enable projection5000-provision.service",
        "",
        "# cleanup: never run again",
        'rm -f "$BOOT/firstrun.sh"',
        # Same strip Raspberry Pi Imager uses: everything from ' systemd.run' to end of line.
        "sed -i 's| systemd.run.*||g' \"$BOOT/cmdline.txt\"",
        'echo "firstrun done $(date)"',
        "exit 0",
        "",
    ]
    return "\n".join(lines)


def _wifi_lines(c: dict) -> list:
    q = shlex.quote
    hidden_flag = "-h " if c["wifi_hidden"] else ""
    psk = c.get("wifi_password") or ""
    nm = [
        "[connection]",
        "id=preconfigured",
        "type=wifi",
        "",
        "[wifi]",
        "mode=infrastructure",
        f"ssid={c['ssid']}",
    ]
    if c["wifi_hidden"]:
        nm.append("hidden=true")
    if psk:
        nm += ["", "[wifi-security]", "key-mgmt=wpa-psk", f"psk={psk}"]
    nm += ["", "[ipv4]", "method=auto", "", "[ipv6]", "method=auto"]
    return [
        "# wifi",
        'if [ -x "$IMAGER" ]; then',
        f'  "$IMAGER" set_wlan {hidden_flag}{q(c["ssid"])} {q(psk)} {q(c["wifi_country"])}',
        "else",
        "  mkdir -p /etc/NetworkManager/system-connections",
        "  cat >/etc/NetworkManager/system-connections/preconfigured.nmconnection <<'NMEOF'",
        *nm,
        "NMEOF",
        "  chmod 0600 /etc/NetworkManager/system-connections/preconfigured.nmconnection",
        "  rfkill unblock wifi",
        f"  raspi-config nonint do_wifi_country {q(c['wifi_country'])}",
        "fi",
        "",
    ]


def render_provision(cfg: dict) -> str:
    c = _cfg(cfg)
    q = shlex.quote
    console = c["console_url"].rstrip("/")
    env = f"DEVICE_ID={q(c['device_id'])} DEVICE_TOKEN={q(c['token'])} CMS_URL={q(console)}"
    lines = [
        "#!/bin/bash",
        "# Projection5000 provisioning. Runs on every boot until the player is installed, then disables itself.",
        "set +e",
        'BOOT=/boot/firmware; [ -d "$BOOT" ] || BOOT=/boot',
        "exec >>/var/log/projection5000-provision.log 2>&1",
        f"CONSOLE={q(console)}",
        'echo "provision start $(date)"',
        "",
        'until curl -fsS --max-time 10 "$CONSOLE/api/health" >/dev/null; do',
        '  echo "waiting for console at $CONSOLE"',
        "  sleep 15",
        "done",
        "",
        "TRIES=0",
        "while :; do",
        "  TRIES=$((TRIES + 1))",
        '  echo "install attempt $TRIES $(date)"',
        "  if apt-get update && apt-get install -y git \\",
        "     && rm -rf /opt/projection5000-src \\",
        f"     && git clone --depth 1 {GITHUB_REPO} /opt/projection5000-src \\",
        f"     && (cd /opt/projection5000-src/player && {env} bash deploy/install-player.sh); then",
        '    echo "install succeeded $(date)"',
        "    systemctl disable projection5000-provision.service",
        '    rm -f /usr/local/sbin/projection5000-provision.sh "$BOOT/projection5000-provision.sh"',
        "    exit 0",
        "  fi",
        '  if [ "$TRIES" -ge 20 ]; then',
        '    echo "GAVE UP after $TRIES attempts. Fix the problem above, then run: sudo systemctl start projection5000-provision.service"',
        "    exit 1",
        "  fi",
        '  echo "attempt $TRIES failed, retrying in 60 s"',
        "  sleep 60",
        "done",
        "",
    ]
    return "\n".join(lines)


def patch_cmdline(text: str) -> str:
    """Append the firstrun boot args to cmdline.txt (one line), replacing any earlier ones."""
    words = [w for w in text.split()
             if not w.startswith(("systemd.run=", "systemd.run_success_action=", "systemd.unit="))]
    return " ".join(words + [CMDLINE_ARGS]) + "\n"


def sample_config() -> dict:
    return {
        "device_id": "lobby-projector",
        "name": "Lobby Projector",
        "username": "pi",
        "password": "correct horse battery",
        "ssh": True,
        "ssid": "Venue WiFi",
        "wifi_password": "it's a $ecret",
        "wifi_country": "US",
        "wifi_hidden": False,
        "ethernet_only": False,
        "timezone": "America/Los_Angeles",
        "keymap": "us",
        "console_url": "https://projectors.photogen5000.com",
        "token": "sample-token-0123456789",
    }
