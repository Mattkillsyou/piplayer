"""Registration flow against the real Python CMS (cms/) started on a free port (or $FLASHER_TEST_PORT)."""
import os
import socket
import subprocess
import sys
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
    token = console.register_device(cms + "/", "admin", PASSWORD, "lobby-projector", "Lobby Projector")
    assert token and " " not in token and "\\" not in token and len(token) >= 16
    # Second run hits the 409 path and returns the same token.
    assert console.register_device(cms, "admin", PASSWORD, "lobby-projector", "Lobby Projector") == token


def test_bad_password(cms):
    with pytest.raises(console.ConsoleError) as e:
        console.register_device(cms, "admin", "wrong-password", "x", "X")
    assert "Invalid username or password" in str(e.value)


def test_bad_device_id_reports_detail(cms):
    with pytest.raises(console.ConsoleError) as e:
        console.register_device(cms, "admin", PASSWORD, "Bad Id", "X")
    assert "device_id" in str(e.value)


def test_unreachable_and_bad_url():
    with pytest.raises(console.ConsoleError):
        console.register_device("http://127.0.0.1:8934", "admin", PASSWORD, "x", "X")
    with pytest.raises(console.ConsoleError):
        console.register_device("127.0.0.1:8934", "admin", PASSWORD, "x", "X")
