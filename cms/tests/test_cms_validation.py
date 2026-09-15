"""Contract 10: every form/JSON input is validated; 400 / 404 / 409, never 500.
Also contract 16 (schedule start == end rejected) and C002 ('inf' duration)."""
import datetime as dt

import pytest

from cms_helpers import (add_item, assert_json_detail, assign_playlist, bearer, create_device,
                         create_group, create_playlist, create_user, execute, one, post, post_json,
                         query, sync, upload)

SQLITE_WORDS = ("UNIQUE", "sqlite", "constraint", "IntegrityError")
NOPE = 999999


@pytest.fixture
def world(admin, make_media, tok):
    """A playlist with two items, a device (default playlist assigned) and a group."""
    pid = create_playlist(admin, f"val-{tok}")
    m1 = upload(admin, make_media("png"))
    m2 = upload(admin, make_media("png"))
    i1 = add_item(admin, pid, m1["id"])
    i2 = add_item(admin, pid, m2["id"])
    dev = create_device(admin, f"val-{tok}")
    assign_playlist(admin, dev["id"], pid)
    gid = create_group(admin, f"val-{tok}")
    return {"pid": pid, "m1": m1, "m2": m2, "i1": i1, "i2": i2, "dev": dev, "gid": gid, "tok": tok}


def _sched(admin, dev_id, **over):
    data = {"name": "Rule", "playlist_id": over.pop("playlist_id"), "priority": "10"}
    data.update({k: v for k, v in over.items()})
    return post(admin, f"/devices/{dev_id}/schedule", data)


# ---------------------------------------------------------------------------
# Schedule rule validation (F009 / F059 / F040)
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("value", ["25:99", "24:00", "12:60", "7", "0800", "8am", "07:00:00", "junk", "1:5"])
def test_malformed_schedule_times_are_400(admin, world, value):
    for field in ("start_time", "end_time"):
        r = _sched(admin, world["dev"]["id"], playlist_id=str(world["pid"]), **{field: value})
        detail = assert_json_detail(r, 400)
        assert detail
    assert query("SELECT id FROM device_schedules WHERE device_id = ?", (world["dev"]["id"],)) == []


def test_valid_schedule_times_are_stored_normalised(admin, world):
    r = _sched(admin, world["dev"]["id"], playlist_id=str(world["pid"]), start_time="07:05", end_time="18:30",
               days_of_week="135", start_date="2026-01-01", end_date="2026-12-31")
    assert r.status_code == 303, r.text[:300]
    row = one("SELECT * FROM device_schedules WHERE device_id = ?", (world["dev"]["id"],))
    assert row["start_time"] == "07:05" and row["end_time"] == "18:30"
    assert row["days_of_week"] == "135"
    assert row["start_date"] == "2026-01-01" and row["end_date"] == "2026-12-31"
    assert row["priority"] == 10


def test_schedule_start_equals_end_is_rejected(admin, world):
    r = _sched(admin, world["dev"]["id"], playlist_id=str(world["pid"]), start_time="09:00", end_time="09:00")
    detail = assert_json_detail(r, 400)
    assert "start and end must differ" in detail
    assert query("SELECT id FROM device_schedules WHERE device_id = ?", (world["dev"]["id"],)) == []


def test_schedule_wrap_midnight_is_accepted(admin, world):
    r = _sched(admin, world["dev"]["id"], playlist_id=str(world["pid"]), start_time="22:00", end_time="02:00")
    assert r.status_code == 303, r.text[:300]


@pytest.mark.parametrize("field,value", [
    ("start_date", "2026-13-01"), ("start_date", "01/02/2026"), ("start_date", "2026-1-5"),
    ("end_date", "junk"), ("end_date", "2026-02-30"),
])
def test_malformed_schedule_dates_are_400(admin, world, field, value):
    r = _sched(admin, world["dev"]["id"], playlist_id=str(world["pid"]), **{field: value})
    assert_json_detail(r, 400)


def test_schedule_end_date_before_start_date_is_400(admin, world):
    r = _sched(admin, world["dev"]["id"], playlist_id=str(world["pid"]),
               start_date="2026-03-02", end_date="2026-03-01")
    assert_json_detail(r, 400)


@pytest.mark.parametrize("value", ["-1", "1001", "99999"])
def test_schedule_priority_out_of_range_is_400(admin, world, value):
    r = _sched(admin, world["dev"]["id"], playlist_id=str(world["pid"]), priority=value)
    assert_json_detail(r, 400)


def test_schedule_priority_non_numeric_is_client_error(admin, world):
    r = _sched(admin, world["dev"]["id"], playlist_id=str(world["pid"]), priority="abc")
    assert r.status_code in (400, 422), r.text[:300]


def test_schedule_priority_bounds_accepted(admin, world):
    for p in ("0", "1000"):
        r = _sched(admin, world["dev"]["id"], playlist_id=str(world["pid"]), priority=p)
        assert r.status_code == 303, r.text[:300]


def test_schedule_playlist_id_non_integer_is_400(admin, world):
    for bad in ("abc", "1.0", "1e3"):
        r = _sched(admin, world["dev"]["id"], playlist_id=bad)
        assert_json_detail(r, 400)
    # an empty required field may be rejected by the framework (422) or the route (400)
    r = _sched(admin, world["dev"]["id"], playlist_id="")
    assert r.status_code in (400, 422), r.text[:300]


def test_schedule_references_to_missing_rows_are_404(admin, world):
    r = _sched(admin, world["dev"]["id"], playlist_id=str(NOPE))
    assert_json_detail(r, 404)
    r = _sched(admin, NOPE, playlist_id=str(world["pid"]))
    assert_json_detail(r, 404)
    assert admin.get(f"/devices/{NOPE}/schedule").status_code == 404


def test_malformed_stored_schedule_row_never_500s(admin, world):
    """A bad row that slipped into the DB (old data) is ignored, not fatal."""
    dev = world["dev"]
    execute(
        "INSERT INTO device_schedules (device_id, playlist_id, name, priority, start_time, end_time) "
        "VALUES (?, ?, 'bad', 50, 'junk', '25:99')",
        (dev["id"], world["pid"]),
    )
    execute(
        "INSERT INTO device_schedules (device_id, playlist_id, name, priority, start_time, end_time, start_date) "
        "VALUES (?, ?, 'bad2', 50, '7', NULL, 'notadate')",
        (dev["id"], world["pid"]),
    )
    assert admin.get("/devices").status_code == 200
    assert admin.get(f"/devices/{dev['id']}/schedule").status_code == 200
    r = sync(admin, dev)
    assert r.status_code == 200, r.text[:300]
    # the malformed rules never match: the device default wins
    assert r.json()["playlist"]["id"] == world["pid"]
    assert r.json()["playlist"]["source"] == "device-default"


# ---------------------------------------------------------------------------
# Assign / group / command / items (F025)
# ---------------------------------------------------------------------------

def test_assign_playlist_validation(admin, world):
    dev = world["dev"]
    for bad in ("abc", "1.5", "1e3"):
        assert_json_detail(post(admin, f"/devices/{dev['id']}/assign", {"playlist_id": bad}), 400)
    assert_json_detail(post(admin, f"/devices/{dev['id']}/assign", {"playlist_id": str(NOPE)}), 404)
    assert_json_detail(post(admin, f"/devices/{NOPE}/assign", {"playlist_id": str(world["pid"])}), 404)
    # unchanged
    assert one("SELECT playlist_id FROM devices WHERE id = ?", (dev["id"],))["playlist_id"] == world["pid"]
    # clearing is allowed
    r = post(admin, f"/devices/{dev['id']}/assign", {"playlist_id": ""})
    assert r.status_code == 303
    assert one("SELECT playlist_id FROM devices WHERE id = ?", (dev["id"],))["playlist_id"] is None


def test_set_group_validation(admin, world):
    dev = world["dev"]
    assert_json_detail(post(admin, f"/devices/{dev['id']}/group", {"group_id": "abc"}), 400)
    assert_json_detail(post(admin, f"/devices/{dev['id']}/group", {"group_id": str(NOPE)}), 404)
    assert_json_detail(post(admin, f"/devices/{NOPE}/group", {"group_id": str(world["gid"])}), 404)
    r = post(admin, f"/devices/{dev['id']}/group", {"group_id": str(world["gid"])})
    assert r.status_code == 303
    assert one("SELECT group_id FROM devices WHERE id = ?", (dev["id"],))["group_id"] == world["gid"]


def test_group_assign_validation(admin, world):
    gid = world["gid"]
    assert_json_detail(post(admin, f"/groups/{gid}/assign", {"playlist_id": "abc"}), 400)
    assert_json_detail(post(admin, f"/groups/{gid}/assign", {"playlist_id": str(NOPE)}), 404)
    assert_json_detail(post(admin, f"/groups/{NOPE}/assign", {"playlist_id": str(world["pid"])}), 404)
    r = post(admin, f"/groups/{gid}/assign", {"playlist_id": str(world["pid"])})
    assert r.status_code == 303


def test_command_validation(admin, world):
    dev = world["dev"]
    assert_json_detail(post(admin, f"/devices/{NOPE}/command", {"command": "reboot"}), 404)
    assert_json_detail(post(admin, f"/devices/{dev['id']}/command", {"command": "rm-rf"}), 400)
    assert query("SELECT id FROM device_commands WHERE device_id = ?", (dev["id"],)) == []


def test_playlist_item_validation(admin, world):
    pid = world["pid"]
    r = post(admin, f"/playlists/{pid}/items", {"media_id": "abc"})
    assert r.status_code in (400, 422), r.text[:300]
    assert_json_detail(post(admin, f"/playlists/{pid}/items", {"media_id": str(NOPE)}), 404)
    assert_json_detail(post(admin, f"/playlists/{NOPE}/items", {"media_id": str(world["m1"]["id"])}), 404)
    assert_json_detail(post(admin, f"/playlists/{pid}/items", {"media_id": str(world["m1"]["id"])}), 409)


def test_rename_missing_playlist_is_404_and_duration_on_missing_item_is_404(admin, world):
    assert_json_detail(post(admin, f"/playlists/{NOPE}/rename", {"name": "whatever"}), 404)
    assert_json_detail(post(admin, f"/playlists/{world['pid']}/items/{NOPE}/duration", {"duration": "5"}), 404)


# ---------------------------------------------------------------------------
# Duration override (C002)
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("value", ["inf", "infinity", "+inf", "Infinity", "1e999", "nan", "-1", "0", "abc", "86401", "1e400"])
def test_bad_duration_override_is_400(admin, world, value):
    r = post(admin, f"/playlists/{world['pid']}/items/{world['i1']}/duration", {"duration": value})
    assert_json_detail(r, 400)
    row = one("SELECT duration_override_seconds FROM playlist_items WHERE id = ?", (world["i1"],))
    assert row["duration_override_seconds"] is None
    # and the device can still sync
    assert sync(admin, world["dev"]).status_code == 200


@pytest.mark.parametrize("value,expected", [("7.5", 7.5), ("86400", 86400.0), ("0.5", 0.5), ("", None)])
def test_good_duration_override_is_stored(admin, world, value, expected):
    r = post(admin, f"/playlists/{world['pid']}/items/{world['i1']}/duration", {"duration": value})
    assert r.status_code == 303, r.text[:300]
    row = one("SELECT duration_override_seconds FROM playlist_items WHERE id = ?", (world["i1"],))
    assert row["duration_override_seconds"] == expected
    r = sync(admin, world["dev"])
    assert r.status_code == 200
    items = {it["filename"]: it for it in r.json()["playlist"]["items"]}
    eff = items[world["m1"]["filename"]]["effective_duration_seconds"]
    if expected is None:
        assert eff == pytest.approx(10.0)  # DEFAULT_IMAGE_DURATION
    else:
        assert eff == expected


# ---------------------------------------------------------------------------
# Uniqueness -> 409 with a friendly message (F041 / F066)
# ---------------------------------------------------------------------------

def _friendly(detail):
    assert isinstance(detail, str) and detail
    for w in SQLITE_WORDS:
        assert w.lower() not in detail.lower(), f"sqlite error text leaked: {detail!r}"


def test_duplicate_playlist_name_is_409(admin, world):
    name = f"val-{world['tok']}"
    _friendly(assert_json_detail(post(admin, "/playlists", {"name": name}), 409))
    other = create_playlist(admin, f"val-other-{world['tok']}")
    _friendly(assert_json_detail(post(admin, f"/playlists/{other}/rename", {"name": name}), 409))
    assert one("SELECT name FROM playlists WHERE id = ?", (other,))["name"] == f"val-other-{world['tok']}"


def test_duplicate_group_device_user_are_409(admin, world):
    tok = world["tok"]
    _friendly(assert_json_detail(post(admin, "/groups", {"name": f"val-{tok}"}), 409))
    _friendly(assert_json_detail(post(admin, "/devices", {"device_id": f"val-{tok}", "name": "again"}), 409))
    create_user(admin, f"dup-{tok}", "pw123456", "viewer")
    _friendly(assert_json_detail(post(admin, "/users", {"username": f"dup-{tok}", "password": "pw123456", "role": "viewer"}), 409))


# ---------------------------------------------------------------------------
# JSON bodies (F026)
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("body", ["notjson", "[1, 2]", "null", '"str"', "42", ""])
def test_reorder_rejects_non_object_json(admin, world, body):
    r = post_json(admin, f"/playlists/{world['pid']}/items/reorder", content=body)
    assert_json_detail(r, 400)


def test_reorder_rejects_wrong_shapes(admin, world):
    pid = world["pid"]
    for payload in ({"order": "x"}, {"order": [1, "a"]}, {"order": [world["i1"]]}, {"nope": 1}):
        r = post_json(admin, f"/playlists/{pid}/items/reorder", payload)
        assert_json_detail(r, 400)
    r = post_json(admin, f"/playlists/{pid}/items/reorder", {"order": [world["i2"], world["i1"]]})
    assert r.status_code == 200 and r.json() == {"ok": True}
    rows = query("SELECT id FROM playlist_items WHERE playlist_id = ? ORDER BY position", (pid,))
    assert [r_["id"] for r_ in rows] == [world["i2"], world["i1"]]


@pytest.mark.parametrize("body", ["notjson", '["list"]', "null", '"str"', ""])
def test_command_result_rejects_non_object_json(admin, world, body):
    dev = world["dev"]
    post(admin, f"/devices/{dev['id']}/command", {"command": "force-sync"})
    cmd = one("SELECT id FROM device_commands WHERE device_id = ? ORDER BY id DESC LIMIT 1", (dev["id"],))
    r = admin.post(f"/api/commands/{cmd['id']}/result", content=body,
                   headers={**bearer(dev["token"]), "Content-Type": "application/json"})
    assert_json_detail(r, 400)
    assert one("SELECT completed_at FROM device_commands WHERE id = ?", (cmd["id"],))["completed_at"] is None


def test_command_result_for_other_device_or_missing_command(admin, world, tok):
    dev = world["dev"]
    other = create_device(admin, f"val-other-{tok}")
    post(admin, f"/devices/{dev['id']}/command", {"command": "force-sync"})
    cmd = one("SELECT id FROM device_commands WHERE device_id = ? ORDER BY id DESC LIMIT 1", (dev["id"],))
    r = admin.post(f"/api/commands/{cmd['id']}/result", json={"result": "x"}, headers=bearer(other["token"]))
    assert r.status_code == 403
    r = admin.post(f"/api/commands/{NOPE}/result", json={"result": "x"}, headers=bearer(dev["token"]))
    assert r.status_code == 404


# ---------------------------------------------------------------------------
# Users (F013)
# ---------------------------------------------------------------------------

def test_user_form_validation(admin, world, tok):
    assert_json_detail(post(admin, "/users", {"username": f"u-{tok}", "password": "short", "role": "viewer"}), 400)
    assert_json_detail(post(admin, "/users", {"username": f"u-{tok}", "password": "pw123456", "role": "god"}), 400)
    assert_json_detail(post(admin, "/users", {"username": "   ", "password": "pw123456", "role": "viewer"}), 400)
    r = post(admin, "/users", {"username": "", "password": "pw123456", "role": "viewer"})
    assert r.status_code in (400, 422), r.text[:300]
    assert_json_detail(post(admin, f"/users/{NOPE}/role", {"role": "viewer"}), 404)
    assert_json_detail(post(admin, f"/users/{NOPE}/password", {"password": "pw123456"}), 404)


def test_playlist_and_group_names_required(admin):
    assert_json_detail(post(admin, "/playlists", {"name": "   "}), 400)
    assert_json_detail(post(admin, "/groups", {"name": "  "}), 400)
    assert post(admin, "/groups", {"name": ""}).status_code in (400, 422)
    assert_json_detail(post(admin, "/devices", {"device_id": "Bad_ID!", "name": "x"}), 400)


# ---------------------------------------------------------------------------
# Schedule evaluation semantics (contract 16, F015 / F040)
# ---------------------------------------------------------------------------

def test_schedule_matches_wrap_window_is_anchored_to_start_day(cms):
    sm = cms.schedules.schedule_matches
    # Monday 2026-09-14. Rule: Mon 22:00 -> 02:00
    rule = {"start_time": "22:00", "end_time": "02:00", "days_of_week": "0"}
    monday_23 = dt.datetime(2026, 9, 14, 23, 0)
    tuesday_01 = dt.datetime(2026, 9, 15, 1, 0)
    monday_01 = dt.datetime(2026, 9, 14, 1, 0)
    tuesday_23 = dt.datetime(2026, 9, 15, 23, 0)
    assert sm(rule, monday_23) is True
    assert sm(rule, tuesday_01) is True, "post-midnight part of a Monday window must still match on Tuesday 01:00"
    assert sm(rule, monday_01) is False, "Monday 01:00 belongs to Sunday's window, which the rule does not cover"
    assert sm(rule, tuesday_23) is False
    # date bounds are anchored the same way
    dated = {"start_time": "22:00", "end_time": "02:00", "start_date": "2026-09-14", "end_date": "2026-09-14"}
    assert sm(dated, monday_23) is True
    assert sm(dated, tuesday_01) is True
    assert sm(dated, dt.datetime(2026, 9, 16, 1, 0)) is False
    assert sm(dated, monday_01) is False
    # non-wrapping windows are unaffected
    plain = {"start_time": "09:00", "end_time": "17:00", "days_of_week": "0"}
    assert sm(plain, dt.datetime(2026, 9, 14, 12, 0)) is True
    assert sm(plain, dt.datetime(2026, 9, 15, 12, 0)) is False
    assert sm(plain, dt.datetime(2026, 9, 14, 17, 0)) is False  # half-open


def test_schedule_matches_is_defensive_for_malformed_rows(cms):
    sm = cms.schedules.schedule_matches
    now = dt.datetime(2026, 9, 14, 12, 0)
    for bad in ({"start_time": "junk"}, {"end_time": "25:99"}, {"start_time": "7"},
                {"start_time": "07:00:00"}, {"start_date": "notadate"}, {"days_of_week": "x"},
                {"start_time": "", "end_time": "abc"}):
        assert sm(bad, now) is False, bad
    assert cms.schedules.pick_active([{"id": 1, "priority": 5, "start_time": "junk"}], now) is None


def test_schedule_matches_logs_a_malformed_row_once(cms, caplog):
    import logging

    sm = cms.schedules.schedule_matches
    now = dt.datetime(2026, 9, 14, 12, 0)
    bad = {"id": 987654, "name": "once", "start_time": "junk", "end_time": "13:00"}
    with caplog.at_level(logging.ERROR):
        assert sm(bad, now) is False
        assert sm(bad, now) is False
        assert sm(dict(bad), now) is False
    errors = [r for r in caplog.records if r.levelno >= logging.ERROR and "987654" in r.getMessage()]
    assert len(errors) == 1, [r.getMessage() for r in errors]


def test_pick_active_prefers_priority_then_id(cms):
    now = dt.datetime(2026, 9, 14, 12, 0)
    rules = [
        {"id": 1, "priority": 5, "playlist_id": 1},
        {"id": 2, "priority": 9, "playlist_id": 2},
        {"id": 3, "priority": 9, "playlist_id": 3},
        {"id": 4, "priority": 99, "playlist_id": 4, "start_time": "13:00", "end_time": "14:00"},
    ]
    assert cms.schedules.pick_active(rules, now)["id"] == 3


# ---------------------------------------------------------------------------
# Safety net: uncaught sqlite3.IntegrityError -> 409, never a bare 500
# ---------------------------------------------------------------------------

def test_integrity_error_handler_is_registered_and_returns_friendly_409(cms):
    import asyncio
    import inspect
    import sqlite3

    from starlette.requests import Request

    handler = cms.app.exception_handlers.get(sqlite3.IntegrityError)
    assert handler is not None, "main.py must register an exception handler for sqlite3.IntegrityError"
    scope = {"type": "http", "method": "POST", "path": "/playlists", "headers": [], "query_string": b"",
             "client": ("testclient", 1234), "server": ("testserver", 80), "scheme": "http",
             "http_version": "1.1", "root_path": "", "app": cms.app}
    request = Request(scope)
    result = handler(request, sqlite3.IntegrityError("UNIQUE constraint failed: playlists.name"))
    response = asyncio.run(result) if inspect.isawaitable(result) else result
    assert response.status_code == 409
    body = response.body.decode()
    assert "detail" in body
    for w in SQLITE_WORDS:
        assert w.lower() not in body.lower(), f"sqlite error text leaked: {body}"
