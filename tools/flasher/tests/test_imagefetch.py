import hashlib
import http.server
import threading

import pytest

import imagefetch

FAKE = bytes(range(256)) * 4096  # 1 MiB
FAKE_SHA = hashlib.sha256(FAKE).hexdigest()
NAME = "2026-01-01-raspios-trixie-arm64-lite.img.xz"
OTHER_PORT = 1


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        if self.path == "/raspios_lite_arm64_latest":
            self.send_response(302)
            self.send_header("Location", f"/raspios/{NAME}")
            self.end_headers()
        elif self.path == f"/raspios/{NAME}":
            self.send_response(200)
            self.send_header("Content-Length", str(len(FAKE)))
            self.end_headers()
            self.wfile.write(FAKE)
        elif self.path == "/offsite":
            self.send_response(302)
            self.send_header("Location", f"http://127.0.0.1:{OTHER_PORT}/raspios/{NAME}")  # another origin
            self.end_headers()
        elif self.path == f"/raspios/{NAME}.sha256":
            body = f"{FAKE_SHA}  {NAME}\n".encode()
            self.send_response(200)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        else:
            self.send_error(404)


@pytest.fixture(scope="module")
def server():
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)  # port 0: never collide with a stray server
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    yield f"http://127.0.0.1:{srv.server_address[1]}"
    srv.shutdown()


def test_resolve_download_verify(server, tmp_path):
    final, name = imagefetch.resolve_latest(server + "/raspios_lite_arm64_latest")
    assert final == f"{server}/raspios/{NAME}"
    assert name == NAME
    assert imagefetch.fetch_sha256(final) == FAKE_SHA
    calls = []
    dest = imagefetch.download(final, tmp_path / name, progress_cb=lambda d, t, r: calls.append((d, t)))
    assert dest.read_bytes() == FAKE
    assert calls[-1] == (len(FAKE), len(FAKE))
    assert not (tmp_path / (name + ".part")).exists()
    assert imagefetch.verify_sha256(dest, FAKE_SHA)
    assert not imagefetch.verify_sha256(dest, "0" * 64)


def test_download_cancel_and_404(server, tmp_path):
    cancel = threading.Event()
    cancel.set()
    with pytest.raises(imagefetch.Cancelled):
        imagefetch.download(f"{server}/raspios/{NAME}", tmp_path / "x.img.xz", cancel_event=cancel)
    assert not (tmp_path / "x.img.xz.part").exists()
    with pytest.raises(imagefetch.FetchError):
        imagefetch.download(f"{server}/missing", tmp_path / "y.img.xz")
    with pytest.raises(imagefetch.FetchError):
        imagefetch.resolve_latest(f"{server}/missing")


def test_cached_path_is_under_the_data_folder(monkeypatch, tmp_path):
    """%LOCALAPPDATA%\\Projection5000\\images on Windows, ~/Library/Application Support/Projection5000/images on a
    Mac (both moved under tmp_path by the conftest sandbox); the file name never escapes it."""
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path))
    monkeypatch.setenv("HOME", str(tmp_path))
    p = imagefetch.cached_path("../evil/" + NAME)
    assert p == imagefetch.app_dir() / "images" / NAME and p.is_relative_to(tmp_path)
    assert p.parent.is_dir()


def test_redirect_off_origin_is_refused(server):
    # The sha256 comes from the final URL, so a redirect to another host (or scheme) would let that
    # host vouch for its own image. A second server plays the other origin (different port).
    global OTHER_PORT
    other = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=other.serve_forever, daemon=True).start()
    OTHER_PORT = other.server_address[1]
    try:
        with pytest.raises(imagefetch.FetchError, match="redirected off its origin"):
            imagefetch.resolve_latest(server + "/offsite")
    finally:
        other.shutdown()
