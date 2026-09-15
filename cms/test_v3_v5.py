"""End-to-end smoke test for v3 (schedules), v4 (groups + remote actions + audit),
v5 (multi-user + screenshots) and zero-touch enrollment (/api/enroll + Settings).

Re-runnable: every name carries a per-run token, ids are resolved from
responses or from cms.db, and the CSRF token is fetched from the server.

Prerequisites (run_smoke_tests.py sets all of this up for you):
  PIPLAYER_BASE_URL   base URL of a running CMS (default http://127.0.0.1:8767)
  PIPLAYER_DATA_DIR   the CMS's data dir (this script reads cms.db directly)
  admin password      test1234 (start the CMS with PIPLAYER_ADMIN_PASSWORD=test1234)
  ffmpeg on PATH      to synthesize small valid test videos
"""
import datetime as dt
import io
import os
import secrets
import sys
import tempfile
from pathlib import Path

import requests

sys.path.insert(0, str(Path(__file__).resolve().parent / "tests"))
from cms_mediagen import make_jpeg_bytes, make_mp4  # noqa: E402
from smoke_common import Client, base_url, bearer, one, query, sync  # noqa: E402

BASE = base_url(8767)
RUN = secrets.token_hex(3)


def upload_video(client, name):
    tmp = Path(tempfile.mkdtemp(prefix="piplayer-smoke-"))
    try:
        path = make_mp4(tmp / name, seed=name)
        with open(path, "rb") as f:
            r = client.post("/library/upload", files={"file": (name, f, "video/mp4")})
        assert r.status_code == 303, f"upload {name} failed: {r.status_code} {r.text[:300]}"
    finally:
        for p in tmp.iterdir():
            p.unlink(missing_ok=True)
        tmp.rmdir()
    return one("SELECT id, filename FROM media WHERE original_name = ?", (name,))


def main():
    admin = Client(BASE)
    r = admin.login("admin", "test1234")
    assert r.status_code == 303, f"admin login failed: {r.status_code} {r.text[:200]}"
    print("  admin login: OK")

    # --- v5.1: multi-user + roles ---
    editor_name, viewer_name = f"edith-{RUN}", f"vinny-{RUN}"
    r = admin.post("/users", data={"username": editor_name, "password": "editor-pass", "role": "editor"})
    assert r.status_code == 303, f"create editor failed: {r.status_code} {r.text[:200]}"
    r = admin.post("/users", data={"username": viewer_name, "password": "viewer-pass", "role": "viewer"})
    assert r.status_code == 303, f"create viewer failed: {r.status_code}"
    print("  v5.1 create editor + viewer: OK")

    # Viewer can read, cannot write
    viewer = Client(BASE)
    r = viewer.login(viewer_name, "viewer-pass")
    assert r.status_code == 303
    r = viewer.get("/library")
    assert r.status_code == 200
    r = viewer.post("/playlists", data={"name": f"viewer-forbidden-{RUN}"})
    assert r.status_code == 403, f"viewer should be 403 on create playlist, got {r.status_code}"
    print("  v5.1 viewer is read-only (403 on write): OK")

    # Viewer cannot see /users
    r = viewer.get("/users")
    assert r.status_code == 403
    print("  v5.1 viewer blocked from /users: OK")

    # Cannot delete yourself / the last admin
    admin_row = one("SELECT id FROM users WHERE username = 'admin'")
    r = admin.post(f"/users/{admin_row['id']}/delete")
    assert r.status_code == 400, f"deleting yourself / last admin should 400, got {r.status_code}"
    print("  v5.1 last-admin guard: OK")

    # Editor can upload + create playlist
    editor = Client(BASE)
    r = editor.login(editor_name, "editor-pass")
    assert r.status_code == 303
    morning_media = upload_video(editor, f"morning_intro_{RUN}.mp4")
    evening_media = upload_video(editor, f"evening_intro_{RUN}.mp4")

    def create_playlist(name):
        r = editor.post("/playlists", data={"name": name})
        assert r.status_code == 303, f"create playlist {name!r} failed: {r.status_code} {r.text[:200]}"
        return int(r.headers["location"].rsplit("/", 1)[-1])

    morning_pid = create_playlist(f"Morning Loop {RUN}")
    evening_pid = create_playlist(f"Evening Loop {RUN}")
    default_pid = create_playlist(f"Default Loop {RUN}")
    print("  editor uploaded 2 videos and created 3 playlists: OK")

    # Add 1 video to each
    for pid, media in ((morning_pid, morning_media), (evening_pid, evening_media), (default_pid, morning_media)):
        r = editor.post(f"/playlists/{pid}/items", data={"media_id": str(media["id"])})
        assert r.status_code == 303, f"add item failed: {r.status_code} {r.text[:200]}"

    # Register device
    device_id = f"dojo-pi-{RUN}"
    r = editor.post("/devices", data={"device_id": device_id, "name": f"Dojo Pi {RUN}"})
    assert r.status_code == 303, f"register device failed: {r.status_code} {r.text[:200]}"
    device = one("SELECT id, device_id, token FROM devices WHERE device_id = ?", (device_id,))
    did = device["id"]
    token = device["token"]

    # Set default playlist
    r = editor.post(f"/devices/{did}/assign", data={"playlist_id": str(default_pid)})
    assert r.status_code == 303
    print(f"  device {device_id} created and assigned default playlist {default_pid}: OK")

    # --- v4.1: groups ---
    group_name = f"Lobby Projectors {RUN}"
    r = editor.post("/groups", data={"name": group_name})
    assert r.status_code == 303
    gid = one("SELECT id FROM device_groups WHERE name = ?", (group_name,))["id"]
    r = editor.post(f"/groups/{gid}/assign", data={"playlist_id": str(default_pid)})
    assert r.status_code == 303
    r = editor.post(f"/devices/{did}/group", data={"group_id": str(gid)})
    assert r.status_code == 303
    print("  v4.1 group created, playlist assigned, device added: OK")

    # --- v3.1-v3.2: scheduling ---
    # A rule that matches RIGHT NOW: a +/-5 minute window (wide enough that the
    # server's evaluation a few hundred ms later can never fall outside it).
    now = dt.datetime.now()
    win_start = (now - dt.timedelta(minutes=5)).strftime("%H:%M")
    win_end = (now + dt.timedelta(minutes=5)).strftime("%H:%M")
    r = editor.post(
        f"/devices/{did}/schedule",
        data={
            "name": "Active Window",
            "playlist_id": str(morning_pid),
            "priority": "10",
            "start_time": win_start,
            "end_time": win_end,
            "days_of_week": "0123456",  # every day
        },
    )
    assert r.status_code == 303, f"schedule create failed: {r.status_code} {r.text[:200]}"

    # A rule that does NOT match (one hour ago to 59 minutes ago), higher priority
    long_ago_start = (now - dt.timedelta(hours=1)).strftime("%H:%M")
    long_ago_end = (now - dt.timedelta(minutes=59)).strftime("%H:%M")
    r = editor.post(
        f"/devices/{did}/schedule",
        data={
            "name": "Inactive Window",
            "playlist_id": str(evening_pid),
            "priority": "20",
            "start_time": long_ago_start,
            "end_time": long_ago_end,
            "days_of_week": "0123456",
        },
    )
    assert r.status_code == 303, f"schedule create failed: {r.status_code} {r.text[:200]}"

    print("  v3.1-3.2 added two schedule rules (one matching, one not): OK")

    # Hit /api/sync and verify the morning playlist is returned (the matching rule wins)
    r = sync(BASE, device)
    assert r.status_code == 200, r.text[:300]
    manifest = r.json()
    pl = manifest["playlist"]
    assert pl["id"] == morning_pid, f"expected morning_pid={morning_pid}, got {pl['id']}"
    assert pl["source"] == "schedule:Active Window", f"unexpected source: {pl['source']}"
    print(f"  v3.2 sync resolves to scheduled playlist 'Morning Loop {RUN}' via source '{pl['source']}': OK")
    server_time = dt.datetime.fromisoformat(manifest["server_time"])
    assert server_time.tzinfo is not None, f"server_time has no UTC offset: {manifest['server_time']}"
    print(f"  v3.2 server_time carries an offset ({manifest['server_time']}): OK")

    # Malformed rules are rejected, not stored
    r = editor.post(f"/devices/{did}/schedule",
                    data={"name": "Bad", "playlist_id": str(morning_pid), "priority": "1",
                          "start_time": "25:99", "end_time": "junk"})
    assert r.status_code == 400, f"malformed schedule time should be 400, got {r.status_code}"
    r = editor.post(f"/devices/{did}/schedule",
                    data={"name": "Bad", "playlist_id": str(morning_pid), "priority": "1",
                          "start_time": "09:00", "end_time": "09:00"})
    assert r.status_code == 400, f"start == end should be 400, got {r.status_code}"
    assert one("SELECT COUNT(*) AS n FROM device_schedules WHERE device_id = ?", (did,))["n"] == 2
    print("  v3.1 malformed schedule rules rejected with 400: OK")

    # --- v4.2: remote commands ---
    r = editor.post(f"/devices/{did}/command", data={"command": "force-sync"})
    assert r.status_code == 303
    cmd_id = one("SELECT id FROM device_commands WHERE device_id = ? AND command = 'force-sync' "
                 "ORDER BY id DESC LIMIT 1", (did,))["id"]
    print(f"  v4.2 issued force-sync command (id={cmd_id}): OK")

    # Sync as device -- should include the pending command
    r = sync(BASE, device)
    manifest = r.json()
    cmds = manifest.get("commands") or []
    assert any(c["id"] == cmd_id and c["command"] == "force-sync" for c in cmds), \
        f"expected command {cmd_id} in manifest, got {cmds}"
    print("  v4.2 sync returns pending command in manifest: OK")

    # Verify delivered_at is now set
    drow = one("SELECT delivered_at, completed_at FROM device_commands WHERE id = ?", (cmd_id,))
    assert drow["delivered_at"] is not None, "delivered_at should be set"
    assert drow["completed_at"] is None, "completed_at should NOT be set yet"

    # Report result
    r = requests.post(f"{BASE}/api/commands/{cmd_id}/result", headers=bearer(token), json={"result": "queued resync"})
    assert r.status_code == 200
    drow = one("SELECT completed_at, result FROM device_commands WHERE id = ?", (cmd_id,))
    assert drow["completed_at"] is not None
    assert drow["result"] == "queued resync"
    print("  v4.2 command result reported and stored: OK")

    # Next sync should NOT include the completed command
    r = sync(BASE, device)
    cmds = r.json().get("commands") or []
    assert not any(c["id"] == cmd_id for c in cmds), "completed command should not be re-delivered"
    print("  v4.2 completed command not re-delivered: OK")

    # A command that never gets a result is delivered at most 5 times
    r = editor.post(f"/devices/{did}/command", data={"command": "restart-mpv"})
    assert r.status_code == 303
    stuck_id = one("SELECT id FROM device_commands WHERE device_id = ? AND command = 'restart-mpv' "
                   "ORDER BY id DESC LIMIT 1", (did,))["id"]
    deliveries = 0
    for _ in range(7):
        cmds = sync(BASE, device).json().get("commands") or []
        if any(c["id"] == stuck_id for c in cmds):
            deliveries += 1
    assert deliveries == 5, f"command should be delivered exactly 5 times, was {deliveries}"
    drow = one("SELECT completed_at, result FROM device_commands WHERE id = ?", (stuck_id,))
    assert drow["completed_at"] is not None and drow["result"] == "undeliverable: no result after 5 deliveries", drow
    print("  v4.2 unanswered command capped at 5 deliveries: OK")

    # Sync error reporting
    r = sync(BASE, device, sync_error="1 of 1 items missing: x.mp4")
    assert r.status_code == 200
    assert one("SELECT last_error FROM devices WHERE id = ?", (did,))["last_error"] == "1 of 1 items missing: x.mp4"
    assert "1 of 1 items missing: x.mp4" in admin.get("/devices").text
    r = sync(BASE, device, sync_error="")
    assert one("SELECT last_error FROM devices WHERE id = ?", (did,))["last_error"] in ("", None)
    print("  v4.2 sync_error stored, shown and cleared: OK")

    # Viewer must not see the device token, editor must
    assert token not in viewer.get("/devices").text, "viewer can read the device token"
    assert token in editor.get("/devices").text, "editor cannot see the device token"
    print("  v5.1 device token hidden from viewer, visible to editor: OK")

    # --- v5.2: screenshot upload ---
    fake_jpg = make_jpeg_bytes(seed=RUN)
    r = requests.post(
        f"{BASE}/api/screenshots/{device_id}",
        headers=bearer(token),
        files={"file": ("screen.jpg", io.BytesIO(fake_jpg), "image/jpeg")},
    )
    assert r.status_code == 200, f"screenshot upload failed: {r.status_code} {r.text[:200]}"
    drow = one("SELECT last_screenshot_at FROM devices WHERE id = ?", (did,))
    assert drow["last_screenshot_at"] is not None
    screenshot_path = os.path.join(os.environ["PIPLAYER_DATA_DIR"], "screenshots", f"{device_id}.jpg")
    assert os.path.exists(screenshot_path), f"screenshot file missing: {screenshot_path}"
    print("  v5.2 screenshot uploaded and stored: OK")

    # A non-JPEG is rejected
    r = requests.post(
        f"{BASE}/api/screenshots/{device_id}",
        headers=bearer(token),
        files={"file": ("screen.jpg", io.BytesIO(b"\x89PNG\r\n\x1a\n" + os.urandom(256)), "image/jpeg")},
    )
    assert r.status_code == 400, f"non-JPEG screenshot should be 400, got {r.status_code}"
    print("  v5.2 non-JPEG screenshot rejected: OK")

    # Admin can fetch it
    r = admin.get(f"/devices/{did}/screenshot")
    assert r.status_code == 200
    assert r.content == fake_jpg
    assert r.headers.get("X-Content-Type-Options") == "nosniff"
    print("  v5.2 admin can fetch screenshot via UI: OK")

    # --- zero-touch enrollment: POST /api/enroll + admin Settings page ---
    def enrollment_key():
        return one("SELECT value FROM settings WHERE key = 'enrollment_key'")["value"]

    def enroll(key, dev_id, name):
        return requests.post(f"{BASE}/api/enroll", json={"key": key, "device_id": dev_id, "name": name})

    key = enrollment_key()
    enroll_id = f"enroll-pi-{RUN}"
    r = enroll(key, enroll_id.upper(), f"Enrolled Pi {RUN}")  # device_id is lowercased
    assert r.status_code == 200, f"enroll failed: {r.status_code} {r.text[:200]}"
    body = r.json()
    erow = one("SELECT id, name, token FROM devices WHERE device_id = ?", (enroll_id,))
    assert body["device_id"] == enroll_id and body["token"] == erow["token"], body
    assert body["cms_url"].startswith("http"), body  # the console's own base URL (PIPLAYER_PUBLIC_BASE_URL or the request origin)
    server_log = Path(os.environ["PIPLAYER_DATA_DIR"]) / "server.log"  # written by run_smoke_tests.py
    if server_log.exists():
        assert erow["token"] not in server_log.read_text(errors="replace"), "enroll must never log the token"
    print("  enroll creates the device and returns its token + cms_url: OK")

    r = enroll(key, enroll_id, f"Renamed Pi {RUN}")
    assert r.status_code == 200 and r.json()["token"] == erow["token"], "re-enroll must keep the token"
    assert one("SELECT name FROM devices WHERE id = ?", (erow["id"],))["name"] == f"Renamed Pi {RUN}"
    print("  re-enroll keeps the token and updates the name: OK")

    r = enroll("not-the-key", f"bad-{RUN}", "x")
    assert r.status_code == 401 and r.json() == {"detail": "invalid enrollment key"}, (r.status_code, r.text[:200])
    assert not query("SELECT id FROM devices WHERE device_id = ?", (f"bad-{RUN}",))
    r = enroll(key, "-bad-id", "x")
    assert r.status_code == 400, f"bad device_id should be 400, got {r.status_code}"
    r = enroll(key, f"noname-{RUN}", "")
    assert r.status_code == 400, f"empty name should be 400, got {r.status_code}"
    print("  enroll rejects a wrong key (401) and bad device_id / name (400): OK")

    # Sync works with the enrolled token, same as a manually registered device
    r = sync(BASE, {"device_id": enroll_id, "token": erow["token"]})
    assert r.status_code == 200, r.text[:300]
    print("  enrolled device can sync: OK")

    # Settings page: admin only, shows the key; rotate invalidates the old key
    r = viewer.get("/settings")
    assert r.status_code == 403, f"viewer should be 403 on /settings, got {r.status_code}"
    r = admin.get("/settings")
    assert r.status_code == 200 and key in r.text, "admin Settings page must show the enrollment key"
    r = admin.post("/settings/enrollment/rotate")
    assert r.status_code == 303, f"rotate failed: {r.status_code} {r.text[:200]}"
    new_key = enrollment_key()
    assert new_key != key and len(new_key) >= 40
    assert enroll(key, f"stale-{RUN}", "x").status_code == 401, "old key must stop working after rotate"
    assert enroll(new_key, enroll_id, f"Renamed Pi {RUN}").status_code == 200
    print("  Settings page shows the key; rotate replaces it and the old key is refused: OK")

    # --- v4.3: audit log ---
    r = admin.get("/audit")
    assert r.status_code == 200
    audit_count = one("SELECT COUNT(*) AS n FROM audit_log")["n"]
    assert audit_count > 0
    actions_seen = {row["action"] for row in query("SELECT DISTINCT action FROM audit_log")}
    expected = {"login", "user_create", "upload_media", "create_playlist", "register_device",
                "device_assign_playlist", "group_create", "group_assign_playlist", "device_set_group",
                "device_schedule_create", "device_send_command", "playlist_add_item",
                "device_enrolled", "device_reenrolled", "enrollment_key_rotated"}
    missing = expected - actions_seen
    assert not missing, f"missing audit actions: {missing}"
    print(f"  v4.3 audit log has {audit_count} entries covering all expected actions: OK")

    # --- Pages render OK ---
    for path in ["/dashboard", "/library", "/playlists", "/devices", "/groups", "/audit", "/users", "/settings",
                 f"/playlists/{morning_pid}", f"/devices/{did}/schedule"]:
        r = admin.get(path)
        assert r.status_code == 200, f"{path} -> {r.status_code}"
    print("  all admin pages render 200: OK")

    # Clean-up of this run's device so re-runs do not accumulate stale devices on the dashboard
    r = editor.post(f"/devices/{did}/delete")
    assert r.status_code == 303
    assert not os.path.exists(screenshot_path), "device delete should remove its screenshot"
    r = editor.post(f"/devices/{erow['id']}/delete")
    assert r.status_code == 303
    print("  devices deleted (screenshot removed with it): OK")

    print()
    print("ALL v3-v5 SMOKE TESTS PASSED")


if __name__ == "__main__":
    main()
