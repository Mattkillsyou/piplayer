"""Execute remote commands issued by the CMS."""
import logging
import subprocess
from typing import Callable

import requests

from . import __version__
from .config import PlayerConfig
from .mpv_client import MpvClient

log = logging.getLogger("piplayer.commands")


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


def execute_commands(
    cfg: PlayerConfig,
    mpv: MpvClient,
    commands: list[dict],
    force_resync: Callable[[], None],
) -> None:
    for cmd in commands:
        cid = cmd.get("id")
        action = cmd.get("command")
        log.info("executing command id=%s action=%s", cid, action)
        try:
            if action == "force-sync":
                force_resync()
                result = "queued resync"
            elif action == "restart-mpv":
                result = _run_restart_mpv()
            elif action == "reboot":
                result = _run_reboot()
            else:
                result = f"unknown command: {action}"
        except Exception as e:
            log.exception("command %s failed", cid)
            result = f"exception: {e!r}"[:300]

        # Report result back
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
            if r.status_code != 200:
                log.warning("command result report failed: HTTP %d %s", r.status_code, r.text[:200])
        except requests.RequestException as e:
            log.warning("could not report command result: %s", e)
