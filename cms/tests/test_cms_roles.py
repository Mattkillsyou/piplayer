"""Roles: viewers are read-only and never see device tokens (F012); page smoke."""
from cms_helpers import create_device, create_user, login, post, query


def _login_as(make_client, username, password):
    c = make_client()
    r = login(c, username, password)
    assert r.status_code == 303, f"login as {username} failed: {r.status_code}"
    return c


def test_viewer_cannot_see_device_tokens_but_editor_and_admin_can(admin, make_client, tok):
    dev = create_device(admin, f"role-{tok}", f"Role Dev {tok}")
    create_user(admin, f"viewer-{tok}", "viewer-pass", "viewer")
    create_user(admin, f"editor-{tok}", "editor-pass", "editor")
    viewer = _login_as(make_client, f"viewer-{tok}", "viewer-pass")
    editor = _login_as(make_client, f"editor-{tok}", "editor-pass")

    r = viewer.get("/devices")
    assert r.status_code == 200
    assert f"Role Dev {tok}" in r.text
    assert dev["token"] not in r.text, "viewer can read the device bearer token"
    assert "DEVICE_TOKEN=" + dev["token"] not in r.text

    r = editor.get("/devices")
    assert r.status_code == 200
    assert dev["token"] in r.text, "editor cannot see the token"

    r = admin.get("/devices")
    assert dev["token"] in r.text


def test_viewer_cannot_write_or_open_users(admin, make_client, tok):
    create_user(admin, f"viewer2-{tok}", "viewer-pass", "viewer")
    viewer = _login_as(make_client, f"viewer2-{tok}", "viewer-pass")
    assert viewer.get("/library").status_code == 200
    r = post(viewer, "/playlists", {"name": f"viewer-forbidden-{tok}"})
    assert r.status_code == 403
    assert query("SELECT id FROM playlists WHERE name = ?", (f"viewer-forbidden-{tok}",)) == []
    assert viewer.get("/users").status_code == 403
    r = post(viewer, "/users", {"username": f"nope-{tok}", "password": "pw123456", "role": "admin"})
    assert r.status_code == 403


def test_editor_cannot_manage_users(admin, make_client, tok):
    create_user(admin, f"editor2-{tok}", "editor-pass", "editor")
    editor = _login_as(make_client, f"editor2-{tok}", "editor-pass")
    assert editor.get("/users").status_code == 403
    r = post(editor, "/users", {"username": f"nope2-{tok}", "password": "pw123456", "role": "viewer"})
    assert r.status_code == 403


def test_anonymous_is_redirected_to_login(client):
    for path in ("/dashboard", "/library", "/playlists", "/devices", "/groups", "/audit", "/users"):
        r = client.get(path, follow_redirects=False)
        assert r.status_code == 303, f"{path}: {r.status_code}"
        assert r.headers["location"] == "/login"
    r = client.get("/", follow_redirects=False)
    assert r.status_code == 303 and r.headers["location"] == "/login"


def test_all_pages_render_for_admin(admin, tok):
    dev = create_device(admin, f"pages-{tok}")
    for path in ("/", "/dashboard", "/library", "/playlists", "/devices", "/groups", "/audit", "/users",
                 f"/devices/{dev['id']}/schedule"):
        r = admin.get(path)
        assert r.status_code == 200, f"{path}: {r.status_code}"


def test_last_admin_cannot_be_deleted_or_demoted(admin, tok):
    admin_row = query("SELECT id FROM users WHERE username = 'admin'")[0]
    r = post(admin, f"/users/{admin_row['id']}/delete")
    assert r.status_code == 400
    r = post(admin, f"/users/{admin_row['id']}/role", {"role": "viewer"})
    assert r.status_code == 400


def test_devices_page_install_command_is_complete(admin, tok):
    dev = create_device(admin, f"inst-{tok}")
    html = admin.get("/devices").text
    assert "deploy/install-player.sh" in html, "install command must reference deploy/install-player.sh"
    assert "cd piplayer/player" in html
    assert f"DEVICE_ID={dev['device_id']}" in html
    assert f"DEVICE_TOKEN={dev['token']}" in html
    assert "CMS_URL=" in html
    # contract 17: sudo -E so the DEVICE_*/CMS_URL variables reach the installer
    assert "sudo -E bash deploy/install-player.sh" in html
