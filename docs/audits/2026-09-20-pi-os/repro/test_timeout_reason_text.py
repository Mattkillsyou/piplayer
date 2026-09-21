import sys
sys.path.insert(0, r"D:\Projection Software\piplayer-audit-pi\player\tests")
sys.path.insert(0, r"D:\Projection Software\piplayer-audit-pi\player")
import pytest, requests
from fakes import FakeCms
from player.sync import sync_once
from player.config import PlayerConfig

@pytest.fixture
def cfg(tmp_path):
    media = tmp_path / "media"; media.mkdir()
    return PlayerConfig(device_id="dev-1", device_token="tok", cms_url="http://cms.test", media_dir=media, manifest_path=tmp_path / "manifest.json", mpv_socket=tmp_path / "mpv.sock", poll_interval_seconds=5, verify_tls=True)

@pytest.fixture
def cms(monkeypatch):
    c = FakeCms(); c.install(monkeypatch); return c

@pytest.mark.parametrize("exc,expected", [
    (requests.ReadTimeout, "ReadTimeout"),
    (requests.ConnectTimeout, "ConnectTimeout"),
    (requests.exceptions.SSLError, "SSLError"),
    (requests.exceptions.ChunkedEncodingError, "ChunkedEncodingError"),
])
def test_timeout_reason_text(cfg, cms, monkeypatch, exc, expected):
    cms.files["a.mp4"] = b"A" * 10
    cms.set_playlist(["a.mp4"])
    real_get = cms.get
    def get(url, **kw):
        if "/api/media/" in url:
            raise exc("boom")
        return real_get(url, **kw)
    monkeypatch.setattr("player.sync.requests.get", get)
    _, _, err = sync_once(cfg)
    assert err == f"download failed: a.mp4: {expected}"
    # next sync sends that verbatim to the console
    sync_once(cfg, sync_error=err)  # as daemon.py:309-310 does
    assert cms.sync_calls[-1]["sync_error"] == f"download failed: a.mp4: {expected}"
