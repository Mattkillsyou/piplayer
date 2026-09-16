"""Feature C, remote updates: update-* commands, the manifest `update` key, the
sync `update_status` report and the Devices page status/buttons."""
import json

from cms_helpers import assert_json_detail, create_device, create_user, login, one, post, query, sync

UPDATE_COMMANDS = ("update-player", "update-os", "update-all")


def _pending(device_row_id):
    return [c["command"] for c in query(
        "SELECT command FROM device_commands WHERE device_id = ? AND completed_at IS NULL ORDER BY id",
        (device_row_id,))]


def test_schema_accepts_update_commands_and_has_last_update_columns(cms):
    sql = one("SELECT sql FROM sqlite_master WHERE name = 'device_commands'")["sql"]
    for c in UPDATE_COMMANDS:
        assert f"'{c}'" in sql, c
    cols = {r["name"] for r in query("PRAGMA table_info(devices)")}
    assert {"last_update_at", "last_update_ok", "last_update_message", "last_update_ref"} <= cols


def test_update_commands_are_queued_and_delivered(admin, client, tok):
    dev = create_device(admin, f"upd-{tok}", f"Upd Dev {tok}")
    for c in UPDATE_COMMANDS:
        r = post(admin, f"/devices/{dev['id']}/command", {"command": c})
        assert r.status_code == 303, f"{c}: {r.status_code} {r.text[:300]}"
    assert_json_detail(post(admin, f"/devices/{dev['id']}/command", {"command": "update-firmware"}), 400)
    assert _pending(dev["id"]) == list(UPDATE_COMMANDS)
    r = sync(client, dev)
    assert r.status_code == 200
    assert [c["command"] for c in r.json()["commands"]] == list(UPDATE_COMMANDS)
    rows = query("SELECT details FROM audit_log WHERE action = 'device_send_command' AND target_id = ? ORDER BY id",
                 (str(dev["id"]),))
    assert [json.loads(r["details"])["command"] for r in rows] == list(UPDATE_COMMANDS)


def test_manifest_carries_update_settings(cms, admin, client, tok):
    dev = create_device(admin, f"upd-man-{tok}")
    r = sync(client, dev)
    assert r.status_code == 200
    # env-driven defaults (conftest sets none of the PIPLAYER_*UPDATE* variables)
    assert r.json()["update"] == {"release": "main", "auto": "off", "window": "03:00-05:00"}
    assert cms.config.AUTO_UPDATE_WINDOW_RE.match("23:30-01:15")
    for bad in ("3:00-5:00", "03:00", "24:00-05:00", "03:00-05:60", "03:00 - 05:00"):
        assert not cms.config.AUTO_UPDATE_WINDOW_RE.match(bad), bad


def test_sync_update_status_is_stored_and_shown(admin, client, tok):
    dev = create_device(admin, f"upd-st-{tok}", f"Upd St {tok}")
    cols = "SELECT last_update_at, last_update_ok, last_update_message, last_update_ref FROM devices WHERE id = ?"
    assert one(cols, (dev["id"],)) == {"last_update_at": None, "last_update_ok": None,
                                       "last_update_message": None, "last_update_ref": None}
    # update-player.sh writes UTC "...Z" timestamps
    status = {"ref": "v1.4.0", "started": "2026-09-15T03:00:01Z", "finished": "2026-09-15T03:02:40Z",
              "ok": False, "message": f"install-player.sh exited 1 (upd-{tok})", "previous_version": "1.3.9+abc1234"}
    r = sync(client, dev, update_status=json.dumps(status))
    assert r.status_code == 200
    row = one(cols, (dev["id"],))
    # `finished` lands in DB form (UTC, no zone suffix)
    assert row["last_update_at"] == "2026-09-15 03:02:40"
    assert (row["last_update_ok"], row["last_update_message"], row["last_update_ref"]) == (0, status["message"], "v1.4.0")
    a = one("SELECT details FROM audit_log WHERE action = 'device_update_reported' AND target_id = ?", (str(dev["id"]),))
    assert json.loads(a["details"]) == {"device_id": dev["device_id"], "ref": "v1.4.0", "ok": False,
                                        "message": status["message"]}
    html = admin.get("/devices").text
    assert "Update failed (v1.4.0)" in html and status["message"] in html
    assert "update-status" in html and 'class="alert error small update-status"' in html

    # a plain sync (no update_status) leaves the last report alone
    sync(client, dev, player_status="playing")
    assert one(cols, (dev["id"],))["last_update_message"] == status["message"]

    # the next successful run replaces it and the page stops highlighting
    r = sync(client, dev, update_status=json.dumps({"ref": "main", "ok": True, "message": "already at abc1234",
                                                    "finished": "2026-09-16T03:01:00+02:00"}))
    assert r.status_code == 200
    row = one(cols, (dev["id"],))
    assert (row["last_update_ok"], row["last_update_message"], row["last_update_ref"]) == (1, "already at abc1234", "main")
    assert row["last_update_at"] == "2026-09-16 01:01:00"   # zone-aware finished is normalised to UTC
    html = admin.get("/devices").text
    assert "Update ok (main)" in html and 'class="alert ok small update-status"' in html
    assert status["message"] not in html


def test_sync_update_status_malformed_is_ignored_and_long_values_capped(client, admin, tok):
    dev = create_device(admin, f"upd-bad-{tok}")
    for raw in ("not json", "[1, 2]", "42", ""):
        r = sync(client, dev, update_status=raw)
        assert r.status_code == 200, raw
        assert one("SELECT last_update_at FROM devices WHERE id = ?", (dev["id"],))["last_update_at"] is None
    r = sync(client, dev, update_status=json.dumps({"ok": 1, "message": "m" * 500, "ref": "r" * 500, "finished": "soon"}))
    assert r.status_code == 200
    row = one("SELECT last_update_at, last_update_ok, last_update_message, last_update_ref FROM devices WHERE id = ?",
              (dev["id"],))
    assert row["last_update_ok"] == 1 and len(row["last_update_message"]) == 200 and len(row["last_update_ref"]) == 100
    assert row["last_update_at"]   # unparsable finished -> report time
    sync(client, dev, update_status=json.dumps({"ok": "yes"}))   # only true/1 count as ok
    assert one("SELECT last_update_ok FROM devices WHERE id = ?", (dev["id"],))["last_update_ok"] == 0


def test_update_message_is_html_escaped(admin, client, tok):
    dev = create_device(admin, f"upd-xss-{tok}")
    sync(client, dev, update_status=json.dumps({"ok": False, "message": "<img src=x onerror=alert(1)>"}))
    html = admin.get("/devices").text
    assert "<img src=x" not in html and "&lt;img src=x" in html


def test_update_all_players_queues_one_command_per_device(admin, make_client, tok):
    devs = [create_device(admin, f"fleet-{tok}-{i}") for i in range(3)]
    before = {d["id"]: _pending(d["id"]) for d in devs}
    html = admin.get("/devices").text
    assert 'action="/devices/update-all"' in html and "Update all players" in html
    for c in UPDATE_COMMANDS:
        assert f'value="{c}"' in html, c

    r = post(admin, "/devices/update-all", {})
    assert r.status_code == 303 and r.headers["location"] == "/devices"
    for d in devs:
        assert _pending(d["id"]) == before[d["id"]] + ["update-player"]
    # every device row got exactly one (other tests' devices included)
    total = one("SELECT COUNT(*) AS n FROM devices")["n"]
    row = one("SELECT details FROM audit_log WHERE action = 'device_update_all' ORDER BY id DESC LIMIT 1")
    assert json.loads(row["details"]) == {"command": "update-player", "devices": total}

    r = post(admin, "/devices/update-all", {"command": "update-os"})
    assert r.status_code == 303
    assert _pending(devs[0]["id"])[-1] == "update-os"
    assert_json_detail(post(admin, "/devices/update-all", {"command": "reboot"}), 400)

    # viewers cannot, and do not see the buttons
    create_user(admin, f"fleet-viewer-{tok}", "viewer-pass", "viewer")
    viewer = make_client()
    assert login(viewer, f"fleet-viewer-{tok}", "viewer-pass").status_code == 303
    assert post(viewer, "/devices/update-all", {}).status_code == 403
    html = viewer.get("/devices").text
    assert "Update all players" not in html and 'value="update-player"' not in html


def test_settings_page_shows_env_driven_update_settings(admin):
    html = admin.get("/settings").text
    assert "Remote updates" in html and "PIPLAYER_PLAYER_RELEASE" in html
    assert "<code>main</code>" in html and "03:00-05:00" in html
