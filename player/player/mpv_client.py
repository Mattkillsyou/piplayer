import itertools
import json
import logging
import socket
import time
from pathlib import Path

log = logging.getLogger("piplayer.mpv")


class MpvClient:
    """Minimal JSON-IPC client for mpv over a Unix socket.

    Every request carries a request_id; the reader keeps consuming lines
    (skipping asynchronous "event" messages, which mpv broadcasts to every
    IPC client) until the reply with the matching request_id arrives or the
    deadline passes.
    """

    def __init__(self, socket_path: Path):
        self.socket_path = socket_path
        self._ids = itertools.count(1)
        # path -> per-file options we loaded that path with (last applied playlist)
        self._entry_options: dict[str, dict] = {}
        # (index, path, new_options, re_add): the entry that was playing during
        # a seamless reload whose per-file options changed (or are unknown to
        # this daemon instance). It keeps playing with its old options and is
        # swapped for a fresh entry once playback has moved on (see
        # remove_stale_entry()); re_add is False when the fresh entry was
        # already appended (single-item playlist).
        self._stale: tuple[int, str, dict, bool] | None = None

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

    def wait_for_socket(self, max_wait_s: float = 60.0, should_stop=None) -> bool:
        """Poll until the socket accepts connections. Returns False on timeout
        or as soon as should_stop() reports a pending shutdown."""
        deadline = time.time() + max_wait_s
        while time.time() < deadline:
            if self.is_alive():
                return True
            if should_stop is not None and should_stop():
                return False
            time.sleep(0.5)
        return False

    @staticmethod
    def _match_reply(line: bytes, request_id: int) -> dict | None:
        line = line.strip()
        if not line:
            return None
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            log.debug("mpv: ignoring unparsable line %r", line[:200])
            return None
        if not isinstance(msg, dict):
            return None
        if "event" in msg:
            return None
        if msg.get("request_id") == request_id:
            return msg
        if "request_id" not in msg and "error" in msg:
            # very old mpv builds do not echo request_id; there is only one
            # in-flight request per connection, so this must be ours
            return msg
        log.debug("mpv: ignoring reply for another request: %r", line[:200])
        return None

    def _request(self, command, timeout: float = 5.0) -> dict | None:
        """Send one command (positional list or named-argument dict) and return
        the matching reply, or None on error/timeout."""
        request_id = next(self._ids)
        payload = (json.dumps({"command": command, "request_id": request_id}) + "\n").encode()
        try:
            with self._connect(timeout=timeout) as s:
                s.sendall(payload)
                buf = b""
                deadline = time.monotonic() + timeout
                while True:
                    while b"\n" in buf:
                        line, buf = buf.split(b"\n", 1)
                        msg = self._match_reply(line, request_id)
                        if msg is not None:
                            return msg
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        break
                    s.settimeout(remaining)
                    chunk = s.recv(4096)
                    if not chunk:
                        break
                    buf += chunk
            log.warning("mpv: no reply to %s within %.1fs", command, timeout)
            return None
        except (OSError, socket.timeout) as e:
            log.warning("mpv command %s failed: %s", command, e)
            return None

    def command(self, *args, timeout: float = 5.0) -> dict | None:
        """Send a single positional mpv command. Returns the parsed reply, or None on error."""
        return self._request(list(args), timeout=timeout)

    def command_named(self, name: str, timeout: float = 5.0, **kwargs) -> dict | None:
        """Send a command using mpv's named-argument form ({"name": ..., <arg>: ...})."""
        cmd = {"name": name}
        cmd.update(kwargs)
        return self._request(cmd, timeout=timeout)

    def get_property(self, name: str):
        reply = self.command("get_property", name)
        if reply is None or reply.get("error") != "success":
            return None
        return reply.get("data")

    def set_property(self, name: str, value) -> bool:
        reply = self.command("set_property", name, value)
        return reply is not None and reply.get("error") == "success"

    def get_version(self) -> str | None:
        """mpv's version string (e.g. 'mpv 0.35.1'), or None if unreachable."""
        v = self.get_property("mpv-version")
        return str(v) if v is not None else None

    def get_pid(self) -> int | None:
        """mpv's process id; changes on every restart."""
        pid = self.get_property("pid")
        try:
            return int(pid) if pid is not None else None
        except (TypeError, ValueError):
            return None

    def _loadfile(self, path: Path, flags: str, options: dict | None) -> bool:
        # Named-argument form: works unchanged on mpv 0.35 (Bookworm) and
        # 0.40 (Trixie); the positional form gained an <index> slot in 0.38
        # which older versions reject.
        opts = options or {}
        reply = self.command_named("loadfile", url=str(path), flags=flags, options=opts)
        ok = reply is not None and reply.get("error") == "success"
        # No reply (timeout) is NOT retried here: mpv may well have executed the
        # command and only the reply was lost, and a second "append" would
        # duplicate the entry. The caller reports failure and the daemon
        # re-pushes the whole playlist on its next cycle instead.
        if ok:
            self._entry_options[str(path)] = dict(opts)
        return ok

    def load_replace(self, path: Path, options: dict | None = None) -> bool:
        """Replace the entire playlist with this single file. Options apply per-file."""
        self._entry_options = {}
        return self._loadfile(path, "replace", options)

    def load_append(self, path: Path, options: dict | None = None) -> bool:
        """Append a file to the playlist with per-file options."""
        return self._loadfile(path, "append", options)

    def load_full_playlist(self, items: list[tuple[Path, dict]]) -> bool:
        """Replace mpv's playlist with [items] (restarts playback from the first item).
        items is [(path, options_dict), ...]."""
        self._stale = None
        if not items:
            ok = self.command("playlist-clear") is not None
            self.command("stop")
            self._entry_options = {}
            return ok
        first_path, first_opts = items[0]
        if not self.load_replace(first_path, first_opts):
            log.error("mpv: failed to load first item %s", first_path)
            return False
        for path, opts in items[1:]:
            if not self.load_append(path, opts):
                log.warning("mpv: failed to append %s; playlist push will be retried", path)
                return False
        log.info("mpv: loaded %d items", len(items))
        return True

    def apply_playlist(self, items: list[tuple[Path, dict]]) -> bool:
        """Make mpv's playlist equal to [items] without interrupting playback when
        possible ("seamless reload").

        If the currently playing file is still in the new list, mpv keeps playing
        it: playlist-clear (mpv keeps only the current entry), append every other
        item in the new order, then playlist-move the current entry to its target
        position. Only when the current file was removed from the list is a full
        `loadfile replace` done, which restarts playback from the first item.

        A per-file option change on the currently playing item cannot be applied
        to the entry already playing; that entry keeps its place (and old
        options) and is swapped for a fresh one once playback has moved on
        (remove_stale_entry), so the change takes effect on that item's next
        play and it is never shown twice in a row. Options are also treated as
        changed when this daemon instance never loaded the entry itself (daemon
        restarted under a running mpv), since they may have changed meanwhile.
        """
        self._stale = None
        if not items:
            return self.load_full_playlist(items)

        current = self.get_property("path")
        current = str(current) if current else None
        new_paths = [str(p) for p, _ in items]
        if current is None or current not in new_paths:
            if current is not None:
                log.info("mpv: current file %s left the playlist; reloading from the top", current)
            return self.load_full_playlist(items)

        recorded = self._entry_options.get(current)
        target = new_paths.index(current)
        new_opts = dict(items[target][1])
        stale = recorded is None or new_opts != recorded

        reply = self.command("playlist-clear")
        if reply is None or reply.get("error") != "success":
            log.warning("mpv: playlist-clear failed; playlist push will be retried")
            return False
        # playlist-clear keeps whatever was playing at that instant, which is
        # not necessarily the entry we read `path` for a round trip ago; if
        # playback moved on in between, the kept entry would be appended
        # again and moved to the wrong index, so start over from the top.
        kept = self.get_property("path")
        if (str(kept) if kept else None) != current:
            log.info("mpv: playback moved on during reload; reloading from the top")
            return self.load_full_playlist(items)

        for i, (path, opts) in enumerate(items):
            if i == target:
                continue
            if not self.load_append(path, opts):
                log.warning("mpv: failed to append %s; playlist push will be retried", path)
                return False
        if target > 0:
            # playlist-move <from> <to>: the moved entry takes the place of entry
            # <to>, so to end up at index `target` we move it before target+1
            reply = self.command("playlist-move", 0, target + 1)
            if reply is None or reply.get("error") != "success":
                log.warning("mpv: playlist-move failed; playlist push will be retried")
                return False
        if not stale:
            self._entry_options[current] = new_opts
            log.info("mpv: reloaded %d items seamlessly (kept playing %s)", len(items), Path(current).name)
            return True

        re_add = len(items) > 1
        if not re_add:
            # a one-item loop never moves off index 0: queue the fresh entry now
            if not self.load_append(Path(current), new_opts):
                log.warning("mpv: failed to append %s; playlist push will be retried", current)
                return False
        self._stale = (target, current, new_opts, re_add)
        if recorded is None:
            self._entry_options.pop(current, None)   # still unknown until swapped
        else:
            self._entry_options[current] = recorded
        log.info("mpv: reloaded %d items seamlessly; new options for %s apply on its next play",
                 len(items), Path(current).name)
        return True

    def remove_stale_entry(self) -> bool:
        """Swap the entry left behind by apply_playlist() for one carrying the
        new options once mpv has moved on from it. Safe to call every poll.
        Returns False when the swap failed and mpv's playlist no longer matches
        the manifest (the caller should schedule a full re-push)."""
        if self._stale is None:
            return True
        index, path, new_opts, re_add = self._stale
        pos = self.get_property("playlist-pos")
        if pos is None or int(pos) == index:
            return True
        self._stale = None
        reply = self.command("playlist-remove", index)
        if reply is None or reply.get("error") != "success":
            log.warning("mpv: could not remove superseded entry for %s", Path(path).name)
            return False
        if not re_add:
            self._entry_options[path] = new_opts
            log.info("mpv: removed superseded entry for %s", Path(path).name)
            return True
        if not self.load_append(Path(path), new_opts):
            log.warning("mpv: failed to re-add %s with its new options; playlist push will be retried",
                        Path(path).name)
            self._entry_options.pop(path, None)
            return False
        count = self.get_property("playlist-count")
        if count is None:
            return False
        if int(count) - 1 > index:
            # the fresh entry was appended at the end; put it back in its place
            reply = self.command("playlist-move", int(count) - 1, index)
            if reply is None or reply.get("error") != "success":
                log.warning("mpv: playlist-move failed; playlist push will be retried")
                return False
        log.info("mpv: applied new options for %s", Path(path).name)
        return True
