"""Shared plumbing for the Python e2e runners: start/stop `wrangler dev --local`, talk to
local D1/R2 through the wrangler CLI (so a check never depends on an admin page that
another package may still be building), and a CSRF-aware admin session.

Local secrets: the dev server gets throwaway SESSION_SECRET / SETUP_TOKEN via
`wrangler dev --var NAME:value` (same mechanism as `npm run dev`); no .dev.vars file is
written anywhere.
"""
import json
import os
import re
import subprocess
import time

import requests

CLOUD = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB_NAME = "piplayer-cloud-db"
BUCKET = "piplayer-cloud-media"
SESSION_SECRET = "e2e-session-secret"
SETUP_TOKEN = "e2e-setup-token"
CSRF_META = re.compile(r'<meta name="csrf-token" content="([^"]+)">')
NPX = "npx.cmd" if os.name == "nt" else "npx"


def wrangler(persist, *args, timeout=120):
    """Run a wrangler subcommand against the local state in `persist`; returns stdout."""
    cmd = [NPX, "wrangler", *args, "--local", "--persist-to", persist]
    r = subprocess.run(cmd, cwd=CLOUD, capture_output=True, text=True, encoding="utf-8", errors="replace",
                       timeout=timeout, stdin=subprocess.DEVNULL)
    if r.returncode != 0:
        raise RuntimeError("wrangler %s failed (rc=%d):\n%s\n%s" % (" ".join(args[:3]), r.returncode, r.stdout, r.stderr))
    return r.stdout


def d1(persist, sql):
    """Execute one statement on local D1 and return its rows (list of dicts)."""
    out = wrangler(persist, "d1", "execute", DB_NAME, "--json", "--command", sql)
    lines = out.splitlines()
    start = next(i for i, line in enumerate(lines) if line.startswith("["))
    data = json.loads("\n".join(lines[start:]))
    return data[0].get("results", [])


def d1_one(persist, sql):
    rows = d1(persist, sql)
    return rows[0] if rows else None


def sql_str(value):
    """Quote a Python string as a SQL literal (the CLI takes a whole statement, no binds)."""
    if value is None:
        return "NULL"
    return "'" + str(value).replace("'", "''") + "'"


def r2_put(persist, key, path, content_type):
    wrangler(persist, "r2", "object", "put", "%s/%s" % (BUCKET, key), "--file", path, "--content-type", content_type)


def r2_get(persist, key, out_path):
    """Download an object to out_path; returns False when it does not exist."""
    try:
        wrangler(persist, "r2", "object", "get", "%s/%s" % (BUCKET, key), "--file", out_path)
    except RuntimeError:
        return False
    return os.path.isfile(out_path)


def r2_delete(persist, key):
    wrangler(persist, "r2", "object", "delete", "%s/%s" % (BUCKET, key))


def migrate(persist):
    wrangler(persist, "d1", "migrations", "apply", DB_NAME)


def start_dev(port, persist, log_name="wrangler-dev.log"):
    """Start `wrangler dev --local` on `port`, wait for /api/health. Returns (proc, base, log)."""
    # --local-upstream: without it wrangler dev rewrites every request URL/Host to the
    # custom domain from wrangler.toml, so manifest media urls would point at production.
    cmd = [NPX, "wrangler", "dev", "--local", "--port", str(port), "--ip", "127.0.0.1",
           "--local-upstream", "127.0.0.1:%d" % port, "--upstream-protocol", "http",
           "--var", "SESSION_SECRET:" + SESSION_SECRET, "--var", "SETUP_TOKEN:" + SETUP_TOKEN,
           # plain http: without this the session cookie is Secure and requests drops it
           "--var", "PIPLAYER_INSECURE_COOKIES:1",
           "--persist-to", persist]
    log = open(os.path.join(persist, log_name), "w")
    proc = subprocess.Popen(cmd, cwd=CLOUD, stdout=log, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL)
    base = "http://127.0.0.1:%d" % port
    deadline = time.time() + 120
    while time.time() < deadline:
        try:
            if requests.get(base + "/api/health", timeout=2).status_code == 200:
                return proc, base, log
        except requests.RequestException:
            pass
        if proc.poll() is not None:
            break
        time.sleep(1)
    stop(proc)
    log.close()
    raise SystemExit("wrangler dev did not come up; see " + os.path.join(persist, log_name))


def stop(proc):
    """Kill the whole wrangler tree (wrangler respawns workerd if only the child dies)."""
    if proc.poll() is not None:
        return
    if os.name == "nt":
        subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    else:
        proc.terminate()
    try:
        proc.wait(10)
    except subprocess.TimeoutExpired:
        proc.kill()


class Admin:
    """requests.Session that carries the CSRF token on every POST."""

    def __init__(self, base):
        self.base = base
        self.s = requests.Session()

    def csrf(self, path="/login"):
        r = self.s.get(self.base + path, allow_redirects=False)
        assert r.status_code == 200, (path, r.status_code, r.text[:200])
        return CSRF_META.search(r.text).group(1)

    def get(self, path, **kw):
        return self.s.get(self.base + path, allow_redirects=False, **kw)

    def post(self, path, data=None, **kw):
        data = dict(data or {})
        data.setdefault("csrf_token", self.csrf())
        return self.s.post(self.base + path, data=data, allow_redirects=False, **kw)

    def setup_admin(self, username="admin", password="test1234"):
        token = self.csrf("/setup?token=" + SETUP_TOKEN)
        r = self.s.post(self.base + "/setup", allow_redirects=False,
                        data={"token": SETUP_TOKEN, "username": username, "password": password,
                              "password2": password, "csrf_token": token})
        assert (r.status_code, r.headers.get("location")) == (303, "/dashboard"), (r.status_code, r.text[:300])

    def login(self, username="admin", password="test1234"):
        r = self.s.post(self.base + "/login", allow_redirects=False,
                        data={"username": username, "password": password, "csrf_token": self.csrf()})
        assert (r.status_code, r.headers.get("location")) == (303, "/dashboard"), (r.status_code, r.text[:300])
