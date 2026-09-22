"""The Pi model row: the table, the remembered choice, and which image each model gets."""
import hashlib
import http.server
import threading

import pytest

import flasher
from conftest import signed_in
import imagefetch
import pimodel
from test_flasher import DISK, FORM, FULL, _bundled_exe, _flash_stubs, _fill, _log, _pump, _root, _shown_errors

FAKE = bytes(range(256)) * 4096  # 1 MiB
FAKE_SHA = hashlib.sha256(FAKE).hexdigest()
ARMHF = "2026-09-15-raspios-trixie-armhf-lite.img.xz"


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_HEAD(self):
        self.do_GET(head=True)

    def do_GET(self, head=False):
        if self.path == "/raspios_lite_armhf_latest":
            self.send_response(302)
            self.send_header("Location", f"/raspios/{ARMHF}")
            self.end_headers()
        elif self.path == f"/raspios/{ARMHF}":
            self.send_response(200)
            self.send_header("Content-Length", str(len(FAKE)))
            self.end_headers()
            if not head:
                self.wfile.write(FAKE)
        elif self.path == f"/raspios/{ARMHF}.sha256":
            body = f"{FAKE_SHA}  {ARMHF}\n".encode()
            self.send_response(200)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        else:
            self.send_error(404)


@pytest.fixture(scope="module")
def server():
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{srv.server_address[1]}"
    srv.shutdown()


def _obtain(v, dry_run=False):
    lines = []
    out = flasher.obtain_image(dict(FULL, **v), lines.append, lambda p, t: None, threading.Event(), dry_run)
    return out, "\n".join(lines)


def test_table_order_and_arch():
    keys = [m.key for m in pimodel.MODELS]
    assert keys == ["pi5", "pi4", "pi3", "zero2", "pi2v12", "pi2", "zero", "pi1bplus"]  # newest first
    assert len(set(keys)) == len(keys) and pimodel.DEFAULT == "pi5"
    assert pimodel.MODELS[-1].label == "Raspberry Pi 1 Model B+ / A+" and "B+" in pimodel.LABELS[-1]
    assert {m.key for m in pimodel.MODELS if m.arch == "armhf"} == {"pi2", "zero", "pi1bplus"}
    assert all(m.arch in ("arm64", "armhf") and m.hint and m.ram_mb >= 256 for m in pimodel.MODELS)
    assert [m.key for m in pimodel.MODELS if m.camera] == ["pi5", "pi4", "pi3", "pi2v12"]
    assert pimodel.get("nonsense").key == "pi5" and pimodel.get(None).key == "pi5"
    assert pimodel.get("zero").arch == "armhf"
    assert pimodel.by_label("Raspberry Pi 2 Model B V1.1").key == "pi2" and pimodel.by_label("?").key == "pi5"
    assert "pi1bplus  armhf  Raspberry Pi 1 Model B+ / A+" in pimodel.table()


def test_model_row_sits_under_device_name_and_updates_the_hint(monkeypatch):
    monkeypatch.setattr(flasher.disk, "list_disks", lambda: [])
    root = _root()
    app = flasher.App(root)
    form = app.model_box.master
    assert form is app.id_label.master
    name_row = next(w.grid_info()["row"] for w in form.winfo_children()
                    if isinstance(w, flasher.ttk.Label) and w.cget("text") == "Device name")
    model_row = next(w.grid_info()["row"] for w in form.winfo_children()
                     if isinstance(w, flasher.ttk.Label) and w.cget("text") == "Pi model")
    assert name_row < model_row == app.model_box.grid_info()["row"] < app.ssid_box.grid_info()["row"]
    assert app.model_hint.grid_info()["row"] == model_row + 1
    assert str(app.model_box["state"]) == "readonly" and list(app.model_box["values"]) == pimodel.LABELS
    # Default pi5, hint shown; picking a row changes the key and the hint.
    assert app.model_box.get() == "Raspberry Pi 5 / 500" and app.v["pi_model"].get() == "pi5"
    assert app.model_hint.cget("text") == "Best pick. 4K video, camera, remote access."
    app.model_box.current(pimodel.LABELS.index("Raspberry Pi Zero / Zero W"))
    app.model_box.event_generate("<<ComboboxSelected>>")
    assert app.v["pi_model"].get() == "zero" and app.model_hint.cget("text").startswith("32-bit image, downloaded once")
    assert app.values()["pi_model"] == "zero"
    root.destroy()


def test_model_is_remembered_and_a_bad_value_falls_back(monkeypatch):
    monkeypatch.setattr(flasher.disk, "list_disks", lambda: [])
    root = _root()
    app = flasher.App(root)
    app.baked_key = "form-enrollment-key_0123456789abcdef"
    _fill(app, image_mode="latest", pi_model="pi2")
    app.v["dry_run"].set(True)
    monkeypatch.setattr(flasher, "run_flash", lambda *a, **k: None)
    app.on_flash()  # a flash writes flasher.json
    assert flasher.load_settings()["pi_model"] == "pi2"
    root.destroy()
    root = _root()
    app = flasher.App(root)
    assert app.v["pi_model"].get() == "pi2" and app.model_box.get() == "Raspberry Pi 2 Model B V1.1"
    root.destroy()
    flasher.save_settings(dict(FORM, pi_model="pi9000"))
    root = _root()
    app = flasher.App(root)
    assert app.v["pi_model"].get() == "pi5" and app.model_box.get() == "Raspberry Pi 5 / 500"
    root.destroy()
    flasher.settings_path().unlink()
    root = _root()
    assert flasher.App(root).v["pi_model"].get() == "pi5"
    root.destroy()


def test_arm64_models_take_the_bundled_image(monkeypatch, tmp_path):
    b = _bundled_exe(tmp_path)
    monkeypatch.setattr(flasher.bundle, "find_bundle", lambda path=None: b)
    monkeypatch.setattr(imagefetch.urllib.request, "urlopen", lambda *a, **k: pytest.fail("network touched"))
    for key in ("pi5", "pi3", "zero2", "pi2v12"):
        (image, sha), text = _obtain({"image_mode": "bundled", "pi_model": key})
        assert image is b and sha == b.sha256 and "Using bundled image" in text
    (image, sha), text = _obtain({"image_mode": "bundled"})  # no model at all (an old form): the default
    assert image is b


def test_armhf_models_download_the_32bit_image_once(monkeypatch, tmp_path, server):
    monkeypatch.setitem(imagefetch.LATEST_URLS, "armhf", server + "/raspios_lite_armhf_latest")
    b = _bundled_exe(tmp_path)
    monkeypatch.setattr(flasher.bundle, "find_bundle", lambda path=None: b)
    # Advanced says Bundled, the model says armhf: the model wins, and the log says so.
    (image, sha), text = _obtain({"image_mode": "bundled", "pi_model": "pi2"})
    assert image == str(imagefetch.cached_path(ARMHF)) and sha == FAKE_SHA
    assert "Raspberry Pi 2 Model B V1.1 needs the 32-bit image; the bundled 64-bit image is skipped." in text
    assert f"Raspberry Pi 2 Model B V1.1 needs the 32-bit image; downloading {ARMHF} (1 MB)" in text
    assert "Download verified." in text and imagefetch.cached_path(ARMHF).read_bytes() == FAKE
    # Second time: the cached copy after a sha256 check, no download; "latest" mode downloads the same arch.
    (image, sha), text = _obtain({"image_mode": "latest", "pi_model": "zero"})
    assert image == str(imagefetch.cached_path(ARMHF)) and "Cached image is valid." in text
    assert "downloading" not in text
    # Dry run stops at the URL.
    imagefetch.cached_path(ARMHF).unlink()
    (image, sha), text = _obtain({"image_mode": "bundled", "pi_model": "pi1bplus"}, dry_run=True)
    assert f"Dry run: would download {server}/raspios/{ARMHF}" in text and not imagefetch.cached_path(ARMHF).exists()


def test_armhf_model_offline_is_plain_words_under_the_row(monkeypatch, tmp_path):
    monkeypatch.setitem(imagefetch.LATEST_URLS, "armhf", "http://127.0.0.1:1/raspios_lite_armhf_latest")
    b = _bundled_exe(tmp_path)
    monkeypatch.setattr(flasher.bundle, "find_bundle", lambda path=None: b)
    with pytest.raises(flasher.ImageOffline) as e:
        _obtain({"image_mode": "bundled", "pi_model": "pi2"})
    assert str(e.value) == flasher.OFFLINE_TEXT
    assert "Connect to the internet once (about 530 MB) and press FLASH again." in flasher.OFFLINE_TEXT
    # In the GUI the worker puts it under the model row, no dialog.
    monkeypatch.setattr(flasher.disk, "list_disks", lambda: [])
    monkeypatch.setattr(flasher.messagebox, "showerror", lambda *a, **k: pytest.fail("dialog shown"))
    signed_in(monkeypatch)
    root = _root()
    app = flasher.App(root)
    app._run_flash(dict(FULL, image_mode="bundled", pi_model="pi2", dry_run=True, disk_info=None))
    assert _pump(root, app, lambda: "pi_model" in _shown_errors(app))
    assert _shown_errors(app)["pi_model"] == flasher.OFFLINE_TEXT and "FAILED: This model needs" in _log(app)
    assert str(app.flash_btn["state"]) == "normal"
    root.destroy()


def test_local_file_is_used_as_given_with_a_warning(tmp_path):
    img = tmp_path / "2026-09-15-raspios-trixie-armhf-lite.img"
    img.write_bytes(b"\x01" * 1024)
    (image, sha), text = _obtain({"image_mode": "local", "image_path": str(img), "pi_model": "pi5"})
    assert image == str(img) and sha == ""
    assert "WARNING: that file name says armhf, but Raspberry Pi 5 / 500 needs an arm64 image." in text
    (image, sha), text = _obtain({"image_mode": "local", "image_path": str(img), "pi_model": "zero"})
    assert image == str(img) and "WARNING" not in text
    img64 = tmp_path / "custom-arm64.img"
    img64.write_bytes(b"\x01" * 1024)
    (image, sha), text = _obtain({"image_mode": "local", "image_path": str(img64), "pi_model": "pi2"})
    assert "WARNING: that file name says arm64, but Raspberry Pi 2 Model B V1.1 needs an armhf image." in text


def test_summary_and_dry_run_name_the_model(monkeypatch, tmp_path):
    calls, lines = [], []
    _flash_stubs(monkeypatch, tmp_path, calls)
    img = tmp_path / "x.img"
    img.write_bytes(bytes(range(256)) * 8)
    v = dict(FULL, image_path=str(img), pi_model="pi3", disk_info=dict(DISK, size=1 << 20))
    flasher.run_flash(v, lines.append, lambda pct, text: None, threading.Event())
    assert "Pi model: Raspberry Pi 3 (B, B+, A+) (arm64)." in lines
    assert "  Pi model: Raspberry Pi 3 (B, B+, A+) (arm64)" in lines[lines.index("SUMMARY"):]
    lines.clear()
    flasher.run_flash(dict(v, pi_model="zero", disk_info=None), lines.append, lambda pct, text: None,
                      threading.Event(), dry_run=True)
    assert "Pi model: Raspberry Pi Zero / Zero W (armhf)." in lines
    assert any(s.startswith("Dry run: would write x.img to") for s in lines)


def test_selfcheck_lists_the_models(capsys):
    assert flasher.selfcheck() == 0
    out = capsys.readouterr().out
    assert "pi models (key, image arch, label" in out and "pi2       armhf  Raspberry Pi 2 Model B V1.1" in out
