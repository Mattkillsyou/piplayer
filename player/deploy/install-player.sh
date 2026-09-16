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
# the credentials file /etc/projector-player/wyze.env is left for the operator
# or the flasher to fill in (keys: WYZE_EMAIL, WYZE_PASSWORD, API_ID, API_KEY).
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
    echo "Please run as root (sudo -E bash deploy/install-player.sh)" >&2
    exit 1
fi

INSTALL_DIR="/opt/piplayer/player"
DATA_DIR="/var/lib/projector-player"
ETC_DIR="/etc/projector-player"
USER_NAME="projector"

WITH_WYZE=0
UNINSTALL=0
for arg in "$@"; do
    case "${arg}" in
        --uninstall) UNINSTALL=1 ;;
        --with-wyze) WITH_WYZE=1 ;;
        *)
            echo "Unknown argument: ${arg} (supported: --uninstall, --with-wyze)" >&2
            exit 1
            ;;
    esac
done

if [[ "${UNINSTALL}" == 1 ]]; then
    echo "==> Stopping and disabling services"
    systemctl disable --now projector-player.service projector-mpv.service projector-wyze-bridge.service 2>/dev/null || true
    rm -f /etc/systemd/system/projector-player.service /etc/systemd/system/projector-mpv.service         /etc/systemd/system/projector-wyze-bridge.service
    systemctl daemon-reload
    systemctl reset-failed projector-player.service projector-mpv.service projector-wyze-bridge.service 2>/dev/null || true
    if command -v docker >/dev/null 2>&1; then
        docker rm -f projector-wyze-bridge >/dev/null 2>&1 || true
        # Docker itself is left installed.
    fi

    echo "==> Removing sudoers drop-in"
    rm -f /etc/sudoers.d/projector-player

    echo "==> Re-enabling the login prompt on tty1"
    systemctl enable getty@tty1.service || true
    systemctl start getty@tty1.service || true

    echo "==> Removing player files (${INSTALL_DIR}, ${DATA_DIR}, ${ETC_DIR})"
    rm -rf "${INSTALL_DIR}" "${DATA_DIR}" "${ETC_DIR}" /tmp/projector-mpv.sock
    # /opt/piplayer/cms (a co-located controller) is intentionally left in place.
    rmdir /opt/piplayer 2>/dev/null || true

    if id -u "${USER_NAME}" >/dev/null 2>&1; then
        echo "==> Removing user '${USER_NAME}'"
        userdel "${USER_NAME}" || true
    fi
    echo "==> Player removed."
    exit 0
fi

: "${DEVICE_ID:?DEVICE_ID env var is required}"
: "${DEVICE_TOKEN:?DEVICE_TOKEN env var is required}"
: "${CMS_URL:?CMS_URL env var is required}"

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "==> Installing system dependencies"
apt-get update
# git and rsync are not part of Raspberry Pi OS Lite; both are needed here.
# ffmpeg grabs the room-camera snapshots ([camera] in config.toml).
apt-get install -y git rsync mpv ffmpeg python3 python3-venv python3-pip libgl1 libegl1

echo "==> Creating user '${USER_NAME}'"
if ! id -u "${USER_NAME}" >/dev/null 2>&1; then
    useradd --system --home-dir "${DATA_DIR}" --shell /bin/bash --create-home "${USER_NAME}"
fi
# Need these groups for --vo=gpu/drm and audio
usermod -aG video,render,input,audio,tty "${USER_NAME}"

echo "==> Creating directories"
mkdir -p "${INSTALL_DIR}" "${DATA_DIR}/media" "${ETC_DIR}" "${DATA_DIR}/.config/mpv"
chown -R "${USER_NAME}:${USER_NAME}" "${DATA_DIR}"

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

echo "==> Granting sudoers rights for reboot + mpv restart"
cat > /etc/sudoers.d/projector-player <<'EOF'
# Allow the projector daemon to reboot the Pi and restart mpv on demand
# (issued from the CMS via the device_commands queue).
projector ALL=(ALL) NOPASSWD: /sbin/reboot
projector ALL=(ALL) NOPASSWD: /usr/sbin/reboot
projector ALL=(ALL) NOPASSWD: /bin/systemctl restart projector-mpv.service
projector ALL=(ALL) NOPASSWD: /usr/bin/systemctl restart projector-mpv.service
EOF
chmod 440 /etc/sudoers.d/projector-player
visudo -c -f /etc/sudoers.d/projector-player
# Smoke-test that the daemon will actually be allowed to use them
if ! sudo -n -u "${USER_NAME}" sudo -n -l /bin/systemctl restart projector-mpv.service >/dev/null 2>&1; then
    echo "WARNING: sudo rule check failed for user ${USER_NAME}; remote reboot/restart-mpv may not work" >&2
fi

if [[ "${WITH_WYZE}" == 1 ]]; then
    echo "==> Installing Docker for the Wyze bridge"
    if ! command -v docker >/dev/null 2>&1; then
        curl -fsSL https://get.docker.com | sh
    fi
    systemctl enable --now docker.service

    echo "==> Writing Wyze credentials at ${ETC_DIR}/wyze.env"
    if [[ -n "${WYZE_EMAIL:-}" && -n "${WYZE_PASSWORD:-}" && -n "${WYZE_API_ID:-}" && -n "${WYZE_API_KEY:-}" ]]; then
        cat > "${ETC_DIR}/wyze.env" <<EOF
WYZE_EMAIL=${WYZE_EMAIL}
WYZE_PASSWORD=${WYZE_PASSWORD}
API_ID=${WYZE_API_ID}
API_KEY=${WYZE_API_KEY}
EOF
    elif [[ ! -f "${ETC_DIR}/wyze.env" ]]; then
        echo "    NOTE: WYZE_EMAIL/WYZE_PASSWORD/WYZE_API_ID/WYZE_API_KEY not all set; writing a template to fill in"
        cat > "${ETC_DIR}/wyze.env" <<'EOF'
# Wyze account + API key (Wyze developer portal). Read by projector-wyze-bridge.service.
WYZE_EMAIL=
WYZE_PASSWORD=
API_ID=
API_KEY=
EOF
    else
        echo "    existing ${ETC_DIR}/wyze.env kept"
    fi
    chmod 600 "${ETC_DIR}/wyze.env"
    chown root:root "${ETC_DIR}/wyze.env"
fi

echo "==> Installing systemd units"
cp "${SRC_DIR}/deploy/projector-mpv.service" /etc/systemd/system/projector-mpv.service
cp "${SRC_DIR}/deploy/projector-player.service" /etc/systemd/system/projector-player.service
if [[ "${WITH_WYZE}" == 1 ]]; then
    cp "${SRC_DIR}/deploy/projector-wyze-bridge.service" /etc/systemd/system/projector-wyze-bridge.service
fi
systemctl daemon-reload
systemctl enable projector-mpv.service projector-player.service
if [[ "${WITH_WYZE}" == 1 ]]; then
    systemctl enable projector-wyze-bridge.service
fi

echo "==> Disabling getty on tty1 (mpv will own the display)"
systemctl disable getty@tty1.service || true
systemctl stop getty@tty1.service || true

echo "==> Starting services"
if [[ "${WITH_WYZE}" == 1 ]]; then
    systemctl restart projector-wyze-bridge.service
    echo "    Wyze bridge (unofficial mrlt8/wyze-bridge): journalctl -u projector-wyze-bridge.service -f"
fi
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
