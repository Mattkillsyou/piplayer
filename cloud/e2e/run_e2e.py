"""Black-box e2e against `wrangler dev --local` (or any running PiPlayer Cloud with --base).

Usage: python e2e/run_e2e.py [--port 8787] [--persist-to DIR] [--base http://host:port]

Starts the worker with local D1/R2 (migrations applied first), waits for /api/health, runs
every check with `requests` and always kills the dev server. Nothing here asserts hard: each
check records PASS/FAIL rows, the table is printed at the end and the exit status is 1 when
anything failed. A 501 (module stub) is a FAIL that names the route, so the orchestrator can
see which package is still missing.

Expected codes come from the spec / cms/app/routes/web.py + api.py (contracts 8, 10, 14, 15):
  anonymous -> 303 /login (303 /login?expired=1 on unsafe methods: no live session)
  viewer on editor routes / editor on admin routes -> 403 {"detail": "requires <role> role"}
  malformed input -> 400, missing rows -> 404, conflicts -> 409, never 500.

Other packages may still append plain assert-style functions to CHECKS; they are wrapped.
"""
import argparse
import datetime as dt
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import traceback
import zlib

import requests
import urllib3

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)   # self-signed cert in the https phase

CLOUD = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SESSION_SECRET = "e2e-session-secret"
SETUP_TOKEN = "e2e-setup-token"
ADMIN, ADMIN_PW = "admin", "test1234"
CSRF_META = re.compile(r'<meta name="csrf-token" content="([^"]+)">')
CSRF_DETAIL = "CSRF token missing or invalid"
NOPE = 999999
XSS = "x');alert(1);//"
XSS_ESC = "x&#39;);alert(1);//"
MAX_SCREENSHOT_BYTES = 5 * 1024 * 1024
UNDELIVERABLE = "undeliverable: no result after 5 deliveries"
ROUTE_HOST = "projectors.photogen5000.com"   # routes[0].pattern in wrangler.toml


# ---------------------------------------------------------------------------
# Result recording
# ---------------------------------------------------------------------------

class Blocked(Exception):
    """A prerequisite (fixture, earlier route) is unavailable; the check is recorded as FAIL."""


class Suite:
    def __init__(self):
        self.rows = []          # (ok, name, detail)
        self.not_implemented = set()

    def rec(self, name, ok, detail=""):
        self.rows.append((bool(ok), name, detail))
        return bool(ok)

    def expect(self, name, r, code, detail_contains=None, location=None):
        """Status (int or set of ints) and optionally a JSON detail substring / Location header."""
        codes = code if isinstance(code, (set, tuple, list, frozenset)) else {code}
        if r.status_code == 501 and 501 not in codes:
            self.not_implemented.add("%s %s" % (r.request.method, r.request.path_url.split("?")[0]))
            return self.rec(name, False, "501 not implemented (package incomplete)")
        if r.status_code not in codes:
            return self.rec(name, False, "expected %s got %s %s" % (sorted(codes), r.status_code, r.text[:120].replace("\n", " ")))
        if detail_contains is not None:
            try:
                detail = r.json().get("detail", "")
            except ValueError:
                return self.rec(name, False, "expected JSON {detail} body, got %r" % r.text[:120])
            if detail_contains not in str(detail):
                return self.rec(name, False, "detail %r lacks %r" % (detail, detail_contains))
        if location is not None and r.headers.get("location") != location:
            return self.rec(name, False, "expected Location %s got %s" % (location, r.headers.get("location")))
        return self.rec(name, True)

    def print_table(self):
        width = max(len(n) for _, n, _ in self.rows) if self.rows else 10
        print()
        print("=" * (width + 8))
        for ok, name, detail in self.rows:
            print("%s  %-*s  %s" % ("PASS" if ok else "FAIL", width, name, detail))
        failed = [r for r in self.rows if not r[0]]
        print("=" * (width + 8))
        print("%d checks, %d passed, %d failed" % (len(self.rows), len(self.rows) - len(failed), len(failed)))
        if self.not_implemented:
            print("routes answering 501 (package incomplete):")
            for r in sorted(self.not_implemented):
                print("  " + r)
        return not failed


S = Suite()


# ---------------------------------------------------------------------------
# HTTP client
# ---------------------------------------------------------------------------

class Web:
    """requests.Session with the CSRF flow of contract 8 (form field for post(), header for
    post_json()/put()). Never follows redirects."""

    def __init__(self, base):
        self.base = base
        self.s = requests.Session()

    def get(self, path, **kw):
        kw.setdefault("allow_redirects", False)
        kw.setdefault("timeout", 30)
        return self.s.get(self.base + path, **kw)

    def head(self, path, **kw):
        kw.setdefault("allow_redirects", False)
        kw.setdefault("timeout", 30)
        return self.s.head(self.base + path, **kw)

    def csrf(self, path="/login"):
        r = self.get(path)
        m = CSRF_META.search(r.text)
        if not m:
            raise Blocked("no csrf meta on %s (%s)" % (path, r.status_code))
        return m.group(1)

    def raw_post(self, path, data=None, headers=None, **kw):
        kw.setdefault("allow_redirects", False)
        kw.setdefault("timeout", 60)
        return self.s.post(self.base + path, data=data, headers=headers, **kw)

    def post(self, path, data=None, **kw):
        d = dict(data or {})
        d["csrf_token"] = self.csrf()
        return self.raw_post(path, d, **kw)

    def post_json(self, path, payload=None, content=None, headers=None, **kw):
        h = {"X-CSRF-Token": self.csrf(), "Content-Type": "application/json"}
        h.update(headers or {})
        body = content if content is not None else json.dumps(payload)
        return self.raw_post(path, body, headers=h, **kw)

    def put(self, path, body, headers=None):
        h = {"X-CSRF-Token": self.csrf(), "Content-Type": "application/octet-stream"}
        h.update(headers or {})
        return self.s.put(self.base + path, data=body, headers=h, allow_redirects=False, timeout=120)

    def login(self, username, password):
        return self.post("/login", {"username": username, "password": password})


def esc(v):
    """HTML escape exactly like util.esc() in the worker (' -> &#39;)."""
    return str(v).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;").replace("'", "&#39;")


def bearer(token):
    return {"Authorization": "Bearer " + token}


def id_after(text, marker, pattern):
    """First `pattern` group-1 match after the first occurrence of `marker` in a page."""
    i = text.find(marker)
    if i < 0:
        return None
    m = re.compile(pattern).search(text, i)
    return m.group(1) if m else None


# ---------------------------------------------------------------------------
# Media helpers (Python side of the chunk protocol)
# ---------------------------------------------------------------------------

SAFE_NAME = re.compile(r"[^A-Za-z0-9._-]+")
MAX_FILENAME_LEN = 120


def final_media_name(sha, original, ext):
    """Port of web._final_media_name so the expected R2 key / manifest filename is known."""
    base = os.path.basename(original or "asset")
    safe = SAFE_NAME.sub("_", base).strip("._") or "asset"
    stem = safe[: -len(ext)] if ext and safe.lower().endswith(ext) else safe
    budget = MAX_FILENAME_LEN - 17 - len(ext)
    stem = stem[:budget].strip("._") or "asset"
    return "%s_%s%s" % (sha[:16], stem, ext)


def make_media(kind, tmpdir, seed=""):
    """Small real files via ffmpeg (a 2 s 320x240 mp4 or a 64x64 png); seed makes the bytes unique."""
    path = os.path.join(tmpdir, "e2e-%s-%s.%s" % (kind, seed or "x", kind))
    if kind == "mp4":
        src = "testsrc=duration=2:size=320x240:rate=10"
        cmd = ["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", src, "-pix_fmt", "yuv420p",
               "-metadata", "comment=" + seed, path]
    else:
        cmd = ["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=64x64", "-frames:v", "1", path]
    subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if kind == "png" and seed:
        # PNG: append a private chunk-free tail? No - keep it a valid PNG: seed goes into a tEXt chunk.
        with open(path, "rb") as f:
            data = f.read()
        text = b"Comment\x00" + seed.encode()
        import zlib
        chunk = len(text).to_bytes(4, "big") + b"tEXt" + text + zlib.crc32(b"tEXt" + text).to_bytes(4, "big")
        iend = data.rfind(b"IEND") - 4
        with open(path, "wb") as f:
            f.write(data[:iend] + chunk + data[iend:])
    return path


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def upload(web, path, original_name=None, media_type=None, duration=None, width=None, height=None):
    """Drive init -> part -> complete like public/upload.js. Returns the media dict or raises Blocked."""
    name = original_name or os.path.basename(path)
    ext = os.path.splitext(name)[1].lower()
    media_type = media_type or ("video" if ext in (".mp4", ".mov", ".m4v", ".mkv", ".webm") else "image")
    size = os.path.getsize(path)
    sha = sha256_file(path)
    if duration is None and media_type == "video":
        duration = 2.0
    if width is None:
        width, height = (320, 240) if media_type == "video" else (64, 64)
    r = web.post_json("/library/upload/init", {"name": name, "size": size, "sha256": sha, "media_type": media_type,
                                               "duration_seconds": duration, "width": width, "height": height})
    if r.status_code != 200:
        raise Blocked("upload init %s %s" % (r.status_code, r.text[:160]))
    init = r.json()
    part_size = int(init.get("part_size") or 8 * 1024 * 1024)
    with open(path, "rb") as f:
        n = 1
        while True:
            chunk = f.read(part_size)
            if not chunk:
                break
            rp = web.put("/library/upload/%s/part/%d" % (init["upload_id"], n), chunk)
            if rp.status_code != 200:
                raise Blocked("upload part %d: %s %s" % (n, rp.status_code, rp.text[:160]))
            n += 1
    rc = web.post_json("/library/upload/%s/complete" % init["upload_id"], {})
    if rc.status_code != 200:
        raise Blocked("upload complete %s %s" % (rc.status_code, rc.text[:160]))
    return {"id": int(rc.json()["media_id"]), "filename": final_media_name(sha, name, ext), "sha256": sha,
            "size_bytes": size, "media_type": media_type, "original_name": name, "duration_seconds": duration,
            "path": path}


def jpeg_bytes(n=2048, seed=b"e2e"):
    """Bytes that start with the JPEG magic (the CMS only checks FF D8 FF)."""
    body = hashlib.sha256(seed).digest()
    return (b"\xff\xd8\xff\xe0" + body * (n // len(body) + 1))[:n]


# ---------------------------------------------------------------------------
# Fixtures (all through HTTP; ids scraped from pages / Location headers)
# ---------------------------------------------------------------------------

class World:
    """Everything the checks share. Attributes are None when the route that creates them is
    unavailable; require() turns that into a Blocked FAIL for the dependent check."""

    def __init__(self, base, tmpdir):
        self.base = base
        self.tmpdir = tmpdir
        self.tok = os.urandom(3).hex()
        self.admin = None
        self.editor = self.viewer = None
        self.editor_name = "editor-" + self.tok
        self.viewer_name = "viewer-" + self.tok
        self.pid = None            # playlist id
        self.pname = "pl-" + self.tok
        self.gid = None            # group id
        self.gname = "grp-" + self.tok
        self.dev = None            # {"id", "device_id", "name", "token"}
        self.dev2 = None
        self.png = self.mp4 = None  # media dicts
        self.items = {}            # media id -> playlist item id
        self.errors = {}

    def require(self, *names):
        for n in names:
            if getattr(self, n) is None:
                raise Blocked("fixture %r unavailable: %s" % (n, self.errors.get(n, "not created")))
        return [getattr(self, n) for n in names]

    def anon(self):
        return Web(self.base)


def create_user(admin, username, password, role):
    r = admin.post("/users", {"username": username, "password": password, "role": role})
    if r.status_code != 303:
        raise Blocked("POST /users -> %s %s" % (r.status_code, r.text[:120]))
    page = admin.get("/users").text
    uid = id_after(page, esc(username), r"/users/(\d+)/")
    return int(uid) if uid else None


def create_device(admin, device_id, name):
    r = admin.post("/devices", {"device_id": device_id, "name": name})
    if r.status_code != 303:
        raise Blocked("POST /devices -> %s %s" % (r.status_code, r.text[:120]))
    page = admin.get("/devices").text
    marker = '<code class="small">%s</code>' % device_id
    if marker not in page:
        marker = device_id
    did = id_after(page, marker, r"/devices/(\d+)/")
    m = re.search(r"DEVICE_ID=%s\s*\\?\s*DEVICE_TOKEN=([A-Za-z0-9_\-]+)" % re.escape(device_id), page)
    if not did or not m:
        raise Blocked("cannot find device id/token for %s on /devices" % device_id)
    return {"id": int(did), "device_id": device_id, "name": name, "token": m.group(1)}


def create_playlist(admin, name):
    r = admin.post("/playlists", {"name": name})
    if r.status_code != 303 or "/playlists/" not in r.headers.get("location", ""):
        raise Blocked("POST /playlists -> %s %s" % (r.status_code, r.text[:120]))
    return int(r.headers["location"].rstrip("/").rsplit("/", 1)[-1])


def create_group(admin, name):
    r = admin.post("/groups", {"name": name})
    if r.status_code != 303:
        raise Blocked("POST /groups -> %s %s" % (r.status_code, r.text[:120]))
    gid = id_after(admin.get("/groups").text, esc(name), r"/groups/(\d+)/")
    if not gid:
        raise Blocked("cannot find group id for %s" % name)
    return int(gid)


def add_item(admin, pid, media_id):
    r = admin.post("/playlists/%d/items" % pid, {"media_id": str(media_id)})
    if r.status_code != 303:
        raise Blocked("add item -> %s %s" % (r.status_code, r.text[:120]))
    page = admin.get("/playlists/%d" % pid).text
    ids = re.findall(r"/playlists/%d/items/(\d+)/(?:duration|delete)" % pid, page)
    return int(ids[-1]) if ids else None


def sync(dev, base, **params):
    return requests.get(base + "/api/sync/" + dev["device_id"], headers=bearer(dev["token"]), params=params, timeout=30)


def build_world(base, tmpdir):
    """Setup/login admin, then create users, media, playlist, group, devices. Each step is
    independent so one missing package does not hide the others."""
    w = World(base, tmpdir)
    a = Web(base)
    r = a.get("/")
    if r.status_code == 303 and r.headers.get("location") == "/setup":
        check_setup_flow(a)
    else:
        S.rec("setup: users already exist, logging in as admin", a.login(ADMIN, ADMIN_PW).status_code == 303)
    if a.get("/dashboard").status_code in (200, 501):
        w.admin = a
    else:
        w.errors["admin"] = "admin session not established"
        return w

    def step(attr, fn):
        try:
            setattr(w, attr, fn())
        except Blocked as e:
            w.errors[attr] = str(e)
        except Exception as e:  # noqa: BLE001 - keep going, report
            w.errors[attr] = "%s: %s" % (type(e).__name__, e)

    def user(name, pw, role):
        def go():
            create_user(a, name, pw, role)
            c = Web(base)
            if c.login(name, pw).status_code != 303:
                raise Blocked("login as %s failed" % name)
            return c
        return go

    step("editor", user(w.editor_name, "editor-pass1", "editor"))
    step("viewer", user(w.viewer_name, "viewer-pass1", "viewer"))
    step("pid", lambda: create_playlist(a, w.pname))
    step("gid", lambda: create_group(a, w.gname))
    step("dev", lambda: create_device(a, "dev-" + w.tok, "Dev " + w.tok))
    step("dev2", lambda: create_device(a, "dev2-" + w.tok, "Dev2 " + w.tok))
    step("png", lambda: upload(a, make_media("png", tmpdir, w.tok)))
    step("mp4", lambda: upload(a, make_media("mp4", tmpdir, w.tok)))
    if w.pid and w.png and w.mp4:
        try:
            w.items[w.png["id"]] = add_item(a, w.pid, w.png["id"])
            w.items[w.mp4["id"]] = add_item(a, w.pid, w.mp4["id"])
        except Blocked as e:
            w.errors["items"] = str(e)
    if w.pid and w.dev:
        r = a.post("/devices/%d/assign" % w.dev["id"], {"playlist_id": str(w.pid)})
        if r.status_code != 303:
            w.errors["assign"] = "%s %s" % (r.status_code, r.text[:100])
    for k, v in w.errors.items():
        S.rec("fixture %s" % k, False, v)
    return w


# ---------------------------------------------------------------------------
# Checks
# ---------------------------------------------------------------------------

def check_setup_flow(a):
    S.expect("setup: / redirects to /setup while users is empty", a.get("/"), 303, location="/setup")
    S.expect("setup: /login also redirects to /setup", a.get("/login"), 303, location="/setup")
    S.expect("setup: /setup without token is 403", a.get("/setup"), 403)
    S.expect("setup: /setup?token=wrong is 403", a.get("/setup?token=wrong"), 403)
    S.expect("setup: /api/health needs no setup", a.get("/api/health"), 200)
    token = a.csrf("/setup?token=" + SETUP_TOKEN)
    form = {"token": SETUP_TOKEN, "username": ADMIN, "password": ADMIN_PW, "password2": ADMIN_PW}
    S.expect("setup: POST without csrf is 403", a.raw_post("/setup", form), 403, CSRF_DETAIL)
    S.expect("setup: POST with wrong token is 403", a.raw_post("/setup", dict(form, token="nope", csrf_token=token)), 403)
    S.expect("setup: mismatched passwords is 400", a.raw_post("/setup", dict(form, password2="other123", csrf_token=token)), 400)
    S.expect("setup: short password is 400", a.raw_post("/setup", dict(form, password="short", password2="short", csrf_token=token)), 400)
    r = a.raw_post("/setup", dict(form, csrf_token=token))
    S.expect("setup: success creates admin and logs in (303 /dashboard)", r, 303, location="/dashboard")
    S.rec("setup: session cookie set", "piplayer_session" in a.s.cookies)
    S.expect("setup: /setup is 404 once a user exists", a.get("/setup?token=" + SETUP_TOKEN), 404)
    S.expect("setup: POST /setup is 404 once a user exists", a.post("/setup", form), 404)


def check_login_csrf(w):
    c = w.anon()
    S.expect("csrf: login without any session is 303 /login?expired=1",
             c.raw_post("/login", {"username": ADMIN, "password": ADMIN_PW}), 303, location="/login?expired=1")
    c.csrf()
    S.expect("csrf: login without token is 403", c.raw_post("/login", {"username": ADMIN, "password": ADMIN_PW}), 403, CSRF_DETAIL)
    S.expect("csrf: login with wrong token is 403",
             c.raw_post("/login", {"username": ADMIN, "password": ADMIN_PW, "csrf_token": "not-the-token"}), 403, CSRF_DETAIL)
    other = w.anon()
    S.expect("csrf: token from another session is 403",
             c.raw_post("/login", {"username": ADMIN, "password": ADMIN_PW, "csrf_token": other.csrf()}), 403, CSRF_DETAIL)
    S.rec("csrf: token is stable within a session", c.csrf() == c.csrf())
    S.expect("csrf: login with X-CSRF-Token header succeeds",
             c.raw_post("/login", {"username": ADMIN, "password": ADMIN_PW}, headers={"X-CSRF-Token": c.csrf()}), 303, location="/dashboard")
    c2 = w.anon()
    r = c2.login(ADMIN, ADMIN_PW)
    S.expect("csrf: login with form token succeeds", r, 303, location="/dashboard")
    S.expect("csrf: wrong password stays on the login page (200)", w.anon().login(ADMIN, "nope"), 200)
    S.expect("csrf: logout without token is 403", c2.raw_post("/logout"), 403, CSRF_DETAIL)
    S.expect("csrf: still logged in after the refused logout", c2.get("/dashboard"), {200, 501})
    # authenticated POSTs without / with foreign token write nothing
    admin = w.admin
    name = "csrf-" + w.tok
    S.expect("csrf: authenticated POST without token is 403", admin.raw_post("/playlists", {"name": name}), 403, CSRF_DETAIL)
    S.expect("csrf: authenticated POST with foreign token is 403",
             admin.raw_post("/playlists", {"name": name, "csrf_token": w.anon().csrf()}), 403, CSRF_DETAIL)
    S.expect("csrf: JSON POST without header is 403",
             admin.raw_post("/playlists/1/items/reorder", json.dumps({"order": []}), headers={"Content-Type": "application/json"}), 403, CSRF_DETAIL)
    S.expect("csrf: raw PUT without header is 403",
             admin.s.put(w.base + "/library/upload/x/part/1", data=b"x", allow_redirects=False), 403, CSRF_DETAIL)
    S.expect("csrf: multipart POST without token is 403",
             admin.s.post(w.base + "/devices", files={"device_id": (None, "x"), "name": (None, "y")}, allow_redirects=False), 403, CSRF_DETAIL)
    page = admin.get("/playlists").text
    if page and admin.get("/playlists").status_code == 200:
        S.rec("csrf: playlists page does not list the refused name", name not in page)
    # every rendered POST form carries the hidden input; every page has the meta tag
    pages = ["/dashboard", "/library", "/playlists", "/devices", "/groups", "/users", "/audit", "/settings"]
    if w.pid:
        pages.append("/playlists/%d" % w.pid)
    if w.dev:
        pages.append("/devices/%d/schedule" % w.dev["id"])
    form_rx = re.compile(r"<form\b[^>]*method=[\"']post[\"'][^>]*>(.*?)</form>", re.S | re.I)
    hidden_rx = re.compile(r'<input[^>]*name="csrf_token"[^>]*value="[^"]+"|<input[^>]*value="[^"]+"[^>]*name="csrf_token"')
    for p in pages:
        r = admin.get(p)
        if r.status_code != 200:
            S.expect("csrf: forms on %s" % p, r, 200)
            continue
        forms = form_rx.findall(r.text)
        ok = bool(forms) and all(hidden_rx.search(f) for f in forms) and bool(CSRF_META.search(r.text))
        S.rec("csrf: every POST form on %s has the hidden csrf_token + meta" % p, ok,
              "" if ok else "%d forms, meta=%s" % (len(forms), bool(CSRF_META.search(r.text))))
    login_html = w.anon().get("/login").text
    S.rec("csrf: login form has hidden csrf_token equal to the meta tag",
          bool(hidden_rx.search(login_html)) and CSRF_META.search(login_html) is not None)


def route_table(w):
    """(method, path, body, kind, {role: expected}) for every spec route. Ids are real where
    the allowed-role result is read-only (200), NOPE where a write would otherwise mutate."""
    pid = w.pid or NOPE
    did = w.dev["id"] if w.dev else NOPE
    A, V = 303, 403     # anonymous -> /login, forbidden
    T = []
    # read-only pages: every logged-in role (404 when the fixture behind the id is missing)
    for p in ("/dashboard", "/library", "/playlists", "/playlists/%d" % pid, "/devices",
              "/devices/%d/schedule" % did, "/groups", "/audit"):
        code = 404 if str(NOPE) in p else 200
        T.append(("GET", p, None, None, {"anon": A, "viewer": code, "editor": code, "admin": code}))
    T.append(("GET", "/devices/%d/screenshot" % NOPE, None, None, {"anon": A, "viewer": 404, "editor": 404, "admin": 404}))
    T.append(("GET", "/users", None, None, {"anon": A, "viewer": V, "editor": V, "admin": 200}))
    T.append(("GET", "/settings", None, None, {"anon": A, "viewer": V, "editor": V, "admin": 200}))
    T.append(("GET", "/library/upload/%d" % NOPE, None, None, {"anon": A, "viewer": V, "editor": 404, "admin": 404}))
    # editor writes (non-mutating inputs: 400 malformed / 404 missing row)
    E = lambda code: {"anon": A, "viewer": V, "editor": code, "admin": code}  # noqa: E731
    T += [
        ("POST", "/library/upload/init", {"name": "x.exe", "size": 10, "sha256": "0" * 64, "media_type": "video",
                                          "duration_seconds": 1, "width": 1, "height": 1}, "json", E(400)),
        ("PUT", "/library/upload/%d/part/1" % NOPE, b"x", "raw", E(404)),
        ("POST", "/library/upload/%d/complete" % NOPE, {}, "json", E(404)),
        ("POST", "/library/upload/%d/abort" % NOPE, {}, "json", E(404)),
        ("POST", "/library/%d/delete" % NOPE, {}, "form", E(404)),
        ("POST", "/playlists", {"name": "  "}, "form", E(400)),
        ("POST", "/playlists/%d/items" % NOPE, {"media_id": "1"}, "form", E(404)),
        ("POST", "/playlists/%d/items/reorder" % NOPE, {"order": []}, "json", E(404)),
        ("POST", "/playlists/%d/items/%d/duration" % (NOPE, NOPE), {"duration": "5"}, "form", E(404)),
        ("POST", "/playlists/%d/items/%d/delete" % (NOPE, NOPE), {}, "form", E(404)),
        ("POST", "/playlists/%d/rename" % NOPE, {"name": "x"}, "form", E(404)),
        ("POST", "/playlists/%d/delete" % NOPE, {}, "form", E(404)),
        ("POST", "/devices", {"device_id": "Bad_ID!", "name": "x"}, "form", E(400)),
        ("POST", "/devices/%d/assign" % NOPE, {"playlist_id": ""}, "form", E(404)),
        ("POST", "/devices/%d/group" % NOPE, {"group_id": ""}, "form", E(404)),
        ("POST", "/devices/%d/regen-token" % NOPE, {}, "form", E(404)),
        ("POST", "/devices/%d/delete" % NOPE, {}, "form", E(404)),
        ("POST", "/devices/%d/command" % NOPE, {"command": "reboot"}, "form", E(404)),
        ("POST", "/devices/%d/schedule" % NOPE, {"name": "r", "playlist_id": str(pid), "priority": "1"}, "form", E(404)),
        ("POST", "/devices/%d/schedule/%d/delete" % (NOPE, NOPE), {}, "form", E(404)),
        ("POST", "/groups", {"name": " "}, "form", E(400)),
        ("POST", "/groups/%d/assign" % NOPE, {"playlist_id": ""}, "form", E(404)),
        ("POST", "/groups/%d/delete" % NOPE, {}, "form", E(404)),
    ]
    # admin writes
    AD = lambda code: {"anon": A, "viewer": V, "editor": V, "admin": code}  # noqa: E731
    T += [
        ("POST", "/users", {"username": "u-" + w.tok, "password": "short", "role": "viewer"}, "form", AD(400)),
        ("POST", "/users/%d/role" % NOPE, {"role": "viewer"}, "form", AD(404)),
        ("POST", "/users/%d/password" % NOPE, {"password": "pw123456"}, "form", AD(404)),
        ("POST", "/users/%d/email" % NOPE, {"email": "nope@example.com"}, "form", AD(404)),
        ("POST", "/users/%d/delete" % NOPE, {}, "form", AD(404)),
        ("POST", "/settings", {"timezone": "Not/AZone", "screenshot_interval": "60", "default_image_duration": "10", "camera_interval": "10"}, "form", AD(400)),
    ]
    # setup is gone for everyone once a user exists
    T.append(("GET", "/setup?token=" + SETUP_TOKEN, None, None, {"anon": 404, "viewer": 404, "editor": 404, "admin": 404}))
    T.append(("POST", "/setup", {"token": SETUP_TOKEN, "username": "x", "password": "pw123456", "password2": "pw123456"}, "form",
              {"anon": 404, "viewer": 404, "editor": 404, "admin": 404}))
    T.append(("GET", "/", None, None, {"anon": 303, "viewer": 303, "editor": 303, "admin": 303}))
    return T


def send(client, method, path, body, kind):
    if method == "GET":
        return client.get(path)
    if kind == "json":
        return client.post_json(path, body)
    if kind == "raw":
        return client.put(path, body)
    return client.post(path, body)


def check_authz_matrix(w):
    """Every route x {anon, viewer, editor, admin}; one table row per route."""
    clients = {"anon": w.anon(), "viewer": w.viewer, "editor": w.editor, "admin": w.admin}
    for method, path, body, kind, expected in route_table(w):
        results, fails = [], []
        for role in ("anon", "viewer", "editor", "admin"):
            c = clients[role]
            if c is None:
                results.append("%s=?(no %s session)" % (role, role))
                fails.append(role)
                continue
            try:
                r = send(c, method, path, body, kind)
            except Blocked as e:
                results.append("%s=blocked(%s)" % (role, e))
                fails.append(role)
                continue
            want = expected[role]
            ok = r.status_code == want
            if ok and want == 303 and role == "anon" and r.headers.get("location") != ("/login" if method == "GET" else "/login?expired=1"):
                ok = False
            if ok and want == 303 and path == "/" and role != "anon" and r.headers.get("location") != "/dashboard":
                ok = False
            if r.status_code == 501:
                S.not_implemented.add("%s %s" % (method, path.split("?")[0]))
            results.append("%s=%s%s" % (role, r.status_code, "" if ok else "(want %s)" % want))
            if not ok:
                fails.append(role)
        S.rec("authz %-4s %-45s" % (method, path), not fails, " ".join(results))


def check_validation(w):
    """Contract 10 sweep on the routes that take these inputs (400 / 404 / 409, never 500)."""
    a = w.admin
    pid, dev = w.pid, w.dev
    if pid and dev:
        base = "/devices/%d/schedule" % dev["id"]
        def sched(**over):
            d = {"name": "Rule", "playlist_id": str(pid), "priority": "10"}
            d.update(over)
            return a.post(base, d)
        for v in ("25:99", "24:00", "12:60", "7", "0800", "8am", "07:00:00", "junk", "1:5"):
            S.expect("validate: schedule start_time=%r is 400" % v, sched(start_time=v), 400)
            S.expect("validate: schedule end_time=%r is 400" % v, sched(end_time=v), 400)
        S.expect("validate: schedule start == end is 400", sched(start_time="09:00", end_time="09:00"), 400, "start and end must differ")
        for f, v in (("start_date", "2026-13-01"), ("start_date", "01/02/2026"), ("start_date", "2026-1-5"),
                     ("end_date", "junk"), ("end_date", "2026-02-30")):
            S.expect("validate: schedule %s=%r is 400" % (f, v), sched(**{f: v}), 400)
        S.expect("validate: schedule end_date before start_date is 400", sched(start_date="2026-03-02", end_date="2026-03-01"), 400)
        for v in ("-1", "1001", "99999", "abc"):
            S.expect("validate: schedule priority=%r is 400" % v, sched(priority=v), 400)
        for v in ("abc", "1.0", "1e3", ""):
            S.expect("validate: schedule playlist_id=%r is 400" % v, sched(playlist_id=v), 400)
        for v in ("abc", "7", "6x40 4"):
            S.expect("validate: schedule days_of_week=%r is 400" % v, sched(days_of_week=v), 400)
        S.expect("validate: schedule playlist_id missing row is 404", sched(playlist_id=str(NOPE)), 404)
        S.expect("validate: schedule for missing device is 404", a.post("/devices/%d/schedule" % NOPE, {"name": "r", "playlist_id": str(pid)}), 404)
        S.expect("validate: schedule page for missing device is 404", a.get("/devices/%d/schedule" % NOPE), 404)
        S.expect("validate: schedule rule delete missing is 404", a.post(base + "/%d/delete" % NOPE), 404)
        r = sched(name="norm-" + w.tok, start_time="7:05", end_time="18:30", days_of_week="531", start_date="2026-01-01", end_date="2026-12-31")
        if S.expect("validate: valid schedule (7:05-18:30, days 531) is 303", r, 303):
            page = a.get(base).text
            S.rec("validate: schedule times are normalised to 07:05 and days sorted", "07:05" in page and "18:30" in page,
                  "" if "07:05" in page else "07:05 not on the schedule page")
            sid = id_after(page, "norm-" + w.tok, r"/schedule/(\d+)/delete")
            if sid:
                a.post(base + "/%s/delete" % sid)
        S.expect("validate: wrap-midnight window (22:00-02:00) is accepted", sched(name="wrap-" + w.tok, start_time="22:00", end_time="02:00"), 303)
        page = a.get(base).text
        sid = id_after(page, "wrap-" + w.tok, r"/schedule/(\d+)/delete")
        if sid:
            S.expect("validate: schedule rule delete is 303", a.post(base + "/%s/delete" % sid), 303)
        # assign / group / command
        for bad in ("abc", "1.5", "1e3"):
            S.expect("validate: assign playlist_id=%r is 400" % bad, a.post("/devices/%d/assign" % dev["id"], {"playlist_id": bad}), 400)
        S.expect("validate: assign missing playlist is 404", a.post("/devices/%d/assign" % dev["id"], {"playlist_id": str(NOPE)}), 404)
        S.expect("validate: assign on missing device is 404", a.post("/devices/%d/assign" % NOPE, {"playlist_id": str(pid)}), 404)
        S.expect("validate: group_id=abc is 400", a.post("/devices/%d/group" % dev["id"], {"group_id": "abc"}), 400)
        S.expect("validate: missing group is 404", a.post("/devices/%d/group" % dev["id"], {"group_id": str(NOPE)}), 404)
        S.expect("validate: unknown command is 400", a.post("/devices/%d/command" % dev["id"], {"command": "rm-rf"}), 400)
        S.expect("validate: command for missing device is 404", a.post("/devices/%d/command" % NOPE, {"command": "reboot"}), 404)
        S.expect("validate: regen-token on missing device is 404", a.post("/devices/%d/regen-token" % NOPE), 404)
        S.expect("validate: delete missing device is 404", a.post("/devices/%d/delete" % NOPE), 404)
        # the device still syncs after all that
        S.expect("validate: device still syncs after rejected inputs", sync(dev, w.base), 200)
    else:
        S.rec("validate: schedule/assign sweep", False, "blocked: playlist or device fixture missing")
    if w.gid:
        S.expect("validate: group assign playlist_id=abc is 400", a.post("/groups/%d/assign" % w.gid, {"playlist_id": "abc"}), 400)
        S.expect("validate: group assign missing playlist is 404", a.post("/groups/%d/assign" % w.gid, {"playlist_id": str(NOPE)}), 404)
        S.expect("validate: group assign on missing group is 404", a.post("/groups/%d/assign" % NOPE, {"playlist_id": str(w.pid or 1)}), 404)
        S.expect("validate: delete missing group is 404", a.post("/groups/%d/delete" % NOPE), 404)
        r = a.post("/groups", {"name": w.gname})
        S.expect("validate: duplicate group name is 409 (friendly)", r, 409)
        friendly(r, "validate: duplicate group 409 detail has no sqlite text")
    if w.pid:
        r = a.post("/playlists", {"name": w.pname})
        S.expect("validate: duplicate playlist name is 409 (friendly)", r, 409)
        friendly(r, "validate: duplicate playlist 409 detail has no sqlite text")
        S.expect("validate: rename missing playlist is 404", a.post("/playlists/%d/rename" % NOPE, {"name": "x"}), 404)
        S.expect("validate: rename to blank is 400", a.post("/playlists/%d/rename" % w.pid, {"name": "  "}), 400)
        S.expect("validate: duration on missing item is 404", a.post("/playlists/%d/items/%d/duration" % (w.pid, NOPE), {"duration": "5"}), 404)
        S.expect("validate: delete missing item is 404", a.post("/playlists/%d/items/%d/delete" % (w.pid, NOPE)), 404)
        S.expect("validate: add item media_id=abc is 400", a.post("/playlists/%d/items" % w.pid, {"media_id": "abc"}), 400)
        S.expect("validate: add item media_id='' is 400", a.post("/playlists/%d/items" % w.pid, {"media_id": ""}), 400)
        S.expect("validate: add missing media is 404", a.post("/playlists/%d/items" % w.pid, {"media_id": str(NOPE)}), 404)
        for body in ("notjson", "[1, 2]", "null", '"str"', "42", ""):
            S.expect("validate: reorder body %r is 400" % body, a.post_json("/playlists/%d/items/reorder" % w.pid, content=body), 400)
        for payload in ({"order": "x"}, {"order": [1, "a"]}, {"nope": 1}):
            S.expect("validate: reorder shape %s is 400" % json.dumps(payload), a.post_json("/playlists/%d/items/reorder" % w.pid, payload), 400)
        S.expect("validate: reorder on missing playlist is 404", a.post_json("/playlists/%d/items/reorder" % NOPE, {"order": []}), 404)
        if w.png and w.mp4 and len(w.items) == 2:
            i_png, i_mp4 = w.items[w.png["id"]], w.items[w.mp4["id"]]
            S.expect("validate: add duplicate item is 409", a.post("/playlists/%d/items" % w.pid, {"media_id": str(w.png["id"])}), 409)
            S.expect("validate: reorder with a subset is 400", a.post_json("/playlists/%d/items/reorder" % w.pid, {"order": [i_png]}), 400)
            r = a.post_json("/playlists/%d/items/reorder" % w.pid, {"order": [i_mp4, i_png]})
            if S.expect("validate: reorder with exact items is 200 {ok}", r, 200):
                S.rec("validate: reorder returns {\"ok\": true}", r.json() == {"ok": True})
            S.expect("validate: reorder back is 200", a.post_json("/playlists/%d/items/reorder" % w.pid, {"order": [i_png, i_mp4]}), 200)
            for v in ("inf", "infinity", "+inf", "Infinity", "1e999", "nan", "-1", "0", "abc", "86401", "1e400"):
                S.expect("validate: duration override %r is 400" % v, a.post("/playlists/%d/items/%d/duration" % (w.pid, i_mp4), {"duration": v}), 400)
            for v in ("86400", "0.5", ""):
                S.expect("validate: duration override %r is 303" % v, a.post("/playlists/%d/items/%d/duration" % (w.pid, i_mp4), {"duration": v}), 303)
    # users
    S.expect("validate: user short password is 400", a.post("/users", {"username": "u1-" + w.tok, "password": "short", "role": "viewer"}), 400)
    S.expect("validate: user bad role is 400", a.post("/users", {"username": "u2-" + w.tok, "password": "pw123456", "role": "god"}), 400)
    S.expect("validate: user blank username is 400", a.post("/users", {"username": "   ", "password": "pw123456", "role": "viewer"}), 400)
    S.expect("validate: user 1025-byte password is 400", a.post("/users", {"username": "u3-" + w.tok, "password": "p" * 1025, "role": "viewer"}), 400)
    S.expect("validate: role on missing user is 404", a.post("/users/%d/role" % NOPE, {"role": "viewer"}), 404)
    S.expect("validate: password on missing user is 404", a.post("/users/%d/password" % NOPE, {"password": "pw123456"}), 404)
    S.expect("validate: delete missing user is 404", a.post("/users/%d/delete" % NOPE), 404)
    if w.viewer:
        r = a.post("/users", {"username": w.viewer_name, "password": "pw123456", "role": "viewer"})
        S.expect("validate: duplicate username is 409 (friendly)", r, 409)
        friendly(r, "validate: duplicate user 409 detail has no sqlite text")
    admin_id = id_after(a.get("/users").text, ">admin", r"/users/(\d+)/") if a.get("/users").status_code == 200 else None
    if admin_id:
        S.expect("validate: last admin cannot be demoted (400)", a.post("/users/%s/role" % admin_id, {"role": "viewer"}), 400)
        S.expect("validate: cannot delete yourself (400)", a.post("/users/%s/delete" % admin_id), 400)
    else:
        S.rec("validate: last-admin protections", False, "blocked: cannot read /users")
    # devices / groups / playlists creation
    S.expect("validate: device_id 'Bad_ID!' is 400", a.post("/devices", {"device_id": "Bad_ID!", "name": "x"}), 400)
    S.expect("validate: device blank name is 400", a.post("/devices", {"device_id": "ok-" + w.tok, "name": " "}), 400)
    if w.dev:
        r = a.post("/devices", {"device_id": w.dev["device_id"], "name": "again"})
        S.expect("validate: duplicate device_id is 409 (friendly)", r, 409)
        friendly(r, "validate: duplicate device 409 detail has no sqlite text")
    S.expect("validate: blank playlist name is 400", a.post("/playlists", {"name": "   "}), 400)
    S.expect("validate: blank group name is 400", a.post("/groups", {"name": ""}), 400)
    # path ids that are not integers
    for p in ("/playlists/abc", "/devices/abc/schedule"):
        S.expect("validate: non-integer path id %s is 400/404" % p, a.get(p), {400, 404})
    # uploads
    ok_body = {"name": "x.png", "size": 10, "sha256": "a" * 64, "media_type": "image", "duration_seconds": None, "width": 1, "height": 1}
    S.expect("validate: upload init unsupported extension is 400", a.post_json("/library/upload/init", dict(ok_body, name="x.exe")), 400)
    S.expect("validate: upload init bad sha256 is 400", a.post_json("/library/upload/init", dict(ok_body, sha256="zz")), 400)
    S.expect("validate: upload init size > max is 413/400", a.post_json("/library/upload/init", dict(ok_body, size=5 * 1024 ** 3 + 1)), {413, 400})
    S.expect("validate: upload init size 0 is 400", a.post_json("/library/upload/init", dict(ok_body, size=0)), 400)
    S.expect("validate: upload init non-object body is 400", a.post_json("/library/upload/init", content="[1]"), 400)
    S.expect("validate: upload status for unknown id is 404", a.get("/library/upload/%d" % NOPE), 404)
    S.expect("validate: upload part for unknown id is 404", a.put("/library/upload/%d/part/1" % NOPE, b"x"), 404)
    S.expect("validate: upload complete for unknown id is 404", a.post_json("/library/upload/%d/complete" % NOPE, {}), 404)
    S.expect("validate: upload abort for unknown id is 404", a.post_json("/library/upload/%d/abort" % NOPE, {}), 404)
    S.expect("validate: delete missing media is 404", a.post("/library/%d/delete" % NOPE), 404)
    if w.png:
        r = a.post_json("/library/upload/init", {"name": "dup-" + w.tok + ".png", "size": w.png["size_bytes"], "sha256": w.png["sha256"],
                                                 "media_type": "image", "duration_seconds": None, "width": 64, "height": 64})
        if S.expect("validate: duplicate sha256 at init is 409", r, 409):
            S.rec("validate: duplicate 409 names the existing file", w.png["original_name"] in r.json().get("detail", ""),
                  r.json().get("detail", ""))
            friendly(r, "validate: duplicate upload 409 detail has no sqlite text")
        long_name = ("n" * 300) + w.tok + ".png"
        try:
            m = upload(a, make_media("png", w.tmpdir, "long" + w.tok), original_name=long_name)
            S.rec("validate: long original filename is truncated to <= 120", len(m["filename"]) <= 120 and m["filename"].endswith(".png"))
            S.expect("validate: media delete is 303", a.post("/library/%d/delete" % m["id"]), 303)
            S.expect("validate: media delete again is 404", a.post("/library/%d/delete" % m["id"]), 404)
        except Blocked as e:
            S.rec("validate: long original filename upload", False, "blocked: %s" % e)
    # settings
    S.expect("validate: settings bad timezone is 400", a.post("/settings", {"timezone": "Not/AZone", "screenshot_interval": "60", "default_image_duration": "10", "camera_interval": "10"}), 400)
    S.expect("validate: settings screenshot_interval=abc is 400", a.post("/settings", {"timezone": "UTC", "screenshot_interval": "abc", "default_image_duration": "10", "camera_interval": "10"}), 400)
    S.expect("validate: settings default_image_duration=0 is 400", a.post("/settings", {"timezone": "UTC", "screenshot_interval": "60", "default_image_duration": "0", "camera_interval": "10"}), 400)
    S.expect("validate: settings camera_interval=abc is 400", a.post("/settings", {"timezone": "UTC", "screenshot_interval": "60", "default_image_duration": "10", "camera_interval": "abc"}), 400)
    S.expect("validate: settings camera_interval=4 is 400", a.post("/settings", {"timezone": "UTC", "screenshot_interval": "60", "default_image_duration": "10", "camera_interval": "4"}), 400)


def friendly(r, name):
    try:
        detail = r.json().get("detail", "")
    except ValueError:
        return S.rec(name, False, "no JSON detail")
    bad = [wd for wd in ("unique", "sqlite", "constraint", "integrityerror", "d1_error") if wd in str(detail).lower()]
    return S.rec(name, isinstance(detail, str) and detail and not bad, detail)


def check_xss(w):
    """Contract 9: names carrying the audit payload are escaped everywhere, never in inline JS."""
    a = w.admin
    created = []
    def make(label, fn):
        try:
            created.append((label, fn()))
        except Blocked as e:
            S.rec("xss: create %s with payload name" % label, False, "blocked: %s" % e)
    make("playlist", lambda: create_playlist(a, XSS + w.tok))
    make("device", lambda: create_device(a, "xss-" + w.tok, XSS + w.tok))
    make("group", lambda: create_group(a, XSS + w.tok))
    make("user", lambda: create_user(a, XSS + w.tok, "pw123456", "viewer"))
    make("media", lambda: upload(a, make_media("png", w.tmpdir, "xss" + w.tok), original_name=XSS + w.tok + ".png"))
    xss_pid = next((v for k, v in created if k == "playlist"), None)
    xss_dev = next((v for k, v in created if k == "device"), None)
    if xss_pid and xss_dev:
        r = a.post("/devices/%d/schedule" % xss_dev["id"], {"name": XSS + w.tok, "playlist_id": str(xss_pid), "priority": "1"})
        S.expect("xss: create schedule rule with payload name", r, 303)
    if xss_dev:
        S.expect("xss: sync with sync_error payload", sync(xss_dev, w.base, sync_error="<b>" + XSS + w.tok), 200)
    pages = ["/dashboard", "/library", "/playlists", "/devices", "/groups", "/users", "/audit"]
    if xss_pid:
        pages.append("/playlists/%d" % xss_pid)
    if xss_dev:
        pages.append("/devices/%d/schedule" % xss_dev["id"])
    confirm_rx = re.compile(r'data-confirm="([^"]*)"')
    for p in pages:
        r = a.get(p)
        if r.status_code != 200:
            S.expect("xss: page %s renders" % p, r, 200)
            continue
        t = r.text
        problems = []
        if "onsubmit" in t:
            problems.append("inline onsubmit")
        if "onchange=" in t:
            problems.append("inline onchange")
        if XSS in t:
            problems.append("raw payload")
        if "<b>" + XSS in t:
            problems.append("raw sync_error html")
        for m in re.finditer(r"alert\(1\)", t):
            if "x');" in t[max(0, m.start() - 40): m.start()]:
                problems.append("unescaped quote before alert(1)")
                break
        for script in re.findall(r"<script\b[^>]*>(.*?)</script>", t, re.S):
            if "alert(1)" in script:
                problems.append("payload inside <script>")
        for c in confirm_rx.findall(t):
            if any(ch in c for ch in "'<>\""):
                problems.append("data-confirm contains a raw quote/angle")
        S.rec("xss: %s escapes the payload (no inline JS)" % p, not problems, ", ".join(problems))
    for label, page, fragment in (("playlist", "/playlists", "Delete playlist " + XSS_ESC),
                                  ("device", "/devices", "Delete device " + XSS_ESC),
                                  ("group", "/groups", "Delete " + XSS_ESC),
                                  ("user", "/users", "Delete " + XSS_ESC),
                                  ("media", "/library", "Delete " + XSS_ESC)):
        if not any(k == label for k, _ in created):
            continue
        t = a.get(page).text
        confirms = [c for c in confirm_rx.findall(t) if "alert(1)" in c]
        S.rec("xss: %s data-confirm carries the escaped name" % label, any(fragment in c for c in confirms),
              "confirms: %s" % confirms[:2])
    if xss_dev:
        t = a.get("/devices/%d/schedule" % xss_dev["id"]).text
        S.rec("xss: schedule rule data-confirm carries the escaped name", "Delete rule " + XSS_ESC in t)
        S.rec("xss: devices page shows the escaped sync_error", "Sync problem: &lt;b&gt;" + XSS_ESC in a.get("/devices").text)
    # public/app.js owns the delegated listener
    app_js = a.get("/static/app.js").text
    S.rec("xss: /static/app.js has the delegated data-confirm listener", "dataset.confirm" in app_js and "preventDefault" in app_js)


def check_not_served(w):
    for p in ("/openapi.json", "/docs", "/redoc"):
        S.expect("404: %s (anonymous)" % p, w.anon().get(p), 404)
        S.expect("404: %s (admin)" % p, w.admin.get(p), 404)
    S.expect("404: unknown path is JSON 404", w.admin.get("/nope-" + w.tok), 404)
    r = w.admin.get("/nope-" + w.tok)
    try:
        S.rec("404: body is {\"detail\": ...}", "detail" in r.json())
    except ValueError:
        S.rec("404: body is {\"detail\": ...}", False, r.text[:80])
    r = w.admin.get("/static/style.css")
    S.rec("static: /static/style.css served as text/css", r.status_code == 200 and r.headers.get("content-type", "").startswith("text/css"))
    S.expect("static: /static/sortable.min.js served", w.admin.get("/static/sortable.min.js"), 200)
    S.expect("static: /static/upload.js served", w.admin.get("/static/upload.js"), 200)
    S.expect("static: /static/sha256.js served", w.admin.get("/static/sha256.js"), 200)
    S.expect("static: missing asset is 404", w.admin.get("/static/nope.css"), 404)


def check_device_api(w):
    base = w.base
    dev, dev2 = w.require("dev", "dev2")
    S.expect("api: sync without token is 401", requests.get(base + "/api/sync/" + dev["device_id"]), 401)
    S.expect("api: sync with bad token is 401", requests.get(base + "/api/sync/" + dev["device_id"], headers=bearer("nope")), 401)
    S.expect("api: sync with Basic auth is 401", requests.get(base + "/api/sync/" + dev["device_id"], headers={"Authorization": "Basic abc"}), 401)
    S.expect("api: token for another device_id is 403", requests.get(base + "/api/sync/" + dev2["device_id"], headers=bearer(dev["token"])), 403)
    S.expect("api: screenshot without token is 401", requests.post(base + "/api/screenshots/" + dev["device_id"], files={"file": ("s.jpg", jpeg_bytes())}), 401)
    S.expect("api: screenshot with other device's token is 403",
             requests.post(base + "/api/screenshots/" + dev["device_id"], headers=bearer(dev2["token"]), files={"file": ("s.jpg", jpeg_bytes())}), 403)
    S.expect("api: command result without token is 401", requests.post(base + "/api/commands/1/result", json={"result": "x"}), 401)
    S.expect("api: session cookie alone does not authenticate /api/sync", w.admin.get("/api/sync/" + dev["device_id"]), 401)
    # manifest: null playlist for an unassigned device
    r = sync(dev2, base, player_version="e2e-1.0", player_status="playing", current_position="3", current_filename="a.mp4")
    if S.expect("api: sync for a device with nothing assigned is 200", r, 200):
        m = r.json()
        S.rec("api: unassigned device gets playlist null", m.get("playlist") is None and m.get("device") == {"id": dev2["device_id"], "name": dev2["name"]},
              json.dumps(m)[:200])
        S.rec("api: manifest has commands [] and screenshot_interval_seconds",
              m.get("commands") == [] and isinstance(m.get("screenshot_interval_seconds"), int))
        st = m.get("server_time", "")
        try:
            parsed = dt.datetime.fromisoformat(st)
            S.rec("api: server_time is ISO with offset and within 60 s of now",
                  parsed.utcoffset() is not None and abs((parsed - dt.datetime.now(dt.timezone.utc)).total_seconds()) < 60, st)
        except ValueError:
            S.rec("api: server_time is ISO with offset", False, st)
        page = w.admin.get("/devices").text
        S.rec("api: devices page shows player_version/status/filename from the sync",
              "e2e-1.0" in page and "a.mp4" in page, "" if "e2e-1.0" in page else "player_version missing")
    # sync_error stored, capped at 200, shown; empty clears it
    long_err = "E" * 250 + w.tok
    sync(dev2, base, sync_error=long_err)
    page = w.admin.get("/devices").text
    S.rec("api: sync_error is stored capped at 200 chars and shown", ("Sync problem: " + "E" * 200) in page and w.tok + "E" not in page and ("E" * 201) not in page)
    sync(dev2, base, sync_error="")
    S.rec("api: empty sync_error clears the warning", "Sync problem: " + "E" * 200 not in w.admin.get("/devices").text)
    # golden manifest for the assigned device
    pid, png, mp4 = w.require("pid", "png", "mp4")
    if len(w.items) != 2:
        raise Blocked("playlist items missing")
    i_mp4 = w.items[mp4["id"]]
    S.expect("api: set duration override 7.5 on the video", w.admin.post("/playlists/%d/items/%d/duration" % (pid, i_mp4), {"duration": "7.5"}), 303)
    r = sync(dev, base)
    if not S.expect("api: sync for the assigned device is 200", r, 200):
        return
    m = r.json()
    pl = m.get("playlist") or {}
    S.rec("api: playlist block id/name/source", pl.get("id") == pid and pl.get("name") == w.pname and pl.get("source") == "device-default",
          json.dumps({k: pl.get(k) for k in ("id", "name", "source")}))
    items = pl.get("items") or []
    expected = [
        {"position": 0, "filename": png["filename"], "sha256": png["sha256"], "size_bytes": png["size_bytes"], "media_type": "image",
         "natural_duration_seconds": None, "effective_duration_seconds": 10.0},
        {"position": 1, "filename": mp4["filename"], "sha256": mp4["sha256"], "size_bytes": mp4["size_bytes"], "media_type": "video",
         "natural_duration_seconds": 2.0, "effective_duration_seconds": 7.5},
    ]
    got = [{k: it.get(k) for k in expected[0]} for it in items]
    S.rec("api: manifest items match (position, filename, sha256, size, type, durations)", got == expected,
          "" if got == expected else "got %s" % json.dumps(got)[:300])
    # wrangler dev rewrites request.url's host to the routes[] pattern (projectors.photogen5000.com),
    # so locally the origin is that domain rather than 127.0.0.1:port; both are the "request host".
    hosts = {w.base.split("://", 1)[1], ROUTE_HOST}
    S.rec("api: item urls are absolute <request origin>/api/media/<filename>",
          len(items) == 2 and all(re.match(r"^https?://(%s)/api/media/%s$" % ("|".join(map(re.escape, hosts)), re.escape(e["filename"])), it.get("url", ""))
                                  for it, e in zip(items, expected)),
          " ".join(it.get("url", "") for it in items))
    h = hashlib.sha256()
    h.update(("playlist:%d\n" % pid).encode())
    for e in expected:
        h.update(("%s:%s:%s:%s\n" % (e["position"], e["filename"], e["sha256"], e["effective_duration_seconds"])).encode())
    S.rec("api: playlist hash matches the Python formula (10.0 / 7.5 formatting)", pl.get("hash") == "sha256:" + h.hexdigest(),
          "got %s want sha256:%s" % (pl.get("hash"), h.hexdigest()))
    S.rec("api: updated_at present", bool(pl.get("updated_at")))
    # 'None' formatting for a video without override
    w.admin.post("/playlists/%d/items/%d/duration" % (pid, i_mp4), {"duration": ""})
    pl2 = sync(dev, base).json().get("playlist") or {}
    h2 = hashlib.sha256()
    h2.update(("playlist:%d\n" % pid).encode())
    h2.update(("0:%s:%s:10.0\n" % (png["filename"], png["sha256"])).encode())
    h2.update(("1:%s:%s:None\n" % (mp4["filename"], mp4["sha256"])).encode())
    S.rec("api: hash uses 'None' for a video without override", pl2.get("hash") == "sha256:" + h2.hexdigest(),
          "got %s" % pl2.get("hash"))
    w.admin.post("/playlists/%d/items/%d/duration" % (pid, i_mp4), {"duration": "7.5"})
    # group fallback resolution
    gid = w.require("gid")[0]
    if S.expect("api: group gets the playlist", w.admin.post("/groups/%d/assign" % gid, {"playlist_id": str(pid)}), 303) and \
            S.expect("api: dev2 joins the group", w.admin.post("/devices/%d/group" % dev2["id"], {"group_id": str(gid)}), 303):
        pl3 = sync(dev2, base).json().get("playlist") or {}
        S.rec("api: group playlist resolves as source group-default", pl3.get("id") == pid and pl3.get("source") == "group-default",
              json.dumps({k: pl3.get(k) for k in ("id", "source")}))


def check_media(w):
    base = w.base
    dev, dev2, png, mp4 = w.require("dev", "dev2", "png", "mp4")
    a = w.admin
    fn = mp4["filename"]
    with open(mp4["path"], "rb") as f:
        full = f.read()
    S.expect("media: anonymous is 401", requests.get(base + "/api/media/" + fn), 401)
    S.expect("media: bad bearer is 401", requests.get(base + "/api/media/" + fn, headers=bearer("nope")), 401)
    S.expect("media: unsafe filename is 400", a.get("/api/media/..%2Fcms.db"), 400)
    S.expect("media: filename with space is 400", a.get("/api/media/a%20b.mp4"), 400)
    S.expect("media: missing file is 404", a.get("/api/media/does-not-exist-%s.mp4" % w.tok), 404)
    r = a.get("/api/media/" + fn)
    if S.expect("media: logged-in user gets 200", r, 200):
        S.rec("media: body matches the uploaded bytes", r.content == full, "%d vs %d bytes" % (len(r.content), len(full)))
        S.rec("media: Content-Type video/mp4", r.headers.get("content-type", "").startswith("video/mp4"), r.headers.get("content-type"))
        S.rec("media: Accept-Ranges: bytes", r.headers.get("accept-ranges") == "bytes")
        S.rec("media: ETag present", bool(r.headers.get("etag")))
        S.rec("media: Content-Length correct", r.headers.get("content-length") == str(len(full)), r.headers.get("content-length"))
        S.rec("media: X-Content-Type-Options: nosniff", r.headers.get("x-content-type-options") == "nosniff")
    if w.viewer:
        S.expect("media: viewer session can fetch media", w.viewer.get("/api/media/" + fn), 200)
    r = a.head("/api/media/" + fn)
    S.rec("media: HEAD is 200 with Content-Length and empty body",
          r.status_code == 200 and r.headers.get("content-length") == str(len(full)) and not r.content, "%s %s" % (r.status_code, r.headers.get("content-length")))
    r = a.get("/api/media/" + fn, headers={"Range": "bytes=0-9"})
    if S.expect("media: Range bytes=0-9 is 206", r, 206):
        S.rec("media: 206 body is the first 10 bytes", r.content == full[:10])
        S.rec("media: Content-Range bytes 0-9/total", r.headers.get("content-range") == "bytes 0-9/%d" % len(full), r.headers.get("content-range"))
        S.rec("media: 206 Content-Length is 10", r.headers.get("content-length") == "10", r.headers.get("content-length"))
    r = requests.get(base + "/api/media/" + fn, headers=dict(bearer(dev["token"]), Range="bytes=%d-" % (len(full) - 100)))
    if S.expect("media: device resume Range bytes=N- is 206", r, 206):
        S.rec("media: resume body is the tail", r.content == full[-100:])
        S.rec("media: resume Content-Range", r.headers.get("content-range") == "bytes %d-%d/%d" % (len(full) - 100, len(full) - 1, len(full)),
              r.headers.get("content-range"))
    S.expect("media: unsatisfiable Range is 416", a.get("/api/media/" + fn, headers={"Range": "bytes=%d-" % (len(full) + 10)}), 416)
    r = a.get("/api/media/" + fn, headers={"Range": "bytes=-50"})
    if S.expect("media: suffix Range bytes=-50 is 206", r, 206):
        S.rec("media: suffix body is the last 50 bytes", r.content == full[-50:])
    # scoping: dev has the playlist (png+mp4); dev2 currently resolves the same via the group; unassign to test
    S.expect("media: device in playlist may fetch", requests.get(base + "/api/media/" + fn, headers=bearer(dev["token"])), 200)
    S.expect("media: device in playlist may fetch the image", requests.get(base + "/api/media/" + png["filename"], headers=bearer(dev["token"])), 200)
    a.post("/devices/%d/group" % dev2["id"], {"group_id": ""})
    S.expect("media: device with no playlist is 403", requests.get(base + "/api/media/" + fn, headers=bearer(dev2["token"])), 403)
    try:
        other = upload(a, make_media("png", w.tmpdir, "other" + w.tok))
        S.expect("media: device may not fetch a file outside its playlist (403)",
                 requests.get(base + "/api/media/" + other["filename"], headers=bearer(dev["token"])), 403)
        # scoping follows the schedule resolver
        pid_b = create_playlist(a, "sched-b-" + w.tok)
        add_item(a, pid_b, other["id"])
        r = a.post("/devices/%d/schedule" % dev["id"], {"name": "always-b", "playlist_id": str(pid_b), "priority": "50"})
        if S.expect("media: schedule rule created", r, 303):
            m = sync(dev, base).json().get("playlist") or {}
            S.rec("media: scheduled playlist wins (source schedule:always-b)", m.get("id") == pid_b and m.get("source") == "schedule:always-b",
                  json.dumps({k: m.get(k) for k in ("id", "source")}))
            S.expect("media: file in the scheduled playlist is allowed", requests.get(base + "/api/media/" + other["filename"], headers=bearer(dev["token"])), 200)
            S.expect("media: file in the default playlist is now 403", requests.get(base + "/api/media/" + fn, headers=bearer(dev["token"])), 403)
            sid = id_after(a.get("/devices/%d/schedule" % dev["id"]).text, "always-b", r"/schedule/(\d+)/delete")
            if sid:
                a.post("/devices/%d/schedule/%s/delete" % (dev["id"], sid))
        a.post("/playlists/%d/delete" % pid_b)
        a.post("/library/%d/delete" % other["id"])
        S.expect("media: deleted media is 404", a.get("/api/media/" + other["filename"]), 404)
    except Blocked as e:
        S.rec("media: out-of-playlist scoping", False, "blocked: %s" % e)


def check_screenshots(w):
    base = w.base
    dev = w.require("dev")[0]
    url = base + "/api/screenshots/" + dev["device_id"]
    png = b"\x89PNG\r\n\x1a\n" + os.urandom(512)
    S.expect("screenshot: PNG bytes are rejected 400", requests.post(url, headers=bearer(dev["token"]), files={"file": ("s.jpg", png, "image/jpeg")}), 400)
    S.expect("screenshot: empty file is 400", requests.post(url, headers=bearer(dev["token"]), files={"file": ("s.jpg", b"", "image/jpeg")}), 400)
    # No file part at all is a 400; the field name itself is not checked (the CMS takes the
    # first file part whatever it is called), which the JPEG check further down covers.
    S.expect("screenshot: no file part is 400", requests.post(url, headers=bearer(dev["token"]), data={"file": "not a file"}, files={"note": (None, "x")}), 400)
    S.expect("screenshot: no screenshot yet is 404 on the admin route", w.admin.get("/devices/%d/screenshot" % dev["id"]), 404)
    big = jpeg_bytes(MAX_SCREENSHOT_BYTES + 1)
    S.expect("screenshot: > max bytes is 413", requests.post(url, headers=bearer(dev["token"]), files={"file": ("s.jpg", big, "image/jpeg")}, timeout=120), 413)
    jpg = jpeg_bytes(4096, seed=w.tok.encode())
    r = requests.post(url, headers=bearer(dev["token"]), files={"file": ("s.jpg", jpg, "image/jpeg")})
    if S.expect("screenshot: JPEG accepted", r, 200):
        S.rec("screenshot: response is {ok, size_bytes}", r.json() == {"ok": True, "size_bytes": len(jpg)}, r.text[:100])
    r = w.admin.get("/devices/%d/screenshot" % dev["id"])
    if S.expect("screenshot: admin can view it", r, 200):
        S.rec("screenshot: bytes round-trip", r.content == jpg)
        S.rec("screenshot: image/jpeg + nosniff + no-store", r.headers.get("content-type", "").startswith("image/jpeg")
              and r.headers.get("x-content-type-options") == "nosniff" and "no-store" in r.headers.get("cache-control", ""),
              "%s %s" % (r.headers.get("content-type"), r.headers.get("cache-control")))
    if w.viewer:
        S.expect("screenshot: viewer can view it", w.viewer.get("/devices/%d/screenshot" % dev["id"]), 200)
    S.expect("screenshot: anonymous is redirected", w.anon().get("/devices/%d/screenshot" % dev["id"]), 303, location="/login")
    page = w.admin.get("/devices").text
    S.rec("screenshot: devices page links the screenshot with its age", "/devices/%d/screenshot" % dev["id"] in page and "s ago" in page)
    # the device's own row: from its id up to the next .device-row card
    marker = '<span class="device-id"><code>%s</code>' % dev["device_id"]
    row = page.split(marker, 1)[1].split('<div class="device-row', 1)[0] if marker in page else ""
    S.rec("screenshot: fresh screenshot is not marked stale", bool(row) and "badge-stale" not in row)


def check_commands(w):
    base = w.base
    dev, dev2 = w.require("dev", "dev2")
    a = w.admin
    S.expect("commands: issue force-sync", a.post("/devices/%d/command" % dev["id"], {"command": "force-sync"}), 303)
    r = sync(dev, base)
    cmds = r.json().get("commands", []) if r.status_code == 200 else []
    if not S.rec("commands: delivered on sync with id/command/issued_at", any(c.get("command") == "force-sync" and "id" in c and "issued_at" in c for c in cmds), json.dumps(cmds)[:200]):
        return
    cid = [c for c in cmds if c["command"] == "force-sync"][-1]["id"]
    res_url = base + "/api/commands/%d/result" % cid
    for body in ("notjson", '["list"]', "null", '"str"', ""):
        S.expect("commands: result body %r is 400" % body, requests.post(res_url, data=body, headers=dict(bearer(dev["token"]), **{"Content-Type": "application/json"})), 400)
    S.expect("commands: result from another device is 403", requests.post(res_url, json={"result": "x"}, headers=bearer(dev2["token"])), 403)
    S.expect("commands: result for unknown command is 404", requests.post(base + "/api/commands/%d/result" % NOPE, json={"result": "x"}, headers=bearer(dev["token"])), 404)
    S.rec("commands: still pending after the rejected results", cid in [c["id"] for c in sync(dev, base).json().get("commands", [])])
    r = requests.post(res_url, json={"result": "R" * 1500}, headers=bearer(dev["token"]))
    if S.expect("commands: result accepted", r, 200):
        S.rec("commands: result response is {ok: true}", r.json() == {"ok": True})
    S.rec("commands: completed command is not delivered again", cid not in [c["id"] for c in sync(dev, base).json().get("commands", [])])
    page = a.get("/devices").text
    S.rec("commands: devices page shows the result truncated to 1000 chars", ("R" * 1000) in page and ("R" * 1001) not in page)
    # delivery cap
    S.expect("commands: issue reboot", a.post("/devices/%d/command" % dev["id"], {"command": "reboot"}), 303)
    seen = []
    for n in range(5):
        seen.append(any(c["command"] == "reboot" for c in sync(dev, base).json().get("commands", [])))
    S.rec("commands: reboot delivered on syncs 1-5", all(seen), str(seen))
    sixth = any(c["command"] == "reboot" for c in sync(dev, base).json().get("commands", []))
    S.rec("commands: not delivered on the 6th sync", not sixth)
    S.rec("commands: stays gone on the 7th sync", not any(c["command"] == "reboot" for c in sync(dev, base).json().get("commands", [])))
    page = a.get("/devices").text
    S.rec("commands: devices page shows '%s'" % UNDELIVERABLE, UNDELIVERABLE in page)
    S.rec("commands: devices page has the Recent commands <details>", "<details" in page and "reboot" in page)


def check_settings_timezone(w):
    a = w.admin
    dev = w.require("dev")[0]
    S.expect("settings: page renders", a.get("/settings"), 200)
    def set_tz(tz):
        return a.post("/settings", {"timezone": tz, "screenshot_interval": "60", "default_image_duration": "10", "camera_interval": "10"})
    S.expect("settings: set timezone Asia/Tokyo", set_tz("Asia/Tokyo"), 303)
    try:
        r = sync(dev, w.base)
        st = r.json().get("server_time", "")
        S.rec("settings: server_time carries +09:00 after the change", st.endswith("+09:00"), st)
        now_tokyo = dt.datetime.now(dt.timezone.utc) + dt.timedelta(hours=9)
        candidates = [(now_tokyo - dt.timedelta(minutes=k)).strftime("%Y-%m-%d %H:%M") for k in (0, 1)]
        page = a.get("/devices").text
        S.rec("settings: devices page renders last_seen in Asia/Tokyo wall time", any(c in page for c in candidates), " | ".join(candidates))
        S.rec("settings: devices page labels the zone", "GMT+9" in page or "JST" in page)
        sp = a.get("/devices/%d/schedule" % dev["id"]).text
        S.rec("settings: schedule page names the zone", re.search(r"Asia/Tokyo|GMT\+9|JST", sp) is not None)
        # schedule evaluation follows the site timezone: window built around 'now' in UTC-12
        S.expect("settings: set timezone Etc/GMT+12 (UTC-12)", set_tz("Etc/GMT+12"), 303)
        pid = w.require("pid")[0]
        utc_hour = dt.datetime.now(dt.timezone.utc).hour
        h_a = (utc_hour - 12) % 24
        start, end = "%02d:00" % h_a, "%02d:00" % ((h_a + 2) % 24)
        r = a.post("/devices/%d/schedule" % dev["id"], {"name": "tzrule", "playlist_id": str(pid), "priority": "77",
                                                        "start_time": start, "end_time": end})
        if S.expect("settings: create a 2 h rule around now in UTC-12 (%s-%s)" % (start, end), r, 303):
            m = sync(dev, w.base).json().get("playlist") or {}
            S.rec("settings: rule matches in UTC-12 (source schedule:tzrule)", m.get("source") == "schedule:tzrule", m.get("source"))
            S.rec("settings: schedule page marks the rule as active", "tzrule" in a.get("/devices/%d/schedule" % dev["id"]).text)
            S.expect("settings: set timezone Etc/GMT-14 (UTC+14)", set_tz("Etc/GMT-14"), 303)
            m = sync(dev, w.base).json().get("playlist") or {}
            S.rec("settings: same rule does not match in UTC+14 (wall clock +26 h)", m.get("source") == "device-default", m.get("source"))
            sid = id_after(a.get("/devices/%d/schedule" % dev["id"]).text, "tzrule", r"/schedule/(\d+)/delete")
            if sid:
                a.post("/devices/%d/schedule/%s/delete" % (dev["id"], sid))
        # screenshot interval flows into the manifest
        S.expect("settings: screenshot_interval 45", a.post("/settings", {"timezone": "UTC", "screenshot_interval": "45", "default_image_duration": "10", "camera_interval": "10"}), 303)
        S.rec("settings: manifest screenshot_interval_seconds follows the setting", sync(dev, w.base).json().get("screenshot_interval_seconds") == 45)
        S.rec("settings: settings_update is audited", "settings_update" in a.get("/audit?limit=50").text)
    finally:
        set_tz("UTC")
        a.post("/settings", {"timezone": "UTC", "screenshot_interval": "60", "default_image_duration": "10", "camera_interval": "10"})


def check_audit(w):
    a = w.admin
    names = ["audit-%s-%d" % (w.tok, i) for i in range(5)]
    for n in names:
        create_playlist(a, n)
    html = a.get("/audit?limit=1000").text
    positions = [html.find(n) for n in names]
    S.rec("audit: newest first even within one second", all(p >= 0 for p in positions) and positions == sorted(positions, reverse=True), str(positions))
    S.expect("audit: limit=0 is 400", a.get("/audit?limit=0"), 400)
    S.expect("audit: limit=5000 is 400", a.get("/audit?limit=5000"), 400)
    S.expect("audit: limit=abc is 400", a.get("/audit?limit=abc"), 400)
    S.expect("audit: limit=1 is 200", a.get("/audit?limit=1"), 200)
    html = a.get("/audit?limit=1000").text
    expected = ["login", "user_create", "create_playlist", "register_device", "device_assign_playlist", "group_create",
                "group_assign_playlist", "device_set_group", "device_schedule_create", "device_schedule_delete",
                "device_send_command", "playlist_add_item", "playlist_set_duration", "playlist_reorder", "upload_media",
                "delete_media", "login_failed", "logout"]
    missing = [e for e in expected if e not in html]
    S.rec("audit: page lists every write action performed so far", not missing, "missing: %s" % missing)
    S.rec("audit: failed login is audited with the username", "login_failed" in html)


def check_sessions(w):
    base = w.base
    c = Web(base)
    anon_cookie = c.csrf() and c.s.cookies.get("piplayer_session")
    r = c.login(ADMIN, ADMIN_PW)
    raw = r.raw.headers
    cookies = raw.getlist("Set-Cookie") if hasattr(raw, "getlist") else raw.get_all("Set-Cookie")
    sess = [x for x in cookies if x.startswith("piplayer_session=")]
    S.rec("cookie: login sets piplayer_session", bool(sess), str(cookies)[:200])
    if sess:
        ck = sess[-1]
        S.rec("cookie: HttpOnly", "HttpOnly" in ck, ck)
        S.rec("cookie: SameSite=Lax", "SameSite=Lax" in ck, ck)
        S.rec("cookie: Path=/ and Max-Age=1209600", "Path=/" in ck and "Max-Age=1209600" in ck, ck)
        S.rec("cookie: value is id.signature", re.match(r"^piplayer_session=[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+;", ck) is not None, ck)
        # Secure is always on (spec) except when the server was started with
        # PIPLAYER_INSECURE_COOKIES=1, which start_dev() does for the plain-http phase only.
        S.rec("cookie: Secure unless the dev opt-out is set", ("Secure" in ck) == base.startswith("https://"), ck)
    S.rec("cookie: login rotates the session id", bool(anon_cookie) and c.s.cookies.get("piplayer_session") not in (None, anon_cookie))
    S.expect("cookie: the pre-login anonymous cookie no longer works", requests.get(base + "/dashboard", cookies={"piplayer_session": anon_cookie or "x"}, allow_redirects=False), 303, location="/login")
    # tampered / forged cookie is ignored
    bad = requests.Session()
    bad.cookies.set("piplayer_session", "forged.forged")
    S.expect("cookie: forged cookie is anonymous", bad.get(base + "/dashboard", allow_redirects=False), 303, location="/login")
    old_cookie = c.s.cookies.get("piplayer_session")
    S.expect("session: dashboard reachable while logged in", c.get("/dashboard"), {200, 501})
    S.expect("session: logout is 303 /login", c.post("/logout"), 303, location="/login")
    S.expect("session: after logout the client is anonymous", c.get("/dashboard"), 303, location="/login")
    replay = requests.Session()
    replay.cookies.set("piplayer_session", old_cookie)
    S.expect("session: the old cookie is invalid after logout", replay.get(base + "/dashboard", allow_redirects=False), 303, location="/login")
    # session dies with the user
    try:
        name = "doomed-" + w.tok
        uid = create_user(w.admin, name, "pw123456", "viewer")
        d = Web(base)
        S.expect("session: doomed user logs in", d.login(name, "pw123456"), 303)
        S.expect("session: doomed user sees the dashboard", d.get("/dashboard"), {200, 501})
        S.expect("session: admin deletes the user", w.admin.post("/users/%s/delete" % uid), 303)
        S.expect("session: deleted user's session is invalid", d.get("/dashboard"), 303, location="/login")
        S.expect("session: deleted user's POST is refused", d.post("/playlists", {"name": "x"}), 303, location="/login?expired=1")
    except Blocked as e:
        S.rec("session: invalid after user deletion", False, "blocked: %s" % e)
    # role change takes effect on the next request
    if w.editor and w.viewer:
        try:
            page = w.admin.get("/users").text
            vid = id_after(page, esc(w.viewer_name), r"/users/(\d+)/")
            S.expect("session: promote viewer to editor", w.admin.post("/users/%s/role" % vid, {"role": "editor"}), 303)
            S.expect("session: promoted viewer may now create a playlist", w.viewer.post("/playlists", {"name": "promoted-" + w.tok}), 303)
            S.expect("session: demote back to viewer", w.admin.post("/users/%s/role" % vid, {"role": "viewer"}), 303)
            S.expect("session: demoted user is refused again", w.viewer.post("/playlists", {"name": "demoted-" + w.tok}), 403)
        except Blocked as e:
            S.rec("session: role change", False, "blocked: %s" % e)
    # login throttle: 5 failures in 30 s lock ip+username
    try:
        name = "throttle-" + w.tok
        create_user(w.admin, name, "correct-pw", "viewer")
        t = Web(base)
        codes = [t.login(name, "incorrect").status_code for _ in range(6)]
        S.rec("throttle: 6th failed login is 429 (first four are not)", codes[-1] == 429 and 429 not in codes[:4] and 500 not in codes, str(codes))
        S.expect("throttle: correct password is also 429 while locked", Web(base).login(name, "correct-pw"), 429)
        S.expect("throttle: another username from the same ip is unaffected", Web(base).login(ADMIN, ADMIN_PW), 303)
    except Blocked as e:
        S.rec("throttle: login lock", False, "blocked: %s" % e)
    # viewer never sees tokens
    if w.viewer and w.dev:
        page = w.viewer.get("/devices").text
        S.rec("roles: viewer page lacks the device token and install command", w.dev["token"] not in page and "DEVICE_TOKEN=" not in page and w.dev["name"] in page)
        page = w.editor.get("/devices").text if w.editor else ""
        S.rec("roles: editor page shows the token and install command",
              w.dev["token"] in page and "deploy/install-player.sh" in page and "cd piplayer/player" in page and "DEVICE_ID=%s" % w.dev["device_id"] in page and "CMS_URL=" in page)
    if w.viewer:
        page = w.viewer.get("/dashboard").text
        S.rec("roles: viewer nav has no Users/Settings links", 'href="/users"' not in page and 'href="/settings"' not in page and 'badge-viewer' in page)
        S.expect("roles: viewer JSON 403 names the role", w.viewer.post("/groups", {"name": "x"}), 403, "requires editor role")
    if w.editor:
        S.expect("roles: editor JSON 403 for admin routes", w.editor.get("/users"), 403, "requires admin role")
        page = w.editor.get("/dashboard").text
        S.rec("roles: editor nav has no Users/Settings links", 'href="/users"' not in page and 'href="/settings"' not in page)


def check_uploads_protocol(w):
    """Resume + abort semantics of the chunk protocol with a small file."""
    a = w.admin
    path = make_media("png", w.tmpdir, "proto" + w.tok)
    size, sha = os.path.getsize(path), sha256_file(path)
    body = {"name": "proto-" + w.tok + ".png", "size": size, "sha256": sha, "media_type": "image", "duration_seconds": None, "width": 64, "height": 64}
    r = a.post_json("/library/upload/init", body)
    if not S.expect("upload: init returns 200 {upload_id, part_size, received}", r, 200):
        return
    init = r.json()
    S.rec("upload: part_size is 8 MiB and received 0", init.get("part_size") == 8388608 and init.get("received") == 0, json.dumps(init)[:120])
    uid = init["upload_id"]
    S.expect("upload: status before any part", a.get("/library/upload/%s" % uid), 200)
    S.expect("upload: init again with the same sha while in flight is 409 or 200", a.post_json("/library/upload/init", body), {409, 200})
    if w.viewer:
        S.expect("upload: another user's upload id is 403/404 for the viewer", w.viewer.put("/library/upload/%s/part/1" % uid, b"x"), {403, 404})
    if w.editor:
        S.expect("upload: another user's upload id is 404/403 for a different editor", w.editor.get("/library/upload/%s" % uid), {403, 404})
    S.expect("upload: complete before all bytes is 400", a.post_json("/library/upload/%s/complete" % uid, {}), 400)
    with open(path, "rb") as f:
        data = f.read()
    S.expect("upload: part 0 is 400", a.put("/library/upload/%s/part/0" % uid, data), 400)
    S.expect("upload: part 'x' is 400", a.put("/library/upload/%s/part/x" % uid, data), 400)
    S.expect("upload: part beyond the declared size is 400", a.put("/library/upload/%s/part/2" % uid, data), 400)
    r = a.put("/library/upload/%s/part/1" % uid, data)
    if S.expect("upload: part 1 accepted", r, 200):
        S.rec("upload: received == size after the last part", r.json().get("received") == size, r.text[:100])
    r = a.put("/library/upload/%s/part/1" % uid, data)
    S.expect("upload: re-sending part 1 is idempotent (200)", r, 200)
    r = a.get("/library/upload/%s" % uid)
    if S.expect("upload: status shows received and parts", r, 200):
        st = r.json()
        S.rec("upload: status received == size, parts == [1]", st.get("received") == size and [int(p if isinstance(p, int) else p.get("partNumber", p.get("n", 0))) for p in st.get("parts", [])] == [1], json.dumps(st)[:120])
    r = a.post_json("/library/upload/%s/complete" % uid, {})
    if S.expect("upload: complete returns {media_id}", r, 200):
        mid = r.json().get("media_id")
        S.rec("upload: media_id is an int", isinstance(mid, int))
        S.expect("upload: complete again is 404 (uploads row gone)", a.post_json("/library/upload/%s/complete" % uid, {}), 404)
        page = a.get("/library").text
        S.rec("upload: library lists the new file", "proto-" + w.tok + ".png" in page and "badge-image" in page)
        S.expect("upload: media is served", a.get("/api/media/" + final_media_name(sha, body["name"], ".png")), 200)
        S.expect("upload: cleanup delete", a.post("/library/%s/delete" % mid), 303)
    # abort
    r = a.post_json("/library/upload/init", dict(body, name="abort-" + w.tok + ".png", sha256=hashlib.sha256(b"abort" + w.tok.encode()).hexdigest()))
    if S.expect("upload: init for abort", r, 200):
        uid = r.json()["upload_id"]
        S.expect("upload: abort is 200", a.post_json("/library/upload/%s/abort" % uid, {}), 200)
        S.expect("upload: status after abort is 404", a.get("/library/upload/%s" % uid), 404)
        S.expect("upload: part after abort is 404", a.put("/library/upload/%s/part/1" % uid, b"x"), 404)


def check_dashboard(w):
    a = w.admin
    r = a.get("/dashboard")
    if S.expect("dashboard: renders", r, 200):
        t = r.text
        S.rec("dashboard: shows device names", (w.dev["name"] in t) if w.dev else False, "" if w.dev else "no device fixture")
        S.rec("dashboard: shows the admin badge and nav", 'badge-admin' in t and 'href="/settings"' in t)
    page = a.get("/library").text
    S.rec("library: page has the upload form/script hooks", "upload" in page.lower() and "csrf-token" in page)
    if w.pid:
        S.expect("playlists: edit page renders", a.get("/playlists/%d" % w.pid), 200)
        S.expect("playlists: rename works", a.post("/playlists/%d/rename" % w.pid, {"name": w.pname}), 303)
    if w.gid:
        S.expect("groups: page renders with the group", a.get("/groups"), 200)
        S.rec("groups: group listed", w.gname in a.get("/groups").text)
    if w.dev:
        S.expect("devices: regen-token works", a.post("/devices/%d/regen-token" % w.dev["id"]), 303)
        page = a.get("/devices").text
        m = re.search(r"DEVICE_ID=%s\s*\\?\s*DEVICE_TOKEN=([A-Za-z0-9_\-]+)" % re.escape(w.dev["device_id"]), page)
        S.rec("devices: token changed after regen", bool(m) and m.group(1) != w.dev["token"])
        if m:
            S.expect("devices: old token is now 401", sync(w.dev, w.base), 401)
            w.dev["token"] = m.group(1)
            S.expect("devices: new token syncs", sync(w.dev, w.base), 200)


def check_enroll(w):
    """Zero-touch enrollment: the key on /settings lets an anonymous POST /api/enroll create a
    device (fresh token) and re-enroll it (same token, new name); bad key 401, throttled 429."""
    a, base = w.admin, w.base
    page = a.get("/settings").text
    m = re.search(r'<input type="password" id="enrollment-key" value="([A-Za-z0-9_\-]+)" readonly', page)
    if not S.rec("enroll: /settings shows the enrollment key (masked input + Show button)",
                 m is not None and 'data-reveal="enrollment-key">Show</button>' in page):
        return
    key = m.group(1)
    did = "enroll-" + w.tok
    e = lambda payload, **kw: requests.post(base + "/api/enroll", json=payload, timeout=30, **kw)  # noqa: E731
    r = e({"key": "nope", "device_id": did, "name": "x"})
    if r.status_code == 429:  # a run less than 60 s ago left this ip locked (persisted state)
        m = re.search(r"in (\d+) s", r.text)
        time.sleep(int(m.group(1)) + 1 if m else 61)
        r = e({"key": "nope", "device_id": did, "name": "x"})
    S.expect("enroll: wrong key is 401", r, 401, detail_contains="invalid enrollment key")
    S.expect("enroll: missing key is 401", e({"device_id": did, "name": "x"}), 401)
    S.expect("enroll: bad device_id is 400", e({"key": key, "device_id": "Bad_ID!", "name": "x"}), 400, detail_contains="device_id")
    S.expect("enroll: empty name is 400", e({"key": key, "device_id": did, "name": " "}), 400, detail_contains="name")
    S.expect("enroll: non-JSON body is 400", requests.post(base + "/api/enroll", data="x", headers={"Content-Type": "application/json"}, timeout=30), 400)
    r = e({"key": key, "device_id": did.upper(), "name": "Enrolled " + w.tok})
    if not S.expect("enroll: new device is 200", r, 200):
        return
    body = r.json()
    tok = body.get("token", "")
    # cms_url is the request origin; wrangler dev rewrites the host to ROUTE_HOST (see check_device_api)
    hosts = {base, "http://" + ROUTE_HOST, "https://" + ROUTE_HOST}
    S.rec("enroll: response carries device_id, token, cms_url (request origin)",
          body.get("device_id") == did and len(tok) > 20 and body.get("cms_url") in hosts, json.dumps(body)[:120])
    S.expect("enroll: the token authenticates /api/sync", requests.get(base + "/api/sync/" + did, headers=bearer(tok), timeout=30), 200)
    r2 = e({"key": key, "device_id": did, "name": "Renamed " + w.tok})
    if S.expect("enroll: re-enroll is 200", r2, 200):
        S.rec("enroll: re-enroll keeps the existing token", r2.json().get("token") == tok)
    devices = a.get("/devices").text
    S.rec("enroll: device shows on /devices with the new name", ("Renamed " + w.tok) in devices and ("Enrolled " + w.tok) not in devices)
    html = a.get("/audit?limit=100").text
    S.rec("enroll: audit shows device_enrolled and device_reenrolled", "device_enrolled" in html and "device_reenrolled" in html)
    S.rec("enroll: audit never contains the token", tok not in html)
    # throttle: 10 bad keys from this ip -> 429 (wrangler dev sees every client as one ip)
    codes = [e({"key": "nope", "device_id": did, "name": "x"}).status_code for _ in range(10)]
    S.rec("enroll: the ip locks after 10 bad keys (2 sent above)", codes[:7] == [401] * 7 and 429 in codes, str(codes))
    r = e({"key": key, "device_id": did, "name": "x"})
    if S.expect("enroll: eleventh attempt is 429 (even with the right key)", r, 429):
        S.rec("enroll: the 429 carries Retry-After", r.headers.get("Retry-After", "").isdigit(), r.headers.get("Retry-After"))
    # rotate: the old key stops working (the throttle also blocks it, so only check the page changed)
    if w.editor:
        S.expect("enroll: rotate is admin-only", w.editor.post("/settings/enrollment/rotate"), 403, detail_contains="requires admin role")
    S.expect("enroll: rotate", a.post("/settings/enrollment/rotate"), 303, location="/settings?rotated=1")
    page2 = a.get("/settings?rotated=1").text
    S.rec("enroll: rotated key differs and the banner shows", key not in page2 and "Enrollment key rotated." in page2)
    S.rec("enroll: enrollment_key_rotated is audited", "enrollment_key_rotated" in a.get("/audit?limit=50").text)
    dev_id = id_after(devices, did, r"/devices/(\d+)/")
    if dev_id:
        a.post("/devices/%s/delete" % dev_id)


def check_cleanup(w):
    """Delete a device and a playlist through the UI; cascades must not 500 and the audit trail
    records them. The other fixtures stay (a persisted state dir keeps them; tok makes them unique)."""
    a = w.admin
    if w.dev2:
        S.expect("cleanup: delete device", a.post("/devices/%d/delete" % w.dev2["id"]), 303)
        S.expect("cleanup: deleted device token is 401", sync(w.dev2, w.base), 401)
    if w.gid:
        S.expect("cleanup: delete group", a.post("/groups/%d/delete" % w.gid), 303)
    if w.pid:
        S.expect("cleanup: delete playlist (cascades items, clears device default)", a.post("/playlists/%d/delete" % w.pid), 303)
        if w.dev:
            r = sync(w.dev, w.base)
            S.rec("cleanup: device now gets playlist null", r.status_code == 200 and r.json().get("playlist") is None)
    html = a.get("/audit?limit=100").text
    S.rec("cleanup: audit shows device_delete / group_delete / playlist_delete",
          all(x in html for x in ("device_delete", "group_delete", "playlist_delete")))


# ---------------------------------------------------------------------------
# Runner
# ---------------------------------------------------------------------------

def check_secure_cookie_https(port, persist):
    """Production is https, so prove the Secure flag black-box: restart wrangler dev with its
    self-signed cert (--local-protocol https), log in over TLS and round-trip the cookie."""
    proc, base, log = start_dev(port, persist, https=True)
    try:
        c = Web(base)
        c.s.verify = False
        r = c.login(ADMIN, ADMIN_PW)
        cookies = r.raw.headers.getlist("Set-Cookie") if hasattr(r.raw.headers, "getlist") else r.raw.headers.get_all("Set-Cookie")
        sess = [x for x in cookies if x.startswith("piplayer_session=")]
        S.rec("https: login sets piplayer_session", bool(sess), str(cookies)[:200])
        if sess:
            S.rec("https: cookie carries Secure", "Secure" in sess[-1], sess[-1])
            S.rec("https: cookie keeps HttpOnly; SameSite=Lax", "HttpOnly" in sess[-1] and "SameSite=Lax" in sess[-1], sess[-1])
        S.expect("https: Secure cookie is accepted back on the next request", c.get("/dashboard"), 200)
        S.expect("https: logout over TLS", c.post("/logout"), 303, location="/login")
    finally:
        stop(proc)
        log.close()


def check_scaffold(base):
    """Kept for packages that still append plain functions to CHECKS."""


CHECKS = []

SUITE = [
    ("login/csrf", check_login_csrf),
    ("authz matrix", check_authz_matrix),
    ("validation", check_validation),
    ("xss", check_xss),
    ("404/static", check_not_served),
    ("device api", check_device_api),
    ("media", check_media),
    ("screenshots", check_screenshots),
    ("commands", check_commands),
    ("uploads protocol", check_uploads_protocol),
    ("settings/timezone", check_settings_timezone),
    ("enroll", check_enroll),
    ("sessions/cookies/roles", check_sessions),
    ("audit", check_audit),
    ("dashboard/pages", check_dashboard),
    ("cleanup", check_cleanup),
]


def run_all(base, tmpdir):
    w = build_world(base, tmpdir)
    if w.admin is None:
        S.rec("admin session", False, w.errors.get("admin", ""))
        return
    for label, fn in SUITE:
        try:
            fn(w)
        except Blocked as e:
            S.rec("%s (whole group)" % label, False, "blocked: %s" % e)
        except Exception as e:  # noqa: BLE001
            S.rec("%s (whole group)" % label, False, "crashed: %s: %s" % (type(e).__name__, e))
            traceback.print_exc()
    for fn in CHECKS:
        try:
            fn(base)
            S.rec("extra check %s" % fn.__name__, True)
        except Exception as e:  # noqa: BLE001
            S.rec("extra check %s" % fn.__name__, False, "%s: %s" % (type(e).__name__, e))


def start_dev(port, persist, https=False):
    """Apply migrations and start `wrangler dev --local`; https=True serves wrangler's self-signed
    cert (callers then pass verify=False). Returns (proc, base, log)."""
    npx = "npx.cmd" if os.name == "nt" else "npx"
    common = ["--persist-to", persist]
    subprocess.run([npx, "wrangler", "d1", "migrations", "apply", "piplayer-cloud-db", "--local"] + common,
                   cwd=CLOUD, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT)
    scheme = "https" if https else "http"
    cmd = [npx, "wrangler", "dev", "--local", "--port", str(port), "--ip", "127.0.0.1", "--local-protocol", scheme,
           "--var", "SESSION_SECRET:" + SESSION_SECRET, "--var", "SETUP_TOKEN:" + SETUP_TOKEN] + common
    if not https:
        # The cookie is always Secure (spec); plain-http dev opts out or requests drops it.
        # The TLS phase leaves it on, proving the production cookie round-trips.
        cmd += ["--var", "PIPLAYER_INSECURE_COOKIES:1"]
    log = open(os.path.join(persist, "wrangler-dev-%s.log" % scheme), "w")
    proc = subprocess.Popen(cmd, cwd=CLOUD, stdout=log, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL)
    base = "%s://127.0.0.1:%d" % (scheme, port)
    deadline = time.time() + 120
    while time.time() < deadline:
        try:
            if requests.get(base + "/api/health", timeout=2, verify=not https).status_code == 200:
                return proc, base, log
        except requests.RequestException:
            pass
        if proc.poll() is not None:
            break
        time.sleep(1)
    stop(proc)
    log.close()
    raise SystemExit("wrangler dev did not come up; see " + log.name)


def stop(proc):
    if proc is None or proc.poll() is not None:
        return
    if os.name == "nt":
        subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    else:
        proc.terminate()
    try:
        proc.wait(10)
    except subprocess.TimeoutExpired:
        proc.kill()


def main():
    # Windows consoles default to cp1252; server details carry en-dashes and "→", so keep
    # print() from raising UnicodeEncodeError on a failing row.
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(errors="replace")
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8787)
    ap.add_argument("--persist-to", default=None, help="fresh temp dir by default")
    ap.add_argument("--base", default=None, help="test an already-running server instead of starting wrangler dev")
    args = ap.parse_args()
    persist = args.persist_to or tempfile.mkdtemp(prefix="piplayer-cloud-e2e-")
    os.makedirs(persist, exist_ok=True)
    tmpdir = tempfile.mkdtemp(prefix="media-", dir=persist)
    proc = log = None
    if args.base:
        base = args.base.rstrip("/")
    else:
        proc, base, log = start_dev(args.port, persist)
    try:
        run_all(base, tmpdir)
    finally:
        stop(proc)
        if log:
            log.close()
    if args.base:
        print("note: --base given, the https/Secure-cookie phase needs a wrangler dev this script controls")
    else:
        check_secure_cookie_https(args.port, persist)
    ok = S.print_table()
    print("e2e OK" if ok else "e2e FAILED")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
