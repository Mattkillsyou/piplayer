"""Operator API token e2e (feature B): the same flow the flasher runs, against
`wrangler dev --local` (local D1), every side effect checked from the outside.

Usage: python e2e/run_operator_e2e.py [--port 8789] [--persist-to DIR]

What it asserts, in order:
  1. admin created through /setup; POST /settings/tokens shows the plain p5k_ token once and
     D1 holds only its SHA-256 hash (never the plaintext).
  2. GET /api/operator/enrollment with that bearer -> 200 {console_url, enrollment_key (the
     settings row), groups, playlists, timezone, wyze_configured:false}; no header, a
     malformed header and an unknown token -> 401 JSON; last_used_at set; audit rows
     api_token_created + api_token_used; a second call within the hour adds no audit row.
  3. Users page: an editor's token issued through POST /users/<id>/tokens works; a viewer
     cannot hold one (400); POST /users/<id>/tokens/<token_id>/revoke -> 303 and the
     revoked token gets 401; audit api_token_revoked carries the username.
"""
import argparse
import hashlib
import os
import re
import shutil
import sys
import tempfile

import requests

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import e2e_common as ec  # noqa: E402

NEW_TOKEN = re.compile(r'id="new-api-token" value="([^"]+)"')
ENROLL = "/api/operator/enrollment"


def create_token(admin, path, name):
    r = admin.post(path, {"name": name})
    assert r.status_code == 200, (path, r.status_code, r.text[:300])
    m = NEW_TOKEN.search(r.text)
    assert m, "no shown-once token block on " + path
    token = m.group(1)
    assert token.startswith("p5k_") and len(token) == 36, token
    return token


def enrollment(base, token=None, headers=None):
    h = dict(headers or {})
    if token:
        h["Authorization"] = "Bearer " + token
    return requests.get(base + ENROLL, headers=h, timeout=30)


def audit_count(persist, action):
    return ec.d1_one(persist, "SELECT COUNT(*) AS n FROM audit_log WHERE action = %s" % ec.sql_str(action))["n"]


def run(base, persist):
    admin = ec.Admin(base)
    admin.setup_admin()
    token = create_token(admin, "/settings/tokens", "e2e laptop")
    row = ec.d1_one(persist, "SELECT id, user_id, name, token_hash, last_used_at FROM api_tokens")
    assert row["token_hash"] == hashlib.sha256(token.encode()).hexdigest(), "stored hash is not sha256(token)"
    assert token not in str(row) and row["last_used_at"] is None, row
    assert ec.d1_one(persist, "SELECT COUNT(*) AS n FROM api_tokens WHERE token_hash = %s" % ec.sql_str(token))["n"] == 0
    assert audit_count(persist, "api_token_created") == 1
    print("1: token shown once; D1 holds only the hash")

    # settings page lists it without the secret
    r = admin.get("/settings")
    assert "e2e laptop" in r.text and token not in r.text, "settings page leaks or lacks the token"

    for name, kw in (("no header", {}), ("not bearer", {"headers": {"Authorization": "Basic abc"}}),
                     ("unknown token", {"token": "p5k_" + "A" * 32}), ("device-style bearer", {"headers": {"Authorization": "Bearer nope"}})):
        r = enrollment(base, **kw)
        assert r.status_code == 401 and "detail" in r.json(), (name, r.status_code, r.text[:200])
    assert audit_count(persist, "api_token_used") == 0, "a rejected bearer must not audit api_token_used"

    r = enrollment(base, token)
    assert r.status_code == 200, (r.status_code, r.text[:300])
    body = r.json()
    key = ec.d1_one(persist, "SELECT value FROM settings WHERE key = 'enrollment_key'")["value"]
    assert body["enrollment_key"] == key and key, (body, key)
    assert body["console_url"].startswith("http://127.0.0.1:"), body["console_url"]
    assert body["wyze_configured"] is False, body
    assert body["groups"] == [] and body["playlists"] == [] and body["timezone"], body
    used = ec.d1_one(persist, "SELECT last_used_at FROM api_tokens WHERE id = %d" % row["id"])["last_used_at"]
    assert used, "last_used_at not set"
    assert audit_count(persist, "api_token_used") == 1
    a = ec.d1_one(persist, "SELECT username, target_id, details FROM audit_log WHERE action = 'api_token_used'")
    assert a["username"] == "admin" and str(a["target_id"]) == str(row["id"]) and "e2e laptop" in a["details"], a
    # a group and a playlist show up on the next fetch; the hourly throttle adds no audit row
    ec.d1(persist, "INSERT INTO device_groups (name) VALUES ('Lobby')")
    ec.d1(persist, "INSERT INTO playlists (name) VALUES ('Loop A')")
    body = enrollment(base, token).json()
    assert [g["name"] for g in body["groups"]] == ["Lobby"] and [p["name"] for p in body["playlists"]] == ["Loop A"], body
    assert audit_count(persist, "api_token_used") == 1, "api_token_used must be throttled to once per hour"
    print("2: bearer fetch returns the live key; 401s are JSON; last_used_at + throttled audit")

    # Users page: editor token works, viewer cannot hold one, revoke kills it
    for username, role in (("ed", "editor"), ("vi", "viewer")):
        r = admin.post("/users", {"username": username, "password": "Passw0rd!x", "role": role})
        assert r.status_code == 303, (username, r.status_code, r.text[:200])
    ids = {u["username"]: u["id"] for u in ec.d1(persist, "SELECT id, username FROM users")}
    r = admin.post("/users/%d/tokens" % ids["vi"], {"name": "nope"})
    assert r.status_code == 400 and "viewers cannot hold" in r.text, (r.status_code, r.text[:200])
    ed_token = create_token(admin, "/users/%d/tokens" % ids["ed"], "ed flasher")
    assert enrollment(base, ed_token).status_code == 200
    ed_row = ec.d1_one(persist, "SELECT id FROM api_tokens WHERE user_id = %d" % ids["ed"])
    r = admin.post("/users/%d/tokens/%d/revoke" % (ids["ed"], ed_row["id"]))
    assert (r.status_code, r.headers.get("location")) == (303, "/users?revoked=1"), (r.status_code, r.text[:200])
    assert enrollment(base, ed_token).status_code == 401, "revoked token still works"
    assert enrollment(base, token).status_code == 200, "revoking one token broke another"
    a = ec.d1_one(persist, "SELECT details FROM audit_log WHERE action = 'api_token_revoked'")
    assert a and "ed flasher" in a["details"] and '"ed"' in a["details"], a
    # wrong owner -> 404, nothing deleted
    r = admin.post("/users/%d/tokens/%d/revoke" % (ids["ed"], row["id"]))
    assert r.status_code == 404, (r.status_code, r.text[:200])
    assert ec.d1_one(persist, "SELECT COUNT(*) AS n FROM api_tokens")["n"] == 1
    print("3: Users page issues/revokes tokens; viewer 400; revoked token 401")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8789)
    ap.add_argument("--persist-to", default=None)
    args = ap.parse_args()
    persist = args.persist_to or tempfile.mkdtemp(prefix="piplayer-operator-e2e-")
    os.makedirs(persist, exist_ok=True)
    shutil.rmtree(os.path.join(persist, "v3"), ignore_errors=True)  # fresh D1: the assertions count rows
    ec.migrate(persist)
    proc, base, log = ec.start_dev(args.port, persist)
    try:
        run(base, persist)
    finally:
        ec.stop(proc)
        log.close()
    print("operator e2e OK")


if __name__ == "__main__":
    main()
