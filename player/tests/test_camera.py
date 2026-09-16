"""Room camera: ffmpeg capture in a background thread, upload shape, error surfacing."""
import dataclasses
import subprocess
import threading
import time

import pytest

from fakes import FakeCms, FakeMpv
from player import camera as camera_mod
from player import daemon
from player.camera import CameraCapture, CameraError, grab_jpeg
from player.daemon import PlayerState, run_cycle
from player.mpv_client import MpvClient

JPEG = b"\xff\xd8\xff\xe0" + b"\x00" * 64 + b"\xff\xd9"


@pytest.fixture
def cam_cfg(cfg):
    return dataclasses.replace(cfg, camera_source="rtsp", camera_rtsp_url="rtsp://cam.test/live",
                               camera_snapshot_interval_seconds=5)


@pytest.fixture
def cms(monkeypatch):
    c = FakeCms()
    c.install(monkeypatch)
    monkeypatch.setattr(daemon, "capture_and_upload", lambda cfg, mpv: True)
    return c


@pytest.fixture
def mpv(monkeypatch):
    fake = FakeMpv()
    fake.install(monkeypatch)
    return fake


@pytest.fixture
def ffmpeg(monkeypatch):
    """Fake subprocess.run: records (cmd, timeout), returns `result` or raises `raises`."""
    state = {"result": subprocess.CompletedProcess([], 0, stdout=JPEG, stderr=b""), "raises": None, "calls": []}

    def run(cmd, capture_output=False, timeout=None):
        state["calls"].append((list(cmd), timeout))
        if state["raises"]:
            raise state["raises"]
        return state["result"]

    monkeypatch.setattr(camera_mod.subprocess, "run", run)
    monkeypatch.delenv("PIPLAYER_CAMERA_SNAPSHOT_FILE", raising=False)
    monkeypatch.delenv("PIPLAYER_CAMERA_FFMPEG", raising=False)
    return state


def test_grab_runs_ffmpeg_with_tcp_and_timeout(ffmpeg):
    assert grab_jpeg("rtsp://cam.test/live") == JPEG
    cmd, timeout = ffmpeg["calls"][0]
    assert cmd[0] == "ffmpeg" and timeout == 15
    assert cmd[-1] == "-" and "rtsp://cam.test/live" in cmd
    assert cmd[cmd.index("-rtsp_transport") + 1] == "tcp"
    assert cmd[cmd.index("-frames:v") + 1] == "1" and cmd[cmd.index("-f") + 1] == "image2"


def test_non_rtsp_input_skips_the_transport_option(ffmpeg):
    grab_jpeg("http://cam.test/mjpeg")
    assert "-rtsp_transport" not in ffmpeg["calls"][0][0]


def test_ffmpeg_binary_env_hook(ffmpeg, monkeypatch):
    monkeypatch.setenv("PIPLAYER_CAMERA_FFMPEG", "/tmp/fake-ffmpeg")
    grab_jpeg("rtsp://x")
    assert ffmpeg["calls"][0][0][0] == "/tmp/fake-ffmpeg"


def test_snapshot_file_env_hook_skips_ffmpeg(ffmpeg, monkeypatch, tmp_path):
    f = tmp_path / "snap.jpg"
    f.write_bytes(JPEG)
    monkeypatch.setenv("PIPLAYER_CAMERA_SNAPSHOT_FILE", str(f))
    assert grab_jpeg("rtsp://x") == JPEG
    assert ffmpeg["calls"] == []


@pytest.mark.parametrize("result, text", [
    (subprocess.CompletedProcess([], 1, stdout=b"", stderr=b"x\nConnection refused\n"), "exit 1"),
    (subprocess.CompletedProcess([], 0, stdout=b"not a jpeg", stderr=b""), "no JPEG"),
    (subprocess.CompletedProcess([], 0, stdout=JPEG + b"\x00" * (2 * 1024 * 1024), stderr=b""), "too large"),
])
def test_grab_failures_raise_clear_errors(ffmpeg, result, text):
    ffmpeg["result"] = result
    with pytest.raises(CameraError, match=text):
        grab_jpeg("rtsp://x")


def test_grab_timeout(ffmpeg):
    ffmpeg["raises"] = subprocess.TimeoutExpired(["ffmpeg"], 15)
    with pytest.raises(CameraError, match="timed out"):
        grab_jpeg("rtsp://x")


def test_capture_uploads_like_screenshots(cam_cfg, cms, ffmpeg):
    cam = CameraCapture(cam_cfg)
    assert cam.capture_once() is True
    assert cam.error == ""
    url, headers, files = cms.upload_calls[0]
    assert url == "http://cms.test/api/camera/dev-1"
    assert headers["Authorization"] == "Bearer tok" and headers["User-Agent"].startswith("piplayer/")
    assert files == {"file": ("dev-1.jpg", JPEG, "image/jpeg")}


def test_capture_failure_sets_error_and_logs_once_per_10_min(cam_cfg, cms, ffmpeg, caplog, monkeypatch):
    ffmpeg["result"] = subprocess.CompletedProcess([], 1, stdout=b"", stderr=b"Connection refused")
    now = [1000.0]
    monkeypatch.setattr(camera_mod.time, "monotonic", lambda: now[0])
    cam = CameraCapture(cam_cfg)
    with caplog.at_level("WARNING", logger="piplayer.camera"):
        for _ in range(3):
            assert cam.capture_once() is False
        now[0] += 601
        cam.capture_once()
    assert "Connection refused" in cam.error and len(cam.error) <= 200
    assert cms.upload_calls == []
    assert sum("camera snapshot failed" in r.message for r in caplog.records) == 2
    # recovery clears the error
    ffmpeg["result"] = subprocess.CompletedProcess([], 0, stdout=JPEG, stderr=b"")
    assert cam.capture_once() is True and cam.error == ""


def test_upload_http_error_is_surfaced(cam_cfg, cms, ffmpeg):
    cms.post_status = 500
    cam = CameraCapture(cam_cfg)
    assert cam.capture_once() is False
    assert "HTTP 500" in cam.error


def test_upload_unreachable_is_surfaced(cam_cfg, cms, ffmpeg):
    cms.unreachable = True
    cam = CameraCapture(cam_cfg)
    assert cam.capture_once() is False
    assert "cannot connect" in cam.error


def test_update_interval_floor(cam_cfg):
    cam = CameraCapture(cam_cfg)
    cam.update_interval(2)
    assert cam.interval == 5
    cam.update_interval(30)
    assert cam.interval == 30


def test_thread_loops_and_stops(cam_cfg, cms, ffmpeg):
    cam = CameraCapture(cam_cfg)
    cam.interval = 0.01
    cam.start()
    deadline = time.monotonic() + 5
    while len(cms.upload_calls) < 3 and time.monotonic() < deadline:
        time.sleep(0.01)
    cam.stop()
    cam.join(timeout=5)
    assert not cam.is_alive() and len(cms.upload_calls) >= 3


def test_hung_ffmpeg_never_blocks_the_sync_loop(cam_cfg, cms, mpv, monkeypatch, tmp_path):
    release = threading.Event()
    started = threading.Event()

    def hang(cmd, capture_output=False, timeout=None):
        started.set()
        release.wait(10)
        return subprocess.CompletedProcess([], 0, stdout=JPEG, stderr=b"")

    monkeypatch.setattr(camera_mod.subprocess, "run", hang)
    monkeypatch.delenv("PIPLAYER_CAMERA_SNAPSHOT_FILE", raising=False)
    cam = CameraCapture(cam_cfg)
    cam.error = "camera unreachable"
    cam.start()
    assert started.wait(5)
    cms.manifest["camera_interval_seconds"] = 20
    client = MpvClient(tmp_path / "mpv.sock")
    state = PlayerState(backoff=5)
    t0 = time.monotonic()
    assert run_cycle(cam_cfg, client, state, camera=cam) is not None
    assert time.monotonic() - t0 < 2
    assert cms.sync_calls[-1]["camera_error"] == "camera unreachable"
    assert cam.interval == 20            # manifest cadence applied while the capture was still running
    release.set()
    cam.stop()
    cam.join(timeout=5)
