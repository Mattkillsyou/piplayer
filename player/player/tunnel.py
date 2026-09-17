"""Live camera without a hand-made tunnel: the console creates one Cloudflare
Tunnel per device and hands its token over in the manifest as
`tunnel: {token, hostname}` (device bearer only). The daemon keeps
/var/lib/projector-player/tunnel.token (mode 600, next to manifest.json) equal
to that token and restarts projector-cloudflared.service (sudoers-allowed)
whenever the file changed; the unit runs `cloudflared tunnel run` with it and
is skipped while the file is missing. No key in the manifest = feature off:
an existing token file is left alone (a tunnel the console deleted stops
working by itself)."""
import logging
import subprocess

from .camera_config import write_private
from .config import PlayerConfig

log = logging.getLogger("piplayer.tunnel")

UNIT = "projector-cloudflared.service"


def token_path(cfg: PlayerConfig):
    return cfg.manifest_path.parent / "tunnel.token"


def write_token(cfg: PlayerConfig, token: str) -> bool:
    """Write tunnel.token (0600) when it changed; True when it did."""
    return write_private(token_path(cfg), token.strip() + "\n")


def restart_service() -> str:
    res = subprocess.run(["sudo", "-n", "/bin/systemctl", "restart", UNIT],
                         capture_output=True, text=True, timeout=30)
    if res.returncode == 0:
        return "cloudflared restarted"
    return f"cloudflared restart failed: rc={res.returncode} {res.stderr.strip()[:200]}"


def maybe_apply(cfg: PlayerConfig, manifest: dict) -> bool:
    """Bring tunnel.token in line with the manifest and restart cloudflared
    when it changed. Failures are logged and retried next cycle (the file
    comparison makes the retry free). Returns True when the token changed."""
    block = manifest.get("tunnel")
    token = str(block.get("token") or "").strip() if isinstance(block, dict) else ""
    if not token:
        return False
    try:
        if not write_token(cfg, token):
            return False
    except OSError as e:
        log.warning("tunnel token write failed (will retry): %s", e)
        return False
    try:
        log.info("tunnel token updated for %s: %s", block.get("hostname") or "?", restart_service())
    except subprocess.SubprocessError as e:
        log.warning("cloudflared restart failed: %s", e)
    return True
