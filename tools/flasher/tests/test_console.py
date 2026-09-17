"""console.enroll / check_health / fetch_enrollment and the device-code sign-in against a stub console (the
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


def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


class StubConsole(http.server.BaseHTTPRequestHandler):
    """The /api/enroll contract shared by the cloud and Python consoles, /api/operator/enrollment, and the
    device-code sign-in (POST device-code, POST device-token: 428 pending / 200 once / 410 gone)."""
    devices = {}
    calls = []
    wyze_configured = False
    # sign-in: the code is approved once `polls` reaches approve_after (None: never), or denied outright
    approve_after = 1
    deny = False
    polls = 0
    claimed = False
    interval = 1

    @classmethod
    def reset(cls):
        cls.devices, cls.calls, cls.polls, cls.claimed = {}, [], 0, False
        cls.approve_after, cls.deny, cls.wyze_configured, cls.interval = 1, False, False, 1

    def log_message(self, *a):
        pass

    def _json(self, code, body):
        raw = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        if self.path == "/api/health":
            return self._json(200, {"ok": True})
        if self.path == "/api/operator/enrollment":
            self.calls.append((self.path, self.headers.get("Authorization")))
            if self.headers.get("Authorization") != f"Bearer {OPERATOR_TOKEN}":
                return self._json(401, {"detail": "invalid API token"})
            return self._json(200, {"console_url": f"http://127.0.0.1:{self.server.server_port}", "enrollment_key": KEY,
                                    "groups": [{"id": 1, "name": "Lobby"}, {"id": 2, "name": "Halls"}],
                                    "playlists": [{"id": 7, "name": "Loop"}], "timezone": "UTC",
                                    "wyze_configured": self.wyze_configured})
        self._json(404, {"detail": "Not Found"})

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
        self.calls.append((self.path, body))
        if self.path == "/api/operator/device-code":
            base = f"http://127.0.0.1:{self.server.server_port}"
            return self._json(200, {"device_code": "dc-" + "x" * 40, "user_code": "BCDF-GH",
                                    "verification_url": base + "/authorize", "expires_in": 600,
                                    "interval": self.interval})
        if self.path == "/api/operator/device-token":
            if body.get("device_code") != "dc-" + "x" * 40 or self.claimed:
                return self._json(410, {"detail": "unknown or expired code", "status": "gone"})
            if self.deny:
                return self._json(410, {"detail": "denied", "status": "denied"})
            StubConsole.polls += 1
            if self.approve_after is None or self.polls < self.approve_after:
                return self._json(428, {"status": "pending"})
            StubConsole.claimed = True  # one shot
            return self._json(200, {"token": OPERATOR_TOKEN, "username": "matt"})
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


def test_fetch_enrollment(stub):
    r = console.fetch_enrollment(stub + "/", " " + OPERATOR_TOKEN + " ")
    assert r["enrollment_key"] == KEY and r["console_url"] == stub and r["timezone"] == "UTC"
    assert r["wyze_configured"] is False
    StubConsole.wyze_configured = "yes"  # coerced to a bool
    try:
        assert console.fetch_enrollment(stub, OPERATOR_TOKEN)["wyze_configured"] is True
    finally:
        StubConsole.wyze_configured = False
    assert [g["name"] for g in r["groups"]] == ["Lobby", "Halls"] and [p["name"] for p in r["playlists"]] == ["Loop"]
    assert StubConsole.calls == [("/api/operator/enrollment", f"Bearer {OPERATOR_TOKEN}")] * 2
    with pytest.raises(console.ConsoleError, match="invalid API token"):
        console.fetch_enrollment(stub, "p5k_wrong")
    assert not any(path == "/api/enroll" for path, _ in StubConsole.calls)  # the fetch never enrolls
    with pytest.raises(console.ConsoleError, match="is this a Projection5000 console"):
        console.fetch_enrollment(stub + "/notaconsole", OPERATOR_TOKEN)


def test_device_code_sign_in_flow(stub):
    r = console.request_device_code(stub + "/", "MYPC")
    assert r["user_code"] == "BCDF-GH" and r["verification_url"] == stub + "/authorize"
    assert r["expires_in"] == 600 and r["interval"] == 1
    assert StubConsole.calls[-1] == ("/api/operator/device-code", {"hostname": "MYPC"})
    StubConsole.approve_after = 3
    for _ in range(2):  # not approved yet: 428 is Pending (a ConsoleError with code 428)
        with pytest.raises(console.Pending) as e:
            console.poll_device_token(stub, r["device_code"])
        assert e.value.code == 428 and isinstance(e.value, console.ConsoleError)
    assert console.poll_device_token(stub, r["device_code"]) == {"token": OPERATOR_TOKEN, "username": "matt"}
    # One shot: the same code is gone afterwards (410), which is a plain ConsoleError.
    with pytest.raises(console.ConsoleError, match="expired") as e:
        console.poll_device_token(stub, r["device_code"])
    assert e.value.code == 410 and not isinstance(e.value, console.Pending)
    with pytest.raises(console.ConsoleError, match="unknown or expired"):
        console.poll_device_token(stub, "dc-wrong")
    # Denied in the browser.
    StubConsole.claimed, StubConsole.deny = False, True
    with pytest.raises(console.ConsoleError, match="denied"):
        console.poll_device_token(stub, r["device_code"])
    # The token the flow yields is accepted by /api/operator/enrollment.
    assert console.fetch_enrollment(stub, OPERATOR_TOKEN)["enrollment_key"] == KEY


def test_device_code_tolerates_a_sparse_or_odd_answer(monkeypatch):
    class Sparse(http.server.BaseHTTPRequestHandler):
        body = {"device_code": "d", "user_code": "u", "verification_url": "http://x/authorize"}

        def log_message(self, *a):
            pass

        def do_POST(self):
            self.rfile.read(int(self.headers.get("Content-Length") or 0))
            raw = json.dumps(self.body).encode()
            self.send_response(200)
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

    srv, base = _serve(Sparse)
    try:
        r = console.request_device_code(base, "pc")
        assert r["expires_in"] == 600 and r["interval"] == 3  # spec defaults when the answer omits them
        Sparse.body = {"device_code": "d", "user_code": "u", "verification_url": "http://x", "interval": 0}
        assert console.request_device_code(base, "pc")["interval"] >= 1  # never a busy loop
        Sparse.body = {"user_code": "u"}
        with pytest.raises(console.ConsoleError, match="no device_code"):
            console.request_device_code(base, "pc")
        Sparse.body = {"username": "x"}
        with pytest.raises(console.ConsoleError, match="no token"):
            console.poll_device_token(base, "d")
        Sparse.body = {"token": " tok "}
        assert console.poll_device_token(base, "d") == {"token": "tok", "username": ""}
    finally:
        srv.shutdown()


def test_fetch_enrollment_tolerates_a_sparse_answer(monkeypatch):
    class Sparse(http.server.BaseHTTPRequestHandler):
        body = {"enrollment_key": " k-0123456789abcdefghij "}

        def log_message(self, *a):
            pass

        def do_GET(self):
            raw = json.dumps(self.body).encode()
            self.send_response(200)
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

    srv, base = _serve(Sparse)
    try:
        r = console.fetch_enrollment(base, OPERATOR_TOKEN)
        assert r == {"enrollment_key": "k-0123456789abcdefghij", "console_url": base, "groups": [], "playlists": [],
                     "wyze_configured": False}
        Sparse.body = {"enrollment_key": KEY, "groups": "no", "playlists": [{"id": 1}, {"id": 2, "name": "ok"}, 3]}
        assert console.fetch_enrollment(base, OPERATOR_TOKEN)["playlists"] == [{"id": 2, "name": "ok"}]
        Sparse.body = {"console_url": base}
        with pytest.raises(console.ConsoleError, match="no enrollment_key"):
            console.fetch_enrollment(base, OPERATOR_TOKEN)
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
