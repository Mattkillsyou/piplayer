"""Audit log: stable newest-first ordering (F046) and action coverage."""
from cms_helpers import (add_item, assign_playlist, create_device, create_group, create_playlist,
                         create_user, post, query, upload)


def test_audit_page_orders_newest_first_even_within_one_second(admin, tok):
    names = [f"audit-{tok}-{i}" for i in range(5)]
    for n in names:
        create_playlist(admin, n)  # several rows share one created_at second
    rows = query("SELECT id, details FROM audit_log WHERE action = 'create_playlist' AND details LIKE ? ORDER BY id",
                 (f"%audit-{tok}-%",))
    assert [r["details"].count(n) for r, n in zip(rows, names)] == [1] * 5
    html = admin.get("/audit?limit=1000").text
    positions = [html.index(n) for n in names]
    assert positions == sorted(positions, reverse=True), \
        f"audit page is not strictly newest-first: {positions}"


def test_audit_query_uses_id_as_tiebreak(admin, tok):
    for i in range(3):
        create_playlist(admin, f"tie-{tok}-{i}")
    html = admin.get("/audit?limit=50").text
    first = html.index(f"tie-{tok}-2")
    second = html.index(f"tie-{tok}-1")
    third = html.index(f"tie-{tok}-0")
    assert first < second < third


def test_audit_covers_every_write_action(admin, make_media, tok):
    m = upload(admin, make_media("png"))
    pid = create_playlist(admin, f"cov-{tok}")
    add_item(admin, pid, m["id"])
    dev = create_device(admin, f"cov-{tok}")
    assign_playlist(admin, dev["id"], pid)
    gid = create_group(admin, f"cov-{tok}")
    post(admin, f"/groups/{gid}/assign", {"playlist_id": str(pid)})
    post(admin, f"/devices/{dev['id']}/group", {"group_id": str(gid)})
    post(admin, f"/devices/{dev['id']}/schedule", {"name": "r", "playlist_id": str(pid), "priority": "1"})
    post(admin, f"/devices/{dev['id']}/command", {"command": "force-sync"})
    create_user(admin, f"cov-{tok}", "pw123456", "viewer")
    seen = {r["action"] for r in query("SELECT DISTINCT action FROM audit_log")}
    expected = {"login", "user_create", "upload_media", "create_playlist", "register_device",
                "device_assign_playlist", "group_create", "group_assign_playlist", "device_set_group",
                "device_schedule_create", "device_send_command", "playlist_add_item"}
    assert expected <= seen, f"missing audit actions: {expected - seen}"
    html = admin.get("/audit").text
    assert "create_playlist" in html and f"cov-{tok}" in html


def test_audit_limit_is_validated(admin):
    assert admin.get("/audit?limit=0").status_code in (400, 422)
    assert admin.get("/audit?limit=5000").status_code in (400, 422)
    assert admin.get("/audit?limit=1").status_code == 200
