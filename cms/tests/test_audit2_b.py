"""Second-audit fixes, package B (cms/app, cms/deploy): one test per code change.

S001 issued_at on manifest commands, S005 busy timeout / OperationalError -> 503,
S006 multipart part and field caps, S010 days_of_week validation, S016 header cap,
S017 stale delivered commands closed at migration, S018 audit pruning opt-in,
S019 devices-page hint, S022 closing boundary required, S023 over-long boundary -> 400,
S024 reorder ids must be JSON integers, S028 streaming screenshot receiver,
S029 file part before the CSRF token -> 403, S030 session rotated on login,
S037 HEAD /api/media, S038 dates are exactly YYYY-MM-DD, X002 expired session -> login
redirect, X004 still image with a video extension -> 400, X005 extension checked at
the part header.
"""
import os
import sqlite3
import threading
import time

import pytest

from cms_helpers import (add_item, bearer, create_device, create_playlist, csrf_token,
                         find_csrf, one, post, post_files, post_json, query, sync, upload)
from cms_mediagen import make_jpeg_bytes
from cms_support import ADMIN_PASSWORD, ADMIN_USERNAME

BOUNDARY = "audit2-boundary"
MP_HEADERS = {"Content-Type": f"multipart/form-data; boundary={BOUNDARY}"}


def _part(name, value, filename=None, ctype=None):
    disp = f'form-data; name="{name}"' + (f'; filename="{filename}"' if filename else "")
    head = f"--{BOUNDARY}\r\nContent-Disposition: {disp}\r\n"
    if ctype:
        head += f"Content-Type: {ctype}\r\n"
    return head.encode() + b"\r\n" + (value if isinstance(value, bytes) else value.encode()) + b"\r\n"


def _body(*parts, closed=True):
    return b"".join(parts) + (f"--{BOUNDARY}--\r\n".encode() if closed else b"")


def _tmp_uploads(cms):
    return sorted(cms.config.MEDIA_DIR.glob(".upload_*.tmp"))


def _shot_tmp(cms):
    return sorted(cms.config.SCREENSHOT_DIR.glob(".upload_*.tmp"))


# ---------------------------------------------------------------------------
# S001: manifest commands carry issued_at (the player's reused-id ledger keys on it)
# ---------------------------------------------------------------------------

def test_manifest_commands_include_issued_at(admin, client, tok):
    dev = create_device(admin, f"s001-{tok}")
    r = post(admin, f"/devices/{dev['id']}/command", {"command": "force-sync"})
    assert r.status_code == 303
    row = one("SELECT id, issued_at FROM device_commands WHERE device_id = ?", (dev["id"],))
    cmds = sync(client, dev).json()["commands"]
    assert cmds == [{"id": row["id"], "command": "force-sync", "issued_at": row["issued_at"]}]
    assert row["issued_at"]  # NOT NULL default in the schema, never None on the wire


# ---------------------------------------------------------------------------
# S005: writer contention waits past sqlite3's 5 s default; a real lock is a 503 {detail}
# ---------------------------------------------------------------------------

def test_write_waits_out_a_six_second_lock(cms):
    locked = threading.Event()
    released = threading.Event()

    def _hold():
        holder = sqlite3.connect(cms.config.DB_PATH, timeout=1)
        holder.execute("BEGIN IMMEDIATE")
        locked.set()
        time.sleep(6)
        holder.rollback()
        holder.close()
        released.set()

    threading.Thread(target=_hold, daemon=True).start()
    assert locked.wait(5)
    t0 = time.monotonic()
    with cms.db.cursor() as cur:  # would raise "database is locked" at the 5 s default
        cur.execute("UPDATE playlists SET updated_at = updated_at WHERE id = -1")
    assert time.monotonic() - t0 >= 5, "write did not block on the held lock"
    released.wait(5)


def test_locked_database_is_a_clean_503(admin, cms, monkeypatch):
    def _locked(*a, **k):
        raise sqlite3.OperationalError("database is locked")

    monkeypatch.setattr(cms.db, "connect", _locked)
    r = admin.get("/library")
    assert r.status_code == 503, f"{r.status_code} {r.text[:300]}"
    assert r.json()["detail"] == "database busy, try again"
    assert r.headers.get("retry-after")


# ---------------------------------------------------------------------------
# S006 / S016 / X005: caps inside the streaming receiver
# ---------------------------------------------------------------------------

def test_too_many_multipart_parts_is_400(admin, cms, tok):
    parts = [_part(f"f{i}", "x" * 100) for i in range(cms.web_routes._UploadReceiver.MAX_PARTS + 1)]
    headers = dict(MP_HEADERS, **{"X-CSRF-Token": csrf_token(admin)})
    r = admin.post("/library/upload", content=_body(*parts), headers=headers, follow_redirects=False)
    assert r.status_code == 400 and "too many multipart parts" in r.json()["detail"]
    assert _tmp_uploads(cms) == []


def test_oversized_text_fields_are_400(admin, cms, tok):
    # two fields whose bytes together pass the total cap (each part counts every byte
    # it carries, stored or not), well under MAX_PARTS
    half = cms.web_routes._UploadReceiver.MAX_FIELDS_TOTAL_BYTES // 2 + 1
    parts = [_part("f0", "y" * half), _part("f1", "y" * half)]
    headers = dict(MP_HEADERS, **{"X-CSRF-Token": csrf_token(admin)})
    r = admin.post("/library/upload", content=_body(*parts), headers=headers, follow_redirects=False)
    assert r.status_code == 400 and "text fields too large" in r.json()["detail"]


def test_receiver_caps_part_header_size(cms, tmp_path):
    recv = cms.web_routes._UploadReceiver(tmp_path / "t", 10)
    recv.on_part_begin()
    junk = b"x" * (recv.MAX_HEADER_BYTES + 1)
    recv.on_header_value(junk, 0, len(junk))
    assert recv.error is not None and recv.error.status_code == 400
    assert len(recv._hdr_value) == 0  # nothing accumulated once over the cap


def test_receiver_rejects_extension_before_any_file_bytes(cms, tmp_path):
    recv = cms.web_routes._UploadReceiver(tmp_path / "t", 10, cms.config.ALLOWED_EXTENSIONS)
    recv.on_part_begin()
    disp = b'form-data; name="file"; filename="movie.avi"'
    recv.on_header_field(b"Content-Disposition", 0, 19)
    recv.on_header_value(disp, 0, len(disp))
    recv.on_header_end()
    recv.on_headers_finished()
    assert recv.error is not None and recv.error.status_code == 400
    assert "Unsupported extension .avi" in recv.error.detail
    assert recv._out is None and not (tmp_path / "t").exists()


def test_unsupported_extension_upload_is_400_end_to_end(admin, cms, tok):
    r = post_files(admin, "/library/upload", {"file": (f"clip-{tok}.avi", b"RIFF" + os.urandom(64), "video/x-msvideo")})
    assert r.status_code == 400 and "Unsupported extension .avi" in r.json()["detail"]
    assert _tmp_uploads(cms) == []


# ---------------------------------------------------------------------------
# S022 / S023 / S029: body shape checks
# ---------------------------------------------------------------------------

def test_upload_without_closing_boundary_is_400(admin, cms, make_media, tok):
    name = f"open-{tok}.png"
    body = _body(_part("csrf_token", csrf_token(admin)),
                 _part("file", make_media("png").read_bytes(), filename=name, ctype="image/png"), closed=False)
    r = admin.post("/library/upload", content=body, headers=MP_HEADERS, follow_redirects=False)
    assert r.status_code == 400 and "incomplete upload" in r.json()["detail"]
    assert query("SELECT id FROM media WHERE original_name = ?", (name,)) == []
    assert _tmp_uploads(cms) == []


def test_over_long_boundary_is_400_not_500(admin, cms):
    b = "b" * 300
    body = f"--{b}\r\nContent-Disposition: form-data; name=\"csrf_token\"\r\n\r\nx\r\n--{b}--\r\n".encode()
    r = admin.post("/library/upload", content=body,
                   headers={"Content-Type": f"multipart/form-data; boundary={b}", "X-CSRF-Token": csrf_token(admin)},
                   follow_redirects=False)
    assert r.status_code == 400, f"{r.status_code} {r.text[:300]}"
    assert "malformed multipart body" in r.json()["detail"]
    assert _tmp_uploads(cms) == []


def test_file_part_before_csrf_token_is_403_without_receiving_it(admin, cms, make_media, tok):
    name = f"early-{tok}.png"
    seen = {"chunks": 0}
    real_flush = cms.web_routes._UploadReceiver.flush

    def counting_flush(self):
        seen["chunks"] += len(self.pending)
        return real_flush(self)

    cms.web_routes._UploadReceiver.flush = counting_flush
    try:
        body = _body(_part("file", make_media("png").read_bytes(), filename=name, ctype="image/png"),
                     _part("csrf_token", "wrong"))
        r = admin.post("/library/upload", content=body, headers=MP_HEADERS, follow_redirects=False)
    finally:
        cms.web_routes._UploadReceiver.flush = real_flush
    assert r.status_code == 403 and r.json()["detail"] == "CSRF token missing or invalid"
    assert seen["chunks"] == 0, "file bytes were written before the token was validated"
    assert query("SELECT id FROM media WHERE original_name = ?", (name,)) == []
    assert _tmp_uploads(cms) == []


# ---------------------------------------------------------------------------
# S028: /api/screenshots streams through the same receiver (no UploadFile spool)
# ---------------------------------------------------------------------------

def test_screenshot_over_limit_is_413_and_leaves_nothing(admin, client, cms, tok):
    dev = create_device(admin, f"shot413-{tok}")
    big = b"\xff\xd8\xff" + b"\0" * (cms.config.MAX_SCREENSHOT_BYTES + 1)
    body = _body(_part("file", big, filename="s.jpg", ctype="image/jpeg"))
    r = client.post(f"/api/screenshots/{dev['device_id']}", content=body,
                    headers=dict(MP_HEADERS, **bearer(dev["token"])))
    assert r.status_code == 413, f"{r.status_code} {r.text[:300]}"
    assert _shot_tmp(cms) == []
    assert not (cms.config.SCREENSHOT_DIR / f"{dev['device_id']}.jpg").exists()
    assert one("SELECT last_screenshot_at FROM devices WHERE id = ?", (dev["id"],))["last_screenshot_at"] is None


def test_screenshot_needs_no_csrf_but_needs_closing_boundary(admin, client, cms, tok):
    dev = create_device(admin, f"shotok-{tok}")
    jpg = make_jpeg_bytes(seed=tok)
    body = _body(_part("file", jpg, filename="s.jpg", ctype="image/jpeg"), closed=False)
    r = client.post(f"/api/screenshots/{dev['device_id']}", content=body,
                    headers=dict(MP_HEADERS, **bearer(dev["token"])))
    assert r.status_code == 400 and "incomplete upload" in r.json()["detail"]
    r = client.post(f"/api/screenshots/{dev['device_id']}", content=_body(_part("file", jpg, filename="s.jpg", ctype="image/jpeg")),
                    headers=dict(MP_HEADERS, **bearer(dev["token"])))
    assert r.status_code == 200 and r.json() == {"ok": True, "size_bytes": len(jpg)}
    assert (cms.config.SCREENSHOT_DIR / f"{dev['device_id']}.jpg").read_bytes() == jpg
    assert _shot_tmp(cms) == []


def test_screenshot_route_no_longer_uses_uploadfile(cms):
    import inspect

    src = inspect.getsource(cms.api_routes)
    assert "UploadFile" not in src


# ---------------------------------------------------------------------------
# S030: login rotates the session (CSRF token from the anonymous page dies with it)
# ---------------------------------------------------------------------------

def test_login_rotates_the_csrf_token(client):
    anon = csrf_token(client, "/login")
    r = client.post("/login", data={"username": ADMIN_USERNAME, "password": ADMIN_PASSWORD, "csrf_token": anon},
                    follow_redirects=False)
    assert r.status_code == 303
    after = find_csrf(client.get("/dashboard").text)
    assert after and after != anon
    r = client.post("/logout", data={"csrf_token": anon}, follow_redirects=False)
    assert r.status_code == 403, "pre-login token must not authorise post-login POSTs"


# ---------------------------------------------------------------------------
# X002: expired / missing session on a form POST -> login redirect, not JSON 403
# ---------------------------------------------------------------------------

def test_form_post_without_session_redirects_to_login(client):
    r = client.post("/devices/1/command", data={"command": "force-sync", "csrf_token": "stale"}, follow_redirects=False)
    assert r.status_code == 303 and r.headers["location"] == "/login?expired=1"
    r = client.post("/logout", follow_redirects=False)
    assert r.status_code == 303 and r.headers["location"] == "/login?expired=1"
    r = client.get("/login?expired=1")
    assert "session expired" in r.text


def test_login_post_without_any_session_gets_a_fresh_form(client):
    r = client.post("/login", data={"username": ADMIN_USERNAME, "password": ADMIN_PASSWORD, "csrf_token": "stale"},
                    follow_redirects=False)
    assert r.status_code == 303 and r.headers["location"] == "/login?expired=1"


def test_login_post_with_wrong_token_on_a_live_session_is_still_403(client):
    csrf_token(client, "/login")  # session now holds a token
    r = client.post("/login", data={"username": ADMIN_USERNAME, "password": ADMIN_PASSWORD, "csrf_token": "wrong"},
                    follow_redirects=False)
    assert r.status_code == 403 and r.json()["detail"] == "CSRF token missing or invalid"


# ---------------------------------------------------------------------------
# S010 / S038 / S024: validation gaps (contract 10)
# ---------------------------------------------------------------------------

@pytest.fixture
def sched_world(admin, make_media, tok):
    m = upload(admin, make_media("png"))
    pid = create_playlist(admin, f"sched-{tok}")
    add_item(admin, pid, m["id"])
    dev = create_device(admin, f"sched-{tok}")
    return {"dev": dev, "pid": pid}


def _sched(admin, world, **fields):
    data = {"name": "r", "playlist_id": str(world["pid"]), "start_time": "09:00", "end_time": "17:00"}
    data.update(fields)
    return post(admin, f"/devices/{world['dev']['id']}/schedule", data)


@pytest.mark.parametrize("bad", ["7", "x", "Sun", "Sat,Sun", "6,7", "1-5", "07 "])
def test_days_of_week_outside_0_6_is_400(admin, sched_world, bad):
    r = _sched(admin, sched_world, days_of_week=bad)
    assert r.status_code == 400, f"{bad!r}: {r.status_code} {r.text[:200]}"
    assert "days_of_week" in r.json()["detail"]


def test_days_of_week_digits_are_stored_sorted_and_deduped(admin, sched_world):
    r = _sched(admin, sched_world, days_of_week="5115")
    assert r.status_code == 303
    row = one("SELECT days_of_week FROM device_schedules WHERE device_id = ? ORDER BY id DESC LIMIT 1",
              (sched_world["dev"]["id"],))
    assert row["days_of_week"] == "15"
    r = _sched(admin, sched_world, days_of_week="  ")
    assert r.status_code == 303
    row = one("SELECT days_of_week FROM device_schedules WHERE device_id = ? ORDER BY id DESC LIMIT 1",
              (sched_world["dev"]["id"],))
    assert row["days_of_week"] is None


@pytest.mark.parametrize("bad", ["20260101", "2026-W37-2", "2026-W37", "2026-1-5", "2026091"])
def test_dates_must_be_exactly_yyyy_mm_dd(admin, sched_world, bad):
    r = _sched(admin, sched_world, start_date=bad)
    assert r.status_code == 400 and "YYYY-MM-DD" in r.json()["detail"], f"{bad!r}: {r.status_code}"
    r = _sched(admin, sched_world, start_date="2026-01-05", end_date="2026-01-05")
    assert r.status_code == 303


@pytest.mark.parametrize("raw", ['{"order":[Infinity]}', '{"order":[1e400]}', '{"order":[-Infinity]}',
                                 '{"order":[1.5]}', '{"order":[true]}', '{"order":["1"]}'])
def test_reorder_rejects_non_integer_ids_with_400(admin, sched_world, raw):
    r = post_json(admin, f"/playlists/{sched_world['pid']}/items/reorder", content=raw)
    assert r.status_code == 400, f"{raw}: {r.status_code} {r.text[:200]}"
    assert r.json()["detail"] == "order must be a list of integers"


# ---------------------------------------------------------------------------
# X004: a still image behind a video extension is not a video
# ---------------------------------------------------------------------------

def test_still_image_with_video_extension_is_400(admin, cms, make_media, tok):
    if not cms.web_routes.ffprobe.have_ffprobe():
        pytest.skip("ffprobe not on PATH")
    png = make_media("png").read_bytes()
    r = post_files(admin, "/library/upload", {"file": (f"fake-{tok}.mp4", png, "video/mp4")})
    assert r.status_code == 400, f"{r.status_code} {r.text[:300]}"
    assert "still image" in r.json()["detail"]
    assert query("SELECT id FROM media WHERE original_name = ?", (f"fake-{tok}.mp4",)) == []
    assert _tmp_uploads(cms) == []


def test_is_still_image_classifier(cms):
    f = cms.web_routes.ffprobe.is_still_image
    assert f({"format_name": "png_pipe"}) and f({"format_name": "image2"}) and f({"format_name": "webp_pipe"})
    assert f({"format_name": "gif", "nb_frames": 1}) and not f({"format_name": "gif", "nb_frames": 5})
    assert not f({"format_name": "mov,mp4,m4a,3gp,3g2,mj2"}) and not f({"format_name": "matroska,webm"})
    assert not f({})  # no ffprobe data -> not a reason to reject


# ---------------------------------------------------------------------------
# S017: migration closes commands the old CMS had delivered but never resolved
# ---------------------------------------------------------------------------

def test_delivery_count_migration_closes_delivered_but_unreported_commands(cms, tmp_path, monkeypatch):
    dbp = tmp_path / "old.db"
    conn = sqlite3.connect(dbp)
    conn.executescript(cms.db.SCHEMA)
    conn.execute("ALTER TABLE device_commands DROP COLUMN delivery_count")  # the pre-fix schema
    conn.execute("ALTER TABLE devices DROP COLUMN last_error")
    conn.execute("INSERT INTO devices (device_id, name, token) VALUES ('d', 'd', 't')")
    did = conn.execute("SELECT id FROM devices").fetchone()[0]
    conn.execute("INSERT INTO device_commands (device_id, command, delivered_at) VALUES (?, 'reboot', datetime('now'))", (did,))
    conn.execute("INSERT INTO device_commands (device_id, command) VALUES (?, 'force-sync')", (did,))
    conn.commit()
    conn.close()

    monkeypatch.setattr(cms.config, "DB_PATH", dbp)
    cms.db.init_schema()
    cms.db.init_schema()  # idempotent

    rows = sqlite3.connect(dbp).execute(
        "SELECT command, completed_at, result, delivery_count FROM device_commands ORDER BY id").fetchall()
    assert rows[0][0] == "reboot" and rows[0][1] and rows[0][2] == "closed at upgrade (no result)" and rows[0][3] == 0
    assert rows[1][0] == "force-sync" and rows[1][1] is None and rows[1][3] == 0  # still queued for its offline device


# ---------------------------------------------------------------------------
# S018 / S019 / S037: defaults, template hint, HEAD
# ---------------------------------------------------------------------------

def test_audit_pruning_is_opt_in(cms):
    assert cms.config.AUDIT_RETENTION_DAYS == 0
    assert cms.db.prune_audit_log(0) == 0
    assert not [r for r in cms.startup_records if "pruned" in r.getMessage()]


def test_devices_page_hint_does_not_push_public_base_url(admin, tok):
    create_device(admin, f"hint-{tok}")
    html = admin.get("/devices").text
    assert "set PIPLAYER_PUBLIC_BASE_URL" not in html
    assert "edit it if this Pi reaches the CMS another way" in html


def test_head_on_media_is_headers_only_200(admin, make_media):
    m = upload(admin, make_media("png"))
    r = admin.head(f"/api/media/{m['filename']}")
    assert r.status_code == 200, r.status_code
    assert r.content == b"" and int(r.headers["content-length"]) == m["size_bytes"]
    assert r.headers.get("x-content-type-options") == "nosniff"
    assert admin.head("/api/media/does-not-exist.png").status_code == 404
