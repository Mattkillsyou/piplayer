"""End-to-end smoke test for v3 (schedules), v4 (groups + remote actions + audit), v5 (multi-user + screenshots)."""
import datetime as dt
import io
import os
import sqlite3
import sys
import tempfile

import requests

BASE = "http://127.0.0.1:8767"


def db_path():
    return os.path.join(os.environ["PIPLAYER_DATA_DIR"], "cms.db")


def query(sql, params=()):
    conn = sqlite3.connect(db_path())
    conn.row_factory = sqlite3.Row
    rows = [dict(r) for r in conn.execute(sql, params).fetchall()]
    conn.close()
    return rows


def main():
    admin = requests.Session()
    r = admin.post(f"{BASE}/login", data={"username": "admin", "password": "test1234"}, allow_redirects=False)
    assert r.status_code == 303
    print("  admin login: OK")

    # --- v5.1: multi-user + roles ---
    r = admin.post(f"{BASE}/users", data={"username": "edith", "password": "editor-pass", "role": "editor"}, allow_redirects=False)
    assert r.status_code == 303, f"create editor failed: {r.status_code} {r.text[:200]}"
    r = admin.post(f"{BASE}/users", data={"username": "vinny", "password": "viewer-pass", "role": "viewer"}, allow_redirects=False)
    assert r.status_code == 303, f"create viewer failed: {r.status_code}"
    print("  v5.1 create editor + viewer: OK")

    # Viewer can read, cannot write
    viewer = requests.Session()
    r = viewer.post(f"{BASE}/login", data={"username": "vinny", "password": "viewer-pass"}, allow_redirects=False)
    assert r.status_code == 303
    r = viewer.get(f"{BASE}/library")
    assert r.status_code == 200
    r = viewer.post(f"{BASE}/playlists", data={"name": "viewer-forbidden"}, allow_redirects=False)
    assert r.status_code == 403, f"viewer should be 403 on create playlist, got {r.status_code}"
    print("  v5.1 viewer is read-only (403 on write): OK")

    # Viewer cannot see /users
    r = viewer.get(f"{BASE}/users")
    assert r.status_code == 403
    print("  v5.1 viewer blocked from /users: OK")

    # Cannot delete last admin
    admin_row = query("SELECT id FROM users WHERE username = 'admin'")[0]
    r = admin.post(f"{BASE}/users/{admin_row['id']}/delete", allow_redirects=False)
    assert r.status_code == 400, f"deleting last admin should 400, got {r.status_code}"
    print("  v5.1 last-admin guard: OK")

    # Editor can upload + create playlist
    editor = requests.Session()
    r = editor.post(f"{BASE}/login", data={"username": "edith", "password": "editor-pass"}, allow_redirects=False)
    assert r.status_code == 303
    with tempfile.NamedTemporaryFile(suffix=".mp4", delete=False) as f:
        f.write(b"FAKE-VIDEO-" + os.urandom(2048))
        vp = f.name
    with open(vp, "rb") as f:
        r = editor.post(f"{BASE}/library/upload", files={"file": ("morning_intro.mp4", f, "video/mp4")}, allow_redirects=False)
    os.unlink(vp)
    assert r.status_code == 303, f"editor upload failed: {r.status_code}"
    with tempfile.NamedTemporaryFile(suffix=".mp4", delete=False) as f:
        f.write(b"FAKE-VIDEO-" + os.urandom(2048))
        vp = f.name
    with open(vp, "rb") as f:
        r = editor.post(f"{BASE}/library/upload", files={"file": ("evening_intro.mp4", f, "video/mp4")}, allow_redirects=False)
    os.unlink(vp)
    assert r.status_code == 303

    r = editor.post(f"{BASE}/playlists", data={"name": "Morning Loop"}, allow_redirects=False)
    morning_pid = int(r.headers["location"].rsplit("/", 1)[-1])
    r = editor.post(f"{BASE}/playlists", data={"name": "Evening Loop"}, allow_redirects=False)
    evening_pid = int(r.headers["location"].rsplit("/", 1)[-1])
    r = editor.post(f"{BASE}/playlists", data={"name": "Default Loop"}, allow_redirects=False)
    default_pid = int(r.headers["location"].rsplit("/", 1)[-1])
    print(f"  editor uploaded 2 videos and created 3 playlists: OK")

    # Add 1 video to each
    media_rows = query("SELECT id, original_name FROM media ORDER BY id")
    morning_media = next(m for m in media_rows if m["original_name"] == "morning_intro.mp4")
    evening_media = next(m for m in media_rows if m["original_name"] == "evening_intro.mp4")
    editor.post(f"{BASE}/playlists/{morning_pid}/items", data={"media_id": str(morning_media["id"])}, allow_redirects=False)
    editor.post(f"{BASE}/playlists/{evening_pid}/items", data={"media_id": str(evening_media["id"])}, allow_redirects=False)
    editor.post(f"{BASE}/playlists/{default_pid}/items", data={"media_id": str(morning_media["id"])}, allow_redirects=False)

    # Register device
    r = editor.post(f"{BASE}/devices", data={"device_id": "dojo-pi", "name": "Dojo Pi"}, allow_redirects=False)
    assert r.status_code == 303
    device_row = query("SELECT id, token FROM devices WHERE device_id = 'dojo-pi'")[0]
    did = device_row["id"]
    token = device_row["token"]

    # Set default playlist
    editor.post(f"{BASE}/devices/{did}/assign", data={"playlist_id": str(default_pid)}, allow_redirects=False)
    print(f"  device dojo-pi created and assigned default playlist {default_pid}: OK")

    # --- v4.1: groups ---
    r = editor.post(f"{BASE}/groups", data={"name": "Lobby Projectors"}, allow_redirects=False)
    assert r.status_code == 303
    gid = query("SELECT id FROM device_groups WHERE name = 'Lobby Projectors'")[0]["id"]
    # Assign default playlist to group (different from device default)
    editor.post(f"{BASE}/groups/{gid}/assign", data={"playlist_id": str(default_pid)}, allow_redirects=False)
    # Put device in group
    editor.post(f"{BASE}/devices/{did}/group", data={"group_id": str(gid)}, allow_redirects=False)
    print(f"  v4.1 group created, playlist assigned, device added: OK")

    # --- v3.1-v3.2: scheduling ---
    # Create a "Morning Loop" rule that matches RIGHT NOW (just use a wide window)
    now = dt.datetime.now()
    one_min_ago = (now - dt.timedelta(minutes=1)).strftime("%H:%M")
    one_min_ahead = (now + dt.timedelta(minutes=1)).strftime("%H:%M")
    r = editor.post(
        f"{BASE}/devices/{did}/schedule",
        data={
            "name": "Active Window",
            "playlist_id": str(morning_pid),
            "priority": "10",
            "start_time": one_min_ago,
            "end_time": one_min_ahead,
            "days_of_week": "0123456",  # every day
        },
        allow_redirects=False,
    )
    assert r.status_code == 303, f"schedule create failed: {r.status_code}"

    # Create another rule that does NOT match (one hour ago to 59 minutes ago)
    long_ago_start = (now - dt.timedelta(hours=1)).strftime("%H:%M")
    long_ago_end = (now - dt.timedelta(minutes=59)).strftime("%H:%M")
    r = editor.post(
        f"{BASE}/devices/{did}/schedule",
        data={
            "name": "Inactive Window",
            "playlist_id": str(evening_pid),
            "priority": "20",  # higher priority but doesn't match
            "start_time": long_ago_start,
            "end_time": long_ago_end,
            "days_of_week": "0123456",
        },
        allow_redirects=False,
    )
    assert r.status_code == 303
    print(f"  v3.1-3.2 added two schedule rules (one matching, one not): OK")

    # Hit /api/sync and verify the morning playlist is returned (the matching rule wins)
    r = requests.get(f"{BASE}/api/sync/dojo-pi", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 200, r.text[:300]
    manifest = r.json()
    pl = manifest["playlist"]
    assert pl["id"] == morning_pid, f"expected morning_pid={morning_pid}, got {pl['id']}"
    assert pl["source"] == "schedule:Active Window", f"unexpected source: {pl['source']}"
    print(f"  v3.2 sync resolves to scheduled playlist 'Morning Loop' via source '{pl['source']}': OK")

    # --- v4.2: remote commands ---
    r = editor.post(f"{BASE}/devices/{did}/command", data={"command": "force-sync"}, allow_redirects=False)
    assert r.status_code == 303
    cmd_id = query("SELECT id FROM device_commands WHERE device_id = ? AND command = 'force-sync'", (did,))[0]["id"]
    print(f"  v4.2 issued force-sync command (id={cmd_id}): OK")

    # Sync as device — should include the pending command
    r = requests.get(f"{BASE}/api/sync/dojo-pi", headers={"Authorization": f"Bearer {token}"})
    manifest = r.json()
    cmds = manifest.get("commands") or []
    assert any(c["id"] == cmd_id and c["command"] == "force-sync" for c in cmds), f"expected command {cmd_id} in manifest, got {cmds}"
    print(f"  v4.2 sync returns pending command in manifest: OK")

    # Verify delivered_at is now set
    drow = query("SELECT delivered_at, completed_at FROM device_commands WHERE id = ?", (cmd_id,))[0]
    assert drow["delivered_at"] is not None, "delivered_at should be set"
    assert drow["completed_at"] is None, "completed_at should NOT be set yet"

    # Report result
    r = requests.post(
        f"{BASE}/api/commands/{cmd_id}/result",
        headers={"Authorization": f"Bearer {token}"},
        json={"result": "queued resync"},
    )
    assert r.status_code == 200
    drow = query("SELECT completed_at, result FROM device_commands WHERE id = ?", (cmd_id,))[0]
    assert drow["completed_at"] is not None
    assert drow["result"] == "queued resync"
    print(f"  v4.2 command result reported and stored: OK")

    # Next sync should NOT include the completed command
    r = requests.get(f"{BASE}/api/sync/dojo-pi", headers={"Authorization": f"Bearer {token}"})
    manifest = r.json()
    cmds = manifest.get("commands") or []
    assert not any(c["id"] == cmd_id for c in cmds), "completed command should not be re-delivered"
    print(f"  v4.2 completed command not re-delivered: OK")

    # --- v5.2: screenshot upload ---
    # Fake 1x1 jpeg (we don't really need valid JPEG bytes for this test)
    fake_jpg = b"\xff\xd8\xff\xe0\x00\x10JFIF\x00" + os.urandom(2048) + b"\xff\xd9"
    r = requests.post(
        f"{BASE}/api/screenshots/dojo-pi",
        headers={"Authorization": f"Bearer {token}"},
        files={"file": ("screen.jpg", io.BytesIO(fake_jpg), "image/jpeg")},
    )
    assert r.status_code == 200, f"screenshot upload failed: {r.status_code} {r.text[:200]}"
    drow = query("SELECT last_screenshot_at FROM devices WHERE id = ?", (did,))[0]
    assert drow["last_screenshot_at"] is not None
    screenshot_path = os.path.join(os.environ["PIPLAYER_DATA_DIR"], "screenshots", "dojo-pi.jpg")
    assert os.path.exists(screenshot_path), f"screenshot file missing: {screenshot_path}"
    print(f"  v5.2 screenshot uploaded and stored: OK")

    # Admin can fetch it
    r = admin.get(f"{BASE}/devices/{did}/screenshot")
    assert r.status_code == 200
    assert r.content == fake_jpg
    print(f"  v5.2 admin can fetch screenshot via UI: OK")

    # --- v4.3: audit log ---
    r = admin.get(f"{BASE}/audit")
    assert r.status_code == 200
    audit_count = query("SELECT COUNT(*) AS n FROM audit_log")[0]["n"]
    assert audit_count > 0
    actions_seen = {r["action"] for r in query("SELECT DISTINCT action FROM audit_log")}
    expected = {"login", "user_create", "upload_media", "create_playlist", "register_device",
                "device_assign_playlist", "group_create", "group_assign_playlist", "device_set_group",
                "device_schedule_create", "device_send_command", "playlist_add_item"}
    missing = expected - actions_seen
    assert not missing, f"missing audit actions: {missing}"
    print(f"  v4.3 audit log has {audit_count} entries covering all expected actions: OK")

    # --- Pages render OK ---
    for path in ["/dashboard", "/library", "/playlists", "/devices", "/groups", "/audit", "/users",
                 f"/playlists/{morning_pid}", f"/devices/{did}/schedule"]:
        r = admin.get(f"{BASE}{path}")
        assert r.status_code == 200, f"{path} -> {r.status_code}"
    print(f"  all admin pages render 200: OK")

    print()
    print("ALL v3-v5 SMOKE TESTS PASSED")


if __name__ == "__main__":
    main()
