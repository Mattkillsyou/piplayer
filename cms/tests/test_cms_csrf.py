"""Contract 8: CSRF tokens on every web POST (F065)."""
import re

from cms_helpers import (CSRF_META, add_item, create_device, create_group, create_playlist,
                         create_user, csrf_token, find_csrf, login, post, post_json, upload)
from cms_support import ADMIN_PASSWORD, ADMIN_USERNAME

CSRF_DETAIL = "CSRF token missing or invalid"
FORM_RX = re.compile(r"<form\b[^>]*method=[\"']post[\"'][^>]*>(.*?)</form>", re.S | re.I)
HIDDEN_RX = re.compile(r'<input[^>]*type="hidden"[^>]*name="csrf_token"[^>]*>|<input[^>]*name="csrf_token"[^>]*type="hidden"[^>]*>')


def test_login_page_exposes_token_in_meta_and_hidden_input(client):
    r = client.get("/login")
    assert r.status_code == 200
    meta = CSRF_META.search(r.text)
    assert meta, "login page has no <meta name=\"csrf-token\">"
    hidden = find_csrf(r.text)
    assert hidden, "login form has no hidden csrf_token input"
    assert meta.group(1) == hidden
    assert len(hidden) >= 32


def test_token_is_stable_within_a_session(client):
    assert csrf_token(client) == csrf_token(client)


def test_login_without_token_never_authenticates(client):
    # No session at all (stale form): the CMS hands out a fresh login form instead of a JSON
    # 403 (deviation from contract 8's wording, same security outcome: no login happens).
    r = client.post("/login", data={"username": ADMIN_USERNAME, "password": ADMIN_PASSWORD}, follow_redirects=False)
    assert r.status_code in (303, 403), f"{r.status_code} {r.text[:200]}"
    if r.status_code == 303:
        assert r.headers["location"].startswith("/login")
    assert client.get("/dashboard", follow_redirects=False).status_code == 303, "token-less login POST authenticated"
    # With a session (the login page was rendered) but no token: 403
    assert csrf_token(client)
    r = client.post("/login", data={"username": ADMIN_USERNAME, "password": ADMIN_PASSWORD}, follow_redirects=False)
    assert r.status_code == 403
    assert r.json() == {"detail": CSRF_DETAIL}
    assert client.get("/dashboard", follow_redirects=False).status_code == 303


def test_login_with_wrong_token_is_403(client):
    csrf_token(client)  # establish a session token
    r = client.post(
        "/login",
        data={"username": ADMIN_USERNAME, "password": ADMIN_PASSWORD, "csrf_token": "not-the-token"},
        follow_redirects=False,
    )
    assert r.status_code == 403
    assert r.json()["detail"] == CSRF_DETAIL


def test_login_with_form_token_succeeds(client):
    r = login(client, ADMIN_USERNAME, ADMIN_PASSWORD)
    assert r.status_code == 303
    assert r.headers["location"] == "/dashboard"


def test_login_with_header_token_succeeds(client):
    token = csrf_token(client)
    assert token, "no CSRF token on the login page"
    r = client.post(
        "/login",
        data={"username": ADMIN_USERNAME, "password": ADMIN_PASSWORD},
        headers={"X-CSRF-Token": token},
        follow_redirects=False,
    )
    assert r.status_code == 303


def test_logout_requires_token(admin):
    r = admin.post("/logout", follow_redirects=False)
    assert r.status_code == 403
    assert r.json()["detail"] == CSRF_DETAIL
    # still logged in
    assert admin.get("/dashboard").status_code == 200
    r = post(admin, "/logout")
    assert r.status_code == 303
    assert admin.get("/dashboard", follow_redirects=False).status_code == 303


def test_authenticated_post_without_token_is_403_and_writes_nothing(admin, tok):
    name = f"csrf-{tok}"
    r = admin.post("/playlists", data={"name": name}, follow_redirects=False)
    assert r.status_code == 403
    assert r.json()["detail"] == CSRF_DETAIL
    from cms_helpers import query
    assert query("SELECT id FROM playlists WHERE name = ?", (name,)) == []


def test_authenticated_post_with_form_token(admin, tok):
    pid = create_playlist(admin, f"csrf-form-{tok}")
    assert pid > 0


def test_authenticated_post_with_header_token(admin, tok):
    token = csrf_token(admin)
    assert token, "no CSRF token available"
    r = admin.post("/playlists", data={"name": f"csrf-hdr-{tok}"}, headers={"X-CSRF-Token": token}, follow_redirects=False)
    assert r.status_code == 303


def test_token_from_another_session_is_rejected(admin, make_client, tok):
    other = make_client()
    foreign = csrf_token(other)
    r = admin.post("/playlists", data={"name": f"csrf-x-{tok}", "csrf_token": foreign}, follow_redirects=False)
    assert r.status_code == 403


def test_json_reorder_requires_header_token(admin, make_media, tok):
    pid = create_playlist(admin, f"csrf-json-{tok}")
    m1 = upload(admin, make_media("png"))
    m2 = upload(admin, make_media("png"))
    i1 = add_item(admin, pid, m1["id"])
    i2 = add_item(admin, pid, m2["id"])
    r = admin.post(f"/playlists/{pid}/items/reorder", json={"order": [i2, i1]})
    assert r.status_code == 403
    assert r.json()["detail"] == CSRF_DETAIL
    r = post_json(admin, f"/playlists/{pid}/items/reorder", {"order": [i2, i1]})
    assert r.status_code == 200
    assert r.json() == {"ok": True}


def test_multipart_upload_requires_token(admin, make_media):
    path = make_media("png")
    with open(path, "rb") as f:
        r = admin.post("/library/upload", files={"file": (path.name, f, "image/png")}, follow_redirects=False)
    assert r.status_code == 403
    assert r.json()["detail"] == CSRF_DETAIL


def test_every_web_post_route_is_csrf_protected(admin, cms):
    """Enumerate the web router itself so a newly added POST route cannot slip past
    this test (app.routes does not flatten included routers on newer Starlette, so
    read cms.web_routes.router.routes directly and refuse to pass vacuously)."""
    paths = sorted(
        re.sub(r"\{[^}]+\}", "1", route.path)
        for route in cms.web_routes.router.routes
        if "POST" in (getattr(route, "methods", None) or ())
    )
    assert paths, "no POST routes found on the web router: enumeration is broken"
    assert "/devices" in paths and "/login" in paths, paths
    assert csrf_token(admin, "/dashboard")  # login cleared the session; render a page so it holds a token
    for path in paths:
        r = admin.post(path, data={"x": "y"}, follow_redirects=False)
        assert r.status_code == 403, f"{path}: {r.status_code} {r.text[:200]}"
        assert r.json()["detail"] == CSRF_DETAIL, path


def test_every_rendered_form_carries_the_hidden_input(admin, make_client, make_media, tok):
    """Every <form method="post"> on every page has the hidden csrf_token input."""
    m = upload(admin, make_media("png"))
    pid = create_playlist(admin, f"csrf-pages-{tok}")
    add_item(admin, pid, m["id"])
    dev = create_device(admin, f"csrf-dev-{tok}")
    post(admin, f"/devices/{dev['id']}/schedule", {"name": "r", "playlist_id": str(pid), "priority": "1"})
    create_group(admin, f"csrf-grp-{tok}")
    create_user(admin, f"csrf-user-{tok}", "pw123456", "viewer")

    pages = ["/dashboard", "/library", "/playlists", f"/playlists/{pid}", "/devices",
             f"/devices/{dev['id']}/schedule", "/groups", "/users", "/audit"]
    for page in pages:
        html = admin.get(page).text
        forms = FORM_RX.findall(html)
        assert forms, f"{page}: expected at least one POST form"
        for body in forms:
            assert HIDDEN_RX.search(body), f"{page}: a POST form lacks the hidden csrf_token input:\n{body[:300]}"
        assert CSRF_META.search(html), f"{page}: missing csrf-token meta tag"

    anon = make_client()
    html = anon.get("/login").text
    for body in FORM_RX.findall(html):
        assert HIDDEN_RX.search(body)


def test_device_api_is_exempt(admin, tok):
    dev = create_device(admin, f"csrf-api-{tok}")
    post(admin, f"/devices/{dev['id']}/command", {"command": "force-sync"})
    from cms_helpers import bearer, one, sync
    r = sync(admin, dev)
    assert r.status_code == 200
    cmd = one("SELECT id FROM device_commands WHERE device_id = ? ORDER BY id DESC LIMIT 1", (dev["id"],))
    r = admin.post(f"/api/commands/{cmd['id']}/result", json={"result": "done"}, headers=bearer(dev["token"]))
    assert r.status_code == 200, r.text
    assert r.json() == {"ok": True}
