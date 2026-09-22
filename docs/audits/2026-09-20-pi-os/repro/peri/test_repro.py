"""Audit repros for the peripherals area (not part of the repo)."""
import base64, sys, types, time, subprocess
import pytest
from player import projector, camera as camera_mod
from player.projector import Projector
from player.camera import CameraCapture
from player import camera_config

PACKET = b"\x26\x00\x0a\x00" + bytes(range(16))
B64 = base64.b64encode(PACKET).decode()


@pytest.fixture
def rm(monkeypatch):
    class FakeRm:
        host = ("10.0.0.9", 80); sent = []; fail = 0
        def auth(self): return True
        def send_data(self, p):
            if self.fail: self.fail -= 1; raise OSError("timed out")
            self.sent.append(bytes(p))
    dev = FakeRm()
    mod = types.ModuleType("broadlink"); mod.exceptions = types.ModuleType("broadlink.exceptions")
    mod.hello = lambda host, timeout=10, **kw: dev
    mod.discover = lambda timeout=10, **kw: [dev]
    monkeypatch.setitem(sys.modules, "broadlink", mod)
    return dev


def toggle_block(want):
    # single-button toggle remote learned as both codes, as automation.md E step 3 recommends
    return {"control": "broadlink", "mode": "auto", "want": want, "codes": {"power_on": B64, "power_off": B64}}


def test_daemon_restart_resends_want_and_toggles_projector(rm):
    p = Projector()
    p.set_block(toggle_block("off"))
    assert p.maybe_apply() is True          # 17:10: off, projector now OFF (1 toggle)
    assert p.maybe_apply() is False
    # 03:00 nightly update-player.sh restarts projector-player.service: fresh Projector()
    p2 = Projector()
    p2.set_block(toggle_block("off"))       # want unchanged: nothing should be sent per the doc
    assert p2.maybe_apply() is True         # but it IS sent: toggle -> projector turns ON at 03:00
    assert len(rm.sent) == 2


def test_rm4_offline_at_0857_is_never_retried_all_day(rm):
    p = Projector()
    p.set_block(toggle_block("on"))
    rm.fail = 2                             # RM4 still booting after a power cut
    assert p.maybe_apply() is True
    assert p.state == "unknown" and p.error
    rm.fail = 0                             # RM4 back 30 s later
    for _ in range(100):                    # 100 polls = 50 min: never retried
        assert p.maybe_apply() is False
    assert rm.sent == []


def test_camera_cadence_is_interval_plus_capture_time(monkeypatch):
    # loop = capture (up to 15 s ffmpeg + 15 s upload) THEN wait(interval): period drifts
    waits = []
    cam = CameraCapture.__new__(CameraCapture)
    cam.rtsp_url = ""; cam.interval = 5
    class Ev:
        def is_set(self): return len(waits) >= 3
        def wait(self, t): waits.append(t)
    cam._stop = Ev()
    monkeypatch.setattr(CameraCapture, "capture_once", lambda self: time.sleep(0.05) or True)
    cam.run()
    assert waits == [5, 5, 5]              # the wait ignores the time the capture took


def test_ffmpeg_gets_any_url_scheme_from_the_console(monkeypatch):
    calls = []
    monkeypatch.setattr(camera_mod.subprocess, "run",
                        lambda cmd, **kw: calls.append(cmd) or subprocess.CompletedProcess([], 0, stdout=b"\xff\xd8\xff", stderr=b""))
    monkeypatch.delenv("PIPLAYER_CAMERA_SNAPSHOT_FILE", raising=False)
    cam = CameraCapture.__new__(CameraCapture); cam.error = ""
    cam.source, cam.rtsp_url, cam.interval = "none", "", 10
    camera_config.apply(types.SimpleNamespace(camera_source="none", camera_rtsp_url=""),
                        {"source": "rtsp", "rtsp_url": "subfile,,start,0,end,64,,:/var/lib/projector-player/tunnel.token"}, cam)
    assert cam.rtsp_url.startswith("subfile")
    camera_mod.grab_jpeg(cam.rtsp_url)
    assert calls[0][calls[0].index("-i") + 1].startswith("subfile")   # handed to ffmpeg -i unfiltered


def test_wyze_env_strip_mangles_passwords_with_edge_spaces():
    assert "WYZE_PASSWORD=p w\n" in camera_config.render_wyze_env({"password": " p w "})
