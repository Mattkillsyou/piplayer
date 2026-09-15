"""Uploads (contract 11), media serving (contract 15 + Range from contract 6),
screenshots (contract 15)."""
import os
import time

import pytest

from cms_helpers import (add_item, assign_playlist, bearer, create_device, create_playlist, csrf_token,
                         execute, one, post, post_files, query, sync, upload)
from cms_mediagen import make_jpeg_bytes
from cms_support import MAX_UPLOAD_BYTES


def _tmp_uploads(cms):
    return sorted(p.name for p in cms.config.MEDIA_DIR.glob(".upload_*.tmp"))


# ---------------------------------------------------------------------------
# Uploads
# ---------------------------------------------------------------------------

def test_upload_video_and_image_are_probed(admin, make_media, cms):
    v = upload(admin, make_media("mp4"))
    assert v["media_type"] == "video"
    assert v["duration_seconds"] == pytest.approx(2.0, abs=0.5)
    assert (v["width"], v["height"]) == (320, 240)
    assert v["codec"]
    assert (cms.config.MEDIA_DIR / v["filename"]).is_file()
    assert v["size_bytes"] == (cms.config.MEDIA_DIR / v["filename"]).stat().st_size

    i = upload(admin, make_media("png"))
    assert i["media_type"] == "image"
    assert (i["width"], i["height"]) == (64, 64)
    assert i["duration_seconds"] is None
    assert _tmp_uploads(cms) == []


def test_upload_rejects_unparseable_video(admin, cms, tok):
    junk = b"FAKE-VIDEO-DATA-" + os.urandom(4096)
    r = post_files(admin, "/library/upload", {"file": (f"junk-{tok}.mp4", junk, "video/mp4")})
    assert r.status_code == 400, f"{r.status_code} {r.text[:300]}"
    assert "ffprobe" in r.json()["detail"]
    assert query("SELECT id FROM media WHERE original_name = ?", (f"junk-{tok}.mp4",)) == []
    assert _tmp_uploads(cms) == []


def test_upload_rejects_unparseable_image(admin, cms, tok):
    junk = b"\x89PNG\r\n\x1a\n" + os.urandom(4096)
    r = post_files(admin, "/library/upload", {"file": (f"junk-{tok}.png", junk, "image/png")})
    assert r.status_code == 400, f"{r.status_code} {r.text[:300]}"
    assert "ffprobe" in r.json()["detail"]
    assert query("SELECT id FROM media WHERE original_name = ?", (f"junk-{tok}.png",)) == []
    assert _tmp_uploads(cms) == []


def test_upload_rejects_unsupported_extension(admin, cms, tok):
    r = post_files(admin, "/library/upload", {"file": (f"x-{tok}.exe", b"MZ" + os.urandom(64), "application/octet-stream")})
    assert r.status_code == 400
    assert _tmp_uploads(cms) == []


def test_upload_over_limit_is_413_before_anything_is_stored(admin, cms, tok):
    big = os.urandom(MAX_UPLOAD_BYTES + 64 * 1024)
    r = post_files(admin, "/library/upload", {"file": (f"big-{tok}.png", big, "image/png")})
    assert r.status_code == 413, f"{r.status_code} {r.text[:300]}"
    assert query("SELECT id FROM media WHERE original_name = ?", (f"big-{tok}.png",)) == []
    assert _tmp_uploads(cms) == []


def _multipart(name, payload, boundary="piplayer-stream-test"):
    """A hand-built single-file multipart body (bytes) with the given boundary."""
    head = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{name}\"\r\n"
            f"Content-Type: image/png\r\n\r\n").encode()
    return head + payload + f"\r\n--{boundary}--\r\n".encode()


def _stream_upload(admin, name, payload, extra_headers=None):
    """POST a multipart body from a generator: httpx sends it chunked with no
    Content-Length, so only the streaming limiter in on_part_data can stop it."""
    body = _multipart(name, payload)

    def gen():
        for i in range(0, len(body), 64 * 1024):
            yield body[i:i + 64 * 1024]

    headers = {"Content-Type": "multipart/form-data; boundary=piplayer-stream-test",
               "X-CSRF-Token": csrf_token(admin)}
    headers.update(extra_headers or {})
    return admin.post("/library/upload", content=gen(), headers=headers, follow_redirects=False)


def test_chunked_upload_over_limit_is_413_while_streaming(admin, make_media, cms, tok):
    """No Content-Length: the header pre-check cannot fire, so the 413 must come from
    on_part_data as soon as the file part exceeds MAX_UPLOAD_BYTES (contract 11)."""
    real_png = make_media("png").read_bytes()
    payload = real_png + b"\0" * (MAX_UPLOAD_BYTES + 1 - len(real_png))
    r = _stream_upload(admin, f"chunked-{tok}.png", payload)
    assert r.status_code == 413, f"{r.status_code} {r.text[:300]}"
    assert query("SELECT id FROM media WHERE original_name = ?", (f"chunked-{tok}.png",)) == []
    assert _tmp_uploads(cms) == []
    # sanity: the same transport with a small payload is accepted, so a 413 above was
    # the limiter and not a broken hand-built body
    r = _stream_upload(admin, f"chunked-ok-{tok}.png", make_media("png").read_bytes())
    assert r.status_code == 303, f"{r.status_code} {r.text[:300]}"


def test_spoofed_content_length_does_not_bypass_the_limit(admin, make_media, cms, tok):
    real_png = make_media("png").read_bytes()
    payload = real_png + b"\0" * (MAX_UPLOAD_BYTES + 1 - len(real_png))
    r = _stream_upload(admin, f"spoof-{tok}.png", payload, {"Content-Length": "1000"})
    assert r.status_code == 413, f"{r.status_code} {r.text[:300]}"
    assert query("SELECT id FROM media WHERE original_name = ?", (f"spoof-{tok}.png",)) == []
    assert _tmp_uploads(cms) == []


def test_duplicate_upload_is_409_friendly(admin, make_media, cms, tok):
    path = make_media("png")
    first = upload(admin, path, original_name=f"dup-a-{tok}.png")
    with open(path, "rb") as f:
        r = post_files(admin, "/library/upload", {"file": (f"dup-b-{tok}.png", f, "image/png")})
    assert r.status_code == 409, f"{r.status_code} {r.text[:300]}"
    detail = r.json()["detail"]
    assert f"dup-a-{tok}.png" in detail
    assert "sqlite" not in detail.lower() and "unique" not in detail.lower()
    assert query("SELECT id FROM media WHERE sha256 = ?", (first["sha256"],)) == [{"id": first["id"]}]
    assert _tmp_uploads(cms) == []


def test_concurrent_identical_uploads_keep_exactly_one_file(make_client, make_media, cms, tok):
    """Overlapping uploads of the same bytes: one 303, the rest 409, and the winner's
    file must still exist afterwards (the dedupe + insert + rename are one transaction)."""
    import threading

    from cms_helpers import login
    from cms_support import ADMIN_PASSWORD, ADMIN_USERNAME

    path = make_media("png")
    data = path.read_bytes()
    n = 6
    clients = []
    for _ in range(n):
        c = make_client()
        assert login(c, ADMIN_USERNAME, ADMIN_PASSWORD).status_code == 303
        clients.append(c)

    results = [None] * n
    barrier = threading.Barrier(n)

    def go(i):
        barrier.wait()
        r = post_files(clients[i], "/library/upload", {"file": (f"race-{tok}-{i}.png", data, "image/png")})
        results[i] = r.status_code

    threads = [threading.Thread(target=go, args=(i,)) for i in range(n)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=60)

    assert sorted(results) == [303] + [409] * (n - 1), results
    rows = query("SELECT filename FROM media WHERE original_name LIKE ?", (f"race-{tok}-%",))
    assert len(rows) == 1, rows
    assert (cms.config.MEDIA_DIR / rows[0]["filename"]).is_file()
    assert _tmp_uploads(cms) == []


def test_long_original_filename_is_truncated(admin, make_media, cms, tok):
    long_name = ("n" * 300) + tok + ".mp4"
    row = upload(admin, make_media("mp4"), original_name=long_name)
    assert len(row["filename"]) <= 120, len(row["filename"])
    assert row["filename"].endswith(".mp4")
    assert (cms.config.MEDIA_DIR / row["filename"]).is_file()


def test_stale_upload_tmp_files_are_swept(admin, make_media, cms):
    media_dir = cms.config.MEDIA_DIR
    old = media_dir / ".upload_stale_test.tmp"
    old.write_bytes(b"x")
    two_hours_ago = time.time() - 2 * 3600
    os.utime(old, (two_hours_ago, two_hours_ago))
    fresh = media_dir / ".upload_fresh_test.tmp"
    fresh.write_bytes(b"y")
    try:
        upload(admin, make_media("png"))
        assert not old.exists(), "stale .upload_*.tmp older than 1 h was not swept"
        assert fresh.exists(), "a fresh in-flight .upload_*.tmp must not be removed"
    finally:
        fresh.unlink(missing_ok=True)
        old.unlink(missing_ok=True)


def test_stale_upload_tmp_is_swept_at_startup(cms):
    """Seeded by conftest before app.main was imported (contract 11: sweep at startup)."""
    assert not cms.startup_stale_tmp.exists(), "startup did not sweep a stale .upload_*.tmp"


def test_library_lists_uploads(admin, make_media, tok):
    v = upload(admin, make_media("mp4"), original_name=f"lib-video-{tok}.mp4")
    i = upload(admin, make_media("png"), original_name=f"lib-image-{tok}.png")
    html = admin.get("/library").text
    assert "badge-video" in html and "badge-image" in html
    assert v["original_name"] in html and i["original_name"] in html


def test_delete_media_removes_file_and_playlist_item(admin, make_media, cms, tok):
    m = upload(admin, make_media("png"))
    pid = create_playlist(admin, f"del-media-{tok}")
    add_item(admin, pid, m["id"])
    r = post(admin, f"/library/{m['id']}/delete")
    assert r.status_code == 303
    assert not (cms.config.MEDIA_DIR / m["filename"]).exists()
    assert query("SELECT id FROM playlist_items WHERE media_id = ?", (m["id"],)) == []
    assert post(admin, f"/library/{m['id']}/delete").status_code == 404


# ---------------------------------------------------------------------------
# /api/media: auth, scoping, nosniff, Range
# ---------------------------------------------------------------------------

@pytest.fixture
def scoped(admin, make_media, tok):
    m_a = upload(admin, make_media("mp4"))
    m_b = upload(admin, make_media("png"))
    pid_a = create_playlist(admin, f"scope-a-{tok}")
    pid_b = create_playlist(admin, f"scope-b-{tok}")
    add_item(admin, pid_a, m_a["id"])
    add_item(admin, pid_b, m_b["id"])
    dev_a = create_device(admin, f"scope-a-{tok}")
    dev_b = create_device(admin, f"scope-b-{tok}")
    dev_none = create_device(admin, f"scope-none-{tok}")
    assign_playlist(admin, dev_a["id"], pid_a)
    assign_playlist(admin, dev_b["id"], pid_b)
    return {"m_a": m_a, "m_b": m_b, "dev_a": dev_a, "dev_b": dev_b, "dev_none": dev_none,
            "pid_a": pid_a, "pid_b": pid_b}


def test_media_requires_auth(client, scoped):
    r = client.get(f"/api/media/{scoped['m_a']['filename']}")
    assert r.status_code == 401
    r = client.get(f"/api/media/{scoped['m_a']['filename']}", headers=bearer("not-a-token"))
    assert r.status_code == 401


def test_media_invalid_filename_and_missing(admin, scoped):
    assert admin.get("/api/media/..%2Fcms.db").status_code in (400, 404)
    assert admin.get("/api/media/does-not-exist.mp4").status_code == 404
    r = admin.get(f"/api/media/{scoped['m_a']['filename']}", headers=bearer(scoped["dev_a"]["token"]))
    assert r.status_code == 200


def test_device_token_is_scoped_to_its_resolved_playlist(client, scoped):
    a, b, none = scoped["dev_a"], scoped["dev_b"], scoped["dev_none"]
    fa, fb = scoped["m_a"]["filename"], scoped["m_b"]["filename"]
    assert client.get(f"/api/media/{fa}", headers=bearer(a["token"])).status_code == 200
    assert client.get(f"/api/media/{fb}", headers=bearer(b["token"])).status_code == 200
    r = client.get(f"/api/media/{fb}", headers=bearer(a["token"]))
    assert r.status_code in (403, 404), f"device A fetched a file only in device B's playlist: {r.status_code}"
    r = client.get(f"/api/media/{fa}", headers=bearer(b["token"]))
    assert r.status_code in (403, 404)
    r = client.get(f"/api/media/{fa}", headers=bearer(none["token"]))
    assert r.status_code in (403, 404), "device with no playlist must not read the library"


def test_scoping_follows_the_schedule_resolver(admin, client, scoped):
    """A file that is only reachable through the device's *scheduled* playlist is allowed."""
    a = scoped["dev_a"]
    fb = scoped["m_b"]["filename"]
    r = post(admin, f"/devices/{a['id']}/schedule", {"name": "always-b", "playlist_id": str(scoped["pid_b"]), "priority": "50"})
    assert r.status_code == 303, r.text[:300]
    assert sync(client, a).json()["playlist"]["id"] == scoped["pid_b"]
    assert client.get(f"/api/media/{fb}", headers=bearer(a["token"])).status_code == 200
    assert client.get(f"/api/media/{scoped['m_a']['filename']}", headers=bearer(a["token"])).status_code in (403, 404)


def test_logged_in_user_can_fetch_anything(admin, scoped):
    for fn in (scoped["m_a"]["filename"], scoped["m_b"]["filename"]):
        r = admin.get(f"/api/media/{fn}")
        assert r.status_code == 200
        assert r.headers.get("x-content-type-options") == "nosniff"


def test_media_supports_range_requests(admin, client, scoped, cms):
    fn = scoped["m_a"]["filename"]
    full = (cms.config.MEDIA_DIR / fn).read_bytes()
    r = admin.get(f"/api/media/{fn}", headers={"Range": "bytes=0-9"})
    assert r.status_code == 206, r.status_code
    assert r.content == full[:10]
    assert r.headers.get("content-range", "").startswith(f"bytes 0-9/{len(full)}")
    assert r.headers.get("x-content-type-options") == "nosniff"
    # resume from an offset, as the player does with a .part file
    r = client.get(f"/api/media/{fn}", headers={**bearer(scoped["dev_a"]["token"]), "Range": f"bytes={len(full) - 100}-"})
    assert r.status_code == 206
    assert r.content == full[-100:]
    assert r.headers["content-range"] == f"bytes {len(full) - 100}-{len(full) - 1}/{len(full)}"
    r = admin.get(f"/api/media/{fn}")
    assert r.status_code == 200 and r.headers.get("accept-ranges") == "bytes"
    assert r.content == full


def test_manifest_urls_point_at_media_route(client, scoped):
    r = sync(client, scoped["dev_a"])
    assert r.status_code == 200
    items = r.json()["playlist"]["items"]
    assert len(items) == 1
    assert items[0]["url"].endswith("/api/media/" + scoped["m_a"]["filename"])
    assert items[0]["sha256"] == scoped["m_a"]["sha256"]


# ---------------------------------------------------------------------------
# Screenshots
# ---------------------------------------------------------------------------

def test_screenshot_must_be_jpeg(admin, client, cms, tok):
    dev = create_device(admin, f"shot-{tok}")
    png = b"\x89PNG\r\n\x1a\n" + os.urandom(512)
    r = client.post(f"/api/screenshots/{dev['device_id']}", headers=bearer(dev["token"]),
                    files={"file": ("screen.jpg", png, "image/jpeg")})
    assert r.status_code == 400, f"{r.status_code} {r.text[:300]}"
    assert not (cms.config.SCREENSHOT_DIR / f"{dev['device_id']}.jpg").exists()
    assert one("SELECT last_screenshot_at FROM devices WHERE id = ?", (dev["id"],))["last_screenshot_at"] is None
    assert sorted(cms.config.SCREENSHOT_DIR.glob(".upload_*.tmp")) == []

    jpg = make_jpeg_bytes(seed=tok)
    r = client.post(f"/api/screenshots/{dev['device_id']}", headers=bearer(dev["token"]),
                    files={"file": ("screen.jpg", jpg, "image/jpeg")})
    assert r.status_code == 200, r.text[:300]
    assert (cms.config.SCREENSHOT_DIR / f"{dev['device_id']}.jpg").read_bytes() == jpg
    assert one("SELECT last_screenshot_at FROM devices WHERE id = ?", (dev["id"],))["last_screenshot_at"]

    r = admin.get(f"/devices/{dev['id']}/screenshot")
    assert r.status_code == 200
    assert r.content == jpg
    assert r.headers.get("x-content-type-options") == "nosniff"
    assert "no-store" in r.headers.get("cache-control", "")


def test_screenshot_over_limit_is_413_and_not_stored(admin, client, cms, tok):
    dev = create_device(admin, f"shot-big-{tok}")
    big = b"\xff\xd8\xff\xe0" + b"\0" * (cms.config.MAX_SCREENSHOT_BYTES - 3)  # limit + 1 bytes
    r = client.post(f"/api/screenshots/{dev['device_id']}", headers=bearer(dev["token"]),
                    files={"file": ("screen.jpg", big, "image/jpeg")})
    assert r.status_code == 413, f"{r.status_code} {r.text[:300]}"
    assert not (cms.config.SCREENSHOT_DIR / f"{dev['device_id']}.jpg").exists()
    assert one("SELECT last_screenshot_at FROM devices WHERE id = ?", (dev["id"],))["last_screenshot_at"] is None
    assert sorted(cms.config.SCREENSHOT_DIR.glob(".upload_*.tmp")) == []


def test_screenshot_token_must_match_device(admin, client, tok):
    a = create_device(admin, f"shot-a-{tok}")
    b = create_device(admin, f"shot-b-{tok}")
    r = client.post(f"/api/screenshots/{a['device_id']}", headers=bearer(b["token"]),
                    files={"file": ("screen.jpg", make_jpeg_bytes(seed=1), "image/jpeg")})
    assert r.status_code == 403


def test_dashboard_marks_stale_screenshot(admin, client, tok):
    dev = create_device(admin, f"aged-{tok}", f"Aged Dev {tok}")  # name deliberately avoids the word "stale"
    r = client.post(f"/api/screenshots/{dev['device_id']}", headers=bearer(dev["token"]),
                    files={"file": ("screen.jpg", make_jpeg_bytes(seed=tok), "image/jpeg")})
    assert r.status_code == 200

    def card():
        html = admin.get("/dashboard").text
        i = html.index(f"Aged Dev {tok}")
        return html[max(0, i - 1500): i + 1500]

    assert "stale" not in card().lower(), "a fresh screenshot must not be flagged stale"
    # 3 x SCREENSHOT_INTERVAL_SECONDS (60 s in tests) -> 1 day old is stale for sure
    execute("UPDATE devices SET last_screenshot_at = datetime('now', '-1 day') WHERE id = ?", (dev["id"],))
    assert "stale" in card().lower(), "dashboard does not flag a screenshot older than 3 intervals"


def test_deleting_device_removes_screenshot_file(admin, client, cms, tok):
    dev = create_device(admin, f"rm-{tok}")
    r = client.post(f"/api/screenshots/{dev['device_id']}", headers=bearer(dev["token"]),
                    files={"file": ("screen.jpg", make_jpeg_bytes(seed=tok), "image/jpeg")})
    assert r.status_code == 200
    shot = cms.config.SCREENSHOT_DIR / f"{dev['device_id']}.jpg"
    assert shot.exists()
    r = post(admin, f"/devices/{dev['id']}/delete")
    assert r.status_code == 303
    assert not shot.exists(), "screenshot file left behind after device delete"
    assert query("SELECT id FROM devices WHERE id = ?", (dev["id"],)) == []
    # the token is dead
    assert sync(client, dev).status_code == 401
