"""Execute remote commands issued by the CMS."""
import json
import logging
import subprocess
import time
from pathlib import Path
from typing import Callable

import requests

from . import __version__, updater
from .config import PlayerConfig
from .mpv_client import MpvClient
from .projector import Projector

log = logging.getLogger("piplayer.commands")

EXECUTED_IDS_MAX = 200
REPORT_RETRIES = 2
_RETRY_DELAY_SECONDS = 1.0


def _run_reboot() -> str:
    res = subprocess.run(["sudo", "-n", "/sbin/reboot"], capture_output=True, text=True, timeout=10)
    if res.returncode == 0:
        return "reboot issued"
    return f"reboot failed: rc={res.returncode} {res.stderr.strip()[:200]}"


def _run_restart_mpv() -> str:
    res = subprocess.run(
        ["sudo", "-n", "/bin/systemctl", "restart", "projector-mpv.service"],
        capture_output=True, text=True, timeout=15,
    )
    if res.returncode == 0:
        return "mpv restart issued"
    return f"restart failed: rc={res.returncode} {res.stderr.strip()[:200]}"


# --- executed-command ledger (next to manifest.json) so an id is never run twice ---
#
# Entries are {"id": <command id>, "issued_at": <as sent by the CMS, or None>}.
# Command ids are per-database autoincrements, so after the controller's DB is
# recreated or restored from a backup the first new commands reuse ids this
# device already ran; a differing issued_at tells them apart. The CMS manifest
# currently sends only {"id", "command"}, so until it also sends issued_at the
# ledger dedupes on id alone (a reused id is treated as already executed; the
# contract's "never execute an id twice" still holds). Older ledgers hold bare ids.

def executed_ids_path(cfg: PlayerConfig) -> Path:
    return cfg.manifest_path.parent / "executed_commands.json"


def _entry(cid, issued_at=None) -> dict:
    return {"id": cid, "issued_at": issued_at}


def load_executed_ids(cfg: PlayerConfig) -> list:
    p = executed_ids_path(cfg)
    if not p.is_file():
        return []
    try:
        data = json.loads(p.read_text())
    except (json.JSONDecodeError, OSError) as e:
        log.warning("failed to read %s: %s", p, e)
        return []
    if not isinstance(data, list):
        return []
    return [e if isinstance(e, dict) else _entry(e) for e in data]


def _was_executed(executed: list, cid, issued_at) -> bool:
    for e in executed:
        if e.get("id") != cid:
            continue
        # only a differing issued_at proves this is a new command with a reused id
        if e.get("issued_at") is None or issued_at is None or e["issued_at"] == issued_at:
            return True
    return False


def _remember_executed(cfg: PlayerConfig, executed: list, cid, issued_at=None) -> None:
    if _was_executed(executed, cid, issued_at):
        return
    executed.append(_entry(cid, issued_at))
    del executed[:-EXECUTED_IDS_MAX]
    p = executed_ids_path(cfg)
    try:
        p.parent.mkdir(parents=True, exist_ok=True)
        tmp = p.with_suffix(p.suffix + ".tmp")
        tmp.write_text(json.dumps(executed))
        tmp.replace(p)
    except OSError as e:
        log.warning("failed to write %s: %s", p, e)


def _report_result(cfg: PlayerConfig, cid, result: str, retries: int = REPORT_RETRIES) -> bool:
    """POST the result for command cid; retried `retries` times. Returns True when the CMS accepted it."""
    for attempt in range(retries + 1):
        try:
            r = requests.post(
                f"{cfg.cms_url}/api/commands/{cid}/result",
                headers={
                    "Authorization": f"Bearer {cfg.device_token}",
                    "User-Agent": f"piplayer/{__version__}",
                },
                json={"result": result},
                timeout=10,
                verify=cfg.verify_tls,
            )
            if r.status_code == 200:
                return True
            log.warning("command result report failed: HTTP %d %s", r.status_code, r.text[:200])
        except requests.RequestException as e:
            log.warning("could not report command result: %s", e)
        if attempt < retries:
            time.sleep(_RETRY_DELAY_SECONDS)
    return False


def execute_commands(
    cfg: PlayerConfig,
    mpv: MpvClient,
    commands: list[dict],
    force_resync: Callable[[], None],
    update: dict | None = None,
    projector: Projector | None = None,
) -> None:
    """`update` is the manifest's optional update block ({release, auto, window}):
    the update-* commands take their git ref from it. `projector` carries the
    manifest's projector block (control, codes, host) for projector-on/off and
    ir-learn:<name>; without one those commands fail."""
    executed = load_executed_ids(cfg)
    for cmd in commands:
        if not isinstance(cmd, dict):
            log.warning("ignoring malformed command entry: %r", cmd)
            continue
        cid = cmd.get("id")
        action = cmd.get("command")
        issued_at = cmd.get("issued_at")
        if _was_executed(executed, cid, issued_at):
            # the CMS re-delivers until it gets a result; ours was lost, so
            # answer again but never run the action a second time
            log.info("command id=%s action=%s already executed; not repeating", cid, action)
            _report_result(cfg, cid, f"already executed: {action}", retries=0)
            continue
        log.info("executing command id=%s action=%s", cid, action)

        if action in ("reboot", "restart-mpv") or action in updater.COMMANDS:
            # Record + report BEFORE acting: the action may kill this process (or
            # the network) before a report could land, and a lost report would
            # otherwise re-trigger the action on the next sync. (update-player
            # restarts the daemon last; the outcome comes back via update_status.)
            _remember_executed(cfg, executed, cid, issued_at)
            _report_result(cfg, cid, {"reboot": "executing reboot", "restart-mpv": "executing mpv restart"}
                           .get(action, f"executing {action}"))
            try:
                if action == "reboot":
                    result = _run_reboot()
                elif action == "restart-mpv":
                    result = _run_restart_mpv()
                else:
                    result = updater.run_command(action, update)
            except Exception as e:
                log.exception("command %s failed", cid)
                result = f"exception: {e!r}"[:300]
            log.info("command id=%s result: %s", cid, result)
            if "failed" in result or result.startswith("exception"):
                _report_result(cfg, cid, result, retries=0)
            continue

        try:
            if action == "force-sync":
                force_resync()
                result = "queued resync"
            elif projector is not None and action in ("projector-on", "projector-off"):
                result = projector.power(action.rsplit("-", 1)[1])
            elif projector is not None and isinstance(action, str) and action.startswith("ir-learn:"):
                result = projector.learn(action[len("ir-learn:"):])   # blocks up to 30 s
            else:
                result = f"unknown command: {action}"
        except Exception as e:
            log.exception("command %s failed", cid)
            result = f"exception: {e!r}"[:300]
        _remember_executed(cfg, executed, cid, issued_at)
        log.info("command id=%s result: %s", cid, result)
        _report_result(cfg, cid, result)
