"""Scratch reproductions for the daemon audit (not part of the repo)."""
import errno
import json
import sys
from pathlib import Path
from urllib.parse import urlencode

import pytest
import requests

ROOT = Path("D:/Projection Software/piplayer-audit-pi/player")
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tests"))

from fakes import FakeCms, FakeMpv, FakeResponse  # noqa: E402
from player import daemon  # noqa: E402
from player import sync as sync_mod  # noqa: E402
from player import status as status_mod  # noqa: E402
from player.config import PlayerConfig  # noqa: E402
from player.daemon import PlayerState, run_cycle  # noqa: E402
from player.mpv_client import MpvClient  # noqa: E402
from player.screens import layout  # noqa: E402
from player.status import StatusScreens  # noqa: E402


@pytest.fixture
def cfg(tmp_path):
    media = tmp_path / "media"
    media.mkdir()
    return PlayerConfig(device_id="dev-1", device_token="tok", cms_url="https://console.example.com",
                        media_dir=media, manifest_path=tmp_path / "manifest.json",
                        mpv_socket=tmp_path / "mpv.sock", poll_interval_seconds=30, verify_tls=True)


@pytest.fixture
def mpv(monkeypatch):
    f = FakeMpv()
    f.install(monkeypatch)
    return f


@pytest.fixture
def cms(monkeypatch):
    c = FakeCms(base="https://console.example.com")
    c.install(monkeypatch)
    monkeypatch.setattr(daemon, "capture_and_upload", lambda cfg, mpv: True)
    return c


@pytest.fixture
def client(tmp_path):
    return MpvClient(tmp_path / "mpv.sock")


@pytest.fixture
def screens(cfg, client, monkeypatch):
    s = StatusScreens(cfg, client, "0.2.0")
    monkeypatch.setattr(s, "throttled", lambda seconds=2.0: True)
    return s


def texts(screens):
    return [t["text"] for t in layout(screens.current)]


def seed_local(cfg, cms, names):
    for n in names:
        cms.files[n] = n.encode() * 10
    cms.set_playlist(names)
    cfg.manifest_path.write_text(json.dumps(cms.manifest))
    for n in names:
        (cfg.media_dir / n).write_bytes(cms.files[n])


# 1. HTTP 5xx: the ERROR screen shows the raw requests text incl. the full sync URL with every status param
def test_http_500_screen_text(cfg, cms, mpv, client, screens, monkeypatch):
    real_get = cms.get

    def get(url, headers=None, params=None, **kw):
        if "/api/sync/" in url:
            full = url + "?" + urlencode(params or {})
            return FakeResponse(500, b"Internal Server Error", url=full)
        return real_get(url, headers=headers, params=params, **kw)
    monkeypatch.setattr(sync_mod.requests, "get", get)
    state = PlayerState(backoff=30)
    run_cycle(cfg, client, state, screens=screens)
    print("\nFAILURE TEXT:", state.failure_text)
    print("SCREEN:", texts(screens))
    assert "player_status" in state.failure_text and "CMS" in state.failure_text
    assert screens.current.kind == "error" and screens.current.reason == "other"


# 2. The PLAYER FAULT condition is never reported to the console
def test_player_fault_not_reported(cfg, cms, mpv, client, screens):
    seed_local(cfg, cms, ["a.mp4"])
    state = PlayerState(last_manifest=json.loads(cfg.manifest_path.read_text()), backoff=30)
    run_cycle(cfg, client, state, screens=screens)
    for _ in range(6):
        mpv.current = None
        run_cycle(cfg, client, state, screens=screens)
    assert screens.current is not None and screens.current.reason == "player"
    last = cms.sync_calls[-1]
    print("\nLAST SYNC PARAMS WHILE ON FAULT SCREEN:", last)
    assert last.get("sync_error", "") == "" and last.get("player_status") == "idle"


# 3. ENOSPC: prune of the old playlist runs only AFTER every new download has already failed
def test_prune_runs_after_downloads(cfg, cms, mpv, client, monkeypatch):
    seed_local(cfg, cms, ["old.mp4"])
    cms.files["new.mp4"] = b"N" * 10
    cms.set_playlist(["new.mp4"])
    order = []

    def dl(cfg_, item, *a, **k):
        order.append("download " + item["filename"])
        raise OSError(errno.ENOSPC, "No space left on device")
    orig_prune = sync_mod._prune_stale

    def prune(*a, **k):
        order.append("prune")
        return orig_prune(*a, **k)
    monkeypatch.setattr(sync_mod, "_download_item", dl)
    monkeypatch.setattr(sync_mod, "_prune_stale", prune)
    changed, manifest, err = sync_mod.sync_once(cfg)
    print("\nORDER:", order, "ERR:", err)
    assert order == ["download new.mp4", "prune"]
    assert "no space left" in err


# 4. SSLError (wrong clock) is shown as OFFLINE "console unreachable / check network"
def test_ssl_error_is_offline(cfg, cms, mpv, client, screens, monkeypatch):
    def get(url, **kw):
        raise requests.exceptions.SSLError("certificate verify failed: certificate is not yet valid")
    monkeypatch.setattr(sync_mod.requests, "get", get)
    state = PlayerState(backoff=30)
    run_cycle(cfg, client, state, screens=screens)
    print("\nSCREEN:", texts(screens), "backoff", state.backoff)
    assert screens.current.kind == "offline"
    assert state.last_failure == "unreachable"
    for _ in range(5):
        run_cycle(cfg, client, state, screens=screens)
    assert state.backoff == 300


# 5. Manifest item without filename: whole sync aborts with a Python error on screen
def test_missing_filename(cfg, cms, mpv, client, screens):
    cms.files["a.mp4"] = b"A" * 10
    cms.set_playlist(["a.mp4"])
    del cms.manifest["playlist"]["items"][0]["filename"]
    state = PlayerState(backoff=30)
    run_cycle(cfg, client, state, screens=screens)
    print("\nFAILURE:", state.last_failure, state.failure_text, texts(screens))
    assert state.last_failure == "sync" and "KeyError" in state.failure_text


# 6. STORAGE FULL screen cannot be rendered when the card is full (PNG write -> ENOSPC)
def test_storage_full_screen_needs_disk(cfg, cms, mpv, client, screens, monkeypatch):
    cms.files["a.mp4"] = b"A" * 10
    cms.set_playlist(["a.mp4"])

    def full(*a, **k):
        raise OSError(errno.ENOSPC, "No space left on device")
    monkeypatch.setattr(sync_mod, "_download_item", full)

    def render_png(state, path):
        raise OSError(errno.ENOSPC, "No space left on device")
    monkeypatch.setattr(status_mod, "render_png", render_png)
    state = PlayerState(backoff=30)
    run_cycle(cfg, client, state, screens=screens)
    assert state.storage_full is True
    assert screens.current is None            # nothing on the projector
    assert mpv.commands("loadfile") == []


# 7. Exception class names reach the console/screen as the reason
def test_timeout_reason_text(cfg, cms, mpv, client, screens, monkeypatch):
    cms.files["a.mp4"] = b"A" * 10
    cms.set_playlist(["a.mp4"])
    real_get = cms.get

    def get(url, **kw):
        if "/api/media/" in url:
            raise requests.exceptions.ReadTimeout("read timed out")
        return real_get(url, **kw)
    monkeypatch.setattr(sync_mod.requests, "get", get)
    state = PlayerState(backoff=30)
    run_cycle(cfg, client, state, screens=screens)
    run_cycle(cfg, client, state, screens=screens)
    print("\nSYNC_ERROR SENT:", cms.sync_calls[-1]["sync_error"], "SCREEN:", texts(screens))
    assert cms.sync_calls[-1]["sync_error"] == "download failed: a.mp4: ReadTimeout"


# 8. Frozen clock: the offline screen is rendered once and its HH:MM:SS never changes
def test_screen_clock_frozen(cfg, cms, mpv, client, screens, monkeypatch):
    cms.unreachable = True
    state = PlayerState(backoff=30)
    run_cycle(cfg, client, state, screens=screens)
    n = len(mpv.commands("loadfile"))
    base = daemon.time.monotonic()
    monkeypatch.setattr(daemon.time, "monotonic", lambda: base + 5 * 3600)     # hours later
    for _ in range(3):
        run_cycle(cfg, client, state, screens=screens)
    print("\nLOADS SINCE:", len(mpv.commands("loadfile")) - n, texts(screens))
    assert len(mpv.commands("loadfile")) - n == 1     # one re-render for "5 h ago", then frozen
