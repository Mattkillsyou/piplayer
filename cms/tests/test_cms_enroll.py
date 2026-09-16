"""Auto-assign on enrollment: the Settings defaults (enroll_group_id / enroll_playlist_id)
apply to a device's FIRST POST /api/enroll only, dangling ids read as none, and the
settings form rejects unknown ids."""
import json

import pytest

from cms_helpers import create_group, create_playlist, execute, one, post, query

TESTCLIENT_IP = "testclient"


@pytest.fixture(autouse=True)
def _clean(cms):
    cms.auth.clear_login_failures(TESTCLIENT_IP, cms.auth.ENROLL_SLOT)
    yield
    execute("DELETE FROM settings WHERE key IN ('enroll_group_id', 'enroll_playlist_id')")


def enroll(client, cms, device_id, name="pi"):
    return client.post("/api/enroll", json={"key": cms.db.enrollment_key(), "device_id": device_id, "name": name})


def save(admin, group_id="", playlist_id=""):
    return post(admin, "/settings", {"enroll_group_id": str(group_id), "enroll_playlist_id": str(playlist_id)})


def test_defaults_apply_on_first_enrollment_and_are_audited(admin, client, cms, tok):
    gid = create_group(admin, f"g-{tok}")
    pid = create_playlist(admin, f"p-{tok}")
    r = save(admin, gid, pid)
    assert r.status_code == 303 and r.headers["location"] == "/settings?saved=1"
    assert enroll(client, cms, f"new-{tok}").status_code == 200
    dev = one("SELECT group_id, playlist_id FROM devices WHERE device_id = ?", (f"new-{tok}",))
    assert (dev["group_id"], dev["playlist_id"]) == (gid, pid)
    a = query("SELECT details FROM audit_log WHERE action = 'device_enrolled' ORDER BY id DESC LIMIT 1")[0]
    assert json.loads(a["details"]) == {"device_id": f"new-{tok}", "name": "pi", "group_id": gid, "playlist_id": pid}


def test_reenroll_keeps_current_assignment(admin, client, cms, tok):
    assert enroll(client, cms, f"old-{tok}").status_code == 200  # enrolled before any default existed
    gid = create_group(admin, f"g-{tok}")
    pid = create_playlist(admin, f"p-{tok}")
    save(admin, gid, pid)
    assert enroll(client, cms, f"old-{tok}", "renamed").status_code == 200
    dev = one("SELECT name, group_id, playlist_id FROM devices WHERE device_id = ?", (f"old-{tok}",))
    assert (dev["name"], dev["group_id"], dev["playlist_id"]) == ("renamed", None, None)


def test_defaults_pointing_at_deleted_rows_are_ignored(admin, client, cms, tok):
    gid = create_group(admin, f"g-{tok}")
    pid = create_playlist(admin, f"p-{tok}")
    save(admin, gid, pid)
    assert post(admin, f"/groups/{gid}/delete").status_code == 303
    assert post(admin, f"/playlists/{pid}/delete").status_code == 303
    assert enroll(client, cms, f"dangle-{tok}").status_code == 200
    dev = one("SELECT group_id, playlist_id FROM devices WHERE device_id = ?", (f"dangle-{tok}",))
    assert (dev["group_id"], dev["playlist_id"]) == (None, None)
    assert admin.get("/settings").status_code == 200  # page renders with the dangling ids


@pytest.mark.parametrize("field", ["enroll_group_id", "enroll_playlist_id"])
def test_settings_reject_unknown_ids(admin, field):
    r = post(admin, "/settings", {field: "999999"})
    assert r.status_code == 400 and field in r.json()["detail"]
    r = post(admin, "/settings", {field: "abc"})
    assert r.status_code == 400
    assert query("SELECT * FROM settings WHERE key = ?", (field,)) == []


def test_settings_page_shows_selection_and_none_clears(admin, cms, tok):
    gid = create_group(admin, f"g-{tok}")
    save(admin, gid, "")
    page = admin.get("/settings").text
    assert f'<option value="{gid}" selected>' in page and 'name="enroll_playlist_id"' in page
    # Enrollment key masked behind the same input + reveal button the cloud console renders.
    assert f'<input type="password" id="enrollment-key" value="{cms.db.enrollment_key()}" readonly' in page
    assert 'data-reveal="enrollment-key">Show</button>' in page
    assert save(admin, "", "").status_code == 303
    assert query("SELECT * FROM settings WHERE key = 'enroll_group_id'") == []


def test_settings_save_is_admin_only_and_needs_csrf(admin, make_client, tok):
    from cms_helpers import create_user, login
    create_user(admin, f"ed-{tok}", "pw123456", "editor")
    ed = make_client()
    assert login(ed, f"ed-{tok}", "pw123456").status_code == 303
    assert post(ed, "/settings", {"enroll_group_id": ""}).status_code == 403
    assert admin.post("/settings", data={"enroll_group_id": ""}, follow_redirects=False).status_code == 403
