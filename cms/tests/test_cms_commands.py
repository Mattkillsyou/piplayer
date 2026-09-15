"""Remote commands delivery cap (contract 4) and sync_error reporting (contract 5)."""
import pytest

from cms_helpers import (add_item, assign_playlist, bearer, create_device, create_playlist, one, post,
                         query, sync, upload)

UNDELIVERABLE = "undeliverable: no result after 5 deliveries"


@pytest.fixture
def dev(admin, tok):
    return create_device(admin, f"cmd-{tok}", f"Cmd Dev {tok}")


def _issue(admin, dev, command="force-sync"):
    r = post(admin, f"/devices/{dev['id']}/command", {"command": command})
    assert r.status_code == 303, r.text[:300]
    return one("SELECT id FROM device_commands WHERE device_id = ? ORDER BY id DESC LIMIT 1", (dev["id"],))["id"]


def test_schema_has_delivery_count_and_last_error_columns(cms):
    cols = {r["name"] for r in query("PRAGMA table_info(device_commands)")}
    assert "delivery_count" in cols
    cols = {r["name"] for r in query("PRAGMA table_info(devices)")}
    assert "last_error" in cols


def test_command_is_delivered_at_most_five_times(admin, client, dev):
    cmd_id = _issue(admin, dev, "reboot")
    seen = []
    for n in range(1, 6):
        r = sync(client, dev)
        assert r.status_code == 200
        ids = [c["id"] for c in r.json()["commands"]]
        seen.append(cmd_id in ids)
        row = one("SELECT delivery_count, delivered_at, completed_at FROM device_commands WHERE id = ?", (cmd_id,))
        assert row["delivery_count"] == n, f"delivery {n}: delivery_count={row['delivery_count']}"
        assert row["delivered_at"] is not None
    assert all(seen), seen
    # the 6th sync no longer delivers it and the command is closed out
    r = sync(client, dev)
    assert r.status_code == 200
    assert cmd_id not in [c["id"] for c in r.json()["commands"]]
    row = one("SELECT delivery_count, completed_at, result FROM device_commands WHERE id = ?", (cmd_id,))
    assert row["delivery_count"] == 5
    assert row["completed_at"] is not None
    assert row["result"] == UNDELIVERABLE
    # and it stays gone
    assert cmd_id not in [c["id"] for c in sync(client, dev).json()["commands"]]


def test_reported_result_stops_delivery(admin, client, dev):
    cmd_id = _issue(admin, dev)
    r = sync(client, dev)
    assert any(c["id"] == cmd_id and c["command"] == "force-sync" for c in r.json()["commands"])
    row = one("SELECT delivered_at, completed_at, delivery_count FROM device_commands WHERE id = ?", (cmd_id,))
    assert row["delivered_at"] is not None and row["completed_at"] is None and row["delivery_count"] == 1
    r = client.post(f"/api/commands/{cmd_id}/result", headers=bearer(dev["token"]), json={"result": "queued resync"})
    assert r.status_code == 200 and r.json() == {"ok": True}
    row = one("SELECT completed_at, result FROM device_commands WHERE id = ?", (cmd_id,))
    assert row["completed_at"] is not None and row["result"] == "queued resync"
    assert cmd_id not in [c["id"] for c in sync(client, dev).json()["commands"]]


def test_devices_page_shows_recent_commands_with_results(admin, client, dev):
    ids = [_issue(admin, dev, c) for c in ("force-sync", "restart-mpv", "reboot", "force-sync", "force-sync", "force-sync")]
    sync(client, dev)
    client.post(f"/api/commands/{ids[0]}/result", headers=bearer(dev["token"]), json={"result": "oldest-cmd-result-000"})
    client.post(f"/api/commands/{ids[1]}/result", headers=bearer(dev["token"]), json={"result": "executing mpv restart"})
    client.post(f"/api/commands/{ids[-1]}/result", headers=bearer(dev["token"]), json={"result": "resync-result-xyz"})
    html = admin.get("/devices").text
    assert "<details" in html
    assert "resync-result-xyz" in html, "latest command result not shown on the Devices page"
    assert "executing mpv restart" in html
    assert "restart-mpv" in html and "reboot" in html
    # only the last 5 per device: the oldest (ids[0]) is not listed
    assert "oldest-cmd-result-000" not in html
    assert html.count("resync-result-xyz") == 1


def test_sync_error_is_stored_and_shown(admin, client, dev):
    msg = "2 of 5 items missing: a.mp4, b.png"
    r = sync(client, dev, sync_error=msg, player_status="playing")
    assert r.status_code == 200
    assert one("SELECT last_error FROM devices WHERE id = ?", (dev["id"],))["last_error"] == msg
    assert msg in admin.get("/dashboard").text
    assert msg in admin.get("/devices").text
    # an empty sync_error clears it
    r = sync(client, dev, sync_error="")
    assert r.status_code == 200
    assert one("SELECT last_error FROM devices WHERE id = ?", (dev["id"],))["last_error"] in ("", None)
    assert msg not in admin.get("/devices").text
    # omitted parameter also means "last sync fully succeeded"
    sync(client, dev, sync_error="download failed: x.mp4: HTTP 404")
    sync(client, dev)
    assert one("SELECT last_error FROM devices WHERE id = ?", (dev["id"],))["last_error"] in ("", None)


def test_sync_error_is_capped_at_200_chars(admin, client, dev):
    msg = "x" * 300
    r = sync(client, dev, sync_error=msg)
    # truncate, never reject: a device with a long error string must still get its manifest
    assert r.status_code == 200, f"{r.status_code} {r.text[:300]}"
    stored = one("SELECT last_error FROM devices WHERE id = ?", (dev["id"],))["last_error"] or ""
    assert len(stored) == 200, len(stored)


def test_sync_error_is_html_escaped(admin, client, dev):
    msg = "<script>alert(1)</script>"
    sync(client, dev, sync_error=msg)
    for page in ("/dashboard", "/devices"):
        html = admin.get(page).text
        assert msg not in html
        assert "&lt;script&gt;alert(1)&lt;/script&gt;" in html


def test_sync_records_status_and_returns_manifest(admin, client, make_media, dev, tok):
    pid = create_playlist(admin, f"cmd-{tok}")
    m = upload(admin, make_media("png"))
    add_item(admin, pid, m["id"])
    assign_playlist(admin, dev["id"], pid)
    r = sync(client, dev, current_position=0, current_filename=m["filename"], player_status="playing",
             player_version="test-0.0.1")
    assert r.status_code == 200
    manifest = r.json()
    assert manifest["device"] == {"id": dev["device_id"], "name": f"Cmd Dev {tok}"}
    assert manifest["playlist"]["id"] == pid and manifest["playlist"]["source"] == "device-default"
    assert manifest["playlist"]["hash"].startswith("sha256:")
    assert manifest["screenshot_interval_seconds"] == 60
    row = one("SELECT current_position, current_filename, player_status, player_version, last_seen_at FROM devices WHERE id = ?", (dev["id"],))
    assert (row["current_position"], row["current_filename"], row["player_status"], row["player_version"]) == \
        (0, m["filename"], "playing", "test-0.0.1")
    assert row["last_seen_at"]
    html = admin.get("/dashboard").text
    assert m["filename"] in html and "playing" in html


def test_sync_token_must_match_device_id(admin, client, dev, tok):
    other = create_device(admin, f"cmd-other-{tok}")
    r = client.get(f"/api/sync/{dev['device_id']}", headers=bearer(other["token"]))
    assert r.status_code == 403
    assert client.get(f"/api/sync/{dev['device_id']}").status_code == 401


def test_device_with_nothing_assigned_gets_null_playlist(client, dev):
    r = sync(client, dev)
    assert r.status_code == 200
    assert r.json()["playlist"] is None
