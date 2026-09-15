"""Real-player e2e: the UNCHANGED Python player from player/player runs its daemon cycles
against `wrangler dev --local` (local D1 + R2) with a fake mpv, and every side effect is
checked from the outside (files on disk, D1 rows, R2 objects).

Usage: python e2e/run_player_e2e.py [--port 8788] [--persist-to DIR] [--work DIR]

What it asserts, in order:
  1. admin created through /setup, logged in with CSRF; media rows + R2 objects seeded
     through the wrangler CLI (uploads are a browser protocol, not the player's concern);
     the device is registered through POST /devices when that page exists, else seeded.
  2. cycle 1: three real ffmpeg files downloaded and sha256-verified, manifest.json saved
     with the server's hash, media_index.json written, D1 device row shows last_seen_at,
     last_ip, player_status/version, a screenshot landed in R2 + last_screenshot_at.
  3. cycle 2: the failed 4th item (row without an R2 object) round-trips as sync_error ->
     devices.last_error.
  4. cycle 3: a truncated .part resumes with Range -> 206; a force-sync command is delivered,
     executed, its result POSTed (device_commands.completed_at/result), and the
     executed-command ledger holds the id; the ghost item removed -> sync_error clears.
  5. cycle 4: full re-verify after force-sync; last_error is NULL again.
"""
import argparse
import hashlib
import json
import logging
import os
import shutil
import subprocess
import sys
import tempfile
import time

import requests

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import e2e_common as ec  # noqa: E402

REPO = os.path.dirname(ec.CLOUD)
PLAYER_ROOT = os.path.join(REPO, "player")
sys.path.insert(0, PLAYER_ROOT)          # `import player` = the real package
sys.path.insert(0, os.path.join(PLAYER_ROOT, "tests"))  # fakes.FakeMpv

DEVICE_ID = "e2e-projector"
FILES = [  # name, ffmpeg args, content type, media_type
    ("clip-a.mp4", ["-f", "lavfi", "-i", "testsrc=duration=2:size=320x240:rate=10", "-pix_fmt", "yuv420p"], "video/mp4", "video"),
    ("still-b.png", ["-f", "lavfi", "-i", "testsrc=size=64x64", "-frames:v", "1"], "image/png", "image"),
    ("clip-c.mp4", ["-f", "lavfi", "-i", "testsrc=duration=3:size=160x120:rate=10", "-pix_fmt", "yuv420p"], "video/mp4", "video"),
]
GHOST = "ghost-d.png"  # media row + playlist item, but no R2 object -> download 404


def sha256_of(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def make_media(work):
    out = {}
    for name, args, ctype, mtype in FILES:
        path = os.path.join(work, name)
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", *args, path], check=True)
        out[name] = {"path": path, "sha256": sha256_of(path), "size": os.path.getsize(path), "ctype": ctype, "mtype": mtype}
    shot = os.path.join(work, "shot.jpg")
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=64x64", "-frames:v", "1", shot], check=True)
    with open(shot, "rb") as f:
        out["_shot"] = f.read()
    assert out["_shot"][:3] == b"\xff\xd8\xff"
    return out


def seed_library(persist, media):
    """media rows + playlist with 4 items (3 real, 1 ghost) + R2 objects. Returns playlist id."""
    for name, m in media.items():
        if name.startswith("_"):
            continue
        ec.r2_put(persist, "media/" + name, m["path"], m["ctype"])
        ec.d1(persist, "INSERT INTO media (filename, original_name, media_type, size_bytes, sha256) VALUES (%s, %s, %s, %d, %s)"
              % (ec.sql_str(name), ec.sql_str(name), ec.sql_str(m["mtype"]), m["size"], ec.sql_str(m["sha256"])))
    ec.d1(persist, "INSERT INTO media (filename, original_name, media_type, size_bytes, sha256) VALUES (%s, %s, 'image', 10, %s)"
          % (ec.sql_str(GHOST), ec.sql_str(GHOST), ec.sql_str("c" * 64)))
    ec.d1(persist, "INSERT INTO playlists (name) VALUES ('e2e playlist')")
    pid = ec.d1_one(persist, "SELECT id FROM playlists WHERE name = 'e2e playlist'")["id"]
    for pos, name in enumerate([n for n, *_ in FILES] + [GHOST]):
        ec.d1(persist, "INSERT INTO playlist_items (playlist_id, media_id, position%s) SELECT %d, id, %d%s FROM media WHERE filename = %s"
              % (", duration_override_seconds" if name == "still-b.png" else "", pid, pos,
                 ", 7.5" if name == "still-b.png" else "", ec.sql_str(name)))
    return pid


def register_device(admin, persist, pid):
    """POST /devices (package P2's page) when it exists; otherwise seed the row directly.
    Either way the playlist assignment is verified in D1. Returns the devices row."""
    r = admin.post("/devices", {"device_id": DEVICE_ID, "name": "E2E Projector"})
    if r.status_code == 303:
        print("device registered through POST /devices")
    elif r.status_code == 501:
        print("POST /devices is still a stub; seeding the device row in D1")
        ec.d1(persist, "INSERT INTO devices (device_id, name, token) VALUES (%s, 'E2E Projector', 'e2e-device-token-0123456789')" % ec.sql_str(DEVICE_ID))
    else:
        raise AssertionError("POST /devices -> %d %s" % (r.status_code, r.text[:300]))
    row = ec.d1_one(persist, "SELECT * FROM devices WHERE device_id = %s" % ec.sql_str(DEVICE_ID))
    assert row and row["token"], row
    r = admin.post("/devices/%d/assign" % row["id"], {"playlist_id": str(pid)})
    if r.status_code == 501:
        ec.d1(persist, "UPDATE devices SET playlist_id = %d WHERE id = %d" % (pid, row["id"]))
    else:
        assert r.status_code == 303, (r.status_code, r.text[:300])
    row = ec.d1_one(persist, "SELECT * FROM devices WHERE device_id = %s" % ec.sql_str(DEVICE_ID))
    assert row["playlist_id"] == pid, row
    return row


def issue_command(admin, persist, dev_row, command="force-sync"):
    r = admin.post("/devices/%d/command" % dev_row["id"], {"command": command})
    if r.status_code == 501:
        ec.d1(persist, "INSERT INTO device_commands (device_id, command) VALUES (%d, %s)" % (dev_row["id"], ec.sql_str(command)))
    else:
        assert r.status_code == 303, (r.status_code, r.text[:300])
    return ec.d1_one(persist, "SELECT id FROM device_commands WHERE device_id = %d ORDER BY id DESC LIMIT 1" % dev_row["id"])["id"]


class RecordingHttp:
    """Wraps requests.get as seen by player.sync so the harness can assert on the
    Range/206 exchange without touching the player."""

    def __init__(self, real_get):
        self.real_get = real_get
        self.calls = []  # (url, request Range header or None, status)
        self.sync_bodies = []  # raw /api/sync response text, for the byte-level golden check

    def get(self, url, **kw):
        r = self.real_get(url, **kw)
        self.calls.append((url, (kw.get("headers") or {}).get("Range"), r.status_code))
        if "/api/sync/" in url:
            self.sync_bodies.append(r.text)
        return r


def parity_probes(base, token):
    """Malformed Range / int params / screenshot bodies answer with the fixed CMS's status and
    {detail} wording (main.py validation_error, web._receive_upload, Starlette FileResponse)."""
    h = {"Authorization": "Bearer " + token}
    media = base + "/api/media/clip-a.mp4"
    for rng, status, detail in [
        ("bytes=200-100", 400, "Range header: start must be less than end"),
        ("garbage", 400, "Malformed range header."),
        ("items=0-1", 400, "Only support bytes range"),
        ("bytes=-0", 416, None),
    ]:
        r = requests.get(media, headers=dict(h, Range=rng))
        assert r.status_code == status, (rng, r.status_code, r.text)
        # Starlette answers these as PlainTextResponse, not the JSON {detail} envelope
        assert r.headers["Content-Type"] == "text/plain; charset=utf-8", (rng, r.headers)
        assert r.text == (detail or ""), (rng, r.text)
    # a disjoint multi-range is multipart/byteranges laid out like FileResponse.generate_multipart
    full = requests.get(media, headers=h).content
    r = requests.get(media, headers=dict(h, Range="bytes=0-99,200-299"))
    assert r.status_code == 206, (r.status_code, r.text[:200])
    boundary = r.headers["Content-Type"].split("boundary=")[1]
    part = lambda a, b: ("--%s\r\nContent-Type: video/mp4\r\nContent-Range: bytes %d-%d/%d\r\n\r\n" % (boundary, a, b, len(full))).encode() + full[a:b + 1] + b"\r\n"
    assert r.content == part(0, 99) + part(200, 299) + ("--%s--" % boundary).encode(), r.content[:200]
    assert int(r.headers["Content-Length"]) == len(r.content)
    int_msg = "Input should be a valid integer, unable to parse string as an integer"
    for pos in ("abc", "", "1.5"):
        r = requests.get(base + "/api/sync/" + DEVICE_ID, params={"current_position": pos}, headers=h)
        assert r.status_code == 400 and r.json() == {"detail": "query.current_position: " + int_msg}, (pos, r.text)
    assert requests.get(base + "/api/sync/" + DEVICE_ID, params={"current_position": "1.0"}, headers=h).status_code == 200
    for cid in ("abc", "1.5"):
        r = requests.post(base + "/api/commands/%s/result" % cid, json={}, headers=h)
        assert r.status_code == 400 and r.json() == {"detail": "path.command_id: " + int_msg}, (cid, r.text)
    shots = base + "/api/screenshots/" + DEVICE_ID
    jpeg = b"\xff\xd8\xff\xe0" + b"\0" * 9
    r = requests.post(shots, data=jpeg, headers=dict(h, **{"Content-Type": "image/jpeg"}))
    assert r.status_code == 400 and r.json() == {"detail": "expected a multipart/form-data upload"}, r.text
    r = requests.post(shots, files={"other": ("x.jpg", jpeg, "image/jpeg")}, headers=h)
    assert r.status_code == 200 and r.json() == {"ok": True, "size_bytes": len(jpeg)}, r.text
    r = requests.post(shots, files={"file": ("x.jpg", b"\xff\xd8\xff" + b"\0" * (6 * 1024 * 1024), "image/jpeg")}, headers=h)
    assert r.status_code == 413 and r.json() == {"detail": "File exceeds 5242880 bytes"}, r.text
    print("parity probes: Range 400/416 text/plain, multipart/byteranges, int params 400, screenshot wording ok")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8788)
    ap.add_argument("--persist-to", default=None)
    ap.add_argument("--work", default=None, help="scratch dir for media/player state (fresh temp dir by default)")
    args = ap.parse_args()
    work = args.work or tempfile.mkdtemp(prefix="piplayer-player-e2e-")
    persist = args.persist_to or os.path.join(work, "state")
    for d in (persist, work):
        os.makedirs(d, exist_ok=True)
    # a fresh local D1/R2 every run: the assertions count rows
    shutil.rmtree(os.path.join(persist, "v3"), ignore_errors=True)
    for sub in ("player-media", "player-state"):
        shutil.rmtree(os.path.join(work, sub), ignore_errors=True)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s", stream=sys.stdout)

    media = make_media(work)
    ec.migrate(persist)
    pid = seed_library(persist, media)

    proc, base, log = ec.start_dev(args.port, persist)
    try:
        run(base, persist, work, media, pid)
    finally:
        ec.stop(proc)
        log.close()
    print("player e2e OK")


def run(base, persist, work, media, pid):
    admin = ec.Admin(base)
    admin.setup_admin()
    admin.s.post(base + "/logout", data={"csrf_token": admin.csrf()}, allow_redirects=False)
    admin.login()
    dev_row = register_device(admin, persist, pid)

    # --- the real player, configured through the environment (no config file) ---------
    media_dir = os.path.join(work, "player-media")
    state_dir = os.path.join(work, "player-state")
    os.makedirs(state_dir, exist_ok=True)
    os.environ.update({
        "DEVICE_ID": DEVICE_ID, "DEVICE_TOKEN": dev_row["token"], "CMS_URL": base,
        "PIPLAYER_MEDIA_DIR": media_dir,
        "PIPLAYER_MANIFEST_PATH": os.path.join(state_dir, "manifest.json"),
        "PIPLAYER_MPV_SOCKET": os.path.join(state_dir, "mpv.sock"),
        "PIPLAYER_CONFIG": os.path.join(work, "does-not-exist.toml"),
        "PIPLAYER_POLL": "5",
    })
    import player.config as pconfig
    import player.daemon as daemon
    import player.sync as psync
    import player.commands as pcommands
    from player.mpv_client import MpvClient
    from player.screenshots import ScreenshotScheduler
    from fakes import FakeMpv

    pconfig.CONFIG_ERROR_WAIT_SECONDS = 0
    cfg = pconfig.load()
    assert cfg.device_id == DEVICE_ID and cfg.cms_url == base

    shot_bytes = media["_shot"]

    class ScreenshotMpv(FakeMpv):
        """FakeMpv whose screenshot-to-file really writes a JPEG (the daemon uploads that file)."""

        def _exec(self, cmd):
            name = cmd["name"] if isinstance(cmd, dict) else cmd[0]
            if name == "screenshot-to-file":
                with open(cmd[1], "wb") as f:
                    f.write(shot_bytes)
            return super()._exec(cmd)

    fake = ScreenshotMpv()
    MpvClient._connect = lambda self, timeout=2.0: fake.connect(timeout)
    http = RecordingHttp(requests.get)
    psync.requests.get = http.get  # player.sync's `requests` is the shared module; wrap, don't recurse

    mpv = MpvClient(cfg.mpv_socket)
    assert mpv.is_alive()
    scheduler = ScreenshotScheduler(interval_seconds=60)
    state = daemon.PlayerState(last_manifest=psync.load_local_manifest(cfg), backoff=cfg.poll_interval_seconds)
    assert state.last_manifest is None

    def device():
        return ec.d1_one(persist, "SELECT * FROM devices WHERE device_id = %s" % ec.sql_str(DEVICE_ID))

    # --- cycle 1: full download + status + screenshot -----------------------------------
    t0 = time.time()
    manifest = daemon.run_cycle(cfg, mpv, state, scheduler)
    assert manifest is not None, "cycle 1 sync failed"
    print("cycle 1: %.1fs, hash=%s" % (time.time() - t0, manifest["playlist"]["hash"]))
    assert manifest["device"] == {"id": DEVICE_ID, "name": "E2E Projector"}, manifest["device"]
    assert manifest["playlist"]["source"] == "device-default"
    assert [i["filename"] for i in manifest["playlist"]["items"]] == [n for n, *_ in FILES] + [GHOST]
    assert manifest["playlist"]["items"][1]["effective_duration_seconds"] == 7.5
    assert manifest["playlist"]["items"][0]["url"] == "%s/api/media/clip-a.mp4" % base
    assert manifest["server_time"][-6] in "+-", manifest["server_time"]
    # byte-identical to the Python CMS: compact separators and floats printed the way
    # json.dumps prints them (the ghost image gets the 10.0 default, the still 7.5)
    raw = http.sync_bodies[-1]
    assert '"effective_duration_seconds":10.0,' in raw and '"effective_duration_seconds":7.5,' in raw, raw[:400]
    assert raw == json.dumps(json.loads(raw), separators=(",", ":"), ensure_ascii=False), raw[:400]

    for name, m in media.items():
        if name.startswith("_"):
            continue
        p = os.path.join(media_dir, name)
        assert os.path.isfile(p), "not downloaded: " + name
        assert sha256_of(p) == m["sha256"], "sha256 mismatch after download: " + name
        assert os.path.getsize(p) == m["size"]
    assert not os.path.exists(os.path.join(media_dir, GHOST))
    downloads = [c for c in http.calls if "/api/media/" in c[0]]
    assert [c[2] for c in downloads] == [200, 200, 200, 404], downloads
    print("downloaded + verified: %s" % ", ".join(n for n, *_ in FILES))

    saved = json.load(open(cfg.manifest_path))
    assert saved["playlist"]["hash"] == manifest["playlist"]["hash"]
    index = json.load(open(psync.media_index_path(cfg)))
    assert set(index) == {n for n, *_ in FILES}, index
    assert state.last_sync_error == "download failed: %s: HTTP 404" % GHOST, state.last_sync_error

    row = device()
    assert row["last_seen_at"], row
    # last_ip comes from CF-Connecting-IP, which Cloudflare sets in production; wrangler dev
    # does not inject it, so locally the column stays NULL (the unit tests cover the header).
    assert row["last_ip"] in (None, "127.0.0.1"), row["last_ip"]
    assert row["player_version"] == __import__("player").__version__, row["player_version"]
    assert row["player_status"] == "idle", row["player_status"]  # status is gathered before the first push
    assert row["last_error"] is None, row["last_error"]  # cycle 1 reported sync_error=""
    assert row["last_screenshot_at"], "screenshot not recorded"
    got = os.path.join(work, "shot-from-r2.jpg")
    assert ec.r2_get(persist, "screenshots/%s.jpg" % DEVICE_ID, got), "screenshot missing in R2"
    assert open(got, "rb").read() == shot_bytes, "screenshot bytes differ"
    print("D1 row: last_seen_at=%s last_ip=%s status=%s version=%s screenshot_at=%s" % (
        row["last_seen_at"], row["last_ip"], row["player_status"], row["player_version"], row["last_screenshot_at"]))
    assert [os.path.basename(p) for p in fake.paths()] == [n for n, *_ in FILES], fake.paths()
    assert fake.playlist[1]["opts"] == {"image-display-duration": "7.5"}, fake.playlist[1]

    # --- cycle 2: sync_error round-trips into devices.last_error --------------------------
    manifest = daemon.run_cycle(cfg, mpv, state, scheduler)
    assert manifest is not None
    row = device()
    assert row["last_error"] == "download failed: %s: HTTP 404" % GHOST, row["last_error"]
    assert row["player_status"] == "playing", row["player_status"]
    assert row["current_filename"] == "clip-a.mp4", row["current_filename"]
    assert row["current_position"] == 0, row["current_position"]
    print("cycle 2: last_error=%r status=%s current=%s" % (row["last_error"], row["player_status"], row["current_filename"]))

    # --- cycle 3: Range resume + force-sync command + ghost removed -----------------------
    ec.d1(persist, "DELETE FROM playlist_items WHERE media_id = (SELECT id FROM media WHERE filename = %s)" % ec.sql_str(GHOST))
    target = os.path.join(media_dir, "clip-a.mp4")
    data = open(target, "rb").read()
    cut = len(data) // 2
    os.remove(target)
    with open(target + ".part", "wb") as f:
        f.write(data[:cut])
    cmd_id = issue_command(admin, persist, dev_row, "force-sync")
    http.calls.clear()
    manifest = daemon.run_cycle(cfg, mpv, state, scheduler)
    assert manifest is not None
    assert [i["filename"] for i in manifest["playlist"]["items"]] == [n for n, *_ in FILES]
    resumed = [c for c in http.calls if c[0].endswith("/api/media/clip-a.mp4")]
    assert resumed == [("%s/api/media/clip-a.mp4" % base, "bytes=%d-" % cut, 206)], resumed
    assert sha256_of(target) == media["clip-a.mp4"]["sha256"]
    assert not os.path.exists(target + ".part")
    print("cycle 3: resumed clip-a.mp4 from byte %d -> 206, sha256 ok" % cut)
    assert [(c["id"], c["command"]) for c in manifest["commands"]] == [(cmd_id, "force-sync")], manifest["commands"]
    assert daemon._force_sync_now is True, "force-sync did not reach the daemon"
    crow = ec.d1_one(persist, "SELECT * FROM device_commands WHERE id = %d" % cmd_id)
    assert crow["delivery_count"] == 1 and crow["delivered_at"], crow
    assert crow["completed_at"] and crow["result"] == "queued resync", crow
    ledger = pcommands.load_executed_ids(cfg)
    assert any(e["id"] == cmd_id for e in ledger), ledger
    assert state.last_sync_error == "", state.last_sync_error
    print("cycle 3: command %d delivered once, result=%r, ledger ok" % (cmd_id, crow["result"]))
    # the daemon's main loop turns the command's force_resync() into a full verify next cycle
    state.force_verify = True

    # --- cycle 4: full re-verify, last_error cleared, nothing re-downloaded ---------------
    http.calls.clear()
    manifest = daemon.run_cycle(cfg, mpv, state, scheduler)
    assert manifest is not None
    assert [c[2] for c in http.calls] == [200], http.calls  # only the sync call
    assert state.force_verify is False
    row = device()
    assert row["last_error"] is None, row["last_error"]
    assert manifest["commands"] == []
    print("cycle 4: full verify without re-download, last_error cleared")

    # --- edge cases the golden verifier probes (the player never sends these) ------------
    parity_probes(base, dev_row["token"])

    # every status the player sends is visible to the browser too (page owned by P2; skip a stub)
    r = admin.get("/devices")
    if r.status_code == 200:
        assert DEVICE_ID in r.text and "queued resync" in r.text, "devices page does not show the device/command"
        print("devices page shows the device and the command result")
    else:
        print("devices page is a stub (%d); skipped the UI check" % r.status_code)


if __name__ == "__main__":
    main()
