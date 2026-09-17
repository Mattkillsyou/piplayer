"""Auto camera tunnel e2e (feature G) against `wrangler dev --local` (local D1) and an
in-process fake of the Cloudflare API (this file, `FakeCloudflare`): the worker is pointed at
it with the CF_API_BASE var, so the whole path from the Create tunnel button / enrollment
through cloudflare.js to the manifest is exercised without an account, a real token or the
production zone. What the fake cannot prove (the API token's permissions, cloudflared
connecting, Access issuing the PIN) is listed in docs/automation.md section G.

Usage: python e2e/run_tunnel_e2e.py [--port 9120] [--persist-to DIR]
(the fake Cloudflare API listens on port + 1)

What it asserts, in order:
  1. Settings shows the tunnel panel as configured (the three CF_* vars are set) with no
     operator email yet; enrolling a device then succeeds WITHOUT a tunnel (audit
     device_tunnel_failed names the missing email list; nothing was created at Cloudflare).
  2. with an alert email set, Create tunnel provisions tunnel + ingress + proxied CNAME + Access
     app + policy in that order with the bearer, stores tunnel_id / tunnel_hostname, sets
     camera_live_url, redirects with the hostname banner, audits device_tunnel_created; the
     Devices page shows the badge, the Recreate button and never the token.
  3. Recreate tunnel is idempotent: no second tunnel / CNAME / app, ingress and policy rewritten.
  4. a second enrollment provisions at enrollment; a re-enrollment of a tunnelled device does not
     touch Cloudflare again.
  5. the device's own sync carries tunnel {token, hostname} (token fetched from the API, absent
     from D1); a wrong bearer is 401; a device without a tunnel gets tunnel: null; the API
     refusing the token call also yields null (the Pi keeps what it has).
  6. a Cloudflare refusal comes back as the tunnel_error banner and device_tunnel_failed, never a
     500; the steps before the refusal stay and the retry finishes the job.
"""
import argparse
import json
import os
import re
import shutil
import sys
import tempfile
import threading
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import requests

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import e2e_common as ec  # noqa: E402

CF_TOKEN = "e2e-cf-token"
ACCT = "acct-e2e"
ZONE = "zone-e2e"
ZONE_NAME = "photogen5000.com"
OPS = "ops@example.net, matt@example.net"
POLICY = {"name": "p5k operators", "decision": "allow",
          "include": [{"email": {"email": "ops@example.net"}}, {"email": {"email": "matt@example.net"}}]}


class FakeCloudflare:
    """In-memory tunnels / DNS / Access apps + policies behind the v4 envelope, on the routes
    cloud/src/cloudflare.js uses. `calls` records (method, path, query, body, auth); `refuse`
    = "METHOD /path" makes that call answer success:false once per assignment."""

    def __init__(self):
        self.tunnels, self.dns, self.apps, self.policies, self.ingress = [], [], [], {}, {}
        self.calls = []
        self.refuse = None
        self.lock = threading.Lock()
        self.seq = 0

    def _id(self, prefix):
        self.seq += 1
        return "%s-%d" % (prefix, self.seq)

    def handle(self, method, path, query, body, auth):
        with self.lock:
            self.calls.append({"method": method, "path": path, "query": query, "body": body, "auth": auth})
            if self.refuse == "%s %s" % (method, path):
                return 400, {"success": False, "errors": [{"code": 1000, "message": "refused by the e2e fake"}], "result": None}
            result = self._route(method, path, query, body)
            if result is None:
                return 404, {"success": False, "errors": [{"code": 7003, "message": "no route %s %s" % (method, path)}], "result": None}
            return 200, {"success": True, "errors": [], "result": result}

    def _route(self, method, path, query, body):
        a, z = "/accounts/%s" % ACCT, "/zones/%s" % ZONE
        m = re.match(a + r"/cfd_tunnel/([^/]+)/(configurations|token)$", path)
        if method == "GET" and path == a + "/cfd_tunnel":
            return [t for t in self.tunnels if t["name"] == query.get("name")]
        if method == "POST" and path == a + "/cfd_tunnel":
            self.tunnels.append(dict(body, id=self._id("tun")))
            return self.tunnels[-1]
        if m and m.group(2) == "configurations" and method == "PUT":
            self.ingress[m.group(1)] = body["config"]
            return body["config"]
        if m and m.group(2) == "token" and method == "GET":
            return "eyJ-e2e-token-for-" + m.group(1)
        if method == "GET" and path == z + "/dns_records":
            return [r for r in self.dns if r["name"] == query.get("name")]
        if method == "POST" and path == z + "/dns_records":
            self.dns.append(dict(body, id=self._id("dns")))
            return self.dns[-1]
        m = re.match(z + r"/dns_records/([^/]+)$", path)
        if m and method == "PUT":
            rec = next(r for r in self.dns if r["id"] == m.group(1))
            rec.update(body)
            return rec
        if method == "GET" and path == a + "/access/apps":
            return [x for x in self.apps if x["domain"] == query.get("domain")]
        if method == "POST" and path == a + "/access/apps":
            self.apps.append(dict(body, id=self._id("app")))
            return self.apps[-1]
        m = re.match(a + r"/access/apps/([^/]+)/policies(?:/([^/]+))?$", path)
        if m and method == "GET" and not m.group(2):
            return self.policies.get(m.group(1), [])
        if m and method == "POST" and not m.group(2):
            self.policies.setdefault(m.group(1), []).append(dict(body, id=self._id("pol")))
            return self.policies[m.group(1)][-1]
        if m and method == "PUT" and m.group(2):
            pol = next(p for p in self.policies[m.group(1)] if p["id"] == m.group(2))
            pol.update(body)
            return pol
        return None

    def shapes(self, start=0):
        return ["%s %s" % (c["method"], c["path"]) for c in self.calls[start:]]


def serve(fake, port):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"  # workerd reports "Network connection lost" on an HTTP/1.0 close

        def _any(self):
            u = urllib.parse.urlsplit(self.path)
            n = int(self.headers.get("content-length") or 0)
            raw = self.rfile.read(n) if n else b""
            body = json.loads(raw) if raw else None
            path = u.path.replace("/client/v4", "", 1)
            status, payload = fake.handle(self.command, path, dict(urllib.parse.parse_qsl(u.query)), body,
                                          self.headers.get("authorization"))
            data = json.dumps(payload).encode()
            self.send_response(status)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        do_GET = do_POST = do_PUT = do_DELETE = _any

        def log_message(self, *a):
            pass

    class Quiet(ThreadingHTTPServer):
        def handle_error(self, request, client_address):  # workerd drops idle keep-alive sockets: not a failure
            pass

    srv = Quiet(("127.0.0.1", port), Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


def audit_rows(persist, action):
    return ec.d1(persist, "SELECT target_id, details FROM audit_log WHERE action = %s ORDER BY id" % ec.sql_str(action))


def dev_row(persist, device_id):
    return ec.d1_one(persist, "SELECT id, token, tunnel_id, tunnel_hostname, camera_live_url FROM devices WHERE device_id = %s" % ec.sql_str(device_id))


def enroll(base, key, device_id, name):
    r = requests.post(base + "/api/enroll", json={"key": key, "device_id": device_id, "name": name}, timeout=60)
    assert r.status_code == 200, (r.status_code, r.text[:300])
    return r.json()


def sync(base, device_id, token):
    return requests.get(base + "/api/sync/" + device_id, headers={"authorization": "Bearer " + token}, timeout=60)


def run(base, persist, fake):
    admin = ec.Admin(base)
    admin.setup_admin()  # username "admin": not an email, so no operator list until Email to is set

    # 1. configured, but nobody to allow yet: enrollment succeeds without a tunnel
    page = admin.get("/settings").text
    key = ec.d1_one(persist, "SELECT value FROM settings WHERE key = 'enrollment_key'")["value"]  # generated on first load
    assert "Camera tunnels (Cloudflare) <span class=\"badge badge-active\">configured</span>" in page, "tunnel panel configured"
    assert '<span class="badge badge-stale">none</span> set the alert email addresses' in page and "Devices with a tunnel: 0" in page
    a = enroll(base, key, "pi-a", "Lobby")
    row = dev_row(persist, "pi-a")
    assert row["tunnel_id"] is None and row["tunnel_hostname"] is None and row["camera_live_url"] is None, row
    failed = audit_rows(persist, "device_tunnel_failed")
    assert len(failed) == 1 and "no operator email known" in failed[0]["details"], failed
    assert fake.calls == [], "nothing was asked of Cloudflare without an operator list"
    assert 'class="small primary" title="Cloudflare Tunnel + DNS + Access app' in admin.get("/devices").text, "Create tunnel button rendered"
    print("1: configured panel; enrollment without an operator email succeeds tunnel-less, audited, no API call")

    # 2. Create tunnel
    r = admin.post("/settings/alerts", {"alert_offline_minutes": "10", "alert_repeat_minutes": "240", "alert_email": OPS, "alert_webhook_url": ""})
    assert r.status_code == 303, (r.status_code, r.text[:200])
    assert "<code>ops@example.net</code>, <code>matt@example.net</code>" in admin.get("/settings").text
    r = admin.post("/devices/%d/tunnel" % row["id"])
    assert (r.status_code, r.headers.get("location")) == (303, "/devices?tunnel=pi-a-cam.%s" % ZONE_NAME), (r.status_code, r.headers.get("location"))
    assert fake.shapes() == [
        "GET /accounts/%s/cfd_tunnel" % ACCT, "POST /accounts/%s/cfd_tunnel" % ACCT,
        "PUT /accounts/%s/cfd_tunnel/tun-1/configurations" % ACCT,
        "GET /zones/%s/dns_records" % ZONE, "POST /zones/%s/dns_records" % ZONE,
        "GET /accounts/%s/access/apps" % ACCT, "POST /accounts/%s/access/apps" % ACCT,
        "GET /accounts/%s/access/apps/app-3/policies" % ACCT, "POST /accounts/%s/access/apps/app-3/policies" % ACCT,
    ], fake.shapes()
    assert all(c["auth"] == "Bearer " + CF_TOKEN for c in fake.calls)
    assert fake.calls[1]["body"] == {"name": "p5k-pi-a", "config_src": "cloudflare"}
    assert fake.ingress["tun-1"] == {"ingress": [{"hostname": "pi-a-cam.photogen5000.com", "service": "http://127.0.0.1:5000"}, {"service": "http_status:404"}]}
    assert fake.dns[0] == {"id": "dns-2", "type": "CNAME", "name": "pi-a-cam.photogen5000.com", "content": "tun-1.cfargotunnel.com", "proxied": True, "ttl": 1}
    assert fake.apps[0] == {"id": "app-3", "name": "p5k-pi-a camera", "domain": "pi-a-cam.photogen5000.com", "type": "self_hosted", "session_duration": "24h"}
    assert fake.policies["app-3"] == [dict(POLICY, id="pol-4")]
    row = dev_row(persist, "pi-a")
    assert (row["tunnel_id"], row["tunnel_hostname"], row["camera_live_url"]) == ("tun-1", "pi-a-cam.photogen5000.com", "https://pi-a-cam.photogen5000.com/"), row
    created = audit_rows(persist, "device_tunnel_created")
    assert len(created) == 1 and '"tunnel_id": "tun-1"' in created[0]["details"] and '"emails": 2' in created[0]["details"], created
    page = admin.get(r.headers["location"]).text
    assert "Tunnel ready: https://pi-a-cam.photogen5000.com/" in page and "tunnel · pi-a-cam.photogen5000.com" in page
    assert ">Recreate tunnel</button>" in page and 'href="https://pi-a-cam.photogen5000.com/"' in page
    assert "eyJ-e2e-token" not in page, "the tunnel token is never on a page"
    print("2: Create tunnel provisioned tunnel / ingress / CNAME / Access app + policy, stored, live URL set, audited")

    # 3. idempotent recreate
    n = len(fake.calls)
    r = admin.post("/devices/%d/tunnel" % row["id"])
    assert r.status_code == 303 and r.headers["location"].endswith("tunnel=pi-a-cam.photogen5000.com"), (r.status_code, r.headers.get("location"))
    assert fake.shapes(n) == [
        "GET /accounts/%s/cfd_tunnel" % ACCT, "PUT /accounts/%s/cfd_tunnel/tun-1/configurations" % ACCT,
        "GET /zones/%s/dns_records" % ZONE, "GET /accounts/%s/access/apps" % ACCT,
        "GET /accounts/%s/access/apps/app-3/policies" % ACCT, "PUT /accounts/%s/access/apps/app-3/policies/pol-4" % ACCT,
    ], fake.shapes(n)
    assert len(fake.tunnels) == 1 and len(fake.dns) == 1 and len(fake.apps) == 1 and len(fake.policies["app-3"]) == 1
    assert dev_row(persist, "pi-a")["tunnel_id"] == "tun-1"
    print("3: Recreate tunnel reused every object (ingress + policy rewritten)")

    # 4. enrollment provisions; re-enrollment of a tunnelled device does not call again
    n = len(fake.calls)
    b = enroll(base, key, "pi-b", "Bar")
    row_b = dev_row(persist, "pi-b")
    assert (row_b["tunnel_id"], row_b["tunnel_hostname"], row_b["camera_live_url"]) == ("tun-5", "pi-b-cam.photogen5000.com", "https://pi-b-cam.photogen5000.com/"), row_b
    assert [t["name"] for t in fake.tunnels] == ["p5k-pi-a", "p5k-pi-b"]
    assert len(audit_rows(persist, "device_tunnel_created")) == 3
    n = len(fake.calls)
    assert enroll(base, key, "pi-b", "Bar 2")["token"] == b["token"]
    assert len(fake.calls) == n, "re-enrollment of a tunnelled device asks Cloudflare nothing"
    assert "Devices with a tunnel: 2" in admin.get("/settings").text
    print("4: enrollment provisions; re-enrollment leaves Cloudflare alone")

    # 5. manifest
    r = sync(base, "pi-a", a["token"])
    assert r.status_code == 200, (r.status_code, r.text[:300])
    assert r.json()["tunnel"] == {"token": "eyJ-e2e-token-for-tun-1", "hostname": "pi-a-cam.photogen5000.com"}, r.json().get("tunnel")
    assert fake.shapes()[-1] == "GET /accounts/%s/cfd_tunnel/tun-1/token" % ACCT
    assert sync(base, "pi-a", "not-the-token").status_code == 401
    assert sync(base, "pi-a", b["token"]).status_code in (401, 403), "another device's bearer never sees pi-a's token"
    assert ec.d1(persist, "SELECT COUNT(*) AS n FROM devices WHERE token LIKE '%eyJ-e2e%'")[0]["n"] == 0
    ec.d1(persist, "INSERT INTO devices (device_id, name, token) VALUES ('pi-c', 'Plain', 'tok-c')")
    r = sync(base, "pi-c", "tok-c")
    assert r.status_code == 200 and "tunnel" in r.json() and r.json()["tunnel"] is None, r.json().get("tunnel", "missing")
    fake.refuse = "GET /accounts/%s/cfd_tunnel/tun-1/token" % ACCT
    r = sync(base, "pi-a", a["token"])
    assert r.status_code == 200 and r.json()["tunnel"] is None, "token fetch refused -> null, sync still 200"
    fake.refuse = None
    print("5: the device's own sync carries {token, hostname}; wrong bearer 401; no tunnel / API refusal -> null")

    # 6. a refusal mid-provision: banner + audit, the retry finishes
    ec.d1(persist, "INSERT INTO devices (device_id, name, token) VALUES ('pi-d', 'Deck', 'tok-d')")
    row_d = dev_row(persist, "pi-d")
    fake.refuse = "POST /zones/%s/dns_records" % ZONE
    r = admin.post("/devices/%d/tunnel" % row_d["id"])
    assert r.status_code == 303 and r.headers["location"].startswith("/devices?tunnel_error="), (r.status_code, r.headers.get("location"))
    msg = urllib.parse.unquote(r.headers["location"])
    assert "Cloudflare API POST /zones/.../dns_records: refused by the e2e fake" in msg, msg
    assert ZONE not in msg and ACCT not in msg, msg
    assert "Tunnel creation failed: Cloudflare API POST" in admin.get(r.headers["location"]).text
    assert dev_row(persist, "pi-d")["tunnel_id"] is None
    failed = audit_rows(persist, "device_tunnel_failed")
    assert len(failed) == 2 and "refused by the e2e fake" in failed[-1]["details"], failed
    assert [t["name"] for t in fake.tunnels][-1] == "p5k-pi-d", "the tunnel made before the refusal stays"
    fake.refuse = None
    n = len(fake.calls)
    r = admin.post("/devices/%d/tunnel" % row_d["id"])
    assert r.status_code == 303 and r.headers["location"].endswith("tunnel=pi-d-cam.photogen5000.com"), (r.status_code, r.headers.get("location"))
    assert "POST /accounts/%s/cfd_tunnel" % ACCT not in fake.shapes(n), "the retry reused the tunnel"
    assert [t["name"] for t in fake.tunnels].count("p5k-pi-d") == 1
    assert dev_row(persist, "pi-d")["tunnel_hostname"] == "pi-d-cam.photogen5000.com"
    print("6: a Cloudflare refusal is a banner + device_tunnel_failed; the retry finishes with the objects already made")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=9120)
    ap.add_argument("--persist-to", default=None)
    args = ap.parse_args()
    persist = args.persist_to or tempfile.mkdtemp(prefix="piplayer-tunnel-e2e-")
    os.makedirs(persist, exist_ok=True)
    shutil.rmtree(os.path.join(persist, "v3"), ignore_errors=True)  # fresh D1: the assertions count rows
    ec.migrate(persist)
    fake = FakeCloudflare()
    srv = serve(fake, args.port + 1)
    proc, base, log = ec.start_dev(args.port, persist, extra_args=(
        "--var", "CF_API_TOKEN:" + CF_TOKEN, "--var", "CF_ACCOUNT_ID:" + ACCT, "--var", "CF_ZONE_ID:" + ZONE,
        "--var", "CF_API_BASE:http://127.0.0.1:%d/client/v4" % (args.port + 1)))
    try:
        run(base, persist, fake)
    finally:
        ec.stop(proc)
        log.close()
        srv.shutdown()
    print("tunnel e2e OK")


if __name__ == "__main__":
    main()
