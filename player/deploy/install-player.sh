#!/usr/bin/env bash
# install-player.sh -- install the PiPlayer player on Raspberry Pi OS (Bookworm).
# Run with:
#   DEVICE_ID=lobby-projector DEVICE_TOKEN=xxxx CMS_URL=http://controller:8080 sudo -E bash install-player.sh
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
    echo "Please run as root (sudo -E bash install-player.sh)" >&2
    exit 1
fi

: "${DEVICE_ID:?DEVICE_ID env var is required}"
: "${DEVICE_TOKEN:?DEVICE_TOKEN env var is required}"
: "${CMS_URL:?CMS_URL env var is required}"

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALL_DIR="/opt/piplayer/player"
DATA_DIR="/var/lib/projector-player"
ETC_DIR="/etc/projector-player"
USER_NAME="projector"

echo "==> Installing system dependencies"
apt-get update
apt-get install -y mpv python3 python3-venv python3-pip libgl1 libegl1

echo "==> Creating user '${USER_NAME}'"
if ! id -u "${USER_NAME}" >/dev/null 2>&1; then
    useradd --system --home-dir "${DATA_DIR}" --shell /bin/bash --create-home "${USER_NAME}"
fi
# Need these groups for --vo=drm and audio
usermod -aG video,render,input,audio,tty "${USER_NAME}"

echo "==> Creating directories"
mkdir -p "${INSTALL_DIR}" "${DATA_DIR}/media" "${ETC_DIR}" "${DATA_DIR}/.config/mpv"
chown -R "${USER_NAME}:${USER_NAME}" "${DATA_DIR}"

echo "==> Copying app files from ${SRC_DIR}"
rsync -a --delete \
    --exclude='__pycache__' \
    --exclude='.venv' \
    --exclude='deploy' \
    "${SRC_DIR}/" "${INSTALL_DIR}/"

echo "==> Installing mpv kiosk config"
cp "${SRC_DIR}/deploy/mpv.conf" "${DATA_DIR}/.config/mpv/mpv.conf"
chown -R "${USER_NAME}:${USER_NAME}" "${DATA_DIR}/.config"

echo "==> Creating virtualenv"
python3 -m venv "${INSTALL_DIR}/.venv"
"${INSTALL_DIR}/.venv/bin/pip" install --upgrade pip
"${INSTALL_DIR}/.venv/bin/pip" install -r "${INSTALL_DIR}/requirements.txt"
chown -R "${USER_NAME}:${USER_NAME}" "${INSTALL_DIR}"

echo "==> Writing config file at ${ETC_DIR}/config.toml"
cat > "${ETC_DIR}/config.toml" <<EOF
device_id = "${DEVICE_ID}"
device_token = "${DEVICE_TOKEN}"
cms_url = "${CMS_URL}"
media_dir = "${DATA_DIR}/media"
manifest_path = "${DATA_DIR}/manifest.json"
mpv_socket = "/tmp/projector-mpv.sock"
poll_interval_seconds = 30
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

echo "==> Installing systemd units"
cp "${SRC_DIR}/deploy/projector-mpv.service" /etc/systemd/system/projector-mpv.service
cp "${SRC_DIR}/deploy/projector-player.service" /etc/systemd/system/projector-player.service
systemctl daemon-reload
systemctl enable projector-mpv.service projector-player.service

echo "==> Disabling getty on tty1 (mpv will own the framebuffer)"
systemctl disable getty@tty1.service || true
systemctl stop getty@tty1.service || true

echo "==> Starting services"
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
