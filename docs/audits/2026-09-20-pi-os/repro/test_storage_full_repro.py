import errno, sys
sys.path.insert(0, "tests")
from conftest import cfg
from test_daemon import mpv, screens, cms, client, fresh_state, run_cycle
from player import sync as sync_mod, status as status_mod


def test_storage_full_screen_needs_disk(cfg, cms, mpv, client, screens, monkeypatch):
    cms.files["a.mp4"] = b"A" * 10
    cms.set_playlist(["a.mp4"])
    def full(*a, **k):
        raise OSError(errno.ENOSPC, "No space left on device")
    monkeypatch.setattr(sync_mod, "_download_item", full)
    monkeypatch.setattr(status_mod, "render_png", full)      # the PNG cannot be written either
    state = fresh_state(cfg)
    run_cycle(cfg, client, state, screens=screens)
    assert state.storage_full is True
    assert "no space left on device" in state.last_sync_error
    assert screens.current is None                            # STORAGE FULL never shown
    assert mpv.commands("loadfile") == []                     # projector stays black


def test_no_free_space_check_anywhere():
    import inspect
    src = inspect.getsource(sync_mod)
    assert "disk_usage" not in src and "statvfs" not in src


def test_part_kept_after_enospc(cfg, monkeypatch, tmp_path):
    """The .part survives a mid-stream ENOSPC and the next call re-issues a Range request."""
    import requests
    class R:
        status_code = 200
        def __init__(self, hdrs): self.hdrs = hdrs
        def __enter__(self): return self
        def __exit__(self, *a): pass
        def raise_for_status(self): pass
        def iter_content(self, chunk_size):
            yield b"x" * 4
            raise OSError(errno.ENOSPC, "No space left on device")   # stand-in for out.write failing
    seen = []
    def get(url, headers=None, **k):
        seen.append(headers.get("Range")); return R(headers)
    monkeypatch.setattr(sync_mod.requests, "get", get)
    item = {"filename": "a.mp4", "url": "http://x/a", "sha256": "0" * 64, "size_bytes": 100}
    for _ in range(2):
        try:
            sync_mod._download_item(cfg, item, lambda: False)
        except OSError as e:
            assert e.errno == errno.ENOSPC
    assert (cfg.media_dir / "a.mp4.part").is_file()
    assert seen == [None, "bytes=4-"]
