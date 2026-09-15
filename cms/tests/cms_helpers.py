"""Helpers shared by the CMS pytest modules (TestClient flavoured).

The CSRF flow follows the cross-package contract: the token is read from the
hidden `csrf_token` input on GET /login (or the `csrf-token` meta tag on any
page) and sent back either as the `csrf_token` form field or as the
`X-CSRF-Token` header. `post()` uses the form field, `post_json()` the header.
"""
import os
import re
import sqlite3
from pathlib import Path

CSRF_INPUT = re.compile(r'<input[^>]*name="csrf_token"[^>]*value="([^"]+)"')
CSRF_INPUT_REV = re.compile(r'<input[^>]*value="([^"]+)"[^>]*name="csrf_token"')
CSRF_META = re.compile(r'<meta[^>]*name="csrf-token"[^>]*content="([^"]+)"')


def find_csrf(html: str):
    for rx in (CSRF_INPUT, CSRF_INPUT_REV, CSRF_META):
        m = rx.search(html)
        if m:
            return m.group(1)
    return None


def csrf_token(client, path="/login"):
    """GET a page and return its CSRF token (None when the page has none)."""
    r = client.get(path, follow_redirects=False)
    return find_csrf(r.text)


def with_csrf(client, data=None):
    d = dict(data or {})
    token = csrf_token(client)
    if token:
        d["csrf_token"] = token
    return d


def post(client, url, data=None, **kw):
    """Form POST carrying the CSRF token as the `csrf_token` field, no redirects."""
    kw.setdefault("follow_redirects", False)
    return client.post(url, data=with_csrf(client, data), **kw)


def post_files(client, url, files, data=None, **kw):
    """Multipart POST (uploads) carrying the CSRF token as a form field."""
    kw.setdefault("follow_redirects", False)
    return client.post(url, data=with_csrf(client, data), files=files, **kw)


def post_json(client, url, payload=None, content=None, **kw):
    """JSON POST carrying the CSRF token in the X-CSRF-Token header."""
    kw.setdefault("follow_redirects", False)
    headers = dict(kw.pop("headers", None) or {})
    token = csrf_token(client)
    if token:
        headers["X-CSRF-Token"] = token
    if content is not None:
        headers.setdefault("Content-Type", "application/json")
        return client.post(url, content=content, headers=headers, **kw)
    return client.post(url, json=payload, headers=headers, **kw)


def login(client, username, password):
    return post(client, "/login", {"username": username, "password": password})


def location_id(response):
    """Numeric id at the end of a 303 Location header (e.g. /playlists/12)."""
    assert response.status_code == 303, f"{response.status_code} {response.text[:300]}"
    return int(response.headers["location"].rstrip("/").rsplit("/", 1)[-1])


# ---------------------------------------------------------------------------
# Direct DB access (the tests own the data dir; see conftest.py)
# ---------------------------------------------------------------------------

def db_path() -> Path:
    return Path(os.environ["PIPLAYER_DATA_DIR"]) / "cms.db"


def query(sql, params=()):
    conn = sqlite3.connect(db_path())
    conn.row_factory = sqlite3.Row
    try:
        return [dict(r) for r in conn.execute(sql, params).fetchall()]
    finally:
        conn.close()


def one(sql, params=()):
    rows = query(sql, params)
    assert len(rows) == 1, f"expected exactly one row for {sql!r} {params!r}, got {len(rows)}"
    return rows[0]


def execute(sql, params=()):
    conn = sqlite3.connect(db_path())
    try:
        conn.execute("PRAGMA foreign_keys = ON")
        cur = conn.execute(sql, params)
        conn.commit()
        return cur.lastrowid
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Entity builders (all resolve ids from responses or the DB, never by guessing)
# ---------------------------------------------------------------------------

def upload(client, path, original_name=None, content_type=None):
    """Upload a file; returns the media row (dict) resolved by original_name."""
    path = Path(path)
    original_name = original_name or path.name
    ext = Path(original_name).suffix.lower()
    content_type = content_type or ("video/mp4" if ext in (".mp4", ".mov", ".m4v") else "image/png")
    with open(path, "rb") as f:
        r = post_files(client, "/library/upload", {"file": (original_name, f, content_type)})
    assert r.status_code == 303, f"upload {original_name} failed: {r.status_code} {r.text[:300]}"
    return one("SELECT * FROM media WHERE original_name = ?", (original_name,))


def create_playlist(client, name):
    r = post(client, "/playlists", {"name": name})
    return location_id(r)


def add_item(client, playlist_id, media_id):
    r = post(client, f"/playlists/{playlist_id}/items", {"media_id": str(media_id)})
    assert r.status_code == 303, f"add item failed: {r.status_code} {r.text[:300]}"
    return one(
        "SELECT id FROM playlist_items WHERE playlist_id = ? AND media_id = ?",
        (playlist_id, media_id),
    )["id"]


def create_device(client, device_id, name=None):
    r = post(client, "/devices", {"device_id": device_id, "name": name or device_id})
    assert r.status_code == 303, f"create device failed: {r.status_code} {r.text[:300]}"
    return one("SELECT id, device_id, token FROM devices WHERE device_id = ?", (device_id,))


def assign_playlist(client, device_row_id, playlist_id):
    r = post(client, f"/devices/{device_row_id}/assign", {"playlist_id": str(playlist_id)})
    assert r.status_code == 303, f"assign failed: {r.status_code} {r.text[:300]}"
    return r


def create_group(client, name):
    r = post(client, "/groups", {"name": name})
    assert r.status_code == 303, f"create group failed: {r.status_code} {r.text[:300]}"
    return one("SELECT id FROM device_groups WHERE name = ?", (name,))["id"]


def create_user(admin_client, username, password, role="editor"):
    r = post(admin_client, "/users", {"username": username, "password": password, "role": role})
    assert r.status_code == 303, f"create user failed: {r.status_code} {r.text[:300]}"
    return one("SELECT id, username, role FROM users WHERE username = ?", (username,))


def bearer(token):
    return {"Authorization": f"Bearer {token}"}


def sync(client, device, **params):
    """GET /api/sync as the device (device = row from create_device)."""
    return client.get(f"/api/sync/{device['device_id']}", headers=bearer(device["token"]), params=params)


def assert_json_detail(response, status=None):
    if status is not None:
        assert response.status_code == status, f"{response.status_code} {response.text[:300]}"
    assert response.status_code < 500, f"server error: {response.status_code} {response.text[:300]}"
    body = response.json()
    assert isinstance(body, dict) and "detail" in body, response.text[:300]
    return body["detail"]
