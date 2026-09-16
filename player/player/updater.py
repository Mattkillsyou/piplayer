"""Remote updates: run deploy/update-player.sh / update-os.sh (root, via sudo),
report /var/lib/projector-player/update-status.json to the console once, and
decide when the nightly auto-update is due.

The scripts detach themselves into a transient systemd unit and return at
once, so the daemon only ever sees "started" or "failed to start"; the real
outcome lands in update-status.json (written by the script, root) and is sent
up as the `update_status` sync param by whichever daemon runs next. A marker
file next to it (the mtime last reported) keeps a status from being reported
on every start."""
import json
import logging
import re
import subprocess
from datetime import datetime, time as dtime, timedelta, timezone
from pathlib import Path
from typing import NamedTuple

from . import __version__
from .config import PlayerConfig

log = logging.getLogger("piplayer.updater")

SCRIPT_DIR = "/opt/piplayer/player/deploy"   # on the Pi; never resolved locally
# written by install-player.sh: the checkout sha the installed code came from
RELEASE_PATH = Path(__file__).resolve().parents[1] / "RELEASE"
STATUS_KEYS = ("ref", "started", "finished", "ok", "message", "previous_version")
STATUS_PARAM_MAX_LEN = 500
COMMANDS = ("update-player", "update-os", "update-all")
AUTO_UPDATE_GAP = timedelta(hours=20)
GIT_REF = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$")


def release_sha() -> str:
    try:
        return RELEASE_PATH.read_text().strip()
    except OSError:
        return ""


def player_version() -> str:
    """__version__ plus the short sha from RELEASE, e.g. 0.2.0+1a2b3c4."""
    sha = release_sha()
    return f"{__version__}+{sha[:7]}" if sha else __version__


# --- running the scripts ---

def _run(cmd: list[str], what: str) -> str:
    res = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
    if res.returncode == 0:
        return f"{what} started"
    return f"{what} failed: rc={res.returncode} {res.stderr.strip()[:200]}"


def run_update_player(ref: str, then_os: bool = False) -> str:
    if not GIT_REF.match(ref or ""):
        return f"update-player failed: bad ref {ref!r}"
    cmd = ["sudo", "-n", f"{SCRIPT_DIR}/update-player.sh", ref]
    if then_os:
        cmd.append("--then-os")
    return _run(cmd, f"update-player {ref}")


def run_update_os() -> str:
    return _run(["sudo", "-n", f"{SCRIPT_DIR}/update-os.sh"], "update-os")


def run_command(action: str, update: dict | None) -> str:
    """update-player / update-os / update-all with the ref from the manifest's `update` block."""
    ref = str((update or {}).get("release") or "main")
    if action == "update-os":
        return run_update_os()
    return run_update_player(ref, then_os=(action == "update-all"))


# --- update-status.json -> sync param ---

def status_path(cfg: PlayerConfig) -> Path:
    return cfg.manifest_path.parent / "update-status.json"


def _marker_path(cfg: PlayerConfig) -> Path:
    return status_path(cfg).with_suffix(".reported")


def read_status(cfg: PlayerConfig) -> dict | None:
    p = status_path(cfg)
    if not p.is_file():
        return None
    try:
        data = json.loads(p.read_text())
    except (json.JSONDecodeError, OSError) as e:
        log.warning("failed to read %s: %s", p, e)
        return None
    return data if isinstance(data, dict) else None


class Pending(NamedTuple):
    param: str          # JSON for the update_status query param (<= STATUS_PARAM_MAX_LEN)
    mtime: str          # status file mtime this param was built from
    reboot: bool        # update-os left /var/run/reboot-required: reboot once reported


def pending_status(cfg: PlayerConfig) -> Pending | None:
    """The status not yet reported to the console, or None."""
    p = status_path(cfg)
    if not p.is_file():
        return None
    try:
        mtime = str(p.stat().st_mtime)
        reported = _marker_path(cfg).read_text().strip() if _marker_path(cfg).is_file() else ""
    except OSError:
        return None
    if reported == mtime:
        return None
    st = read_status(cfg)
    if st is None:
        return None
    out = {k: st.get(k) for k in STATUS_KEYS}
    out["message"] = str(out["message"] or "")
    param = json.dumps(out, separators=(",", ":"))
    over = len(param) - STATUS_PARAM_MAX_LEN
    if over > 0:
        out["message"] = out["message"][: max(0, len(out["message"]) - over)]
        param = json.dumps(out, separators=(",", ":"))
    return Pending(param, mtime, bool(st.get("reboot_required")))


def mark_reported(cfg: PlayerConfig, pending: Pending) -> None:
    try:
        _marker_path(cfg).write_text(pending.mtime)
    except OSError as e:
        log.warning("failed to write %s: %s", _marker_path(cfg), e)


# --- nightly auto-update ---

def in_window(window: str, now: datetime) -> bool:
    """True when now's wall-clock time falls in "HH:MM-HH:MM" (may wrap midnight)."""
    m = re.fullmatch(r"(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})", (window or "").strip())
    if not m:
        return False
    try:
        start = dtime(int(m[1]), int(m[2]))
        end = dtime(int(m[3]), int(m[4]))
    except ValueError:
        return False
    t = now.time().replace(second=0, microsecond=0)
    if start <= end:
        return start <= t < end
    return t >= start or t < end


def last_player_update_started(cfg: PlayerConfig) -> datetime | None:
    """`started` of the last update-player run (update-os runs do not count), aware UTC."""
    st = read_status(cfg) or {}
    if st.get("ref") == "os":
        return None
    raw = str(st.get("started") or "")
    try:
        dt = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def auto_update_due(update: dict | None, now: datetime, last_started: datetime | None) -> bool:
    """Manifest `update` block says nightly, now (aware, local tz) is inside the
    window, and the last update-player run started >= 20 h ago (or never)."""
    if not isinstance(update, dict) or update.get("auto") != "nightly":
        return False
    if not in_window(str(update.get("window") or "03:00-05:00"), now):
        return False
    return last_started is None or now - last_started >= AUTO_UPDATE_GAP


def maybe_auto_update(cfg: PlayerConfig, update: dict | None, state, now: datetime | None = None) -> bool:
    """Run update-player once per window (state.last_auto_update guards the
    daemon's lifetime, update-status.json's `started` guards across restarts).
    Returns True when a run was started."""
    now = now or datetime.now().astimezone()
    if state.last_auto_update is not None and now - state.last_auto_update < AUTO_UPDATE_GAP:
        return False
    if not auto_update_due(update, now, last_player_update_started(cfg)):
        return False
    state.last_auto_update = now
    ref = str(update.get("release") or "main")
    log.info("auto-update: running update-player %s", ref)
    result = run_update_player(ref)
    log.info("auto-update: %s", result)
    return True
