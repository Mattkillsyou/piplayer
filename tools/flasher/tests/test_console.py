"""console.enroll / check_health and the operator API (login, me, register_device) against a stub console (the
request/response shapes from the flasher spec), plus one integration test against the real Python CMS (cms/)
on a free port that is skipped until that CMS answers /api/enroll."""
import http.server
import json
import os
import socket
import sqlite3
import subprocess
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

import pytest

import console

REPO = Path(__file__).resolve().parents[3]
CMS_DIR = REPO / "cms"
PYTHON = CMS_DIR / ".venv" / "Scripts" / "python.exe"
KEY = "stub-enrollment-key_0123456789abcdef"
OPERATOR_TOKEN = "p5k_" + "o" * 32
VIEWER_TOKEN = "p5k_" + "v" * 32
VIEW_ONLY = "This account can only view; ask an admin to make it an editor"
TAKEN = "A projector with that ID belongs to another account; pick another name"


def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


class StubConsole(http.server.BaseHTTPRequestHandler):
    """The /api/enroll contract shared by the cloud and Python consoles, and the cloud's operator API as the
    flasher spec states it: POST /api/operator/login (matt/secret is an editor, viewer/secret can only view,
    any other pair is 401, a third failure is 429), GET /api/operator/me and POST /api/operator/devices
    (a device_id owned by another account is 409)."""
    devices = {}
    calls = []
    wyze_configured = False
    failures = 0
    others = ("taken",)  # device ids that belong to another account

    @classmethod
    def reset(cls):
        cls.devices, cls.calls, cls.failures, cls.wyze_configured = {}, [], 0, False

    def log_message(self, *a):
        pass

    def _json(self, code, body):
        raw = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def _operator(self):
        """The bearer token's (username, role); None (and a 401 sent) for anything else."""
        auth = self.headers.get("Authorization")
        if auth == f"Bearer {OPERATOR_TOKEN}":
            return "matt", "editor"
        if auth == f"Bearer {VIEWER_TOKEN}":
            return "viewer", "viewer"
        self._json(401, {"detail": "invalid API token"})
        return None

    def do_GET(self):
        if self.path == "/api/health":
            return self._json(200, {"ok": True})
        if self.path == "/api/operator/me":
            self.calls.append((self.path, self.headers.get("Authorization")))
            who = self._operator()
            if not who:
                return
            if who[1] == "viewer":
                return self._json(403, {"detail": VIEW_ONLY})
            return self._json(200, {"username": who[0], "role": who[1],
                                    "console_url": f"http://127.0.0.1:{self.server.server_port}",
                                    "groups": [{"id": 1, "name": "Lobby"}, {"id": 2, "name": "Halls"}],
                                    "playlists": [{"id": 7, "name": "Loop"}], "timezone": "UTC",
                                    "wyze_configured": self.wyze_configured})
        self._json(404, {"detail": "Not Found"})

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
        self.calls.append((self.path, body))
        if self.path == "/api/operator/login":
            if self.failures >= 3:  # the flasher reads the wait from the detail, not from Retry-After
                return self._json(429, {"detail": "Too many failed attempts; try again in 60 s"})
            if body.get("password") != "secret" or body.get("username") not in ("matt", "viewer"):
                StubConsole.failures += 1
                return self._json(401, {"detail": "Invalid username or password"})
            if body["username"] == "viewer":
                return self._json(403, {"detail": VIEW_ONLY})
            return self._json(200, {"token": OPERATOR_TOKEN, "username": "matt", "role": "editor"})
        if self.path == "/api/operator/devices":
            who = self._operator()
            if not who:
                return
            if who[1] == "viewer":
                return self._json(403, {"detail": VIEW_ONLY})
            dev = (body.get("device_id") or "").lower()
            if not dev.replace("-", "").isalnum():
                return self._json(400, {"detail": "device_id must be lowercase alphanumeric + hyphens, 1-63 chars"})
            if dev in self.others:
                return self._json(409, {"detail": TAKEN})
            created = dev not in self.devices
            entry = self.devices.setdefault(dev, {})
            entry.update(name=body.get("name"), pi_model=body.get("pi_model"), owner=who[0],
                         token=f"tok-{dev}-{len(self.calls):04d}xxxxxxxxxx")  # a new token every time
            return self._json(201 if created else 200,
                              {"device_id": dev, "token": entry["token"], "owner": who[0], "created": created,
                               "cms_url": f"http://127.0.0.1:{self.server.server_port}"})
        if self.path != "/api/enroll":
            return self._json(404, {"detail": "Not Found"})
        if body.get("key") != KEY:
            return self._json(401, {"detail": "invalid enrollment key"})
        dev = (body.get("device_id") or "").lower()
        if not dev.replace("-", "").isalnum():
            return self._json(400, {"detail": "device_id must be lowercase letters, digits and hyphens"})
        entry = self.devices.setdefault(dev, {"token": f"tok-{dev}-{len(self.devices):04d}xxxxxxxxxx"})
        entry["name"] = body.get("name")
        self._json(200, {"device_id": dev, "token": entry["token"], "cms_url": f"http://127.0.0.1:{self.server.server_port}"})


def _serve(handler_cls):
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler_cls)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, f"http://127.0.0.1:{srv.server_address[1]}"


@pytest.fixture
def stub():
    StubConsole.reset()
    srv, base = _serve(StubConsole)
    try:
        yield base
    finally:
        srv.shutdown()


def test_enroll_and_reenroll(stub):
    token, cms_url = console.enroll(stub + "/", KEY, "lobby-projector", "Lobby Projector")
    assert token.startswith("tok-lobby-projector") and cms_url == stub
    # Same device_id again: the console keeps the token (and takes the new name).
    assert console.enroll(stub, KEY, " Lobby-Projector ", "Hall 2") == (token, stub)
    assert StubConsole.devices["lobby-projector"]["name"] == "Hall 2"
    assert StubConsole.calls[-1] == ("/api/enroll", {"key": KEY, "device_id": "lobby-projector", "name": "Hall 2"})
    token2, _ = console.enroll(stub, KEY, "hall-3", "Hall 3")
    assert token2 != token


def test_bad_key_reports_the_servers_detail(stub):
    with pytest.raises(console.ConsoleError, match="invalid enrollment key"):
        console.enroll(stub, "wrong-key-0123456789abcdef", "x", "X")
    with pytest.raises(console.ConsoleError, match="device_id"):
        console.enroll(stub, KEY, "Bad Id", "X")


def test_check_health(stub):
    console.check_health(stub)
    with pytest.raises(console.ConsoleError, match="is this a Projection5000 console"):
        console.check_health(stub + "/notaconsole")
    assert not any(path == "/api/enroll" for path, _ in StubConsole.calls)  # a health check never enrolls


def test_login(stub):
    r = console.login(stub + "/", " matt ", "secret", "MYPC")
    assert r == {"token": OPERATOR_TOKEN, "username": "matt", "role": "editor"}
    assert StubConsole.calls[-1] == ("/api/operator/login", {"username": "matt", "password": "secret",
                                                            "hostname": "MYPC"})
    # The wrong password, a view-only account and the throttle: the console's own words, with the status code.
    with pytest.raises(console.ConsoleError, match="Invalid username or password") as e:
        console.login(stub, "matt", "wrong", "MYPC")
    assert e.value.code == 401 and e.value.plain() == "Invalid username or password"
    with pytest.raises(console.ConsoleError, match="can only view") as e:
        console.login(stub, "viewer", "secret", "MYPC")
    assert e.value.code == 403 and e.value.plain() == VIEW_ONLY
    for _ in range(2):
        with pytest.raises(console.ConsoleError):
            console.login(stub, "matt", "wrong", "MYPC")
    with pytest.raises(console.ConsoleError, match="Too many failed attempts; try again in 60 s") as e:
        console.login(stub, "matt", "secret", "MYPC")
    assert e.value.code == 429
    assert not any(path == "/api/enroll" for path, _ in StubConsole.calls)  # a sign-in never enrolls
    with pytest.raises(console.ConsoleError, match="is this a Projection5000 console"):
        console.login(stub + "/notaconsole", "matt", "secret", "MYPC")


def test_me(stub):
    r = console.me(stub + "/", " " + OPERATOR_TOKEN + " ")
    assert r["username"] == "matt" and r["role"] == "editor" and r["console_url"] == stub and r["timezone"] == "UTC"
    assert r["wyze_configured"] is False
    StubConsole.wyze_configured = "yes"  # coerced to a bool
    try:
        assert console.me(stub, OPERATOR_TOKEN)["wyze_configured"] is True
    finally:
        StubConsole.wyze_configured = False
    assert [g["name"] for g in r["groups"]] == ["Lobby", "Halls"] and [p["name"] for p in r["playlists"]] == ["Loop"]
    assert StubConsole.calls == [("/api/operator/me", f"Bearer {OPERATOR_TOKEN}")] * 2
    with pytest.raises(console.ConsoleError, match="invalid API token") as e:
        console.me(stub, "p5k_wrong")
    assert e.value.code == 401
    with pytest.raises(console.ConsoleError, match="can only view") as e:  # a viewer's token: 403, same words
        console.me(stub, VIEWER_TOKEN)
    assert e.value.code == 403 and e.value.plain() == VIEW_ONLY
    assert not any(path == "/api/enroll" for path, _ in StubConsole.calls)  # the check never enrolls
    with pytest.raises(console.ConsoleError, match="is this a Projection5000 console"):
        console.me(stub + "/notaconsole", OPERATOR_TOKEN)


def test_register_device(stub):
    r = console.register_device(stub + "/", OPERATOR_TOKEN, " Lobby-Projector ", "Lobby Projector", "Raspberry Pi 5")
    assert r == {"device_id": "lobby-projector", "token": r["token"], "cms_url": stub, "owner": "matt", "created": True}
    assert r["token"].startswith("tok-lobby-projector")
    assert StubConsole.calls[-1] == ("/api/operator/devices", {"device_id": "lobby-projector", "name": "Lobby Projector",
                                                              "pi_model": "Raspberry Pi 5"})
    assert StubConsole.devices["lobby-projector"]["owner"] == "matt"
    # The same id again (a re-flash): not created, a fresh token, the new name.
    r2 = console.register_device(stub, OPERATOR_TOKEN, "lobby-projector", "Hall 2")
    assert r2["created"] is False and r2["token"] != r["token"] and r2["owner"] == "matt"
    assert StubConsole.devices["lobby-projector"]["name"] == "Hall 2"
    # Another account's projector, a view-only account, a revoked token: the console's words and the code.
    with pytest.raises(console.ConsoleError, match="belongs to another account") as e:
        console.register_device(stub, OPERATOR_TOKEN, "taken", "Taken")
    assert e.value.code == 409 and e.value.plain() == TAKEN
    with pytest.raises(console.ConsoleError, match="can only view") as e:
        console.register_device(stub, VIEWER_TOKEN, "hall-3", "Hall 3")
    assert e.value.code == 403
    with pytest.raises(console.ConsoleError, match="invalid API token") as e:
        console.register_device(stub, "p5k_wrong", "hall-3", "Hall 3")
    assert e.value.code == 401
    with pytest.raises(console.ConsoleError, match="device_id"):
        console.register_device(stub, OPERATOR_TOKEN, "Bad Id", "X")
    assert not any(path == "/api/enroll" for path, _ in StubConsole.calls)  # the flasher never enrolls


def test_operator_api_tolerates_a_sparse_answer(monkeypatch):
    class Sparse(http.server.BaseHTTPRequestHandler):
        body = {}

        def log_message(self, *a):
            pass

        def do_GET(self):
            raw = json.dumps(self.body).encode()
            self.send_response(200)
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def do_POST(self):
            self.rfile.read(int(self.headers.get("Content-Length") or 0))
            self.do_GET()

    srv, base = _serve(Sparse)
    try:
        assert console.me(base, OPERATOR_TOKEN) == {"username": "", "console_url": base, "groups": [],
                                                    "playlists": [], "wyze_configured": False}
        Sparse.body = {"username": "matt", "groups": "no", "playlists": [{"id": 1}, {"id": 2, "name": "ok"}, 3]}
        assert console.me(base, OPERATOR_TOKEN)["playlists"] == [{"id": 2, "name": "ok"}]
        with pytest.raises(console.ConsoleError, match="no token"):
            console.login(base, "matt", "secret", "pc")
        with pytest.raises(console.ConsoleError, match="no token"):
            console.register_device(base, OPERATOR_TOKEN, "lobby", "Lobby")
        Sparse.body = {"token": " tok "}
        assert console.login(base, " matt ", "secret", "pc") == {"token": "tok", "username": "matt", "role": ""}
        assert console.register_device(base, OPERATOR_TOKEN, " Lobby ", "Lobby") == {
            "device_id": "lobby", "token": "tok", "cms_url": base, "owner": "", "created": False}
    finally:
        srv.shutdown()


def test_unreachable_and_bad_url():
    port = _free_port()  # nothing listens here
    with pytest.raises(console.ConsoleError, match="cannot reach"):
        console.enroll(f"http://127.0.0.1:{port}", KEY, "x", "X")
    with pytest.raises(console.ConsoleError, match="http:// or https://"):
        console.enroll(f"127.0.0.1:{port}", KEY, "x", "X")


def test_timeout_and_non_json(monkeypatch):
    monkeypatch.setattr(console, "TIMEOUT", 1)

    class Odd(http.server.BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def do_POST(self):
            time.sleep(3)  # headers never arrive in time: a bare TimeoutError inside urllib
            self.send_error(500)

        def do_GET(self):
            body = b"<html>not a console</html>"
            self.send_response(200)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    srv, base = _serve(Odd)
    try:
        with pytest.raises(console.ConsoleError, match="cannot reach .*/api/enroll"):
            console.enroll(base, KEY, "x", "X")
        with pytest.raises(console.ConsoleError, match="not a JSON response"):
            console.check_health(base)
    finally:
        srv.shutdown()


# ---------------------------------------------------------------- the real Python CMS

# A fixed port would silently attach the test to any other CMS already listening there.
PORT = int(os.environ.get("FLASHER_TEST_PORT") or _free_port())
BASE = f"http://127.0.0.1:{PORT}"


@pytest.fixture(scope="module")
def cms(tmp_path_factory):
    if not PYTHON.exists():
        pytest.skip("cms/.venv not present")
    data = tmp_path_factory.mktemp("cmsdata") / "data"
    env = dict(os.environ, PIPLAYER_DATA_DIR=str(data), PIPLAYER_ADMIN_PASSWORD="test1234")
    proc = subprocess.Popen(
        [str(PYTHON), "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", str(PORT)],
        cwd=str(CMS_DIR), env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        for _ in range(100):
            if proc.poll() is not None:
                pytest.fail("CMS exited early")
            try:
                urllib.request.urlopen(BASE + "/api/health", timeout=1).close()
                break
            except Exception:
                time.sleep(0.2)
        else:
            pytest.fail("CMS did not come up")
        yield BASE, data
    finally:
        proc.kill()
        proc.wait()


def test_real_cms_enrolls(cms):
    base, data = cms
    try:
        console.enroll(base, "probe-key-0123456789abcdef", "probe", "Probe")
    except console.ConsoleError as e:
        if "Not Found" in str(e) or "is this a Projection5000 console" in str(e):
            pytest.skip("this CMS has no /api/enroll yet")
        assert "invalid enrollment key" in str(e)
    try:
        with sqlite3.connect(data / "cms.db") as con:
            key = con.execute("SELECT value FROM settings WHERE key = 'enrollment_key'").fetchone()[0]
    except (sqlite3.Error, TypeError) as e:
        pytest.skip(f"cannot read the CMS enrollment key: {e}")
    token, cms_url = console.enroll(base + "/", key, "lobby-projector", "Lobby Projector")
    assert token and " " not in token and len(token) >= 16 and cms_url.startswith("http")
    assert console.enroll(base, key, "Lobby-Projector", "Renamed")[0] == token  # re-flash keeps the identity
    with pytest.raises(console.ConsoleError, match="device_id"):
        console.enroll(base, key, "Bad Id", "X")
