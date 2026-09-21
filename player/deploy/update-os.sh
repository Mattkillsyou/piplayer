#!/usr/bin/env bash
# update-os.sh -- upgrade the OS packages (root): apt-get update, upgrade with
# existing config files kept, autoremove. Issued by the daemon for the
# update-os / update-all commands (sudoers drop-in from install-player.sh) or
# by hand: sudo /opt/piplayer/player/deploy/update-os.sh
#
# The result goes to /var/lib/projector-player/update-status.json (ref "os",
# plus reboot_required when /var/run/reboot-required exists afterwards); the
# daemon reports it on its next sync and then reboots if asked to. Output is
# appended to /var/lib/projector-player/update.log. Like update-player.sh the
# script re-launches itself as a transient systemd unit so a long apt run
# never blocks (or gets killed with) the daemon. PIPLAYER_ROOT (tests only)
# prefixes the absolute paths, as in update-player.sh.
set -Eeuo pipefail

ROOT="${PIPLAYER_ROOT:-}"
DATA_DIR="${ROOT}/var/lib/projector-player"
STATUS_FILE="${DATA_DIR}/update-status.json"
LOG_FILE="${DATA_DIR}/update.log"

if [[ $EUID -ne 0 && -z "${ROOT}" ]]; then
    echo "Please run as root (sudo $0)" >&2
    exit 1
fi

STARTED="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) update-os: $*"; }

# write_status <true|false> <message> <reboot_required: true|false>
write_status() {
    python3 - "${STARTED}" "$1" "$2" "$3" > "${STATUS_FILE}.tmp" <<'PY'
import datetime, json, sys
started, ok, message, reboot = sys.argv[1:5]
print(json.dumps({
    "ref": "os", "started": started,
    "finished": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "ok": ok == "true", "message": message[:300], "previous_version": None,
    "reboot_required": reboot == "true",
}))
PY
    chmod 644 "${STATUS_FILE}.tmp"
    mv "${STATUS_FILE}.tmp" "${STATUS_FILE}"
    log "status: ok=$1 $2"
}

fail() {
    trap - ERR
    log "FAILED: $*"
    write_status false "$*" false
    exit 1
}

main() {
    if [[ -z "${PIPLAYER_UPDATE_DETACHED:-}" ]] && command -v systemd-run >/dev/null 2>&1; then
        exec systemd-run --quiet --collect --unit=projector-os-update \
            --setenv=PIPLAYER_UPDATE_DETACHED=1 "$(readlink -f "$0")" "$@"
    fi
    mkdir -p "${DATA_DIR}"
    exec >> "${LOG_FILE}" 2>&1
    trap 'fail "apt failed at line ${LINENO} (see ${LOG_FILE})"' ERR
    log "== update-os"
    export DEBIAN_FRONTEND=noninteractive
    # a power cut mid-apt leaves dpkg interrupted and every later apt-get refuses to run: repair first
    dpkg --configure -a || true
    apt-get update
    apt-get -y -o Dpkg::Options::=--force-confold upgrade
    apt-get -y autoremove
    trap - ERR
    local summary
    summary="$(grep -E '^[0-9]+ upgraded, ' "${LOG_FILE}" | tail -n 1 || true)"
    if [[ -f "${ROOT}/var/run/reboot-required" ]]; then
        write_status true "${summary:-packages upgraded}; reboot required" true
    else
        write_status true "${summary:-packages upgraded}" false
    fi
}

main "$@"
