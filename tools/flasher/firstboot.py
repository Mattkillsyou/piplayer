"""First-boot files for a Projection5000 player card.

Pure functions. Every operator-supplied value is passed through shlex.quote
before it lands in a shell script. Output uses LF line endings, UTF-8, no BOM.
validate_cfg() is the single list of input rules; the GUI and the renderers both use it.
"""
import hashlib
import ipaddress
import re
import shlex
import unicodedata
import urllib.parse

# RFC 952/1123 label: no leading or trailing hyphen (systemd strips a trailing one, RFC forbids it).
DEVICE_ID_RE = re.compile(r"[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?")
# What Raspberry Pi's userconf-service accepts before it calls userconf (1-32 chars, not root).
USERNAME_RE = re.compile(r"[a-z][a-z0-9-]{0,31}")
TOKEN_RE = re.compile(r"[A-Za-z0-9_-]{16,}")
# urlsafe-base64 as the console generates it (token_urlsafe / getRandomValues), padding tolerated.
ENROLL_KEY_RE = re.compile(r"[A-Za-z0-9_-]+={0,2}")
MAX_NAME_LEN = 120
TIMEZONE_RE = re.compile(r"UTC|[A-Za-z_]+(/[A-Za-z0-9_+-]+){1,2}")
KEYMAP_RE = re.compile(r"[a-z]{2,8}")
# One authorized_keys line as sshkey.public_line() writes it (type, base64 blob, optional comment).
SSH_PUBKEY_RE = re.compile(r"ssh-ed25519 [A-Za-z0-9+/]+=* ?[^\s]*")
HEX64_RE = re.compile(r"[0-9a-fA-F]{64}")
# imager_custom set_wlan parses these positionally; an SSID equal to one of them is taken as a flag.
WLAN_FLAGS = {"-h", "--hidden", "-p", "--plain"}
# ISO 3166-1 alpha-2, what raspi-config do_wifi_country accepts (/usr/share/zoneinfo/iso3166.tab).
ISO3166 = frozenset("""
AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ
CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR
GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO
JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR
MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO
RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV
TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW
""".split())
COUNTRY_ALIASES = {"UK": "GB"}

CMDLINE_ARGS = ("systemd.run=/boot/firmware/firstrun.sh "
                "systemd.run_success_action=reboot "
                "systemd.unit=kernel-command-line.target")
PLAYER_ARCHIVE = "projection5000-player.tar.gz"  # player/ tree, written next to firstrun.sh

# The setup screen on the HDMI console (tty1), drawn with the kernel console alone (bash + setfont + echo:
# stock Pi OS Lite has no Pillow, fbi or figlet). Shared by firstrun.sh and provision.sh; install-player.sh
# carries a copy. A no-op without a writable tty (tests under Git Bash, headless boards); SCREEN_TTY is
# only overridden by the tests. Safe under set -e: every line ends in a success.
SCREEN_FN = r"""
# setup screen: screen_init once, then screen STEP [HINT...] (centred, the hints dim) on the HDMI console.
SCREEN_TTY="${SCREEN_TTY:-/dev/tty1}"
screen_init() {
  [ -w "$SCREEN_TTY" ] || return 0
  TERM=linux setterm --blank 0 --cursor off --powersave off >>"$SCREEN_TTY" 2>/dev/null || true
  local f=/usr/share/consolefonts/Lat15-TerminusBold32x16.psf.gz
  [ -f "$f" ] && setfont "$f" -C "$SCREEN_TTY" 2>/dev/null || true
}
screen() {
  [ -w "$SCREEN_TTY" ] || return 0
  local size rows cols i
  size=$(stty size <"$SCREEN_TTY" 2>/dev/null || true); rows=${size%% *}; cols=${size##* }
  [ "${cols:-0}" -gt 0 ] 2>/dev/null || { rows=25; cols=80; }
  centre() { local pad=$(( (cols - ${#1}) / 2 )); [ "$pad" -gt 0 ] || pad=0; printf "%*s%s\n" "$pad" "" "$1"; }
  {
    printf "\033[2J\033[H"; for ((i = 0; i < rows / 2 - 3; i++)); do echo; done
    centre "MATT BROWN'S"; printf "\033[1m"; centre "PROJECTION5000"; printf "\033[0m"; echo
    centre "$1"; shift; printf "\033[2m"; for i in "$@"; do centre "$i"; done; printf "\033[0m"
  } >>"$SCREEN_TTY" 2>/dev/null || true
}
""".strip("\n").splitlines()

DEFAULTS = {
    "username": "pi",
    "ssh": True,
    "ethernet_only": False,
    "wifi_hidden": False,
    "wifi_country": "US",
    "timezone": "America/Los_Angeles",
    "keymap": "us",
    "ssh_pubkey": "",  # set: key-only SSH (authorized_keys + PasswordAuthentication no)
    "static_ip": "",  # "192.168.1.50/24"; empty: DHCP
    "gateway": "",  # required with static_ip; also the DNS server
}


def derive_device_id(name: str) -> str:
    """'Lobby Projector' -> 'lobby-projector'. Accents are folded to ASCII, other runs become one hyphen."""
    ascii_name = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode()
    s = re.sub(r"[^a-z0-9]+", "-", ascii_name.lower()).strip("-")
    return s[:63].rstrip("-")


def valid_device_id(device_id: str) -> bool:
    return bool(DEVICE_ID_RE.fullmatch(device_id))


def _local_host(host: str) -> bool:
    try:
        ip = ipaddress.ip_address(host)
        return ip.is_private or ip.is_loopback or ip.is_link_local
    except ValueError:
        return host == "localhost" or host.endswith(".local") or "." not in host


def console_url_problem(url: str):
    """None when url is acceptable, else a message. http:// is only allowed for LAN addresses."""
    p = urllib.parse.urlsplit(url.strip())
    if p.scheme not in ("http", "https") or not p.hostname:
        return "Console URL must start with http:// or https://."
    if p.scheme == "http" and not _local_host(p.hostname):
        return ("Console URL must use https:// (http:// would send the enrollment key and the device token "
                "in clear text; it is only allowed for LAN addresses, .local names and localhost).")
    return None


def enrollment_key_problem(key: str):
    """None when key looks like a console enrollment key (urlsafe-base64, 20-128 chars), else a message."""
    if not (ENROLL_KEY_RE.fullmatch(key or "") and 20 <= len(key) <= 128):
        return "Enrollment key must be 20-128 letters, digits, '-' or '_' (copy it from the console's Settings page)."
    return None


def wifi_problems(ssid: str, password: str) -> list:
    """Rules from imager_custom (GKeyFile value syntax, positional flags) and NetworkManager (lengths)."""
    problems = []
    if not ssid:
        problems.append("Wi-Fi SSID is required (or tick Ethernet only).")
    else:
        if ssid in WLAN_FLAGS:
            problems.append(f"Wi-Fi SSID {ssid!r} is not allowed.")
        if "\\" in ssid:
            problems.append("Wi-Fi SSID must not contain a backslash.")
        if ssid != ssid.strip():
            problems.append("Wi-Fi SSID must not start or end with a space.")
        if not 1 <= len(ssid.encode("utf-8")) <= 32:
            problems.append("Wi-Fi SSID must be 1-32 bytes.")
    if password and not HEX64_RE.fullmatch(password):
        n = len(password.encode("utf-8"))
        if not 8 <= n <= 63:
            problems.append("Wi-Fi password must be 8-63 characters (or a 64-digit hex key); "
                            "leave it empty for an open network.")
    return problems


def validate_cfg(cfg: dict) -> list:
    """Every rule a card configuration must satisfy; returns a list of problems (empty when fine)."""
    c = dict(DEFAULTS)
    c.update(cfg)
    problems = []
    for key, val in c.items():
        if isinstance(val, str) and ("\n" in val or "\r" in val):
            problems.append(f"{key} must not contain line breaks.")
    if not valid_device_id(c.get("device_id") or ""):
        problems.append("device_id must be lowercase letters, digits and hyphens (1-63 chars, "
                        "no leading or trailing hyphen).")
    user = c.get("username") or ""
    if not USERNAME_RE.fullmatch(user) or user == "root":
        problems.append("Pi username must be 1-32 lowercase letters, digits or hyphens, start with a letter, "
                        "and not be root.")
    if not c.get("password"):
        problems.append("Pi password is required.")
    url_problem = console_url_problem(c.get("console_url") or "")
    if url_problem:
        problems.append(url_problem)
    if not 1 <= len((c.get("name") or "").strip()) <= MAX_NAME_LEN:
        problems.append(f"Device name must be 1-{MAX_NAME_LEN} characters.")
    if c.get("token"):  # a token on the card bypasses enrollment
        if not TOKEN_RE.fullmatch(c["token"]):
            problems.append("Device token must be at least 16 letters, digits, '-' or '_' (as issued by the console).")
    else:
        key_problem = enrollment_key_problem(c.get("enrollment_key") or "")
        if key_problem:
            problems.append(key_problem)
    if not c["ethernet_only"]:
        problems.extend(wifi_problems(c.get("ssid") or "", c.get("wifi_password") or ""))
    country = (c.get("wifi_country") or "").strip().upper()
    if country in COUNTRY_ALIASES:
        problems.append(f"Wi-Fi country {country} is not an ISO code: use {COUNTRY_ALIASES[country]}.")
    elif country not in ISO3166:
        problems.append("Wi-Fi country must be a 2-letter ISO 3166 code (e.g. US, GB, DE).")
    if not TIMEZONE_RE.fullmatch(c.get("timezone") or ""):
        problems.append("Timezone must look like Area/City (e.g. Europe/London) or UTC.")
    if not KEYMAP_RE.fullmatch(c.get("keymap") or ""):
        problems.append("Keyboard layout must be 2-8 lowercase letters (e.g. us, gb, de).")
    if c.get("ssh_pubkey") and not SSH_PUBKEY_RE.fullmatch(c["ssh_pubkey"]):
        problems.append("SSH public key must be one ssh-ed25519 line.")
    problems.extend(static_ip_problems(c.get("static_ip") or "", c.get("gateway") or ""))
    return problems


def static_ip_problems(static_ip: str, gateway: str) -> list:
    """Empty static_ip means DHCP (gateway ignored); otherwise IPv4/prefix plus a gateway in that network."""
    if not static_ip:
        return []
    try:
        iface = ipaddress.IPv4Interface(static_ip)
        if iface.network.prefixlen > 30 or iface.ip in (iface.network.network_address, iface.network.broadcast_address):
            raise ValueError
    except ValueError:
        return ["Static IP must be an IPv4 address with a prefix (e.g. 192.168.1.50/24)."]
    try:
        if ipaddress.IPv4Address(gateway) not in iface.network:
            raise ValueError
    except ValueError:
        return [f"Gateway must be an IPv4 address in {iface.network} (e.g. {iface.network.network_address + 1})."]
    return []


def _cfg(cfg: dict) -> dict:
    problems = validate_cfg(cfg)
    if problems:
        raise ValueError(" ".join(problems))
    full = dict(DEFAULTS)
    full.update(cfg)
    full["wifi_country"] = full["wifi_country"].strip().upper()
    return full


def wifi_psk(ssid: str, password: str) -> str:
    """What goes into psk=: a 64-hex key as is, otherwise PBKDF2 as Raspberry Pi Imager does it, so the
    plaintext passphrase never reaches the card and GKeyFile escaping cannot mangle it."""
    if not password or HEX64_RE.fullmatch(password):
        return password
    return hashlib.pbkdf2_hmac("sha1", password.encode("utf-8"), ssid.encode("utf-8"), 4096, 32).hex()


def render_firstrun(cfg: dict) -> str:
    c = _cfg(cfg)
    q = shlex.quote
    dev = q(c["device_id"])
    user = q(c["username"])
    lines = [
        "#!/bin/bash",
        "# Projection5000 first-boot configuration. Runs once as root, then wipes itself.",
        "set +e",
        'BOOT=/boot/firmware; [ -d "$BOOT" ] || BOOT=/boot',
        'exec >>"$BOOT/firstrun.log" 2>&1',
        'echo "firstrun start $(date)"',
        "IMAGER=/usr/lib/raspberrypi-sys-mods/imager_custom",
        "FAILS=0",
        "# run CMD ARGS...: log the exit status of each step (only the first two words, never the secrets).",
        'run() { "$@"; local rc=$?; echo "  $1 ${2:-} -> rc=$rc"; [ "$rc" -eq 0 ] || FAILS=$((FAILS + 1)); return $rc; }',
        "# wipe FILE: zero-fill in place before unlinking (rm alone leaves the bytes in free FAT clusters).",
        'wipe() { [ -s "$1" ] && dd if=/dev/zero of="$1" bs="$(stat -c %s "$1")" count=1 conv=notrunc 2>/dev/null; rm -f "$1"; }',
        "# finish: a function, so bash has parsed it completely before firstrun.sh wipes itself.",
        "finish() {",
        '  wipe "$BOOT/firstrun.sh"',
        "  sync",
        '  echo "firstrun done $(date): $FAILS step(s) failed"',
        '  [ "$FAILS" -eq 0 ] && touch "$BOOT/firstrun.ok"',
        "  exit 0",
        "}",
        "",
        "# no login prompt on the HDMI console, ever (SSH and the serial console are unaffected)",
        "systemctl mask --now getty@tty1.service 2>/dev/null",
        *SCREEN_FN,
        "screen_init",
        'screen "Setting up this projector" "Step 1 of 4: first start"',
        "",
        "# hostname",
        'if [ -x "$IMAGER" ]; then',
        f'  run "$IMAGER" set_hostname {dev}',
        "else",
        '  CURRENT_HOSTNAME=$(tr -d " \\t\\n\\r" </etc/hostname)',
        f"  echo {dev} >/etc/hostname",
        f'  run sed -i "s/127.0.1.1.*$CURRENT_HOSTNAME/127.0.1.1\\t{c["device_id"]}/g" /etc/hosts',
        "fi",
        "",
        "# user",
        f"HASH=$(printf %s {q(c['password'])} | openssl passwd -6 -stdin)",
        '[ -n "$HASH" ] || { echo "  openssl passwd -> failed"; FAILS=$((FAILS + 1)); }',
        "if [ -f /usr/lib/userconf-pi/userconf ]; then",
        f'  run /usr/lib/userconf-pi/userconf {user} "$HASH"',
        "else",
        f"  id -u {user} >/dev/null 2>&1 || run useradd -m -G sudo,video,render,audio,input,tty -s /bin/bash {user}",
        f'  printf "%s:%s\\n" {user} "$HASH" | run chpasswd -e',
        "  systemctl disable userconfig 2>/dev/null",
        "  rm -f /etc/xdg/autostart/piwiz.desktop",
        "fi",
        "",
    ]
    if c["ssh"]:
        lines += [
            "# ssh",
            'if [ -x "$IMAGER" ]; then run "$IMAGER" enable_ssh; else run systemctl enable ssh; fi',
        ]
        if c["ssh_pubkey"]:
            lines += [
                "# key-only login: the flasher's public key, password authentication off",
                f'HOME_DIR=$(getent passwd {user} | cut -d: -f6); [ -n "$HOME_DIR" ] || HOME_DIR=/home/{c["username"]}',
                f'run install -d -m 0700 -o {user} -g {user} "$HOME_DIR/.ssh"',
                f'printf "%s\\n" {q(c["ssh_pubkey"])} >"$HOME_DIR/.ssh/authorized_keys"',
                f'run chown {user}:{user} "$HOME_DIR/.ssh/authorized_keys"',
                'run chmod 0600 "$HOME_DIR/.ssh/authorized_keys"',
                "mkdir -p /etc/ssh/sshd_config.d",
                'printf "%s\\n" "PasswordAuthentication no" "KbdInteractiveAuthentication no" '
                ">/etc/ssh/sshd_config.d/projection5000.conf",
            ]
        lines.append("")
    lines += _wired_lines(c) if c["ethernet_only"] else _wifi_lines(c)
    lines += [
        "# locale",
        'if [ -x "$IMAGER" ]; then',
        f'  run "$IMAGER" set_keymap {q(c["keymap"])}',
        f'  run "$IMAGER" set_timezone {q(c["timezone"])}',
        "else",
        f"  run raspi-config nonint do_configure_keyboard {q(c['keymap'])}",
        f"  run timedatectl set-timezone {q(c['timezone'])}",
        "fi",
        "",
        "# provisioning service: installs the player once the network is up. The script (device token)",
        "# and the player files move off the FAT partition now, root-only.",
        'run install -m 0700 "$BOOT/projection5000-provision.sh" /usr/local/sbin/projection5000-provision.sh',
        f'run install -m 0600 "$BOOT/{PLAYER_ARCHIVE}" /opt/{PLAYER_ARCHIVE}',
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
        "run systemctl enable projection5000-provision.service",
        "",
        "# cleanup: never run again, and leave no secrets on the FAT partition",
        'wipe "$BOOT/projection5000-provision.sh"',
        f'rm -f "$BOOT/{PLAYER_ARCHIVE}"',
        # Token-wise, as raspberrypi-sys-mods' imager_fixup does: raspi-config appends
        # cfg80211.ieee80211_regdom=CC after our args and it must survive.
        "sed -i -E 's/ ?systemd\\.(run|run_success_action|unit)=[^ ]*//g' \"$BOOT/cmdline.txt\"",
        "finish",
        "",
    ]
    return "\n".join(lines)


def _ipv4_lines(c: dict) -> list:
    """NetworkManager keyfile [ipv4]/[ipv6] sections: DHCP, or the static address with the gateway as DNS."""
    if not c["static_ip"]:
        return ["[ipv4]", "method=auto", "", "[ipv6]", "method=auto"]
    return ["[ipv4]", "method=manual", f"address1={c['static_ip']},{c['gateway']}", f"dns={c['gateway']};", "",
            "[ipv6]", "method=auto"]


def _keyfile_lines(name: str, nm: list) -> list:
    path = f"/etc/NetworkManager/system-connections/{name}.nmconnection"
    return ["mkdir -p /etc/NetworkManager/system-connections", f"cat >{path} <<'NMEOF'", *nm, "NMEOF",
            f"chmod 0600 {path}"]


def _wifi_lines(c: dict) -> list:
    q = shlex.quote
    hidden_flag = "-h " if c["wifi_hidden"] else ""
    psk = wifi_psk(c["ssid"], c.get("wifi_password") or "")
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
    nm += ["", *_ipv4_lines(c)]
    keyfile = [
        *_keyfile_lines("preconfigured", nm),
        "rfkill unblock wifi",
        f"run raspi-config nonint do_wifi_country {q(c['wifi_country'])}",
    ]
    if c["static_ip"]:  # imager_custom set_wlan only knows DHCP: always write the keyfile
        return ["# wifi (static IP)", *keyfile, ""]
    return [
        "# wifi",
        'if [ -x "$IMAGER" ]; then',
        f'  run "$IMAGER" set_wlan {hidden_flag}{q(c["ssid"])} {q(psk)} {q(c["wifi_country"])}',
        "else",
        *keyfile,
        "fi",
        "",
    ]


def _wired_lines(c: dict) -> list:
    """Ethernet: nothing to do for DHCP; a static address needs its own keyfile."""
    if not c["static_ip"]:
        return []
    nm = ["[connection]", "id=wired-static", "type=ethernet", "", *_ipv4_lines(c)]
    return ["# ethernet (static IP)", *_keyfile_lines("wired-static", nm), ""]


def render_provision(cfg: dict) -> str:
    """The boot-time installer. With a device token on the card it installs straight away; otherwise it
    first trades the enrollment key for a token at POST /api/enroll (the same device_id re-enrolls the
    same device, so a re-flashed card keeps its identity on the console). cfg["with_wyze"] (the console's
    /api/operator/enrollment reported wyze_configured) adds --with-wyze: Docker + the Wyze bridge unit go
    on at install; the credentials come from the console once the player runs (camera zero-config)."""
    c = _cfg(cfg)
    q = shlex.quote
    console = c["console_url"].rstrip("/")
    install_flags = " --with-wyze" if c.get("with_wyze") else ""
    if c.get("token"):
        secret = [f"DEVICE_TOKEN={q(c['token'])}", 'CMS_URL="$CONSOLE"']
    else:
        secret = [f"DEVICE_NAME={q(c['name'].strip())}", f"ENROLL_KEY={q(c['enrollment_key'])}",
                  "DEVICE_TOKEN=", "CMS_URL="]
    body = ('import json, os; print(json.dumps({"key": os.environ["ENROLL_KEY"], '
            '"device_id": os.environ["DEVICE_ID"], "name": os.environ["DEVICE_NAME"]}))')
    lines = [
        "#!/bin/bash",
        "# Projection5000 provisioning. Runs on every boot until the player is installed, then disables itself.",
        "set +e",
        "exec >>/var/log/projection5000-provision.log 2>&1",
        f"CONSOLE={q(console)}",
        f"DEVICE_ID={q(c['device_id'])}",
        *secret,
        f"SRC=/opt/{PLAYER_ARCHIVE}",
        'echo "provision start $(date)"',
        *SCREEN_FN,
        "screen_init",
        'screen "Setting up this projector" "Step 2 of 4: joining the network"',
        "",
        "# enroll: POST /api/enroll with the enrollment key; sets DEVICE_TOKEN and CMS_URL. The JSON body is",
        "# built by python3 (proper escaping) and piped to curl, so the key never appears on a command line.",
        "enroll() {",
        "  local out rc",
        "  out=$(mktemp) || return 1",
        f'  ENROLL_KEY="$ENROLL_KEY" DEVICE_ID="$DEVICE_ID" DEVICE_NAME="$DEVICE_NAME" python3 -c {q(body)} \\',
        '    | curl -fsS --max-time 30 -X POST "$CONSOLE/api/enroll" -H "content-type: application/json" -d @- -o "$out"',
        "  rc=$?",
        '  if [ "$rc" -eq 0 ]; then',
        "    DEVICE_TOKEN=$(python3 -c 'import json, sys; print(json.load(sys.stdin)[\"token\"])' <\"$out\")",
        "    CMS_URL=$(python3 -c 'import json, sys; print(json.load(sys.stdin).get(\"cms_url\") or \"\")' <\"$out\")",
        '    [ -n "$CMS_URL" ] || CMS_URL="$CONSOLE"',
        "  fi",
        '  rm -f "$out"',
        '  if [ "$rc" -ne 0 ] || [ -z "$DEVICE_TOKEN" ]; then',
        "    DEVICE_TOKEN=",
        '    echo "enrollment failed (curl rc=$rc). HTTP 401 means the console\'s enrollment key was rotated: re-flash the card."',
        '    REASON="The console did not accept this projector (enrollment failed)."',
        "    return 1",
        "  fi",
        '  echo "enrolled as $DEVICE_ID at $CMS_URL"',
        "}",
        "",
        "# The image's clock is stale until NTP syncs; TLS and apt both need the real time.",
        "for _ in $(seq 1 24); do",
        '  [ "$(timedatectl show -p NTPSynchronized --value 2>/dev/null)" = yes ] && break',
        "  sleep 5",
        "done",
        'if [ "$(timedatectl show -p NTPSynchronized --value 2>/dev/null)" != yes ]; then',
        '  D=$(curl -sSk --max-time 10 -o /dev/null -D - "$CONSOLE/api/health" | tr -d "\\r" | sed -n "s/^[Dd]ate: //p")',
        '  [ -n "$D" ] && date -s "$D" >/dev/null && echo "clock set from console: $D"',
        "fi",
        'echo "clock: $(date), NTP synced: $(timedatectl show -p NTPSynchronized --value 2>/dev/null)"',
        "",
        "WAITS=0",
        'until curl -fsS --max-time 10 "$CONSOLE/api/health" >/dev/null; do',
        '  echo "waiting for console at $CONSOLE"',
        "  WAITS=$((WAITS + 1))",
        '  [ "$WAITS" -lt 8 ] || screen "Setting up this projector" "Step 2 of 4: joining the network" \\',
        '    "This is taking longer than usual: check the Wi-Fi name and password."',
        "  sleep 15",
        "done",
        "",
        "TRIES=0",
        "while :; do",
        "  TRIES=$((TRIES + 1))",
        '  echo "install attempt $TRIES $(date)"',
        '  REASON="The player did not install."',
        '  if { [ -n "$DEVICE_TOKEN" ] || enroll; } \\',
        "     && rm -rf /opt/projection5000-src && mkdir -p /opt/projection5000-src \\",
        '     && tar -xzf "$SRC" -C /opt/projection5000-src \\',
        '     && (cd /opt/projection5000-src/player && DEVICE_ID="$DEVICE_ID" DEVICE_TOKEN="$DEVICE_TOKEN" '
        f'CMS_URL="$CMS_URL" bash deploy/install-player.sh{install_flags}); then',
        '    echo "install succeeded $(date)"',
        "    systemctl disable projection5000-provision.service",
        '    rm -f /usr/local/sbin/projection5000-provision.sh "$SRC"',
        '    screen "Ready. Waiting for the first video."',
        "    exit 0",
        "  fi",
        '  if [ "$TRIES" -ge 20 ]; then',
        '    echo "GAVE UP after $TRIES attempts. Fix the problem above, then run: sudo systemctl start projection5000-provision.service"',
        "    # The user has no SSH: park a copy of the log on the FAT partition so it can be read from any PC.",
        '    BOOT=/boot/firmware; [ -d "$BOOT" ] || BOOT=/boot',
        '    cp /var/log/projection5000-provision.log "$BOOT/setup-failed.log" 2>/dev/null; sync',
        '    screen "Setup did not finish." "$REASON" "Log: /boot/firmware/setup-failed.log"',
        "    exit 1",
        "  fi",
        '  echo "attempt $TRIES failed, retrying in 60 s"',
        '  screen "Setting up this projector" "Step 2 of 4: joining the network" "Try $TRIES did not finish; trying again in a minute."',
        "  sleep 60",
        "done",
        "",
    ]
    return "\n".join(lines)


def patch_cmdline(text: str) -> str:
    """Append the firstrun boot args to cmdline.txt (one line), replacing any earlier ones."""
    words = [w for w in text.split()
             if not w.startswith(("systemd.run=", "systemd.run_success_action=", "systemd.unit="))]
    if not words:
        raise ValueError("cmdline.txt is empty: is this a Raspberry Pi OS image?")
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
        "enrollment_key": "sample-enrollment-key_0123456789",
        "token": "",
        "ssh_pubkey": "",
        "static_ip": "",
        "gateway": "",
    }
