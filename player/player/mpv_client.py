import json
import logging
import socket
import time
from pathlib import Path

log = logging.getLogger("piplayer.mpv")


class MpvClient:
    """Minimal JSON-IPC client for mpv over a Unix socket."""

    def __init__(self, socket_path: Path):
        self.socket_path = socket_path

    def _connect(self, timeout: float = 2.0) -> socket.socket:
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.settimeout(timeout)
        s.connect(str(self.socket_path))
        return s

    def is_alive(self) -> bool:
        try:
            with self._connect(timeout=1.0):
                return True
        except (OSError, socket.timeout):
            return False

    def wait_for_socket(self, max_wait_s: float = 60.0) -> bool:
        deadline = time.time() + max_wait_s
        while time.time() < deadline:
            if self.is_alive():
                return True
            time.sleep(0.5)
        return False

    def command(self, *args, timeout: float = 5.0) -> dict | None:
        """Send a single mpv command. Returns the parsed reply, or None on error."""
        payload = (json.dumps({"command": list(args)}) + "\n").encode()
        try:
            with self._connect(timeout=timeout) as s:
                s.sendall(payload)
                buf = b""
                deadline = time.time() + timeout
                while b"\n" not in buf and time.time() < deadline:
                    chunk = s.recv(4096)
                    if not chunk:
                        break
                    buf += chunk
            for line in buf.splitlines():
                if not line.strip():
                    continue
                msg = json.loads(line)
                if "error" in msg or "data" in msg:
                    return msg
            return None
        except (OSError, socket.timeout, json.JSONDecodeError) as e:
            log.warning("mpv command %s failed: %s", args, e)
            return None

    def get_property(self, name: str):
        reply = self.command("get_property", name)
        if reply is None or reply.get("error") != "success":
            return None
        return reply.get("data")

    def set_property(self, name: str, value) -> bool:
        reply = self.command("set_property", name, value)
        return reply is not None and reply.get("error") == "success"

    def load_replace(self, path: Path, options: dict | None = None) -> bool:
        """Replace the entire playlist with this single file. Options apply per-file."""
        opts = options or {}
        # mpv loadfile signature: <url> [flags] [insertion-index] [options]
        reply = self.command("loadfile", str(path), "replace", -1, opts)
        return reply is not None and reply.get("error") == "success"

    def load_append(self, path: Path, options: dict | None = None) -> bool:
        """Append a file to the playlist with per-file options."""
        opts = options or {}
        reply = self.command("loadfile", str(path), "append", -1, opts)
        return reply is not None and reply.get("error") == "success"

    def load_full_playlist(self, items: list[tuple[Path, dict]]) -> bool:
        """Replace mpv's playlist with [items]. items is [(path, options_dict), ...]."""
        if not items:
            ok = self.command("playlist-clear") is not None
            self.command("stop")
            return ok
        first_path, first_opts = items[0]
        if not self.load_replace(first_path, first_opts):
            log.error("mpv: failed to load first item %s", first_path)
            return False
        for path, opts in items[1:]:
            if not self.load_append(path, opts):
                log.warning("mpv: failed to append %s (continuing)", path)
        log.info("mpv: loaded %d items", len(items))
        return True
