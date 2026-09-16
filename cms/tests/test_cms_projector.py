"""Feature E, projector power: the projector-on / projector-off / ir-learn:<name> commands, the
per-device Projector block (control, mode, RM4 host), learned IR codes filed from the command
result, the sync projector_state / projector_error report, the manifest `projector` block with
its auto-mode `want`, and the Settings page lead / idle knobs."""
import base64
import datetime as dt
import json
import os

import pytest

from cms_helpers import (assert_json_detail, assign_playlist, bearer, create_device, create_playlist, create_user,
                         execute, login, one, post, query, sync)

PROJECTOR_COMMANDS = ("projector-on", "projector-off", "ir-learn:power_on", "ir-learn:power_off",
                      "ir-learn:input_hdmi1")


def _code(seed: str, n: int = 64) -> str:
    return base64.b64encode(b"\x26\x00" + seed.encode() + os.urandom(n)).decode()


def _row(dev):
    return one("SELECT projector_control, projector_power_mode, broadlink_host, projector_ir_codes, "
               "projector_power_state, projector_error FROM devices WHERE id = ?", (dev["id"],))


def _last_command_id(dev):
    return one("SELECT id FROM device_commands WHERE device_id = ? ORDER BY id DESC LIMIT 1", (dev["id"],))["id"]


def _report(client, dev, command_id, body):
    return client.post(f"/api/commands/{command_id}/result", headers=bearer(dev["token"]), json=body)


def _section(html, dev):
    """This device's Projector <details> block (summary, form, buttons, badges)."""
    head, tail = html.split(f'action="/devices/{dev["id"]}/projector"')
    return head.rsplit('<details class="projector-block">', 1)[1] + tail.split("</details>")[0]


def _set_projector(admin, dev, control="broadlink", mode="manual", host=""):
    return post(admin, f"/devices/{dev['id']}/projector",
                {"projector_control": control, "projector_power_mode": mode, "broadlink_host": host})


# ---------------------------------------------------------------------------
# Schema + commands
# ---------------------------------------------------------------------------

def test_schema_accepts_projector_commands_and_has_projector_columns(cms):
    sql = one("SELECT sql FROM sqlite_master WHERE name = 'device_commands'")["sql"]
    assert "'projector-on'" in sql and "'projector-off'" in sql and "LIKE 'ir-learn:%'" in sql
    cols = {r["name"] for r in query("PRAGMA table_info(devices)")}
    assert {"projector_control", "projector_ir_codes", "broadlink_host", "projector_power_mode",
            "projector_power_state", "projector_error"} <= cols
    assert cms.db.IR_CODE_NAMES == ("power_on", "power_off", "input_hdmi1")


def test_projector_commands_are_queued_and_delivered(admin, client, tok):
    dev = create_device(admin, f"proj-{tok}", f"Proj Dev {tok}")
    for c in PROJECTOR_COMMANDS:
        r = post(admin, f"/devices/{dev['id']}/command", {"command": c})
        assert r.status_code == 303, f"{c}: {r.status_code} {r.text[:300]}"
    # only the known code names can be learned (the CHECK would take any ir-learn:* string)
    for bad in ("ir-learn:volume_up", "ir-learn:", "ir-learn", "projector-toggle"):
        assert_json_detail(post(admin, f"/devices/{dev['id']}/command", {"command": bad}), 400)
    r = sync(client, dev)
    assert r.status_code == 200
    assert [c["command"] for c in r.json()["commands"]] == list(PROJECTOR_COMMANDS)
    rows = query("SELECT details FROM audit_log WHERE action = 'device_send_command' AND target_id = ? ORDER BY id",
                 (str(dev["id"]),))
    assert [json.loads(r["details"])["command"] for r in rows] == list(PROJECTOR_COMMANDS)


# ---------------------------------------------------------------------------
# Projector block (control / mode / host) + manifest
# ---------------------------------------------------------------------------

def test_projector_settings_are_saved_validated_and_served(admin, client, make_client, tok):
    dev = create_device(admin, f"proj-set-{tok}", f"Proj Set {tok}")
    assert _row(dev)["projector_control"] is None
    # feature off: no projector key content until a control is chosen
    assert sync(client, dev).json()["projector"] is None

    r = _set_projector(admin, dev, "broadlink", "auto", "192.168.1.44")
    assert r.status_code == 303 and r.headers["location"] == "/devices"
    row = _row(dev)
    assert (row["projector_control"], row["projector_power_mode"], row["broadlink_host"]) == ("broadlink", "auto", "192.168.1.44")
    a = one("SELECT details FROM audit_log WHERE action = 'device_set_projector' AND target_id = ?", (str(dev["id"]),))
    assert json.loads(a["details"]) == {"projector_control": "broadlink", "projector_power_mode": "auto",
                                        "broadlink_host": "192.168.1.44"}
    block = sync(client, dev).json()["projector"]
    assert block == {"control": "broadlink", "mode": "auto", "want": "off", "codes": {}, "broadlink_host": "192.168.1.44"}

    # empty host = discover on the LAN; a cec projector needs no host
    assert _set_projector(admin, dev, "cec", "manual", "  ").status_code == 303
    row = _row(dev)
    assert (row["projector_control"], row["projector_power_mode"], row["broadlink_host"]) == ("cec", "manual", None)
    assert sync(client, dev).json()["projector"]["broadlink_host"] is None

    for bad in ({"projector_control": "hdmi"}, {"projector_power_mode": "sometimes"},
                {"broadlink_host": "http://rm4.local"}, {"broadlink_host": "rm4 local"},
                {"broadlink_host": "x" * 254}):
        form = {"projector_control": "broadlink", "projector_power_mode": "manual", "broadlink_host": "", **bad}
        assert_json_detail(post(admin, f"/devices/{dev['id']}/projector", form), 400)
    assert _row(dev)["projector_control"] == "cec", "a rejected form must not touch the row"
    assert_json_detail(post(admin, "/devices/999999/projector",
                            {"projector_control": "cec", "projector_power_mode": "manual"}), 404)

    # viewers cannot change it and see no buttons; the page renders the block for everyone
    create_user(admin, f"proj-viewer-{tok}", "viewer-pass", "viewer")
    viewer = make_client()
    assert login(viewer, f"proj-viewer-{tok}", "viewer-pass").status_code == 303
    assert _set_projector(viewer, dev, "none").status_code == 403
    html = viewer.get("/devices").text
    assert 'action="/devices/%d/projector"' % dev["id"] in html
    assert 'value="projector-on"' not in html


def test_devices_page_shows_projector_block_state_and_codes(admin, client, tok):
    dev = create_device(admin, f"proj-page-{tok}", f"Proj Page {tok}")
    section = _section(admin.get("/devices").text, dev)
    assert "status-projector-" not in section and 'value="projector-on"' not in section

    assert _set_projector(admin, dev, "broadlink", "manual").status_code == 303
    section = _section(admin.get("/devices").text, dev)
    assert 'value="projector-on"' in section and 'value="projector-off"' in section
    for n in ("power_on", "power_off", "input_hdmi1"):
        assert f'value="ir-learn:{n}"' in section, n
        assert f'badge badge-muted" title="not learned yet">{n}<' in section, n
    assert "status-projector-unknown" in section and "Learning" not in section

    # a queued learn disables that button and shows the 30 s hint
    assert post(admin, f"/devices/{dev['id']}/command", {"command": "ir-learn:power_on"}).status_code == 303
    section = _section(admin.get("/devices").text, dev)
    assert "Learning" in section and "within 30 s" in section
    cid = _last_command_id(dev)
    code = _code(tok)
    assert _report(client, dev, cid, {"result": json.dumps({"learned": "power_on", "code": code})}).status_code == 200
    html = admin.get("/devices").text
    section = _section(html, dev)
    assert 'badge badge-active" title="learned">power_on<' in section
    assert "Learning" not in section
    assert code not in html, "the packet is never rendered"
    assert "learned power_on" in html   # the recent-commands entry

    # state lamp + error from the sync report
    sync(client, dev, projector_state="on", projector_error="")
    assert "status-projector-on" in _section(admin.get("/devices").text, dev)
    sync(client, dev, projector_state="unknown", projector_error="projector on: Broadlink auth failed for 10.0.0.9")
    section = _section(admin.get("/devices").text, dev)
    assert "status-projector-unknown" in section and "Projector: projector on: Broadlink auth failed" in section
    # CEC: no IR badges / learn buttons
    assert _set_projector(admin, dev, "cec", "auto").status_code == 303
    section = _section(admin.get("/devices").text, dev)
    assert "ir-learn:" not in section and 'value="projector-on"' in section


def test_projector_error_is_html_escaped(admin, client, tok):
    dev = create_device(admin, f"proj-xss-{tok}")
    sync(client, dev, projector_error="<img src=x onerror=alert(1)>")
    html = admin.get("/devices").text
    assert "<img src=x" not in html and "&lt;img src=x" in html


# ---------------------------------------------------------------------------
# ir-learn results
# ---------------------------------------------------------------------------

def test_ir_learn_result_files_the_code_under_its_name(admin, client, tok):
    dev = create_device(admin, f"proj-ir-{tok}")
    assert _set_projector(admin, dev, "broadlink").status_code == 303

    def learn(name, body):
        assert post(admin, f"/devices/{dev['id']}/command", {"command": f"ir-learn:{name}"}).status_code == 303
        cid = _last_command_id(dev)
        r = _report(client, dev, cid, body)
        assert r.status_code == 200, r.text[:300]
        return one("SELECT result, completed_at FROM device_commands WHERE id = ?", (cid,))

    # the player's shape: a JSON result {"learned", "code"}
    on = _code(tok + "on")
    row = learn("power_on", {"result": json.dumps({"learned": "power_on", "code": on})})
    assert row["completed_at"] and row["result"] == "learned power_on"
    assert json.loads(_row(dev)["projector_ir_codes"]) == {"power_on": on}
    # a bare base64 result and a top-level `code` are accepted too
    off = _code(tok + "off")
    learn("power_off", {"result": off})
    hdmi = _code(tok + "hdmi")
    learn("input_hdmi1", {"result": "learned", "code": hdmi})
    assert json.loads(_row(dev)["projector_ir_codes"]) == {"power_on": on, "power_off": off, "input_hdmi1": hdmi}
    rows = query("SELECT details FROM audit_log WHERE action = 'device_ir_code_learned' AND target_id = ? ORDER BY id",
                 (str(dev["id"]),))
    assert [json.loads(r["details"]) for r in rows] == [{"device_id": dev["device_id"], "name": n}
                                                        for n in ("power_on", "power_off", "input_hdmi1")]
    for r in rows:
        assert on not in r["details"] and off not in r["details"], "audited without the packet"

    # failure texts leave the stored codes alone but still close the command
    for fail in ("ir-learn power_on failed: nothing learned in 30 s (press the remote at the RM4)",
                 "failed", "QUJD", "", "not base64!!"):
        row = learn("power_on", {"result": fail})
        assert row["completed_at"] and row["result"] == fail
    assert json.loads(_row(dev)["projector_ir_codes"])["power_on"] == on

    # re-learning replaces just that name; the manifest carries the codes
    on2 = _code(tok + "on2")
    learn("power_on", {"result": json.dumps({"learned": "power_on", "code": on2})})
    codes = json.loads(_row(dev)["projector_ir_codes"])
    assert codes == {"power_on": on2, "power_off": off, "input_hdmi1": hdmi}
    assert sync(client, dev).json()["projector"]["codes"] == codes

    # a projector-on result is stored verbatim, never as a code
    assert post(admin, f"/devices/{dev['id']}/command", {"command": "projector-on"}).status_code == 303
    cid = _last_command_id(dev)
    assert _report(client, dev, cid, {"result": on}).status_code == 200
    assert one("SELECT result FROM device_commands WHERE id = ?", (cid,))["result"] == on
    assert json.loads(_row(dev)["projector_ir_codes"]) == codes

    # another device's token cannot file a code on this device's command
    other = create_device(admin, f"proj-ir-other-{tok}")
    assert post(admin, f"/devices/{dev['id']}/command", {"command": "ir-learn:power_off"}).status_code == 303
    cid = _last_command_id(dev)
    assert _report(client, other, cid, {"result": _code("evil")}).status_code == 403
    assert json.loads(_row(dev)["projector_ir_codes"])["power_off"] == off


def test_junk_ir_codes_column_never_breaks_sync_or_page(admin, client, cms, tok):
    dev = create_device(admin, f"proj-junk-{tok}")
    assert _set_projector(admin, dev, "broadlink").status_code == 303
    for junk in ("not json", "[1, 2]", '{"power_on": 7, "volume": "x"}'):
        execute("UPDATE devices SET projector_ir_codes = ? WHERE id = ?", (junk, dev["id"]))
        assert sync(client, dev).json()["projector"]["codes"] == {}
        assert admin.get("/devices").status_code == 200
    assert cms.api_routes.ir_codes('{"power_on": "QUJDRA==", "extra": "x", "power_off": ""}') == {"power_on": "QUJDRA=="}


# ---------------------------------------------------------------------------
# Sync report
# ---------------------------------------------------------------------------

def test_sync_stores_projector_state_and_error(admin, client, tok):
    dev = create_device(admin, f"proj-sync-{tok}")
    row = _row(dev)
    assert (row["projector_power_state"], row["projector_error"]) == (None, None)
    assert sync(client, dev, projector_state="on").status_code == 200
    assert _row(dev)["projector_power_state"] == "on"
    # a sync without the param (no projector control) keeps the last state; junk is ignored
    sync(client, dev)
    sync(client, dev, projector_state="blown")
    assert _row(dev)["projector_power_state"] == "on"
    sync(client, dev, projector_state="unknown", projector_error="x" * 500)
    row = _row(dev)
    assert row["projector_power_state"] == "unknown" and len(row["projector_error"]) == 200
    sync(client, dev, projector_state="off", projector_error="")
    row = _row(dev)
    assert (row["projector_power_state"], row["projector_error"]) == ("off", None)


# ---------------------------------------------------------------------------
# want computation (fixed times)
# ---------------------------------------------------------------------------

@pytest.fixture
def want(cms):
    def _want(dev, now, **kw):
        with cms.db.cursor() as cur:
            d = dict(cur.execute("SELECT id, playlist_id, group_id FROM devices WHERE id = ?", (dev["id"],)).fetchone())
            return cms.api_routes.projector_want(d, now, cur, **kw)
    return _want


def _schedule(admin, dev, playlist_id, name, start, end, **extra):
    r = post(admin, f"/devices/{dev['id']}/schedule",
             {"name": name, "playlist_id": str(playlist_id), "start_time": start, "end_time": end, **extra})
    assert r.status_code == 303, f"{r.status_code} {r.text[:300]}"


def test_projector_want_follows_playlist_lead_and_idle(admin, client, want, tok):
    dev = create_device(admin, f"proj-want-{tok}")
    pl = create_playlist(admin, f"Proj Want {tok}")
    wed = dt.datetime(2026, 9, 16, 9, 0)   # a Wednesday
    # nothing assigned, nothing scheduled: off
    assert want(dev, wed) == "off"

    # a schedule 10:00-11:00: on from 3 min before (lead) until 10 min after (idle)
    _schedule(admin, dev, pl, "morning", "10:00", "11:00")
    cases = {
        dt.datetime(2026, 9, 16, 9, 50): "off",
        dt.datetime(2026, 9, 16, 9, 56): "off",
        dt.datetime(2026, 9, 16, 9, 57): "on",      # 3 min lead
        dt.datetime(2026, 9, 16, 9, 59, 30): "on",
        dt.datetime(2026, 9, 16, 10, 0): "on",
        dt.datetime(2026, 9, 16, 10, 59, 59): "on",
        dt.datetime(2026, 9, 16, 11, 0): "on",      # just ended: idle delay
        dt.datetime(2026, 9, 16, 11, 9, 59): "on",  # 10:59:59 was still playing
        dt.datetime(2026, 9, 16, 11, 10, 0): "off", # 10 idle minutes since 11:00
        dt.datetime(2026, 9, 16, 13, 0): "off",
        # zone-aware now works too (02:00 UTC is a local time outside 09:57-11:10 in every zone)
        dt.datetime(2026, 9, 16, 2, 0, tzinfo=dt.timezone.utc).astimezone(): "off",
    }
    for now, expected in cases.items():
        assert want(dev, now) == expected, now

    # the knobs
    assert want(dev, dt.datetime(2026, 9, 16, 9, 45), lead_minutes=15) == "on"
    assert want(dev, dt.datetime(2026, 9, 16, 9, 45), lead_minutes=14) == "off"
    assert want(dev, dt.datetime(2026, 9, 16, 11, 30), idle_minutes=60) == "on"
    assert want(dev, dt.datetime(2026, 9, 16, 11, 2), idle_minutes=1) == "off"
    assert want(dev, dt.datetime(2026, 9, 16, 11, 0, 30), idle_minutes=0) == "off"

    # a device default playlist is always served: on around the clock
    assign_playlist(admin, dev["id"], pl)
    assert want(dev, dt.datetime(2026, 9, 16, 3, 0)) == "on"
    assign_playlist(admin, dev["id"], "")
    assert want(dev, dt.datetime(2026, 9, 16, 3, 0)) == "off"

    # the manifest carries the same answer for the CMS clock
    assert _set_projector(admin, dev, "cec", "auto").status_code == 303
    r = sync(client, dev)
    assert r.json()["projector"]["want"] in ("on", "off")
    assert r.json()["projector"]["mode"] == "auto"


def test_projector_want_weekday_rule_off_on_other_days(admin, want, tok):
    dev = create_device(admin, f"proj-want-dow-{tok}")
    pl = create_playlist(admin, f"Proj Want DOW {tok}")
    _schedule(admin, dev, pl, "fridays", "18:00", "20:00", days_of_week="4")
    assert want(dev, dt.datetime(2026, 9, 18, 17, 58)) == "on"    # Friday
    assert want(dev, dt.datetime(2026, 9, 17, 17, 58)) == "off"   # Thursday
    assert want(dev, dt.datetime(2026, 9, 18, 20, 5)) == "on"
    assert want(dev, dt.datetime(2026, 9, 18, 20, 11)) == "off"


# ---------------------------------------------------------------------------
# Settings page
# ---------------------------------------------------------------------------

def test_settings_page_shows_projector_env_knobs(admin, cms):
    html = admin.get("/settings").text
    assert "Projector power" in html and "PIPLAYER_PROJECTOR_LEAD_MINUTES" in html
    assert "PIPLAYER_PROJECTOR_IDLE_MINUTES" in html
    assert f"{cms.config.PROJECTOR_LEAD_MINUTES} min" in html and f"{cms.config.PROJECTOR_IDLE_MINUTES} min" in html
    assert (cms.config.PROJECTOR_LEAD_MINUTES, cms.config.PROJECTOR_IDLE_MINUTES) == (3, 10)
