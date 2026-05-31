"""End-to-end smoke test for v2 features. Run against a fresh DB."""
import os
import sys
import tempfile
import time
from pathlib import Path

import requests

BASE = "http://127.0.0.1:8766"


def main():
    s = requests.Session()

    # Login
    r = s.post(f"{BASE}/login", data={"username": "admin", "password": "test1234"}, allow_redirects=False)
    assert r.status_code == 303, f"login failed: {r.status_code}"
    print(f"  login: OK")

    # Upload a fake video (binary garbage with .mp4 extension)
    with tempfile.NamedTemporaryFile(suffix=".mp4", delete=False) as f:
        f.write(b"FAKE-VIDEO-DATA-" + os.urandom(2048))
        video_path = f.name
    with open(video_path, "rb") as f:
        r = s.post(f"{BASE}/library/upload", files={"file": ("dojo_logo.mp4", f, "video/mp4")}, allow_redirects=False)
    os.unlink(video_path)
    assert r.status_code == 303, f"video upload failed: {r.status_code} {r.text[:300]}"
    print(f"  upload video: {r.status_code} -> {r.headers.get('location')}")

    # Upload a fake image
    with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as f:
        f.write(b"\x89PNG\r\n\x1a\n" + os.urandom(2048))
        img_path = f.name
    with open(img_path, "rb") as f:
        r = s.post(f"{BASE}/library/upload", files={"file": ("class_schedule.png", f, "image/png")}, allow_redirects=False)
    os.unlink(img_path)
    assert r.status_code == 303, f"image upload failed: {r.status_code} {r.text[:300]}"
    print(f"  upload image: {r.status_code} -> {r.headers.get('location')}")

    # Library page should show both, with badges
    r = s.get(f"{BASE}/library")
    assert r.status_code == 200
    assert "badge-video" in r.text, "video badge missing"
    assert "badge-image" in r.text, "image badge missing"
    assert "dojo_logo.mp4" in r.text
    assert "class_schedule.png" in r.text
    print(f"  library page: shows VIDEO + IMAGE badges OK")

    # Create a playlist
    r = s.post(f"{BASE}/playlists", data={"name": "Lobby Loop"}, allow_redirects=False)
    assert r.status_code == 303
    pid = int(r.headers["location"].rsplit("/", 1)[-1])
    print(f"  create playlist: id={pid}")

    # Add both media to the playlist
    r = s.post(f"{BASE}/playlists/{pid}/items", data={"media_id": "1"}, allow_redirects=False)
    assert r.status_code == 303, r.text[:300]
    r = s.post(f"{BASE}/playlists/{pid}/items", data={"media_id": "2"}, allow_redirects=False)
    assert r.status_code == 303, r.text[:300]
    print(f"  add 2 items to playlist: OK")

    # Set duration override on item 2 (the image)
    r = s.post(f"{BASE}/playlists/{pid}/items/2/duration", data={"duration": "7.5"}, allow_redirects=False)
    assert r.status_code == 303, r.text[:300]
    print(f"  set duration override on item 2 (image) to 7.5s: OK")

    # Reorder: put item 2 first
    r = s.post(f"{BASE}/playlists/{pid}/items/reorder", json={"order": [2, 1]})
    assert r.status_code == 200, f"reorder failed: {r.status_code} {r.text[:300]}"
    assert r.json() == {"ok": True}
    print(f"  reorder via JSON API: OK")

    # Verify the order changed by inspecting the edit page
    r = s.get(f"{BASE}/playlists/{pid}")
    assert r.status_code == 200
    # The image should appear before the video in the order now (just check both present)
    assert "class_schedule.png" in r.text
    assert "dojo_logo.mp4" in r.text
    # The class schedule should be position 1 (#1 displayed) and have the override 7.5
    print(f"  playlist_edit page renders: OK")

    # Register a device
    r = s.post(f"{BASE}/devices", data={"device_id": "lobby-pi", "name": "Lobby Pi"}, allow_redirects=False)
    assert r.status_code == 303
    print(f"  register device: OK")

    # Assign the playlist to the device
    r = s.post(f"{BASE}/devices/1/assign", data={"playlist_id": str(pid)}, allow_redirects=False)
    assert r.status_code == 303
    print(f"  assign playlist to device: OK")

    # Read the device token from DB (we need it for the sync API)
    import sqlite3
    conn = sqlite3.connect(os.environ["PIPLAYER_DATA_DIR"] + "/cms.db")
    row = conn.execute("SELECT device_id, token FROM devices WHERE id = 1").fetchone()
    conn.close()
    device_id, token = row[0], row[1]

    # Hit /api/sync as the device, reporting status
    r = requests.get(
        f"{BASE}/api/sync/{device_id}",
        headers={"Authorization": f"Bearer {token}"},
        params={
            "current_position": "0",
            "current_filename": "class_schedule.png",
            "player_status": "playing",
            "player_version": "test-0.0.1",
        },
    )
    assert r.status_code == 200
    manifest = r.json()
    print(f"  /api/sync: 200")
    print(f"    device: {manifest['device']}")
    print(f"    playlist name: {manifest['playlist']['name']}")
    print(f"    items: {len(manifest['playlist']['items'])}")
    assert len(manifest["playlist"]["items"]) == 2
    first = manifest["playlist"]["items"][0]
    second = manifest["playlist"]["items"][1]
    assert first["media_type"] == "image", f"first should be image, got {first['media_type']}"
    assert first["effective_duration_seconds"] == 7.5, f"override not applied: {first['effective_duration_seconds']}"
    assert second["media_type"] == "video"
    assert "url" in first and first["url"].endswith("/api/media/" + first["filename"])
    print(f"    first item: {first['media_type']}, effective_duration={first['effective_duration_seconds']}s [OK]")
    print(f"    second item: {second['media_type']}, effective_duration={second['effective_duration_seconds']} [OK]")

    # Verify device status was recorded
    conn = sqlite3.connect(os.environ["PIPLAYER_DATA_DIR"] + "/cms.db")
    row = conn.execute(
        "SELECT current_position, current_filename, player_status, player_version FROM devices WHERE id = 1"
    ).fetchone()
    conn.close()
    print(f"  device status in DB: pos={row[0]}, file={row[1]}, status={row[2]}, ver={row[3]}")
    assert row[0] == 0
    assert row[1] == "class_schedule.png"
    assert row[2] == "playing"
    assert row[3] == "test-0.0.1"
    print(f"    device status: recorded correctly [OK]")

    # Dashboard should now show the current playing item
    r = s.get(f"{BASE}/dashboard")
    assert r.status_code == 200
    assert "class_schedule.png" in r.text, "dashboard should show currently-playing file"
    assert "playing" in r.text
    print(f"  dashboard shows 'Now playing': OK")

    print()
    print("ALL v2 SMOKE TESTS PASSED")


if __name__ == "__main__":
    main()
