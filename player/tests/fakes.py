"""Test doubles: an in-memory mpv speaking the JSON IPC wire protocol through a
fake socket, and a fake CMS for requests.get/post."""
import hashlib
import json
import socket

import requests


# ---------------------------------------------------------------- fake mpv ---

class FakeSocket:
    def __init__(self, server):
        self.server = server
        self.out = b""
        self.timeout = None
        self.closed = False

    def settimeout(self, t):
        self.timeout = t

    def sendall(self, data: bytes):
        self.out += self.server.handle(data)

    def recv(self, n: int) -> bytes:
        if not self.out:
            if self.server.recv_on_empty == "eof":
                return b""                      # mpv closed the connection
            if self.server.recv_on_empty == "events":
                # mpv keeps broadcasting events but our reply never comes
                self.out = json.dumps({"event": "tick"}).encode() + b"\n"
            else:
                # nothing more will ever arrive on this connection
                raise socket.timeout("timed out")
        chunk, self.out = self.out[:n], self.out[n:]
        return chunk

    def close(self):
        self.closed = True

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()


class FakeMpv:
    """Models the bits of mpv the daemon relies on: a playlist with per-entry
    options, the current entry, pid/version, and the IPC reply/event framing."""

    def __init__(self, version="mpv 0.35.1", pid=1000):
        self.version = version
        self.pid = pid
        self.alive = True
        self.playlist: list[dict] = []      # {"path": str, "opts": dict}
        self.current: dict | None = None
        self.paused = False
        self.requests: list[dict] = []      # every JSON message received, in order
        self.pending_events: list[str] = []  # event lines emitted before the next reply
        self.pending_prefix: list[str] = []  # arbitrary raw lines emitted before the next reply
        self.silent_commands: set[str] = set()  # command names that get no reply at all
        self.lost_reply_commands: set[str] = set()  # executed, but the reply never arrives
        self.fail_commands: set[str] = set()    # command names replied with an error
        self.recv_on_empty: str | None = None   # None: socket.timeout; "eof"; "events"
        self.screenshot_bytes: bytes | None = None  # written by screenshot-to-file when set
        # playback properties the daemon reads and writes; delete one to model an
        # mpv that does not know it ("property not found")
        self.props: dict = {"framedrop": "vo", "hwdec": "auto-safe", "hwdec-current": "no",
                            "estimated-vf-fps": 29.97}
        self.overlays: list = []             # overlay-add / overlay-remove commands, in order
        self.connections = 0

    # -- socket plumbing ------------------------------------------------------

    def connect(self, timeout=2.0):
        if not self.alive:
            raise OSError(111, "connection refused")
        self.connections += 1
        return FakeSocket(self)

    def install(self, monkeypatch):
        from player.mpv_client import MpvClient
        monkeypatch.setattr(MpvClient, "_connect", lambda client, timeout=2.0: self.connect(timeout))

    def handle(self, data: bytes) -> bytes:
        out = b""
        for line in data.split(b"\n"):
            if not line.strip():
                continue
            msg = json.loads(line)
            self.requests.append(msg)
            cmd = msg["command"]
            name = cmd["name"] if isinstance(cmd, dict) else cmd[0]
            reply = self._exec(cmd)
            if "request_id" in msg:
                reply["request_id"] = msg["request_id"]
            for ev in self.pending_prefix:
                out += ev.encode() + b"\n"
            self.pending_prefix = []
            for ev in self.pending_events:
                out += json.dumps({"event": ev}).encode() + b"\n"
            self.pending_events = []
            if reply.get("_silent") or name in self.lost_reply_commands:
                continue
            out += json.dumps(reply).encode() + b"\n"
        return out

    # -- convenience ----------------------------------------------------------

    def restart(self, pid=None):
        """Simulate systemd restarting mpv: new pid, empty playlist, idle."""
        self.pid = pid if pid is not None else self.pid + 1
        self.playlist = []
        self.current = None
        self.alive = True

    def commands(self, name=None) -> list:
        """The commands received (positional list or named dict), optionally filtered by name."""
        out = []
        for m in self.requests:
            c = m["command"]
            n = c["name"] if isinstance(c, dict) else c[0]
            if name is None or n == name:
                out.append(c)
        return out

    def paths(self) -> list[str]:
        return [e["path"] for e in self.playlist]

    @property
    def pos(self) -> int:
        return self.playlist.index(self.current) if self.current in self.playlist else -1

    def advance(self):
        """Playback finished the current entry: move to the next (looping)."""
        if not self.playlist:
            self.current = None
            return
        i = self.pos
        self.current = self.playlist[(i + 1) % len(self.playlist)]

    # -- command execution ----------------------------------------------------

    def _exec(self, cmd) -> dict:
        if isinstance(cmd, dict):
            name = cmd["name"]
            args = cmd
        else:
            name = cmd[0]
            args = cmd[1:]
        if name in self.silent_commands:
            return {"_silent": True}
        if name in self.fail_commands:
            return {"error": "invalid parameter"}

        if name == "get_property":
            return self._get_property(args[0])
        if name == "set_property":
            if args[0] == "pause":
                self.paused = bool(args[1])
            if args[0] in self.props:
                self.props[args[0]] = args[1]
            return {"error": "success"}
        if name == "loadfile":
            if not isinstance(cmd, dict):
                # positional form: mpv 0.35 rejects the 4-arg (index) variant
                if len(args) > 3:
                    return {"error": "invalid parameter"}
                url, flags = args[0], (args[1] if len(args) > 1 else "replace")
                opts = args[2] if len(args) > 2 else {}
            else:
                url, flags, opts = args["url"], args.get("flags", "replace"), args.get("options", {})
            entry = {"path": url, "opts": dict(opts)}
            if flags == "replace":
                self.playlist = [entry]
                self.current = entry
            elif flags == "append":
                self.playlist.append(entry)
            elif flags == "append-play":
                self.playlist.append(entry)
                if self.current is None:
                    self.current = entry
            else:
                return {"error": "invalid parameter"}
            return {"error": "success"}
        if name == "playlist-clear":
            self.playlist = [self.current] if self.current else []
            return {"error": "success"}
        if name == "playlist-move":
            i1, i2 = int(args[0]), int(args[1])
            if not (0 <= i1 < len(self.playlist)) or i2 < 0:
                return {"error": "invalid parameter"}
            entry = self.playlist[i1]
            at = self.playlist[i2] if i2 < len(self.playlist) else None
            if entry is at:
                return {"error": "success"}
            self.playlist.remove(entry)
            if at is None:
                self.playlist.append(entry)
            else:
                self.playlist.insert(self.playlist.index(at), entry)
            return {"error": "success"}
        if name == "playlist-remove":
            idx = int(args[0])
            if not (0 <= idx < len(self.playlist)):
                return {"error": "invalid parameter"}
            entry = self.playlist.pop(idx)
            if entry is self.current:
                self.current = self.playlist[idx % len(self.playlist)] if self.playlist else None
            return {"error": "success"}
        if name == "stop":
            self.playlist = []
            self.current = None
            return {"error": "success"}
        if name in ("overlay-add", "overlay-remove"):
            self.overlays.append(cmd)
            return {"error": "success"}
        if name == "screenshot-to-file":
            if self.screenshot_bytes is not None:
                from pathlib import Path
                Path(args[0]).write_bytes(self.screenshot_bytes)
            return {"error": "success"}
        return {"error": "invalid parameter"}

    def _get_property(self, prop) -> dict:
        if prop == "pid":
            return {"data": self.pid, "error": "success"}
        if prop == "mpv-version":
            return {"data": self.version, "error": "success"}
        if prop == "playlist-count":
            return {"data": len(self.playlist), "error": "success"}
        if prop == "playlist-pos":
            return {"data": self.pos, "error": "success"}
        if prop == "idle-active":
            return {"data": self.current is None, "error": "success"}
        if prop == "pause":
            return {"data": self.paused, "error": "success"}
        if prop == "path":
            if self.current is None:
                return {"error": "property unavailable"}
            return {"data": self.current["path"], "error": "success"}
        if prop in self.props:
            return {"data": self.props[prop], "error": "success"}
        return {"error": "property not found"}


# ---------------------------------------------------------------- fake CMS ---

class FakeResponse:
    def __init__(self, status_code, body=b"", json_body=None, url="", headers=None, drop_after=None):
        self.status_code = status_code
        self._body = body
        self._json = json_body
        self.url = url
        self.headers = headers or {}
        self.text = body.decode(errors="replace") if isinstance(body, bytes) else str(body)
        self._drop_after = drop_after

    def json(self):
        return self._json

    def raise_for_status(self):
        if self.status_code >= 400:
            raise requests.HTTPError(f"{self.status_code} error for {self.url}", response=self)

    def iter_content(self, chunk_size=1):
        sent = 0
        for i in range(0, len(self._body), chunk_size):
            chunk = self._body[i:i + chunk_size]
            if self._drop_after is not None and sent + len(chunk) > self._drop_after:
                partial = chunk[: self._drop_after - sent]
                if partial:
                    yield partial
                raise requests.ConnectionError("connection dropped mid-transfer")
            sent += len(chunk)
            yield chunk

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


class FakeCms:
    """Serves /api/sync/<id> from `self.manifest` and /api/media/<name> from `self.files`."""

    def __init__(self, base="http://cms.test"):
        self.base = base
        self.files: dict[str, bytes] = {}
        self.manifest: dict = {"device": {"id": "dev-1"}, "playlist": None, "commands": []}
        self.sync_calls: list[dict] = []     # params of every /api/sync call
        self.media_calls: list[tuple[str, dict]] = []  # (filename, headers)
        self.post_calls: list[tuple[str, dict]] = []
        self.upload_calls: list[tuple[str, dict, dict]] = []  # (url, headers, {field: (name, bytes, type)})
        self.ignore_range = False
        self.drop_after: dict[str, int] = {}  # filename -> bytes after which the connection drops
        self.sync_status = 200
        self.unreachable = False
        self.post_status = 200
        self.post_failures_left = 0

    def install(self, monkeypatch):
        import player.sync as sync_mod
        import player.commands as cmd_mod
        import player.screenshots as shot_mod
        import player.camera as camera_mod
        monkeypatch.setattr(sync_mod.requests, "get", self.get)
        monkeypatch.setattr(cmd_mod.requests, "post", self.post)
        monkeypatch.setattr(shot_mod.requests, "post", self.post)
        monkeypatch.setattr(camera_mod.requests, "post", self.post)

    def item(self, name: str, media_type="video", duration=None, position=None) -> dict:
        data = self.files[name]
        return {
            "position": position if position is not None else 0,
            "filename": name,
            "sha256": sha256(data),
            "size_bytes": len(data),
            "media_type": media_type,
            "natural_duration_seconds": None,
            "effective_duration_seconds": duration if duration is not None else (10 if media_type == "image" else None),
            "url": f"{self.base}/api/media/{name}",
        }

    def set_playlist(self, names, hash_=None, **item_kw):
        items = []
        for i, n in enumerate(names):
            it = self.item(n, position=i, **item_kw)
            items.append(it)
        h = hash_ or ("sha256:" + sha256(",".join(f"{i['position']}:{i['filename']}:{i['sha256']}:{i['effective_duration_seconds']}" for i in items).encode()))
        self.manifest["playlist"] = {"id": 1, "name": "pl", "source": "device-default", "hash": h, "items": items}
        return h

    def get(self, url, headers=None, params=None, stream=False, timeout=None, verify=True):
        if self.unreachable:
            raise requests.ConnectionError(f"cannot connect to {url}")
        headers = headers or {}
        if url.startswith(f"{self.base}/api/sync/"):
            self.sync_calls.append(dict(params or {}))
            if self.sync_status != 200:
                return FakeResponse(self.sync_status, b"nope", url=url)
            return FakeResponse(200, json_body=json.loads(json.dumps(self.manifest)), url=url)
        if url.startswith(f"{self.base}/api/media/"):
            name = url.rsplit("/", 1)[1]
            self.media_calls.append((name, dict(headers)))
            if name not in self.files:
                return FakeResponse(404, b"not found", url=url)
            data = self.files[name]
            rng = headers.get("Range")
            drop = self.drop_after.get(name)
            if rng and not self.ignore_range:
                start = int(rng.split("=")[1].rstrip("-"))
                if start >= len(data):
                    return FakeResponse(416, url=url)
                return FakeResponse(206, data[start:], url=url,
                                    headers={"Content-Range": f"bytes {start}-{len(data)-1}/{len(data)}"},
                                    drop_after=drop)
            return FakeResponse(200, data, url=url, drop_after=drop)
        return FakeResponse(404, b"unknown url", url=url)

    def post(self, url, headers=None, json=None, timeout=None, verify=True, files=None):
        if self.unreachable:
            raise requests.ConnectionError(f"cannot connect to {url}")
        if self.post_failures_left > 0:
            self.post_failures_left -= 1
            raise requests.ConnectionError("post failed")
        if files is not None:
            self.upload_calls.append((url, dict(headers or {}),
                                      {k: (v[0], v[1].read(), v[2]) for k, v in files.items()}))
            return FakeResponse(self.post_status, b"{}", json_body={"ok": True}, url=url)
        self.post_calls.append((url, dict(json or {})))
        return FakeResponse(self.post_status, b"{}", json_body={"ok": True}, url=url)
