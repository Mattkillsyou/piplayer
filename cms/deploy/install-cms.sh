#!/usr/bin/env bash
# install-cms.sh -- install the PiPlayer CMS on Raspberry Pi OS (Bookworm or Trixie).
# Run with: sudo -E bash install-cms.sh
# Optional env vars (need sudo -E to survive sudo's env_reset): PIPLAYER_ADMIN_USERNAME,
# PIPLAYER_ADMIN_PASSWORD, PIPLAYER_PUBLIC_BASE_URL. They are written into /etc/projector-cms/env
# on the FIRST run only (the file is left untouched afterwards); every other PIPLAYER_* knob
# is listed there, commented out.
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
apt-get install -y git python3 python3-venv python3-pip ffmpeg rsync

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
# --upgrade so an in-place upgrade also lifts the pins (e.g. python-multipart's header limits).
"${INSTALL_DIR}/.venv/bin/pip" install --upgrade -r "${INSTALL_DIR}/requirements.txt"
# The install tree stays root-owned (world-readable) so the service cannot rewrite its
# own code; only the data dir belongs to the service user.
chown -R root:root "${INSTALL_DIR}"
chmod -R a+rX "${INSTALL_DIR}"

echo "==> Writing environment file at ${ETC_DIR}/env"
if [[ ! -f "${ETC_DIR}/env" ]]; then
    SECRET=$(python3 -c 'import secrets; print(secrets.token_urlsafe(48))')
    # env_line NAME DEFAULT: NAME="value" when NAME is set in this environment (sudo -E),
    # otherwise the commented template line. Double quotes keep spaces and '#' intact for
    # systemd's EnvironmentFile=; a value containing '"' or '\' must be edited in by hand.
    env_line() {
        local value="${!1:-}"
        if [[ -n "${value}" ]]; then printf '%s="%s"\n' "$1" "${value}"; else printf '# %s=%s\n' "$1" "$2"; fi
    }
    cat > "${ETC_DIR}/env" <<EOF
PIPLAYER_SECRET_KEY=${SECRET}
# Username / initial password (max 72 bytes) of the first admin; only read while the
# users table is empty. Leave the password commented to have one generated.
$(env_line PIPLAYER_ADMIN_USERNAME admin)
$(env_line PIPLAYER_ADMIN_PASSWORD set-this-to-control-the-initial-password)
$(env_line PIPLAYER_PUBLIC_BASE_URL https://your.public.url)
# Secure session cookie; only if every login goes through HTTPS.
# PIPLAYER_HTTPS_ONLY=1
# Reverse proxies allowed to set X-Forwarded-For.
# PIPLAYER_FORWARDED_ALLOW_IPS=127.0.0.1
# Audit log rows older than this many days are pruned at startup (0 = keep forever, the default).
# PIPLAYER_AUDIT_RETENTION_DAYS=0
# Seconds between player screenshots; the dashboard marks them stale after 3x.
# PIPLAYER_SCREENSHOT_INTERVAL=60
# Largest screenshot upload accepted (bytes).
# PIPLAYER_MAX_SCREENSHOT_BYTES=5242880
# Largest media upload accepted (bytes, default 5 GB).
# PIPLAYER_MAX_UPLOAD_BYTES=5368709120
# Seconds an image stays on screen when no override is set.
# PIPLAYER_DEFAULT_IMAGE_DURATION=10
# NOTE: systemd EnvironmentFile= has no trailing-comment support, so every
# uncommented line must contain nothing but NAME=value.
EOF
    chmod 600 "${ETC_DIR}/env"
    chown root:root "${ETC_DIR}/env"
    echo "    Wrote ${ETC_DIR}/env (edit this to customize)"
else
    echo "    ${ETC_DIR}/env already exists, leaving untouched"
    if [[ -n "${PIPLAYER_ADMIN_PASSWORD:-}${PIPLAYER_ADMIN_USERNAME:-}${PIPLAYER_PUBLIC_BASE_URL:-}" ]]; then
        echo "    NOTE: PIPLAYER_ADMIN_*/PUBLIC_BASE_URL from the environment are ignored on re-runs; edit the file."
    fi
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
echo "    First start only: the admin password comes from PIPLAYER_ADMIN_PASSWORD in ${ETC_DIR}/env"
echo "    (never written to the log); if that line is absent a password was generated and logged:"
echo "        journalctl -u projector-cms.service -n 50   (look for 'Created admin user')"
echo "    Schedules use this Pi's local time zone: check it with 'timedatectl' and set it with"
echo "        sudo timedatectl set-timezone Region/City"
