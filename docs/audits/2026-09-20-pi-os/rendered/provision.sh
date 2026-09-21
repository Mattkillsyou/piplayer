#!/bin/bash
# Projection5000 provisioning. Runs on every boot until the player is installed, then disables itself.
set +e
exec >>/var/log/projection5000-provision.log 2>&1
CONSOLE=https://projectors.photogen5000.com
DEVICE_ID=lobby-projector
DEVICE_NAME='Lobby Projector'
ENROLL_KEY=sample-enrollment-key_0123456789
DEVICE_TOKEN=
CMS_URL=
SRC=/opt/projection5000-player.tar.gz
echo "provision start $(date)"
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
screen "Setting up this projector" "Step 2 of 4: joining the network"

# enroll: POST /api/enroll with the enrollment key; sets DEVICE_TOKEN and CMS_URL. The JSON body is
# built by python3 (proper escaping) and piped to curl, so the key never appears on a command line.
enroll() {
  local out rc
  out=$(mktemp) || return 1
  ENROLL_KEY="$ENROLL_KEY" DEVICE_ID="$DEVICE_ID" DEVICE_NAME="$DEVICE_NAME" python3 -c 'import json, os; print(json.dumps({"key": os.environ["ENROLL_KEY"], "device_id": os.environ["DEVICE_ID"], "name": os.environ["DEVICE_NAME"]}))' \
    | curl -fsS --max-time 30 -X POST "$CONSOLE/api/enroll" -H "content-type: application/json" -d @- -o "$out"
  rc=$?
  if [ "$rc" -eq 0 ]; then
    DEVICE_TOKEN=$(python3 -c 'import json, sys; print(json.load(sys.stdin)["token"])' <"$out")
    CMS_URL=$(python3 -c 'import json, sys; print(json.load(sys.stdin).get("cms_url") or "")' <"$out")
    [ -n "$CMS_URL" ] || CMS_URL="$CONSOLE"
  fi
  rm -f "$out"
  if [ "$rc" -ne 0 ] || [ -z "$DEVICE_TOKEN" ]; then
    DEVICE_TOKEN=
    echo "enrollment failed (curl rc=$rc). HTTP 401 means the console's enrollment key was rotated: re-flash the card."
    REASON="The console did not accept this projector (enrollment failed)."
    return 1
  fi
  echo "enrolled as $DEVICE_ID at $CMS_URL"
}

# The image's clock is stale until NTP syncs; TLS and apt both need the real time.
for _ in $(seq 1 24); do
  [ "$(timedatectl show -p NTPSynchronized --value 2>/dev/null)" = yes ] && break
  sleep 5
done
if [ "$(timedatectl show -p NTPSynchronized --value 2>/dev/null)" != yes ]; then
  D=$(curl -sSk --max-time 10 -o /dev/null -D - "$CONSOLE/api/health" | tr -d "\r" | sed -n "s/^[Dd]ate: //p")
  [ -n "$D" ] && date -s "$D" >/dev/null && echo "clock set from console: $D"
fi
echo "clock: $(date), NTP synced: $(timedatectl show -p NTPSynchronized --value 2>/dev/null)"

WAITS=0
until curl -fsS --max-time 10 "$CONSOLE/api/health" >/dev/null; do
  echo "waiting for console at $CONSOLE"
  WAITS=$((WAITS + 1))
  [ "$WAITS" -lt 8 ] || screen "Setting up this projector" "Step 2 of 4: joining the network" \
    "This is taking longer than usual: check the Wi-Fi name and password."
  sleep 15
done

TRIES=0
while :; do
  TRIES=$((TRIES + 1))
  echo "install attempt $TRIES $(date)"
  REASON="The player did not install."
  if { [ -n "$DEVICE_TOKEN" ] || enroll; } \
     && rm -rf /opt/projection5000-src && mkdir -p /opt/projection5000-src \
     && tar -xzf "$SRC" -C /opt/projection5000-src \
     && (cd /opt/projection5000-src/player && DEVICE_ID="$DEVICE_ID" DEVICE_TOKEN="$DEVICE_TOKEN" CMS_URL="$CMS_URL" bash deploy/install-player.sh --with-wyze); then
    echo "install succeeded $(date)"
    systemctl disable projection5000-provision.service
    rm -f /usr/local/sbin/projection5000-provision.sh "$SRC"
    screen "Ready. Waiting for the first video."
    exit 0
  fi
  if [ "$TRIES" -ge 20 ]; then
    echo "GAVE UP after $TRIES attempts. Fix the problem above, then run: sudo systemctl start projection5000-provision.service"
    # The user has no SSH: park a copy of the log on the FAT partition so it can be read from any PC.
    BOOT=/boot/firmware; [ -d "$BOOT" ] || BOOT=/boot
    cp /var/log/projection5000-provision.log "$BOOT/setup-failed.log" 2>/dev/null; sync
    screen "Setup did not finish." "$REASON" "Log: /boot/firmware/setup-failed.log"
    exit 1
  fi
  echo "attempt $TRIES failed, retrying in 60 s"
  screen "Setting up this projector" "Step 2 of 4: joining the network" "Try $TRIES did not finish; trying again in a minute."
  sleep 60
done
