#!/usr/bin/env bash
# install-cms.sh -- install the PiPlayer CMS on Raspberry Pi OS (Bookworm).
# Run with: sudo bash install-cms.sh
# Optional env vars: PIPLAYER_ADMIN_USERNAME, PIPLAYER_ADMIN_PASSWORD, PIPLAYER_PUBLIC_BASE_URL
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
    echo "Please run as root (sudo bash install-cms.sh)" >&2
    exit 1
fi

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALL_DIR="/opt/piplayer/cms"
DATA_DIR="/var/lib/projector-cms"
ETC_DIR="/etc/projector-cms"
USER_NAME="piplayer"

echo "==> Installing system dependencies"
apt-get update
apt-get install -y python3 python3-venv python3-pip ffmpeg

echo "==> Creating user '${USER_NAME}'"
if ! id -u "${USER_NAME}" >/dev/null 2>&1; then
    useradd --system --home-dir "${DATA_DIR}" --shell /usr/sbin/nologin "${USER_NAME}"
fi

echo "==> Creating directories"
mkdir -p "${INSTALL_DIR}" "${DATA_DIR}/media" "${ETC_DIR}"
chown -R "${USER_NAME}:${USER_NAME}" "${DATA_DIR}"

echo "==> Copying app files from ${SRC_DIR}"
rsync -a --delete \
    --exclude='__pycache__' \
    --exclude='.venv' \
    --exclude='data' \
    --exclude='deploy' \
    "${SRC_DIR}/" "${INSTALL_DIR}/"

echo "==> Creating virtualenv"
python3 -m venv "${INSTALL_DIR}/.venv"
"${INSTALL_DIR}/.venv/bin/pip" install --upgrade pip
"${INSTALL_DIR}/.venv/bin/pip" install -r "${INSTALL_DIR}/requirements.txt"
chown -R "${USER_NAME}:${USER_NAME}" "${INSTALL_DIR}"

echo "==> Writing environment file at ${ETC_DIR}/env"
if [[ ! -f "${ETC_DIR}/env" ]]; then
    SECRET=$(python3 -c 'import secrets; print(secrets.token_urlsafe(48))')
    cat > "${ETC_DIR}/env" <<EOF
PIPLAYER_SECRET_KEY=${SECRET}
# PIPLAYER_ADMIN_USERNAME=admin
# PIPLAYER_ADMIN_PASSWORD=set-this-to-control-the-initial-password
# PIPLAYER_PUBLIC_BASE_URL=https://your.public.url
EOF
    chmod 600 "${ETC_DIR}/env"
    chown root:root "${ETC_DIR}/env"
    echo "    Wrote ${ETC_DIR}/env (edit this to customize)"
else
    echo "    ${ETC_DIR}/env already exists, leaving untouched"
fi

echo "==> Installing systemd unit"
cp "${SRC_DIR}/deploy/projector-cms.service" /etc/systemd/system/projector-cms.service
systemctl daemon-reload
systemctl enable projector-cms.service

echo "==> Starting projector-cms.service"
systemctl restart projector-cms.service
sleep 2
systemctl --no-pager --lines=20 status projector-cms.service || true

echo ""
echo "==> Done."
echo "    CMS is listening on http://$(hostname -I | awk '{print $1}'):8080"
echo "    Initial admin credentials are in:  journalctl -u projector-cms.service -n 50"
echo "    (look for 'Created admin user' if PIPLAYER_ADMIN_PASSWORD was not set)"
