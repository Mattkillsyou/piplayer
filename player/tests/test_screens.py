"""Status screen renderer: sizes, layout contract (texts + safe area), PNG/BGRA output, headlines."""
import time

import pytest
from PIL import Image

from player.screens import (
    HEIGHT, SAFE_X, SAFE_Y, WIDTH, ScreenState, headline, layout, render, render_overlay_bgra, render_png,
)

COMMON = dict(device_id="dev-1", device_name="Lobby", console_url="http://cms.test", version="0.2.0", clock="12:00:00")


def state(kind, **kw):
    return ScreenState(kind=kind, **COMMON, **kw)


ALL = [
    state("boot"),
    state("pairing"),
    state("waiting", playlist_name="Day", next_rule={"name": "Night", "playlist": "After", "starts_at": "2026-01-06T22:00:00+00:00"}),
    state("syncing", progress_done=3, progress_total=7, current_file="clip.mp4", bytes_done=1048576, bytes_total=4194304),
    state("offline", last_contact="4 min ago"),
    state("error", reason="token"),
    state("nowplaying", playlist_name="Day", item_count=3, source="device-default"),
]


def texts(st):
    return [t["text"] for t in layout(st)]


def assert_safe(st):
    for it in layout(st):
        assert it["x"] >= SAFE_X and it["y"] >= SAFE_Y, (st.kind, it)
        assert it["x"] + it["w"] <= WIDTH - SAFE_X, (st.kind, it)
        assert it["y"] + it["h"] <= HEIGHT - SAFE_Y, (st.kind, it)


@pytest.mark.parametrize("st", ALL, ids=[s.kind for s in ALL])
def test_every_kind_renders_full_frame_inside_safe_area(st):
    img = render(st)
    assert img.size == (WIDTH, HEIGHT)
    assert img.mode == ("RGBA" if st.kind == "nowplaying" else "RGB")
    assert_safe(st)


FULL = [s for s in ALL if s.kind not in ("pairing", "nowplaying")]


@pytest.mark.parametrize("st", FULL, ids=[s.kind for s in FULL])
def test_full_screens_carry_name_version_and_clock_but_no_id_or_console(st):
    joined = "\n".join(texts(st))
    assert "LOBBY" in joined and "v0.2.0" in joined and "12:00:00" in joined
    assert "dev-1" not in joined and "http://cms.test" not in joined
    assert headline(st) in texts(st)


@pytest.mark.parametrize("st", FULL + [ALL[1]], ids=[s.kind for s in FULL] + ["pairing"])
def test_no_screen_gives_instructions(st):
    joined = "\n".join(texts(st)).lower()
    for word in ("devices page", "assign", "check", "regenerate", "free space", "restart"):
        assert word not in joined, (st.kind, word)


def test_standby_shows_only_the_name_centered():
    it = layout(ALL[1])
    assert [t["text"] for t in it] == ["LOBBY"]
    assert it[0]["font"] == "display"
    assert abs(it[0]["x"] + it[0]["w"] / 2 - WIDTH / 2) <= 1
    assert abs(it[0]["y"] + it[0]["h"] / 2 - HEIGHT / 2) <= 1


def test_name_equal_to_id_shows_once_on_every_screen():
    for kind in ("pairing", "boot", "waiting", "syncing", "offline", "error"):
        t = texts(ScreenState(kind=kind, device_id="test", device_name="TEST", version="1", clock="12:00:00"))
        assert sum("test" in x.lower() for x in t) == 1, (kind, t)


def test_id_stands_in_only_when_the_name_is_empty():
    assert texts(ScreenState(kind="pairing", device_id="dev-1")) == ["DEV-1"]
    assert "DEV-1" in texts(ScreenState(kind="boot", device_id="dev-1", version="1", clock="12:00:00"))


def test_syncing_layout_has_filename_and_count():
    t = texts(ALL[3])
    assert "Downloading 3 of 7" in t and "clip.mp4" in t and "1.0 MB / 4.0 MB" in t
    verifying = state("syncing", phase="verifying", progress_done=2, progress_total=7, current_file="clip.mp4")
    assert "Verifying 2 of 7" in texts(verifying)


def test_waiting_layout_names_next_rule():
    t = texts(ALL[2])
    assert "Playlist Day has no items" in t
    assert any(x.startswith("Next: Night") and "After" in x and "Tue 22:00" in x for x in t)
    assert "No schedule rule is active" in texts(state("waiting", playlist_name=None))


def test_error_and_offline_wording():
    assert "No cached content" in texts(ALL[4]) and "Last contact 4 min ago" in texts(ALL[4])
    assert "Cannot reach the console" in texts(ALL[4])
    assert "Playing cached content" in texts(state("offline", cached=True))
    assert "The console refused this projector's token" in texts(ALL[5])
    assert "mpv exited" in texts(state("error", reason="player", message="mpv exited"))
    assert "Waiting for the first sync" in texts(ALL[0])


def test_nowplaying_layout():
    t = texts(ALL[6])
    assert t == ["NOW PLAYING", "Day", "3 items · via device-default"]


def test_long_filename_and_url_are_truncated_into_safe_area():
    st = state("syncing", progress_done=1, progress_total=1, current_file="f" * 300)
    assert_safe(st)
    shown = next(x for x in texts(st) if x.startswith("fff"))
    assert "…" in shown and len(shown) < 300
    assert_safe(ScreenState(kind="boot", device_id="d" * 120, version="1"))
    assert_safe(ScreenState(kind="pairing", device_name="N" * 120))
    assert_safe(ScreenState(kind="nowplaying", playlist_name="P" * 200, item_count=1))


def test_headline_table():
    assert [headline(state(k)) for k in ("boot", "pairing", "waiting", "syncing", "offline")] == [
        "BOOTING", "NOT ASSIGNED", "STANDING BY", "SYNCING", "OFFLINE"]
    assert headline(state("error", reason="token")) == "TOKEN REJECTED"
    assert headline(state("error", reason="player")) == "PLAYER FAULT"
    assert headline(state("error", reason="storage")) == "STORAGE FULL"
    assert headline(state("error", reason="other")) == "ERROR"
    assert headline(state("error")) == "ERROR"


def test_render_png_writes_valid_png(tmp_path):
    out = render_png(ALL[1], tmp_path / "screens" / "pairing.png")
    assert out.is_file() and not out.with_suffix(".png.tmp").exists()
    with Image.open(out) as img:
        assert img.format == "PNG" and img.size == (WIDTH, HEIGHT)


def test_render_overlay_bgra_is_premultiplied_raw(tmp_path):
    path, w, h = render_overlay_bgra(ALL[6], tmp_path / "nowplaying.bgra")
    data = path.read_bytes()
    assert (w, h) == (WIDTH, HEIGHT) and len(data) == w * h * 4
    assert data[:4] == b"\x00\x00\x00\x00"                  # top-left is fully transparent
    assert any(data[i] for i in range(3, len(data), 4))    # some alpha somewhere
    # premultiplied: no channel exceeds its alpha
    assert all(max(data[i:i + 3]) <= data[i + 3] for i in range(0, len(data), 4 * 997))


def test_all_screens_render_fast():
    t0 = time.perf_counter()
    for st in ALL:
        render(st)
    assert time.perf_counter() - t0 < 5
