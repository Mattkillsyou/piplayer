#!/usr/bin/env bash
# update-player.sh -- fetch <ref> of the piplayer repository and reinstall the
# player from it (root). Issued by the daemon for the update-player /
# update-all commands (sudoers drop-in from install-player.sh) or by hand:
#   sudo /opt/piplayer/player/deploy/update-player.sh v6.0
#   sudo /opt/piplayer/player/deploy/update-player.sh main --then-os   # then update-os.sh
#   sudo /opt/piplayer/player/deploy/update-player.sh --postcheck      # run by the timer, see below
#
# Order: clone into /opt/piplayer/src-<ts> (tarball via curl if git is missing),
# check player/player/__init__.py, compare the sha with /opt/piplayer/player/RELEASE
# (equal: "already at <sha>", nothing touched), move the running code to
# /opt/piplayer/player.prev (exactly one kept), run install-player.sh --upgrade
# from the checkout, write /var/lib/projector-player/update-status.json, arm the
# post-check timer, restart projector-player.service last. A failing install
# restores .prev. Everything is appended to /var/lib/projector-player/update.log.
#
# The daemon runs this through sudo from inside projector-player.service, whose
# cgroup the final restart would kill (the script included), so the first thing
# it does is re-launch itself as a transient unit with systemd-run and return.
#
# PIPLAYER_ROOT (tests only) prefixes every absolute path so the whole flow,
# rollback included, runs as a normal user in a scratch directory with fake
# git remote / systemctl / apt-get on PATH (player/tests/test_updater.py).
set -Eeuo pipefail

REPO_URL="${PIPLAYER_REPO_URL:-https://github.com/Mattkillsyou/piplayer.git}"
ROOT="${PIPLAYER_ROOT:-}"
INSTALL_DIR="${ROOT}/opt/piplayer/player"
PREV_DIR="${INSTALL_DIR}.prev"
DATA_DIR="${ROOT}/var/lib/projector-player"
STATUS_FILE="${DATA_DIR}/update-status.json"
LOG_FILE="${DATA_DIR}/update.log"
SERVICE="projector-player.service"
POSTCHECK_TIMER="projector-player-postcheck.timer"
MAX_RESTARTS=3

REF="${1:-main}"
THEN_OS=0
case "${2:-}" in
    "") ;;
    --then-os) THEN_OS=1 ;;
    *) echo "Unknown argument: ${2} (supported: --then-os)" >&2; exit 1 ;;
esac

if [[ $EUID -ne 0 && -z "${ROOT}" ]]; then
    echo "Please run as root (sudo $0 ${REF})" >&2
    exit 1
fi

STARTED="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
PREV_VERSION="$(cat "${INSTALL_DIR}/RELEASE" 2>/dev/null || echo unknown)"

log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) update-player: $*"; }

# write_status <true|false> <message>  -> update-status.json (atomic, world-readable:
# the daemon runs as user projector and reports it on its next sync)
write_status() {
    mkdir -p "${DATA_DIR}"
    python3 - "${REF}" "${STARTED}" "$1" "$2" "${PREV_VERSION}" > "${STATUS_FILE}.tmp" <<'PY'
import datetime, json, sys
ref, started, ok, message, prev = sys.argv[1:6]
print(json.dumps({
    "ref": ref, "started": started,
    "finished": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "ok": ok == "true", "message": message[:300], "previous_version": prev,
}))
PY
    chmod 644 "${STATUS_FILE}.tmp"
    mv "${STATUS_FILE}.tmp" "${STATUS_FILE}"
    log "status: ok=$1 $2"
}

restore_prev() {
    if [[ -d "${PREV_DIR}" ]]; then
        log "restoring ${PREV_DIR} -> ${INSTALL_DIR}"
        rm -rf "${INSTALL_DIR}"
        mv "${PREV_DIR}" "${INSTALL_DIR}"
    fi
}

# --postcheck: run by projector-player-postcheck.timer 2 min after the restart.
# A daemon that cannot import or keeps exiting shows up as a unit that is not
# active (start limit hit) or has been auto-restarted MAX_RESTARTS+ times.
postcheck() {
    local active restarts
    active="$(systemctl is-active "${SERVICE}" 2>/dev/null || true)"
    restarts="$(systemctl show -p NRestarts --value "${SERVICE}" 2>/dev/null || echo 0)"
    restarts="${restarts:-0}"
    if [[ "${active}" == "active" && "${restarts}" -lt "${MAX_RESTARTS}" ]]; then
        log "post-check ok: ${SERVICE} ${active}, ${restarts} restarts"
        return 0
    fi
    if [[ ! -d "${PREV_DIR}" ]]; then
        log "post-check: ${SERVICE} ${active} with ${restarts} restarts but no ${PREV_DIR} to roll back to"
        return 0
    fi
    log "post-check: ${SERVICE} ${active} with ${restarts} restarts; rolling back"
    REF="$(cat "${INSTALL_DIR}/RELEASE" 2>/dev/null || echo unknown)"
    restore_prev
    PREV_VERSION="$(cat "${INSTALL_DIR}/RELEASE" 2>/dev/null || echo unknown)"
    write_status false "rolled back to ${PREV_VERSION}: player ${active} with ${restarts} restarts after the update"
    systemctl reset-failed "${SERVICE}" 2>/dev/null || true
    systemctl restart "${SERVICE}"
}

fail() {
    trap - ERR
    log "FAILED: $*"
    if [[ "${PREV_MADE:-0}" == 1 ]]; then
        restore_prev
    fi
    write_status false "$*"
    rm -rf "${SRC_DIR:-/nonexistent}"
    exit 1
}

update() {
    if [[ ! "${REF}" =~ ^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$ ]]; then
        fail "bad ref: ${REF}"
    fi
    log "== update-player ${REF} (running ${PREV_VERSION})"
    rm -rf "${ROOT}/opt/piplayer"/src-*
    SRC_DIR="${ROOT}/opt/piplayer/src-$(date +%Y%m%d%H%M%S)"
    mkdir -p "$(dirname "${SRC_DIR}")"

    local sha
    if command -v git >/dev/null 2>&1; then
        if ! git clone --quiet --depth 1 --branch "${REF}" "${REPO_URL}" "${SRC_DIR}" 2>&1; then
            # a commit sha is not a branch: full clone, then check it out
            rm -rf "${SRC_DIR}"
            git clone --quiet "${REPO_URL}" "${SRC_DIR}" 2>&1 || fail "git clone failed for ${REF}"
            git -C "${SRC_DIR}" checkout --quiet "${REF}" 2>&1 || fail "ref not found: ${REF}"
        fi
        sha="$(git -C "${SRC_DIR}" rev-parse HEAD)"
    else
        log "git not installed; fetching the tarball"
        mkdir -p "${SRC_DIR}"
        curl -fsSL "${REPO_URL%.git}/archive/${REF}.tar.gz" | tar -xz --strip-components=1 -C "${SRC_DIR}" \
            || fail "tarball download failed for ${REF}"
        sha="${REF}"
    fi
    [[ -f "${SRC_DIR}/player/player/__init__.py" ]] || fail "not a piplayer checkout: ${SRC_DIR}"
    log "checkout ${sha}"

    if [[ "${sha}" == "${PREV_VERSION}" ]]; then
        write_status true "already at ${sha}"
        rm -rf "${SRC_DIR}"
        return 0
    fi

    rm -rf "${PREV_DIR}"
    if [[ -d "${INSTALL_DIR}" ]]; then
        mv "${INSTALL_DIR}" "${PREV_DIR}"
        PREV_MADE=1
    fi
    log "installing ${sha} (previous code kept at ${PREV_DIR})"
    if ! PIPLAYER_RELEASE_SHA="${sha}" bash "${SRC_DIR}/player/deploy/install-player.sh" --upgrade 2>&1; then
        fail "install-player.sh --upgrade failed (see ${LOG_FILE})"
    fi
    rm -rf "${SRC_DIR}"
    write_status true "updated ${PREV_VERSION} -> ${sha}"
    systemctl restart "${POSTCHECK_TIMER}" 2>&1 || log "WARNING: could not arm ${POSTCHECK_TIMER}"
    log "restarting ${SERVICE}"
    systemctl restart "${SERVICE}"
    return 0
}

main() {
    if [[ "${REF}" == "--postcheck" ]]; then
        exec >> "${LOG_FILE}" 2>&1
        postcheck
        exit 0
    fi
    # Detach from the caller's cgroup (see the header). The unit name doubles as
    # the lock: a second update while one runs fails with "already exists".
    if [[ -z "${PIPLAYER_UPDATE_DETACHED:-}" ]] && command -v systemd-run >/dev/null 2>&1; then
        exec systemd-run --quiet --collect --unit=projector-player-update \
            --setenv=PIPLAYER_UPDATE_DETACHED=1 "$(readlink -f "$0")" "$@"
    fi
    mkdir -p "${DATA_DIR}"
    exec >> "${LOG_FILE}" 2>&1
    trap 'fail "error at line ${LINENO} (see ${LOG_FILE})"' ERR
    update
    trap - ERR
    if [[ "${THEN_OS}" == 1 ]]; then
        exec bash "${INSTALL_DIR}/deploy/update-os.sh"
    fi
}

main "$@"
