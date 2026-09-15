"""Registration flow against the real Python CMS (cms/) started on a free port (or $FLASHER_TEST_PORT)."""
import http.server
import os
import socket
import subprocess
import threading
import time
import urllib.request
from pathlib import Path

import pytest

import console

REPO = Path(__file__).resolve().parents[3]
CMS_DIR = REPO / "cms"
PYTHON = CMS_DIR / ".venv" / "Scripts" / "python.exe"


def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


# A fixed port would silently attach the tests to any other CMS already listening there.
PORT = int(os.environ.get("FLASHER_TEST_PORT") or _free_port())
BASE = f"http://127.0.0.1:{PORT}"
PASSWORD = "test1234"


@pytest.fixture(scope="module")
def cms(tmp_path_factory):
    if not PYTHON.exists():
        pytest.skip("cms/.venv not present")
    data = tmp_path_factory.mktemp("cmsdata")
    env = dict(os.environ, PIPLAYER_DATA_DIR=str(data / "data"), PIPLAYER_ADMIN_PASSWORD=PASSWORD)
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
        yield BASE
    finally:
        proc.kill()
        proc.wait()


def test_register_and_repeat(cms):
    token, created = console.register_device(cms + "/", "admin", PASSWORD, "lobby-projector", "Lobby Projector")
    assert created is True
    assert token and " " not in token and "\\" not in token and len(token) >= 16
    # Second run hits the 409 path, reports the reuse and returns the same token.
    assert console.register_device(cms, "admin", PASSWORD, "lobby-projector", "Lobby Projector") == (token, False)
    # A different name for the same id does not rename the console device; the caller is told it was reused.
    assert console.register_device(cms, "admin", PASSWORD, "lobby-projector", "Hall 2") == (token, False)
    # The id is normalised like the consoles do, so the token of the created device is found.
    token2, created2 = console.register_device(cms, "admin", PASSWORD, " Hall-2 ", "Hall 2")
    assert created2 is True and token2 != token


def test_bad_password(cms):
    with pytest.raises(console.ConsoleError) as e:
        console.register_device(cms, "admin", "wrong-password", "x", "X")
    assert "Invalid username or password" in str(e.value)


def test_bad_device_id_reports_detail(cms):
    with pytest.raises(console.ConsoleError) as e:
        console.register_device(cms, "admin", PASSWORD, "Bad Id", "X")
    assert "device_id" in str(e.value)


def test_unreachable_and_bad_url():
    port = _free_port()  # nothing listens here
    with pytest.raises(console.ConsoleError, match="cannot reach"):
        console.register_device(f"http://127.0.0.1:{port}", "admin", PASSWORD, "x", "X")
    with pytest.raises(console.ConsoleError):
        console.register_device(f"127.0.0.1:{port}", "admin", PASSWORD, "x", "X")


def _serve(handler_cls):
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler_cls)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, f"http://127.0.0.1:{srv.server_address[1]}"


def test_timeouts_and_not_a_console(monkeypatch):
    monkeypatch.setattr(console, "TIMEOUT", 1)

    class Slow(http.server.BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def do_GET(self):
            if self.path == "/login":
                time.sleep(3)  # headers never arrive in time: a bare TimeoutError inside urllib
            self.send_error(404)

    srv, base = _serve(Slow)
    try:
        with pytest.raises(console.ConsoleError, match="cannot reach .*/login"):
            console.register_device(base, "admin", "pw", "x", "X")
        with pytest.raises(console.ConsoleError, match="is this a Projection5000 console"):
            console.register_device(base + "/notaconsole", "admin", "pw", "x", "X")
    finally:
        srv.shutdown()


def test_expired_redirect_means_cookie_not_kept():
    class Expiring(http.server.BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def do_GET(self):
            body = b'<form><input name="csrf_token" value="abc"></form>'
            self.send_response(200)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_POST(self):
            self.rfile.read(int(self.headers.get("Content-Length") or 0))
            self.send_response(303)
            self.send_header("Location", "/login?expired=1")
            self.send_header("Content-Length", "0")
            self.end_headers()

    srv, base = _serve(Expiring)
    try:
        with pytest.raises(console.ConsoleError, match="use an https:// console URL"):
            console.register_device(base, "admin", "pw", "x", "X")
    finally:
        srv.shutdown()


def test_device_token_scrape_matches_both_console_layouts():
    c = console.Console("http://127.0.0.1:1")
    pages = [
        # Python CMS template
        'x <pre class="install-cmd">cd piplayer/player && \\\nDEVICE_ID=lobby-projector \\\nDEVICE_TOKEN=AbC-123_xyz \\\n'
        'CMS_URL=http://c \\\nsudo -E bash deploy/install-player.sh</pre>',
        # A reformatted snippet must still work
        'DEVICE_ID=lobby-projector DEVICE_TOKEN=AbC-123_xyz CMS_URL=http://c',
    ]
    for body in pages:
        c._open = lambda path, form=None, b=body: ("", b)
        assert c.device_token("lobby-projector") == "AbC-123_xyz"
    c._open = lambda path, form=None: ("", "DEVICE_ID=other \\\nDEVICE_TOKEN=zzz")
    with pytest.raises(console.ConsoleError, match="not found on /devices, or its token is hidden"):
        c.device_token("lobby-projector")
