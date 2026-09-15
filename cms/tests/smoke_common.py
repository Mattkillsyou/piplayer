"""Shared helpers for the end-to-end smoke scripts (test_v2.py, test_v3_v5.py).

These talk to a *running* CMS over HTTP with `requests` and read cms.db
directly (PIPLAYER_DATA_DIR must point at the server's data dir).
"""
import os
import re
import sqlite3
import sys

import requests

CSRF_INPUT = re.compile(r'<input[^>]*name="csrf_token"[^>]*value="([^"]+)"')
CSRF_INPUT_REV = re.compile(r'<input[^>]*value="([^"]+)"[^>]*name="csrf_token"')
CSRF_META = re.compile(r'<meta[^>]*name="csrf-token"[^>]*content="([^"]+)"')


def base_url(default_port: int) -> str:
    return os.environ.get("PIPLAYER_BASE_URL", f"http://127.0.0.1:{default_port}").rstrip("/")


def find_csrf(html: str):
    for rx in (CSRF_INPUT, CSRF_INPUT_REV, CSRF_META):
        m = rx.search(html)
        if m:
            return m.group(1)
    return None


class Client:
    """A requests.Session that follows the CMS CSRF contract.

    - login() sends the token as the `csrf_token` form field (what the browser does);
    - every other post() sends it as the `X-CSRF-Token` header (what the page's
      fetch/XHR calls do), which also works for multipart uploads and JSON bodies.
    Redirects are never followed so the 303s can be asserted.
    """

    def __init__(self, base: str):
        self.base = base
        self.s = requests.Session()
        self.csrf = None

    def refresh_csrf(self):
        r = self.s.get(self.base + "/login")
        self.csrf = find_csrf(r.text)
        return self.csrf

    def get(self, path, **kw):
        return self.s.get(self.base + path, **kw)

    def post(self, path, data=None, files=None, json=None, **kw):
        if self.csrf is None:
            self.refresh_csrf()
        headers = dict(kw.pop("headers", None) or {})
        if self.csrf:
            headers["X-CSRF-Token"] = self.csrf
        kw.setdefault("allow_redirects", False)
        return self.s.post(self.base + path, data=data, files=files, json=json, headers=headers, **kw)

    def login(self, username, password):
        self.refresh_csrf()
        data = {"username": username, "password": password}
        if self.csrf:
            data["csrf_token"] = self.csrf
        r = self.s.post(self.base + "/login", data=data, allow_redirects=False)
        self.refresh_csrf()  # the token may be rotated on login
        return r


def db_path() -> str:
    data_dir = os.environ.get("PIPLAYER_DATA_DIR")
    if not data_dir:
        sys.exit("PIPLAYER_DATA_DIR must point at the running CMS's data dir "
                 "(the smoke tests read cms.db directly). Use run_smoke_tests.py.")
    return os.path.join(data_dir, "cms.db")


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


def bearer(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def sync(base: str, device: dict, **params):
    """GET /api/sync as the device (device = row with device_id + token)."""
    return requests.get(f"{base}/api/sync/{device['device_id']}", headers=bearer(device["token"]), params=params)
