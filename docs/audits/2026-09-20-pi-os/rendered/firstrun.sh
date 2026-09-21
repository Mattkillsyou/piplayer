#!/bin/bash
# Projection5000 first-boot configuration. Runs once as root, then wipes itself.
set +e
BOOT=/boot/firmware; [ -d "$BOOT" ] || BOOT=/boot
exec >>"$BOOT/firstrun.log" 2>&1
echo "firstrun start $(date)"
IMAGER=/usr/lib/raspberrypi-sys-mods/imager_custom
FAILS=0
# run CMD ARGS...: log the exit status of each step (only the first two words, never the secrets).
run() { "$@"; local rc=$?; echo "  $1 ${2:-} -> rc=$rc"; [ "$rc" -eq 0 ] || FAILS=$((FAILS + 1)); return $rc; }
# wipe FILE: zero-fill in place before unlinking (rm alone leaves the bytes in free FAT clusters).
wipe() { [ -s "$1" ] && dd if=/dev/zero of="$1" bs="$(stat -c %s "$1")" count=1 conv=notrunc 2>/dev/null; rm -f "$1"; }
# finish: a function, so bash has parsed it completely before firstrun.sh wipes itself.
finish() {
  wipe "$BOOT/firstrun.sh"
  sync
  echo "firstrun done $(date): $FAILS step(s) failed"
  [ "$FAILS" -eq 0 ] && touch "$BOOT/firstrun.ok"
  exit 0
}

# no login prompt on the HDMI console, ever (SSH and the serial console are unaffected)
systemctl mask --now getty@tty1.service 2>/dev/null
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
screen_init
screen "Setting up this projector" "Step 1 of 4: first start"

# hostname
if [ -x "$IMAGER" ]; then
  run "$IMAGER" set_hostname lobby-projector
else
  CURRENT_HOSTNAME=$(tr -d " \t\n\r" </etc/hostname)
  echo lobby-projector >/etc/hostname
  run sed -i "s/127.0.1.1.*$CURRENT_HOSTNAME/127.0.1.1\tlobby-projector/g" /etc/hosts
fi

# user
HASH=$(printf %s 'correct horse battery' | openssl passwd -6 -stdin)
[ -n "$HASH" ] || { echo "  openssl passwd -> failed"; FAILS=$((FAILS + 1)); }
if [ -f /usr/lib/userconf-pi/userconf ]; then
  run /usr/lib/userconf-pi/userconf projector-admin "$HASH"
else
  id -u projector-admin >/dev/null 2>&1 || run useradd -m -G sudo,video,render,audio,input,tty -s /bin/bash projector-admin
  printf "%s:%s\n" projector-admin "$HASH" | run chpasswd -e
  systemctl disable userconfig 2>/dev/null
  rm -f /etc/xdg/autostart/piwiz.desktop
fi

# ssh
if [ -x "$IMAGER" ]; then run "$IMAGER" enable_ssh; else run systemctl enable ssh; fi
# key-only login: the flasher's public key, password authentication off
HOME_DIR=$(getent passwd projector-admin | cut -d: -f6); [ -n "$HOME_DIR" ] || HOME_DIR=/home/projector-admin
run install -d -m 0700 -o projector-admin -g projector-admin "$HOME_DIR/.ssh"
printf "%s\n" 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleKeyExampleKeyExampleKeyExampleKey flasher' >"$HOME_DIR/.ssh/authorized_keys"
run chown projector-admin:projector-admin "$HOME_DIR/.ssh/authorized_keys"
run chmod 0600 "$HOME_DIR/.ssh/authorized_keys"
mkdir -p /etc/ssh/sshd_config.d
printf "%s\n" "PasswordAuthentication no" "KbdInteractiveAuthentication no" >/etc/ssh/sshd_config.d/projection5000.conf

# wifi
if [ -x "$IMAGER" ]; then
  run "$IMAGER" set_wlan 'Venue WiFi' acb6a28ec1f76601c089083184108b2ca47cbda4b4e35e7afe60e1dfadcadead US
else
mkdir -p /etc/NetworkManager/system-connections
cat >/etc/NetworkManager/system-connections/preconfigured.nmconnection <<'NMEOF'
[connection]
id=preconfigured
type=wifi

[wifi]
mode=infrastructure
ssid=Venue WiFi

[wifi-security]
key-mgmt=wpa-psk
psk=acb6a28ec1f76601c089083184108b2ca47cbda4b4e35e7afe60e1dfadcadead

[ipv4]
method=auto

[ipv6]
method=auto
NMEOF
chmod 0600 /etc/NetworkManager/system-connections/preconfigured.nmconnection
rfkill unblock wifi
run raspi-config nonint do_wifi_country US
fi

# locale
if [ -x "$IMAGER" ]; then
  run "$IMAGER" set_keymap us
  run "$IMAGER" set_timezone America/Los_Angeles
else
  run raspi-config nonint do_configure_keyboard us
  run timedatectl set-timezone America/Los_Angeles
fi

# provisioning service: installs the player once the network is up. The script (device token)
# and the player files move off the FAT partition now, root-only.
run install -m 0700 "$BOOT/projection5000-provision.sh" /usr/local/sbin/projection5000-provision.sh
run install -m 0600 "$BOOT/projection5000-player.tar.gz" /opt/projection5000-player.tar.gz
cat >/etc/systemd/system/projection5000-provision.service <<'EOF'
[Unit]
Description=Projection5000 first-boot install
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/local/sbin/projection5000-provision.sh

[Install]
WantedBy=multi-user.target
EOF
run systemctl enable projection5000-provision.service

# cleanup: never run again, and leave no secrets on the FAT partition
wipe "$BOOT/projection5000-provision.sh"
rm -f "$BOOT/projection5000-player.tar.gz"
sed -i -E 's/ ?systemd\.(run|run_success_action|unit)=[^ ]*//g' "$BOOT/cmdline.txt"
finish
