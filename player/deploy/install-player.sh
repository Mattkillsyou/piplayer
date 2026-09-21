#!/usr/bin/env bash
# install-player.sh -- install the PiPlayer player on Raspberry Pi OS (Bookworm or Trixie).
# Run from the piplayer/player directory:
#   DEVICE_ID=lobby-projector DEVICE_TOKEN=xxxx CMS_URL=http://controller:8080 sudo -E bash deploy/install-player.sh
# Remove the player again (units, sudoers drop-in, code, data, config, user;
# re-enables the tty1 login prompt; leaves a co-located CMS in /opt/piplayer/cms alone):
#   sudo bash deploy/install-player.sh --uninstall
# Optional room camera via a Wyze Cam (installs Docker and the unofficial
# mrlt8/wyze-bridge container as projector-wyze-bridge.service):
#   DEVICE_ID=... DEVICE_TOKEN=... CMS_URL=... \
#   WYZE_EMAIL=.. WYZE_PASSWORD=.. WYZE_API_ID=.. WYZE_API_KEY=.. WYZE_CAMERA="Lobby Cam" sudo -E bash deploy/install-player.sh --with-wyze
# The API id/key come from the Wyze developer portal. Without the WYZE_* vars
# no credentials file is written: the player daemon fetches them from the
# console (camera zero-config) into /var/lib/projector-player/wyze.env (keys:
# WYZE_EMAIL, WYZE_PASSWORD, API_ID, API_KEY) and starts the bridge itself.
# Upgrade the code in place (deploy/update-player.sh runs this from a fresh
# checkout; also fine by hand after a git pull). With an existing config.toml
# the DEVICE_* vars are not needed and config, wyze.env and data are kept;
# nothing is restarted, the caller does that:
#   sudo bash deploy/install-player.sh --upgrade && sudo systemctl restart projector-player.service
# /opt/piplayer/player/RELEASE gets the checkout's sha (PIPLAYER_RELEASE_SHA or
# git rev-parse) so update-player.sh can tell "already at <sha>".
# cloudflared (Cloudflare Tunnel client) is always installed, from the
# Cloudflare apt repo or the GitHub .deb, as projector-cloudflared.service: it
# stays skipped until the daemon writes /var/lib/projector-player/tunnel.token
# from the console's manifest (live camera view without a hand-made tunnel).
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
    echo "Please run as root (sudo -E bash deploy/install-player.sh)" >&2
    exit 1
fi

INSTALL_DIR="/opt/piplayer/player"
DATA_DIR="/var/lib/projector-player"
ETC_DIR="/etc/projector-player"
USER_NAME="projector"
CLOUDFLARED_KEYRING="/usr/share/keyrings/cloudflare-main.gpg"
CLOUDFLARED_LIST="/etc/apt/sources.list.d/cloudflared.list"
CLOUDFLARED_BIN="/usr/bin/cloudflared"
# the camera bridge (Docker + the arm64-only wyze-bridge image) needs a 64-bit
# OS and this much RAM (MemTotal in kB; 1 GB boards report about 935000 with
# the default gpu_mem). player/pi_info.py applies the same rule.
CAMERA_MIN_MEM_KB=900000

# What kind of Pi this is: PI_ARCH (dpkg arch: arm64 / armhf), PI_MACHINE
# (uname -m: aarch64 / armv7l / armv6l), PI_MEM_KB / PI_MEM_MB, PI_MODEL (the
# board string), PI_SOC (device-tree compatible, e.g. "brcm,bcm2837") and
# CAMERA_SUPPORTED (1 / 0). PROC_ROOT is only overridden by the tests.
pi_caps() {
    local proc="${PROC_ROOT:-/proc}"
    PI_ARCH="$(dpkg --print-architecture 2>/dev/null || echo unknown)"
    PI_MACHINE="$(uname -m 2>/dev/null || echo unknown)"
    PI_MEM_KB="$(awk '/^MemTotal:/ {print $2}' "${proc}/meminfo" 2>/dev/null || true)"
    PI_MEM_KB="${PI_MEM_KB:-0}"
    PI_MEM_MB=$(( PI_MEM_KB / 1024 ))
    PI_MODEL="$(tr -d '\0' < "${proc}/device-tree/model" 2>/dev/null || true)"
    PI_MODEL="${PI_MODEL:-unknown board}"
    PI_SOC="$(tr '\0' ' ' < "${proc}/device-tree/compatible" 2>/dev/null || true)"
    CAMERA_SUPPORTED=0
    if [[ "${PI_ARCH}" == arm64 && "${PI_MEM_KB}" -ge "${CAMERA_MIN_MEM_KB}" ]]; then
        CAMERA_SUPPORTED=1
    fi
}

# The first-boot setup screen on the HDMI console (a copy of firstboot.SCREEN_FN in the flasher; a no-op
# without /dev/tty1). The player's status screen covers it as soon as projector-player starts.
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

WITH_WYZE=0
UNINSTALL=0
UPGRADE=0
for arg in "$@"; do
    case "${arg}" in
        --uninstall) UNINSTALL=1 ;;
        --with-wyze) WITH_WYZE=1 ;;
        --upgrade) UPGRADE=1 ;;
        *)
            echo "Unknown argument: ${arg} (supported: --uninstall, --with-wyze, --upgrade)" >&2
            exit 1
            ;;
    esac
done

if [[ "${UNINSTALL}" == 1 ]]; then
    echo "==> Stopping and disabling services"
    # The wyze unit only exists on --with-wyze installs; systemd refuses the whole
    # disable call when any named unit is missing, so handle it separately.
    systemctl disable --now projector-player.service projector-mpv.service 2>/dev/null || true
    if [[ -f /etc/systemd/system/projector-wyze-bridge.service ]]; then
        systemctl disable --now projector-wyze-bridge.service 2>/dev/null || true
    fi
    systemctl disable --now projector-player-postcheck.timer 2>/dev/null || true
    systemctl disable --now projector-cloudflared.service 2>/dev/null || true
    rm -f /etc/systemd/system/projector-cloudflared.service
    rm -f /etc/systemd/system/projector-player.service /etc/systemd/system/projector-mpv.service         /etc/systemd/system/projector-wyze-bridge.service \
        /etc/systemd/system/projector-player-postcheck.service /etc/systemd/system/projector-player-postcheck.timer
    systemctl daemon-reload
    systemctl reset-failed projector-player.service projector-mpv.service 2>/dev/null || true
    systemctl reset-failed projector-wyze-bridge.service projector-cloudflared.service 2>/dev/null || true
    # cloudflared itself is left installed, like Docker.
    if command -v docker >/dev/null 2>&1; then
        docker rm -f projector-wyze-bridge >/dev/null 2>&1 || true
        # Docker itself is left installed.
    fi

    echo "==> Removing sudoers drop-in"
    rm -f /etc/sudoers.d/projector-player

    echo "==> Re-enabling the login prompt on tty1"
    systemctl unmask getty@tty1.service || true
    systemctl enable getty@tty1.service || true
    systemctl start getty@tty1.service || true

    echo "==> Removing player files (${INSTALL_DIR}, ${DATA_DIR}, ${ETC_DIR})"
    rm -rf "${INSTALL_DIR}" "${INSTALL_DIR}.prev" /opt/piplayer/src-* "${DATA_DIR}" "${ETC_DIR}" /tmp/projector-mpv.sock
    # /opt/piplayer/cms (a co-located controller) is intentionally left in place.
    rmdir /opt/piplayer 2>/dev/null || true

    if id -u "${USER_NAME}" >/dev/null 2>&1; then
        echo "==> Removing user '${USER_NAME}'"
        userdel "${USER_NAME}" || true
    fi
    echo "==> Player removed."
    exit 0
fi

# --upgrade with a config.toml in place keeps it and needs no DEVICE_* vars
KEEP_CONFIG=0
# an upgrade refreshes the wyze unit too when it is installed
if [[ "${UPGRADE}" == 1 && -f /etc/systemd/system/projector-wyze-bridge.service ]]; then
    WITH_WYZE=1
fi
if [[ "${UPGRADE}" == 1 && -f "${ETC_DIR}/config.toml" ]]; then
    KEEP_CONFIG=1
else
    : "${DEVICE_ID:?DEVICE_ID env var is required}"
    : "${DEVICE_TOKEN:?DEVICE_TOKEN env var is required}"
    : "${CMS_URL:?CMS_URL env var is required}"
fi

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

pi_caps
echo "==> This is a ${PI_MODEL} (${PI_ARCH}, ${PI_MEM_MB} MB)"
if [[ "${WITH_WYZE}" == 1 && "${CAMERA_SUPPORTED}" == 0 ]]; then
    # WITH_WYZE=0 skips Docker, the [camera] config, the wyze unit and its start below
    echo "    Camera bridge: not supported on ${PI_MODEL} (${PI_ARCH}, ${PI_MEM_MB} MB); skipping Docker and the Wyze bridge"
    WITH_WYZE=0
fi

echo "==> Installing system dependencies"
if [[ "${UPGRADE}" == 0 ]]; then
    screen_init
    screen "Setting up this projector" "Step 3 of 4: installing the player (about 10 minutes)"
fi
# Runs unattended (provision service on first boot, systemd-run on updates): never wait on a prompt.
export DEBIAN_FRONTEND=noninteractive
# A power cut mid-apt leaves dpkg interrupted and every later apt-get refuses to run: repair first.
dpkg --configure -a || true
apt-get -y -f install || true
apt-get update
# git and rsync are not part of Raspberry Pi OS Lite; both are needed here.
# ffmpeg grabs the room-camera snapshots ([camera] in config.toml).
# v4l-utils brings cec-ctl (projector power over HDMI-CEC).
apt-get install -y git rsync mpv ffmpeg python3 python3-venv python3-pip libgl1 libegl1 v4l-utils

echo "==> Creating user '${USER_NAME}'"
if ! id -u "${USER_NAME}" >/dev/null 2>&1; then
    useradd --system --home-dir "${DATA_DIR}" --shell /bin/bash --create-home "${USER_NAME}"
fi
# Need these groups for --vo=gpu/drm and audio
usermod -aG video,render,input,audio,tty "${USER_NAME}"

echo "==> Creating directories"
mkdir -p "${INSTALL_DIR}" "${DATA_DIR}/media" "${ETC_DIR}" "${DATA_DIR}/.config/mpv"
chown -R "${USER_NAME}:${USER_NAME}" "${DATA_DIR}"
chmod 700 "${DATA_DIR}"   # tunnel.token / wyze.env live here; useradd HOME_MODE is not guaranteed

echo "==> Copying app files from ${SRC_DIR}"
rsync -a --delete \
    --exclude='__pycache__' \
    --exclude='.venv' \
    --exclude='deploy' \
    --exclude='tests' \
    "${SRC_DIR}/" "${INSTALL_DIR}/"

echo "==> Installing mpv kiosk config"
MPV_CONF="${DATA_DIR}/.config/mpv/mpv.conf"
if [[ -f "${MPV_CONF}" ]]; then
    # Per-Pi edits (vo=drm fallback, hwdec=, ao=) must survive an upgrade:
    # leave the file alone and ship the new default next to it.
    cp "${SRC_DIR}/deploy/mpv.conf" "${MPV_CONF}.dist"
    if ! cmp -s "${SRC_DIR}/deploy/mpv.conf" "${MPV_CONF}"; then
        echo "    NOTE: existing ${MPV_CONF} kept; the new default is at ${MPV_CONF}.dist"
    fi
else
    cp "${SRC_DIR}/deploy/mpv.conf" "${MPV_CONF}"
    if [[ "${PI_SOC}" == *bcm283[567]* ]]; then
        # VideoCore IV boards (Pi 0/1/2/3, any arch): auto-safe finds no decoder
        # there; the V4L2 M2M copy path (bcm2835-codec) is the H.264 hardware
        # decoder. Later lines win in mpv.conf, so append rather than edit.
        echo "    ${PI_MODEL}: hwdec=v4l2m2m-copy (VideoCore IV H.264 decoder)"
        printf '\n# %s (VideoCore IV): the V4L2 M2M copy path is the H.264 hardware decoder\nhwdec=v4l2m2m-copy\n' \
            "${PI_MODEL}" >> "${MPV_CONF}"
    fi
fi
chown -R "${USER_NAME}:${USER_NAME}" "${DATA_DIR}/.config"

echo "==> Creating virtualenv"
python3 -m venv "${INSTALL_DIR}/.venv"
"${INSTALL_DIR}/.venv/bin/pip" install --upgrade pip
"${INSTALL_DIR}/.venv/bin/pip" install -r "${INSTALL_DIR}/requirements.txt"
# The install tree stays root-owned (world-readable) so the service cannot rewrite its
# own code or venv (ProtectSystem=full does not cover /opt); only the data dir is its own.
chown -R root:root "${INSTALL_DIR}"
chmod -R a+rX "${INSTALL_DIR}"

echo "==> Installing the update scripts and RELEASE"
# deploy/ is excluded from the rsync above; the daemon runs these two via sudo
mkdir -p "${INSTALL_DIR}/deploy"
cp "${SRC_DIR}/deploy/update-player.sh" "${SRC_DIR}/deploy/update-os.sh" "${INSTALL_DIR}/deploy/"
chmod 755 "${INSTALL_DIR}/deploy/update-player.sh" "${INSTALL_DIR}/deploy/update-os.sh"
RELEASE_SHA="${PIPLAYER_RELEASE_SHA:-$(git -C "${SRC_DIR}" rev-parse HEAD 2>/dev/null || echo unknown)}"
echo "${RELEASE_SHA}" > "${INSTALL_DIR}/RELEASE"
chmod 644 "${INSTALL_DIR}/RELEASE"

if [[ "${KEEP_CONFIG}" == 1 ]]; then
    echo "==> Keeping ${ETC_DIR}/config.toml (upgrade)"
else
echo "==> Writing config file at ${ETC_DIR}/config.toml"
# Keys the installer does not own (poll_interval_seconds, verify_tls, ...)
# are carried over from an existing file so a re-run keeps per-Pi tuning.
KEEP_KEYS=""
if [[ -f "${ETC_DIR}/config.toml" ]]; then
    KEEP_KEYS="$(grep -Ev '^[[:space:]]*(#|$|(device_id|device_token|cms_url|media_dir|manifest_path|mpv_socket)[[:space:]]*=)' "${ETC_DIR}/config.toml" || true)"
fi
if ! grep -Eq '^[[:space:]]*poll_interval_seconds[[:space:]]*=' <<<"${KEEP_KEYS}"; then
    KEEP_KEYS="poll_interval_seconds = 30"$'\n'"${KEEP_KEYS}"
fi
if [[ "${WITH_WYZE}" == 1 && -n "${WYZE_CAMERA:-}" ]] && ! grep -Eq '^[[:space:]]*\[camera\]' <<<"${KEEP_KEYS}"; then
    KEEP_KEYS="${KEEP_KEYS}"$'\n'"[camera]"$'\n'"source = \"wyze\""$'\n'"wyze_camera = \"${WYZE_CAMERA}\""
fi
cat > "${ETC_DIR}/config.toml" <<EOF
device_id = "${DEVICE_ID}"
device_token = "${DEVICE_TOKEN}"
cms_url = "${CMS_URL}"
media_dir = "${DATA_DIR}/media"
manifest_path = "${DATA_DIR}/manifest.json"
mpv_socket = "/tmp/projector-mpv.sock"
${KEEP_KEYS}
EOF
chmod 600 "${ETC_DIR}/config.toml"
chown "${USER_NAME}:${USER_NAME}" "${ETC_DIR}/config.toml"

cat > "${ETC_DIR}/env" <<EOF
PIPLAYER_CONFIG=${ETC_DIR}/config.toml
EOF
chmod 644 "${ETC_DIR}/env"
fi

echo "==> Granting sudoers rights for reboot, mpv/player/wyze-bridge/cloudflared restart and the update scripts"
cat > /etc/sudoers.d/projector-player <<'EOF'
# Allow the projector daemon to reboot the Pi, restart mpv / itself / the Wyze
# bridge (after writing new credentials) / cloudflared (after writing a new
# tunnel token) and run the update scripts on demand (issued from the CMS via
# the device_commands queue).
projector ALL=(ALL) NOPASSWD: /sbin/reboot
projector ALL=(ALL) NOPASSWD: /usr/sbin/reboot
projector ALL=(ALL) NOPASSWD: /bin/systemctl restart projector-mpv.service
projector ALL=(ALL) NOPASSWD: /usr/bin/systemctl restart projector-mpv.service
projector ALL=(ALL) NOPASSWD: /bin/systemctl restart projector-player.service
projector ALL=(ALL) NOPASSWD: /usr/bin/systemctl restart projector-player.service
projector ALL=(ALL) NOPASSWD: /bin/systemctl restart projector-wyze-bridge.service
projector ALL=(ALL) NOPASSWD: /usr/bin/systemctl restart projector-wyze-bridge.service
projector ALL=(ALL) NOPASSWD: /bin/systemctl restart projector-cloudflared.service
projector ALL=(ALL) NOPASSWD: /usr/bin/systemctl restart projector-cloudflared.service
projector ALL=(ALL) NOPASSWD: /opt/piplayer/player/deploy/update-player.sh *
projector ALL=(ALL) NOPASSWD: /usr/bin/bash /opt/piplayer/player/deploy/update-player.sh *
projector ALL=(ALL) NOPASSWD: /opt/piplayer/player/deploy/update-os.sh
projector ALL=(ALL) NOPASSWD: /usr/bin/bash /opt/piplayer/player/deploy/update-os.sh
EOF
chmod 440 /etc/sudoers.d/projector-player
visudo -c -f /etc/sudoers.d/projector-player
# Smoke-test that the daemon will actually be allowed to use them
if ! sudo -n -u "${USER_NAME}" sudo -n -l /bin/systemctl restart projector-mpv.service >/dev/null 2>&1; then
    echo "WARNING: sudo rule check failed for user ${USER_NAME}; remote reboot/restart-mpv may not work" >&2
fi

echo "==> Installing cloudflared (Cloudflare Tunnel client for the console's live camera view)"
if command -v cloudflared >/dev/null 2>&1; then
    echo "    cloudflared already installed ($(cloudflared --version 2>/dev/null | head -n 1))"
elif [[ "${PI_MACHINE}" == armv6l ]]; then
    # Pi Zero / Zero W / Pi 1: the apt repo and the armhf .deb are ARMv7 builds
    # and die with "Illegal instruction" here; Cloudflare's ARMv6-capable build
    # (GOARM=5) only ships as the raw cloudflared-linux-arm binary, so install
    # that (no apt upgrades for it; re-run the installer to refresh it).
    echo "    ${PI_MODEL} is ARMv6: installing the raw cloudflared-linux-arm binary (the .deb would crash)"
    if ! { curl -fsSL -o "${CLOUDFLARED_BIN}.new" "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm" \
            && chmod 755 "${CLOUDFLARED_BIN}.new" && mv "${CLOUDFLARED_BIN}.new" "${CLOUDFLARED_BIN}"; }; then
        rm -f "${CLOUDFLARED_BIN}.new"
        echo "WARNING: cloudflared could not be installed; the console's live camera view needs it (re-run the installer later)" >&2
    fi
else
    # The Cloudflare apt repo first (so apt upgrades keep it current), the .deb
    # from GitHub releases as fallback. Nothing runs until tunnel.token exists.
    CLOUDFLARED_OK=0
    if curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg -o "${CLOUDFLARED_KEYRING}"; then
        echo "deb [signed-by=${CLOUDFLARED_KEYRING}] https://pkg.cloudflare.com/cloudflared any main" > "${CLOUDFLARED_LIST}"
        if apt-get update && apt-get install -y cloudflared; then
            CLOUDFLARED_OK=1
        fi
    fi
    if [[ "${CLOUDFLARED_OK}" == 1 ]]; then
        echo "    cloudflared installed from pkg.cloudflare.com"
    else
        echo "    Cloudflare apt repo failed; installing the .deb from GitHub releases"
        rm -f "${CLOUDFLARED_LIST}" "${CLOUDFLARED_KEYRING}"
        CLOUDFLARED_DEB="$(mktemp --suffix=.deb)"
        if ! { curl -fsSL -o "${CLOUDFLARED_DEB}" "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-$(dpkg --print-architecture).deb"                 && dpkg -i "${CLOUDFLARED_DEB}"; }; then
            # optional feature: an upgrade must not die over it
            echo "WARNING: cloudflared could not be installed; the console's live camera view needs it (re-run the installer later)" >&2
        fi
        rm -f "${CLOUDFLARED_DEB}"
    fi
fi

if [[ "${WITH_WYZE}" == 1 ]]; then
    echo "==> Installing Docker for the Wyze bridge"
    if ! command -v docker >/dev/null 2>&1; then
        curl -fsSL https://get.docker.com | sh
    fi
    systemctl enable --now docker.service
    # Pre-pull the bridge image: the unit's ExecStartPre pull would otherwise
    # run inside the daemon's first `systemctl restart` (30 s budget) on a Pi.
    docker pull mrlt8/wyze-bridge:latest || true

    WYZE_ENV="${DATA_DIR}/wyze.env"
    if [[ -n "${WYZE_EMAIL:-}" && -n "${WYZE_PASSWORD:-}" && -n "${WYZE_API_ID:-}" && -n "${WYZE_API_KEY:-}" ]]; then
        echo "==> Writing Wyze credentials at ${WYZE_ENV}"
        cat > "${WYZE_ENV}" <<EOF
WYZE_EMAIL=${WYZE_EMAIL}
WYZE_PASSWORD=${WYZE_PASSWORD}
API_ID=${WYZE_API_ID}
API_KEY=${WYZE_API_KEY}
EOF
    elif [[ ! -f "${WYZE_ENV}" && -f "${ETC_DIR}/wyze.env" ]]; then
        echo "==> Moving Wyze credentials from ${ETC_DIR}/wyze.env to ${WYZE_ENV}"
        mv "${ETC_DIR}/wyze.env" "${WYZE_ENV}"
    elif [[ ! -f "${WYZE_ENV}" ]]; then
        echo "    no Wyze credentials given: the player fetches them from the console's camera config"
    else
        echo "    existing ${WYZE_ENV} kept"
    fi
    if [[ -f "${WYZE_ENV}" ]]; then
        chmod 600 "${WYZE_ENV}"
        chown "${USER_NAME}:${USER_NAME}" "${WYZE_ENV}"
    fi
fi

echo "==> Installing systemd units"
cp "${SRC_DIR}/deploy/projector-mpv.service" /etc/systemd/system/projector-mpv.service
cp "${SRC_DIR}/deploy/projector-player.service" /etc/systemd/system/projector-player.service
cp "${SRC_DIR}/deploy/projector-cloudflared.service" /etc/systemd/system/projector-cloudflared.service
if [[ "${WITH_WYZE}" == 1 ]]; then
    cp "${SRC_DIR}/deploy/projector-wyze-bridge.service" /etc/systemd/system/projector-wyze-bridge.service
fi
# Post-update check: update-player.sh arms the timer right before it restarts
# the player; 2 min later the service rolls back to /opt/piplayer/player.prev
# when the new daemon is not running or keeps restarting. Not enabled at boot.
cat > /etc/systemd/system/projector-player-postcheck.service <<'EOF'
[Unit]
Description=PiPlayer post-update check (roll back to player.prev if the daemon keeps failing)

[Service]
Type=oneshot
ExecStart=/opt/piplayer/player/deploy/update-player.sh --postcheck
EOF
cat > /etc/systemd/system/projector-player-postcheck.timer <<'EOF'
[Unit]
Description=Run the PiPlayer post-update check 2 min after an update

[Timer]
OnActiveSec=2min
AccuracySec=10s
RemainAfterElapse=no
EOF
systemctl daemon-reload
systemctl enable projector-mpv.service projector-player.service projector-cloudflared.service
if [[ "${WITH_WYZE}" == 1 ]]; then
    systemctl enable projector-wyze-bridge.service
fi

echo "==> Disabling getty on tty1 (mpv will own the display)"
systemctl disable getty@tty1.service || true
systemctl stop getty@tty1.service || true

if [[ "${UPGRADE}" == 1 ]]; then
    echo ""
    echo "==> Upgraded to ${RELEASE_SHA}. Nothing was restarted; run:"
    echo "      sudo systemctl restart projector-player.service"
    exit 0
fi

screen "Setting up this projector" "Step 4 of 4: connecting to the console"
echo "==> Starting services"
if [[ "${WITH_WYZE}" == 1 ]]; then
    systemctl restart projector-wyze-bridge.service
    echo "    Wyze bridge (unofficial mrlt8/wyze-bridge): journalctl -u projector-wyze-bridge.service -f"
fi
# skipped (not failed) until the daemon writes the tunnel token
systemctl restart projector-cloudflared.service || true
systemctl restart projector-mpv.service
sleep 1
systemctl restart projector-player.service
sleep 2
systemctl --no-pager --lines=10 status projector-mpv.service || true
systemctl --no-pager --lines=10 status projector-player.service || true

echo ""
echo "==> Done."
echo "    Logs:"
echo "      journalctl -u projector-mpv.service -f"
echo "      journalctl -u projector-player.service -f"
echo ""
echo "    If you don't see video yet:"
echo "      1) check that this Pi can reach ${CMS_URL}"
echo "      2) confirm this device has a playlist assigned in the CMS"
echo "      3) verify HDMI cable is in HDMI0 (the port closer to USB-C on Pi 4/5)"
echo "      4) if mpv logs a video-output error, switch mpv.conf to the vo=drm fallback"
