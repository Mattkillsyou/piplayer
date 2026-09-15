"""StatusScreens controller: dedup, overlay add/remove timing, clear() without stop."""
import pytest

from fakes import FakeMpv
from player import status as status_mod
from player.mpv_client import MpvClient
from player.screens import ScreenState
from player.status import StatusScreens


@pytest.fixture
def mpv(monkeypatch):
    fake = FakeMpv()
    fake.install(monkeypatch)
    return fake


@pytest.fixture
def screens(cfg, mpv):
    return StatusScreens(cfg, MpvClient(cfg.mpv_socket), "0.2.0")


def test_show_loads_png_once_and_dedups_identical_state(cfg, mpv, screens):
    assert screens.show(screens.state("boot", clock="10:00:00")) is True
    loads = mpv.commands("loadfile")
    assert len(loads) == 1
    assert loads[0]["url"].endswith("boot.png") and loads[0]["options"] == {"image-display-duration": "inf"}
    assert (cfg.manifest_path.parent / "screens" / "boot.png").is_file()
    assert screens.showing() and screens.current.kind == "boot"
    assert screens.show(screens.state("boot", clock="10:00:01")) is False     # clock ignored
    assert len(mpv.commands("loadfile")) == 1
    assert screens.show(screens.state("offline", last_contact="never")) is True
    assert len(mpv.commands("loadfile")) == 2 and screens.current.kind == "offline"


def test_show_reports_failure_and_keeps_previous_state(mpv, screens):
    mpv.fail_commands = {"loadfile"}
    assert screens.show(screens.state("boot")) is False
    assert not screens.showing()


def test_now_playing_overlay_is_added_then_removed_after_deadline(cfg, mpv, screens, monkeypatch):
    now = [1000.0]
    monkeypatch.setattr(status_mod.time, "monotonic", lambda: now[0])
    screens.now_playing("Day", 3, "device-default")
    (add,) = mpv.overlays
    assert add[:4] == ["overlay-add", 63, 0, 0] and add[4].endswith("nowplaying.bgra")
    assert add[5:] == [0, "bgra", 1920, 1080, 1920 * 4]
    assert (cfg.manifest_path.parent / "screens" / "nowplaying.bgra").stat().st_size == 1920 * 1080 * 4
    now[0] += StatusScreens.NOWPLAYING_SECONDS - 0.5
    screens.tick()
    assert len(mpv.overlays) == 1
    now[0] += 1
    screens.tick()
    screens.tick()
    assert mpv.overlays[1:] == [["overlay-remove", 63]]      # removed exactly once


def test_clear_forgets_without_stopping_mpv(mpv, screens):
    screens.show(screens.state("pairing"))
    n = len(mpv.requests)
    screens.clear()
    assert not screens.showing() and screens.current is None
    assert mpv.requests[n:] == []


def test_throttled_allows_once_per_window(screens, monkeypatch):
    now = [50.0]
    monkeypatch.setattr(status_mod.time, "monotonic", lambda: now[0])
    assert screens.throttled(2.0) is True
    assert screens.throttled(2.0) is False
    now[0] += 2.0
    assert screens.throttled(2.0) is True


def test_state_fills_identity(cfg, screens):
    st = screens.state("error", reason="token")
    assert st == ScreenState(kind="error", device_id="dev-1", console_url="http://cms.test", version="0.2.0", reason="token")


def test_show_survives_a_render_failure(cfg, monkeypatch):
    """A missing font or unwritable screens dir logs and returns False instead of raising."""
    from player import status as status_mod
    fake = FakeMpv()
    fake.install(monkeypatch)
    screens = StatusScreens(cfg, MpvClient(cfg.mpv_socket), "0.0.0")
    monkeypatch.setattr(status_mod, "render_png", lambda state, path: (_ for _ in ()).throw(OSError("no font")))
    assert screens.show(screens.state("boot")) is False
    assert screens.current is None
    assert fake.commands("loadfile") == []
