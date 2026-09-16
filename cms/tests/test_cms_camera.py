"""Room camera feed: POST /api/camera (same protocol as screenshots), camera_error on sync,
camera_interval_seconds in the manifest, the Devices / Dashboard snapshot + STALE badge, the
camera_live_url field (https only, audited) and the lazy live iframe."""
import os

from cms_helpers import bearer, create_device, create_user, execute, login, one, post, query, sync
from cms_mediagen import make_jpeg_bytes


def _upload(client, dev, body, ctype="image/jpeg"):
    return client.post(f"/api/camera/{dev['device_id']}", headers=bearer(dev["token"]),
                       files={"file": ("cam.jpg", body, ctype)})


def _cam_file(cms, dev):
    return cms.config.SCREENSHOT_DIR / f"camera_{dev['device_id']}.jpg"


def _row(dev):
    return one("SELECT last_camera_at, camera_error, camera_live_url FROM devices WHERE id = ?", (dev["id"],))


# ---------------------------------------------------------------------------
# Upload endpoint
# ---------------------------------------------------------------------------

def test_camera_upload_stores_jpeg_and_stamps_row(admin, client, cms, tok):
    dev = create_device(admin, f"cam-{tok}")
    assert _row(dev)["last_camera_at"] is None

    r = _upload(client, dev, b"\x89PNG\r\n\x1a\n" + os.urandom(256))
    assert r.status_code == 400, f"{r.status_code} {r.text[:300]}"
    assert not _cam_file(cms, dev).exists()
    assert _row(dev)["last_camera_at"] is None
    assert sorted(cms.config.SCREENSHOT_DIR.glob(".upload_*.tmp")) == []

    execute("UPDATE devices SET camera_error = 'ffmpeg timed out' WHERE id = ?", (dev["id"],))
    jpg = make_jpeg_bytes(seed=tok)
    r = _upload(client, dev, jpg)
    assert r.status_code == 200, r.text[:300]
    assert r.json() == {"ok": True, "size_bytes": len(jpg)}
    assert _cam_file(cms, dev).read_bytes() == jpg
    row = _row(dev)
    assert row["last_camera_at"]
    assert row["camera_error"] is None, "a good frame must clear the last capture error"
    # the projector screenshot slot is untouched
    assert not (cms.config.SCREENSHOT_DIR / f"{dev['device_id']}.jpg").exists()
    assert one("SELECT last_screenshot_at FROM devices WHERE id = ?", (dev["id"],))["last_screenshot_at"] is None

    r = admin.get(f"/devices/{dev['id']}/camera")
    assert r.status_code == 200
    assert r.content == jpg
    assert r.headers["content-type"].startswith("image/jpeg")
    assert r.headers.get("x-content-type-options") == "nosniff"
    assert "no-store" in r.headers.get("cache-control", "")


def test_camera_upload_auth_and_size(admin, client, cms, tok):
    a = create_device(admin, f"cam-a-{tok}")
    b = create_device(admin, f"cam-b-{tok}")
    jpg = make_jpeg_bytes(seed=tok)
    r = client.post(f"/api/camera/{a['device_id']}", files={"file": ("cam.jpg", jpg, "image/jpeg")})
    assert r.status_code == 401
    r = _upload(client, {"device_id": a["device_id"], "token": b["token"]}, jpg)
    assert r.status_code == 403
    r = _upload(client, {"device_id": a["device_id"], "token": "nope"}, jpg)
    assert r.status_code == 401

    big = b"\xff\xd8\xff\xe0" + b"\0" * (cms.config.MAX_CAMERA_BYTES - 3)  # limit + 1 bytes
    r = _upload(client, a, big)
    assert r.status_code == 413, f"{r.status_code} {r.text[:300]}"
    assert not _cam_file(cms, a).exists()
    assert _row(a)["last_camera_at"] is None
    assert sorted(cms.config.SCREENSHOT_DIR.glob(".upload_*.tmp")) == []


def test_camera_view_needs_session_and_404s_without_frame(admin, client, tok):
    dev = create_device(admin, f"cam-view-{tok}")
    r = client.get(f"/devices/{dev['id']}/camera", follow_redirects=False)
    assert r.status_code in (302, 303, 401)
    r = admin.get(f"/devices/{dev['id']}/camera")
    assert r.status_code == 404
    assert admin.get("/devices/999999/camera").status_code == 404


def test_deleting_device_removes_camera_file(admin, client, cms, tok):
    dev = create_device(admin, f"cam-rm-{tok}")
    assert _upload(client, dev, make_jpeg_bytes(seed=tok)).status_code == 200
    assert _cam_file(cms, dev).exists()
    assert post(admin, f"/devices/{dev['id']}/delete").status_code == 303
    assert not _cam_file(cms, dev).exists()


# ---------------------------------------------------------------------------
# Sync: camera_error + manifest interval
# ---------------------------------------------------------------------------

def test_sync_stores_camera_error_and_manifest_interval(admin, client, cms, tok):
    dev = create_device(admin, f"cam-sync-{tok}")
    r = sync(client, dev, camera_error="rtsp connect failed: " + "x" * 300)
    assert r.status_code == 200
    assert r.json()["camera_interval_seconds"] == cms.config.CAMERA_INTERVAL_SECONDS
    assert cms.config.CAMERA_INTERVAL_SECONDS >= 5
    stored = _row(dev)["camera_error"]
    assert stored.startswith("rtsp connect failed") and len(stored) == cms.api_routes.MAX_SYNC_ERROR_LEN

    html = admin.get("/devices").text
    assert "Camera: rtsp connect failed" in html
    html = admin.get("/dashboard").text
    assert "Camera: rtsp connect failed" in html

    # a clean sync clears it
    assert sync(client, dev).status_code == 200
    assert _row(dev)["camera_error"] is None
    assert "rtsp connect failed" not in admin.get("/devices").text


# ---------------------------------------------------------------------------
# Snapshot on the pages, STALE badge
# ---------------------------------------------------------------------------

def test_pages_show_snapshot_and_flag_stale(admin, client, cms, tok):
    dev = create_device(admin, f"cam-aged-{tok}", f"Cam Aged {tok}")

    def block(path):
        # just this device's row / card (neighbouring devices may have snapshots of their own)
        html = admin.get(path).text
        marker = '<div class="device-row' if path == "/devices" else '<div class="device-card'
        i = html.index(f"Cam Aged {tok}")
        start = html.rindex(marker, 0, i)
        end = html.find(marker, i)
        return html[start: end if end > 0 else None]

    for path in ("/devices", "/dashboard"):
        assert "device-camera" not in block(path), "no snapshot yet must render no camera tile"

    assert _upload(client, dev, make_jpeg_bytes(seed=tok)).status_code == 200
    for path in ("/devices", "/dashboard"):
        b = block(path)
        assert f"/devices/{dev['id']}/camera?t=" in b
        assert "device-camera" in b and "cam · " in b
        assert "device-thumb-stale" not in b

    execute("UPDATE devices SET last_camera_at = datetime('now', '-1 day') WHERE id = ?", (dev["id"],))
    for path in ("/devices", "/dashboard"):
        assert "device-thumb-stale" in block(path), f"{path} does not flag a snapshot older than 3 intervals"


# ---------------------------------------------------------------------------
# camera_live_url
# ---------------------------------------------------------------------------

def test_camera_live_url_validation_and_audit(admin, client, make_client, tok):
    dev = create_device(admin, f"cam-url-{tok}", f"Cam Url {tok}")
    ok = f"https://cam-{tok}.example.com/lobby?x=1"
    r = post(admin, f"/devices/{dev['id']}/camera-url", {"camera_live_url": f"  {ok} "})
    assert r.status_code == 303, r.text[:300]
    assert _row(dev)["camera_live_url"] == ok
    audit = query("SELECT action, target_id, details FROM audit_log WHERE action = 'device_set_camera_url' "
                  "AND target_id = ? ORDER BY id DESC LIMIT 1", (str(dev["id"]),))
    assert audit and ok in audit[0]["details"]

    html = admin.get("/devices").text
    assert f'data-src="{ok}"' in html
    assert 'class="live-frame"' in html and 'sandbox="allow-same-origin allow-scripts"' in html
    assert 'referrerpolicy="no-referrer"' in html
    assert f'href="{ok}"' in html and "Show live" in html

    for bad in ("http://cam.example.com/", "javascript:alert(1)", "ftp://x/", "https://", "not a url",
                "https://cam.example.com/a b", "https://cam.example.com/a\nb", "https://cam.example.com/\x07"):
        r = post(admin, f"/devices/{dev['id']}/camera-url", {"camera_live_url": bad})
        assert r.status_code == 400, (bad, r.status_code, r.text[:200])
        assert _row(dev)["camera_live_url"] == ok, bad

    assert post(admin, "/devices/999999/camera-url", {"camera_live_url": ok}).status_code == 404

    # empty clears
    r = post(admin, f"/devices/{dev['id']}/camera-url", {"camera_live_url": ""})
    assert r.status_code == 303
    assert _row(dev)["camera_live_url"] is None
    assert "live-frame" not in admin.get("/devices").text.split(f"Cam Url {tok}", 1)[1][:4000]

    # viewers may not set it
    create_user(admin, f"viewer-{tok}", "viewerpass123", role="viewer")
    v = make_client()
    assert login(v, f"viewer-{tok}", "viewerpass123").status_code == 303
    r = post(v, f"/devices/{dev['id']}/camera-url", {"camera_live_url": ok})
    assert r.status_code == 403
    assert _row(dev)["camera_live_url"] is None


def test_camera_live_url_is_escaped_and_revalidated_on_render(admin, tok):
    dev = create_device(admin, f"cam-xss-{tok}", f"Cam Xss {tok}")
    hostile = f'https://cam-{tok}.example.com/?q="><script>alert(1)</script>'
    r = post(admin, f"/devices/{dev['id']}/camera-url", {"camera_live_url": hostile})
    assert r.status_code == 303
    html = admin.get("/devices").text
    assert "<script>alert(1)</script>" not in html
    assert "&lt;script&gt;" in html

    # a value that bypassed the form (direct DB edit) never becomes an iframe src
    execute("UPDATE devices SET camera_live_url = 'javascript:alert(1)' WHERE id = ?", (dev["id"],))
    html = admin.get("/devices").text
    section = html.split(f"Cam Xss {tok}", 1)[1][:6000]
    assert "javascript:" not in section
    assert "live-frame" not in section
