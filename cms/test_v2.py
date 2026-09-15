"""End-to-end smoke test for v2 features (library, playlists, devices, /api/sync).

Re-runnable: every name carries a per-run token, ids are resolved from
responses or from cms.db, and the CSRF token is fetched from the server.

Prerequisites (run_smoke_tests.py sets all of this up for you):
  PIPLAYER_BASE_URL   base URL of a running CMS (default http://127.0.0.1:8766)
  PIPLAYER_DATA_DIR   the CMS's data dir (this script reads cms.db directly)
  admin password      test1234 (start the CMS with PIPLAYER_ADMIN_PASSWORD=test1234)
  ffmpeg on PATH      to synthesize a small valid test video
"""
import os
import secrets
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "tests"))
from cms_mediagen import make_mp4, make_png  # noqa: E402
from smoke_common import Client, base_url, query, one, bearer, sync  # noqa: E402

import requests  # noqa: E402

BASE = base_url(8766)
RUN = secrets.token_hex(3)


def main():
    s = Client(BASE)

    # Login
    r = s.login("admin", "test1234")
    assert r.status_code == 303, f"login failed: {r.status_code} {r.text[:200]}"
    print("  login: OK")

    tmp = Path(tempfile.mkdtemp(prefix="piplayer-smoke-"))
    video_name = f"dojo_logo_{RUN}.mp4"
    image_name = f"class_schedule_{RUN}.png"
    try:
        make_mp4(tmp / video_name, seed=RUN + "v")
        make_png(tmp / image_name, seed=RUN + "i")

        with open(tmp / video_name, "rb") as f:
            r = s.post("/library/upload", files={"file": (video_name, f, "video/mp4")})
        assert r.status_code == 303, f"video upload failed: {r.status_code} {r.text[:300]}"
        print(f"  upload video: {r.status_code} -> {r.headers.get('location')}")

        with open(tmp / image_name, "rb") as f:
            r = s.post("/library/upload", files={"file": (image_name, f, "image/png")})
        assert r.status_code == 303, f"image upload failed: {r.status_code} {r.text[:300]}"
        print(f"  upload image: {r.status_code} -> {r.headers.get('location')}")
    finally:
        for p in tmp.iterdir():
            p.unlink(missing_ok=True)
        tmp.rmdir()

    video = one("SELECT id, filename FROM media WHERE original_name = ?", (video_name,))
    image = one("SELECT id, filename FROM media WHERE original_name = ?", (image_name,))

    # Library page should show both, with badges
    r = s.get("/library")
    assert r.status_code == 200
    assert "badge-video" in r.text, "video badge missing"
    assert "badge-image" in r.text, "image badge missing"
    assert video_name in r.text
    assert image_name in r.text
    print("  library page: shows VIDEO + IMAGE badges OK")

    # Create a playlist
    playlist_name = f"Lobby Loop {RUN}"
    r = s.post("/playlists", data={"name": playlist_name})
    assert r.status_code == 303, f"create playlist failed: {r.status_code} {r.text[:200]}"
    pid = int(r.headers["location"].rsplit("/", 1)[-1])
    print(f"  create playlist: id={pid}")

    # Add both media to the playlist
    r = s.post(f"/playlists/{pid}/items", data={"media_id": str(video["id"])})
    assert r.status_code == 303, r.text[:300]
    r = s.post(f"/playlists/{pid}/items", data={"media_id": str(image["id"])})
    assert r.status_code == 303, r.text[:300]
    video_item = one("SELECT id FROM playlist_items WHERE playlist_id = ? AND media_id = ?", (pid, video["id"]))["id"]
    image_item = one("SELECT id FROM playlist_items WHERE playlist_id = ? AND media_id = ?", (pid, image["id"]))["id"]
    print("  add 2 items to playlist: OK")

    # Set duration override on the image item
    r = s.post(f"/playlists/{pid}/items/{image_item}/duration", data={"duration": "7.5"})
    assert r.status_code == 303, r.text[:300]
    print(f"  set duration override on item {image_item} (image) to 7.5s: OK")

    # Reorder: put the image first
    r = s.post(f"/playlists/{pid}/items/reorder", json={"order": [image_item, video_item]})
    assert r.status_code == 200, f"reorder failed: {r.status_code} {r.text[:300]}"
    assert r.json() == {"ok": True}
    print("  reorder via JSON API: OK")

    # Verify the order changed by inspecting the edit page
    r = s.get(f"/playlists/{pid}")
    assert r.status_code == 200
    assert image_name in r.text
    assert video_name in r.text
    assert r.text.index(image_name) < r.text.index(video_name), "image should be listed first after reorder"
    print("  playlist_edit page renders in the new order: OK")

    # Register a device
    device_id = f"lobby-pi-{RUN}"
    r = s.post("/devices", data={"device_id": device_id, "name": f"Lobby Pi {RUN}"})
    assert r.status_code == 303, f"register device failed: {r.status_code} {r.text[:200]}"
    device = one("SELECT id, device_id, token FROM devices WHERE device_id = ?", (device_id,))
    print(f"  register device: id={device['id']} OK")

    # Assign the playlist to the device
    r = s.post(f"/devices/{device['id']}/assign", data={"playlist_id": str(pid)})
    assert r.status_code == 303
    print("  assign playlist to device: OK")

    # Hit /api/sync as the device, reporting status
    r = sync(BASE, device, current_position="0", current_filename=image["filename"],
             player_status="playing", player_version="test-0.0.1")
    assert r.status_code == 200, r.text[:300]
    manifest = r.json()
    print("  /api/sync: 200")
    print(f"    device: {manifest['device']}")
    print(f"    playlist name: {manifest['playlist']['name']}")
    print(f"    items: {len(manifest['playlist']['items'])}")
    assert manifest["playlist"]["id"] == pid
    assert len(manifest["playlist"]["items"]) == 2
    first = manifest["playlist"]["items"][0]
    second = manifest["playlist"]["items"][1]
    assert first["media_type"] == "image", f"first should be image, got {first['media_type']}"
    assert first["effective_duration_seconds"] == 7.5, f"override not applied: {first['effective_duration_seconds']}"
    assert second["media_type"] == "video"
    assert second["natural_duration_seconds"], "video duration should have been probed"
    assert "url" in first and first["url"].endswith("/api/media/" + first["filename"])
    print(f"    first item: {first['media_type']}, effective_duration={first['effective_duration_seconds']}s [OK]")
    print(f"    second item: {second['media_type']}, effective_duration={second['effective_duration_seconds']} [OK]")

    # The device can download its own media
    r = requests.get(first["url"].replace(manifest_base(first["url"]), BASE), headers=bearer(device["token"]))
    assert r.status_code == 200, f"device media download failed: {r.status_code}"
    print("  device can download its playlist media: OK")

    # Verify device status was recorded
    row = one(
        "SELECT current_position, current_filename, player_status, player_version FROM devices WHERE id = ?",
        (device["id"],),
    )
    print(f"  device status in DB: pos={row['current_position']}, file={row['current_filename']}, "
          f"status={row['player_status']}, ver={row['player_version']}")
    assert row["current_position"] == 0
    assert row["current_filename"] == image["filename"]
    assert row["player_status"] == "playing"
    assert row["player_version"] == "test-0.0.1"
    print("    device status: recorded correctly [OK]")

    # Dashboard should now show the current playing item
    r = s.get("/dashboard")
    assert r.status_code == 200
    assert image["filename"] in r.text, "dashboard should show currently-playing file"
    assert "playing" in r.text
    print("  dashboard shows 'Now playing': OK")

    print()
    print("ALL v2 SMOKE TESTS PASSED")


def manifest_base(url: str) -> str:
    """Scheme+host of a manifest URL (the CMS may advertise PIPLAYER_PUBLIC_BASE_URL)."""
    from urllib.parse import urlsplit
    parts = urlsplit(url)
    return f"{parts.scheme}://{parts.netloc}"


if __name__ == "__main__":
    main()
