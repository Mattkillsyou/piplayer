"""Black-box e2e of the chunked upload protocol + Library page against `wrangler dev --local`.

Usage: python e2e/run_upload_e2e.py [--port 8790] [--persist-to DIR] [--no-browser]

Reuses the runner from run_e2e.py (starts + migrates + kills the dev server). A real 12 MiB
H.264 mp4 is generated with ffmpeg, hashed with hashlib and pushed through init / part /
status / complete with 8 MiB parts, including an interrupted-and-resumed upload, the 409
duplicate and 413 oversize answers at init, abort (checked down in Miniflare's R2 store), and
the delete route.

Then the browser half: a headless Chrome driven over the DevTools protocol (the `websockets`
package that uvicorn[standard] pulls into cms/.venv; no other dependency) logs in through the
real form, opens /library, puts three real File objects into the file picker (DataTransfer is
the only way any automation fills <input type=file>), submits, and records every progress bar
state upload.js renders: hashing %, upload %, the 409 detail text, the final status line.
`--no-browser` skips that half; `PIPLAYER_CHROME` points at another Chromium binary.
"""
import argparse
import base64
import hashlib
import json
import os
import glob
import re
import sqlite3
import subprocess
import sys
import tempfile
import time

import requests

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from run_e2e import CLOUD, SETUP_TOKEN, start_dev, stop  # noqa: E402

MiB = 1024 * 1024
PERSIST = None
CSRF_META = re.compile(r'<meta name="csrf-token" content="([^"]+)">')


def csrf(session, base, path="/login"):
    r = session.get(base + path, allow_redirects=False)
    assert r.status_code == 200, (path, r.status_code, r.text[:200])
    return CSRF_META.search(r.text).group(1)


def d1(sql):
    """Rows of a SELECT against the local D1 (same --persist-to as the dev server)."""
    npx = "npx.cmd" if os.name == "nt" else "npx"
    out = subprocess.run([npx, "wrangler", "d1", "execute", "piplayer-cloud-db", "--local", "--json",
                          "--persist-to", PERSIST, "--command", sql],
                         cwd=CLOUD, check=True, capture_output=True, text=True).stdout
    return json.loads(out[out.index("["):])[0]["results"]


def r2_multipart(upload_id):
    """(state, part rows) of an R2 multipart upload straight from Miniflare's bucket store.

    The dev server keeps R2 in `<persist>/v3/r2/miniflare-R2BucketObject/<id>.sqlite`
    (tables _mf_multipart_uploads / _mf_multipart_parts, see miniflare's bucket.worker.js);
    state 0 = in progress, 1 = completed, 2 = aborted, and abort deletes the part rows.
    Read-only, so the running worker's own connection is never disturbed.
    """
    for f in glob.glob(os.path.join(PERSIST, "v3", "r2", "miniflare-R2BucketObject", "*.sqlite")):
        c = sqlite3.connect("file:%s?mode=ro" % f.replace("\\", "/"), uri=True)
        try:
            row = c.execute("SELECT state FROM _mf_multipart_uploads WHERE upload_id = ?", (upload_id,)).fetchone()
            if row is None:
                continue
            parts = c.execute("SELECT COUNT(*) FROM _mf_multipart_parts WHERE upload_id = ?", (upload_id,)).fetchone()[0]
            return row[0], parts
        except sqlite3.OperationalError:
            continue  # metadata.sqlite (alarms only)
        finally:
            c.close()
    raise AssertionError("multipart upload %s not found in %s" % (upload_id, PERSIST))


def make_mp4(path):
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=duration=7:size=1280x720:rate=30",
                    "-c:v", "libx264", "-b:v", "16M", "-minrate", "16M", "-maxrate", "16M", "-bufsize", "8M", "-x264-params", "nal-hrd=cbr",
                    "-pix_fmt", "yuv420p", path], check=True)
    size = os.path.getsize(path)
    assert size >= 12 * MiB, "want a >= 12 MiB clip (two parts), got %d bytes" % size
    probe = json.loads(subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
                                       "stream=width,height:format=duration", "-of", "json", path],
                                      check=True, capture_output=True, text=True).stdout)
    return size, probe["streams"][0]["width"], probe["streams"][0]["height"], float(probe["format"]["duration"])


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(8 * MiB), b""):
            h.update(chunk)
    return h.hexdigest()


def login(base):
    s = requests.Session()
    r = s.get(base + "/", allow_redirects=False)
    if r.headers.get("location") == "/setup":
        token = csrf(s, base, "/setup?token=" + SETUP_TOKEN)
        r = s.post(base + "/setup", data={"token": SETUP_TOKEN, "username": "admin", "password": "test1234",
                                          "password2": "test1234", "csrf_token": token}, allow_redirects=False)
        assert r.status_code == 303, r.text[:300]
    else:
        r = s.post(base + "/login", data={"username": "admin", "password": "test1234", "csrf_token": csrf(s, base)},
                   allow_redirects=False)
        assert r.status_code == 303, r.text[:300]
    s.headers["X-CSRF-Token"] = csrf(s, base, "/library")
    return s


def put_part(s, base, upload_id, n, data):
    return s.put("%s/library/upload/%s/part/%d" % (base, upload_id, n), data=data,
                 headers={"Content-Type": "application/octet-stream"})


def check_uploads(base):
    s = login(base)
    tmp = tempfile.mkdtemp(prefix="piplayer-upload-e2e-")
    path = os.path.join(tmp, "e2e clip (720p).mp4")
    size, width, height, duration = make_mp4(path)
    sha = sha256_file(path)
    init_body = {"name": os.path.basename(path), "size": size, "sha256": sha, "media_type": "video",
                 "duration_seconds": duration, "width": width, "height": height}
    print("generated %s: %d bytes %dx%d %.2fs sha256=%s" % (path, size, width, height, duration, sha[:16]))

    # oversize -> 413 before anything is created
    r = s.post(base + "/library/upload/init", json=dict(init_body, size=5 * 1024 * MiB + 1))
    assert r.status_code == 413 and r.json()["detail"].startswith("File exceeds"), (r.status_code, r.text[:200])
    r = s.post(base + "/library/upload/init", json=dict(init_body, name="x.exe"))
    assert r.status_code == 400 and "Unsupported extension" in r.json()["detail"], r.text[:200]
    assert d1("SELECT COUNT(*) AS n FROM uploads")[0]["n"] == 0

    # init, part 1, then "the tab was closed": status + a second init hand back the same upload
    r = s.post(base + "/library/upload/init", json=init_body)
    assert r.status_code == 200, (r.status_code, r.text[:300])
    init = r.json()
    assert init["part_size"] == 8 * MiB and init["received"] == 0, init
    upload_id = init["upload_id"]
    with open(path, "rb") as f:
        parts = []
        while True:
            chunk = f.read(8 * MiB)
            if not chunk:
                break
            parts.append(chunk)
    assert len(parts) == 2, len(parts)
    r = put_part(s, base, upload_id, 1, parts[0])
    assert r.status_code == 200 and r.json() == {"received": 8 * MiB}, (r.status_code, r.text[:200])
    # a too-small non-last part is refused (R2 needs >= 5 MiB, the protocol needs exactly part_size)
    r = put_part(s, base, upload_id, 2, parts[1][:-1])
    assert r.status_code == 400, (r.status_code, r.text[:200])

    st = s.get("%s/library/upload/%s" % (base, upload_id)).json()
    assert st["received"] == 8 * MiB and st["parts"] == [1], st
    r = s.post(base + "/library/upload/init", json=init_body)
    assert r.status_code == 200 and r.json() == {"upload_id": upload_id, "part_size": 8 * MiB, "received": 8 * MiB}, r.text[:200]
    # resumed: skip part 1, send part 2, complete
    r = put_part(s, base, upload_id, 2, parts[1])
    assert r.status_code == 200 and r.json() == {"received": size}, (r.status_code, r.text[:200])
    r = s.post("%s/library/upload/%s/complete" % (base, upload_id))
    assert r.status_code == 200, (r.status_code, r.text[:300])
    media_id = r.json()["media_id"]

    rows = d1("SELECT filename, original_name, media_type, size_bytes, width, height, duration_seconds, sha256 FROM media WHERE id = %d" % media_id)
    assert len(rows) == 1, rows
    row = rows[0]
    assert (row["original_name"], row["media_type"], row["size_bytes"], row["width"], row["height"], row["sha256"]) == \
        (init_body["name"], "video", size, width, height, sha), row
    assert abs(row["duration_seconds"] - duration) < 0.01, row
    assert row["filename"] == sha[:16] + "_e2e_clip_720p.mp4", row["filename"]
    assert d1("SELECT COUNT(*) AS n FROM uploads")[0]["n"] == 0
    assert d1("SELECT action FROM audit_log WHERE action = 'upload_media'") == [{"action": "upload_media"}]

    # the R2 object is served back byte-identical to a logged-in session
    r = s.get("%s/api/media/%s" % (base, row["filename"]), stream=True)
    assert r.status_code == 200, (r.status_code, r.text[:200])
    assert int(r.headers["Content-Length"]) == size, r.headers
    assert r.headers.get("Content-Type", "").startswith("video/mp4"), r.headers
    got = hashlib.sha256()
    for chunk in r.iter_content(1024 * 1024):
        got.update(chunk)
    assert got.hexdigest() == sha
    r = s.head("%s/api/media/%s" % (base, row["filename"]))
    assert r.status_code == 200 and int(r.headers["Content-Length"]) == size, r.headers

    # duplicate content -> 409 with the existing name, no upload row
    r = s.post(base + "/library/upload/init", json=dict(init_body, name="renamed copy.mp4"))
    assert r.status_code == 409, (r.status_code, r.text[:200])
    assert r.json()["detail"] == "Duplicate of '%s' (sha256 match)" % init_body["name"], r.text
    assert d1("SELECT COUNT(*) AS n FROM uploads")[0]["n"] == 0

    # library page lists it
    page = s.get(base + "/library").text
    assert init_body["name"] in page and "badge-video" in page and "%dx%d" % (width, height) in page.replace("×", "x"), page[:500]
    assert 'data-confirm="Delete %s?' % init_body["name"] in page
    assert "/static/upload.js" in page and "/static/sha256.js" in page
    for asset in ("/static/upload.js", "/static/sha256.js"):
        assert s.get(base + asset).status_code == 200, asset

    # abort removes the row AND the R2 multipart (state aborted, parts dropped); the upload
    # id is then unknown to every endpoint
    small = os.urandom(3 * MiB)
    r = s.post(base + "/library/upload/init", json={"name": "abort.png", "size": len(small),
                                                    "sha256": hashlib.sha256(small).hexdigest(), "media_type": "image"})
    assert r.status_code == 200, r.text[:200]
    aid = r.json()["upload_id"]
    assert put_part(s, base, aid, 1, small).status_code == 200
    urow = d1("SELECT upload_id FROM uploads WHERE id = '%s'" % aid)
    assert len(urow) == 1, urow
    r2_id = urow[0]["upload_id"]
    assert r2_multipart(r2_id) == (0, 1), r2_multipart(r2_id)
    r = s.post("%s/library/upload/%s/abort" % (base, aid))
    assert r.status_code == 200 and r.json() == {"ok": True}, r.text[:200]
    assert d1("SELECT COUNT(*) AS n FROM uploads")[0]["n"] == 0
    assert r2_multipart(r2_id) == (2, 0), r2_multipart(r2_id)
    assert s.get("%s/library/upload/%s" % (base, aid)).status_code == 404
    assert put_part(s, base, aid, 1, small).status_code == 404
    assert s.post("%s/library/upload/%s/complete" % (base, aid)).status_code == 404

    # delete through the page route: row + object gone, 404 afterwards
    r = s.post("%s/library/%d/delete" % (base, media_id), data={"csrf_token": s.headers["X-CSRF-Token"]}, allow_redirects=False)
    assert (r.status_code, r.headers["location"]) == (303, "/library"), (r.status_code, r.text[:200])
    assert d1("SELECT COUNT(*) AS n FROM media WHERE id = %d" % media_id)[0]["n"] == 0
    assert s.get("%s/api/media/%s" % (base, row["filename"])).status_code == 404
    assert s.post("%s/library/%d/delete" % (base, media_id), data={"csrf_token": s.headers["X-CSRF-Token"]},
                  allow_redirects=False).status_code == 404
    print("upload e2e checks OK")


CHROME_CANDIDATES = [
    os.environ.get("PIPLAYER_CHROME"),
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
]


def find_chrome():
    for c in CHROME_CANDIDATES:
        if c and os.path.isfile(c):
            return c
    raise SystemExit("no Chrome/Chromium found; set PIPLAYER_CHROME or pass --no-browser")


class Cdp:
    """Minimal DevTools client over one websocket: send(method) waits for its reply and
    queues every event that arrives meanwhile; wait_event() drains that queue first."""

    def __init__(self, ws):
        self.ws = ws
        self.seq = 0
        self.events = []

    def send(self, method, timeout=60, **params):
        self.seq += 1
        self.ws.send(json.dumps({"id": self.seq, "method": method, "params": params}))
        deadline = time.time() + timeout
        while True:
            msg = json.loads(self.ws.recv(timeout=max(0.1, deadline - time.time())))
            if msg.get("id") == self.seq:
                if "error" in msg:
                    raise AssertionError("%s failed: %s" % (method, msg["error"]))
                return msg.get("result", {})
            if "method" in msg:
                self.events.append(msg)

    def wait_event(self, name, timeout=60):
        deadline = time.time() + timeout
        while True:
            for i, ev in enumerate(self.events):
                if ev["method"] == name:
                    del self.events[i]
                    return ev.get("params", {})
            msg = json.loads(self.ws.recv(timeout=max(0.1, deadline - time.time())))
            if "method" in msg:
                self.events.append(msg)

    def evaluate(self, js, timeout=60):
        r = self.send("Runtime.evaluate", timeout=timeout, expression=js, awaitPromise=True, returnByValue=True)
        if "exceptionDetails" in r:
            raise AssertionError("page script threw: %s" % json.dumps(r["exceptionDetails"])[:500])
        return r["result"].get("value")

    def navigate(self, url):
        self.events = [e for e in self.events if e["method"] != "Page.loadEventFired"]
        self.send("Page.navigate", url=url)
        self.wait_event("Page.loadEventFired")


def start_chrome(chrome):
    """Headless Chrome with a throwaway profile; returns (proc, websocket url of its page)."""
    profile = tempfile.mkdtemp(prefix="piplayer-chrome-")
    proc = subprocess.Popen([chrome, "--headless", "--remote-debugging-port=0", "--user-data-dir=" + profile,
                             "--no-first-run", "--no-default-browser-check", "--disable-gpu", "about:blank"],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL)
    active = os.path.join(profile, "DevToolsActivePort")   # "<port>\n<browser ws path>", written once it listens
    deadline = time.time() + 30
    while time.time() < deadline and not os.path.isfile(active):
        time.sleep(0.2)
    assert os.path.isfile(active), "Chrome did not open its DevTools port"
    port = int(open(active).read().splitlines()[0])
    for _ in range(50):
        try:
            pages = [t for t in requests.get("http://127.0.0.1:%d/json" % port, timeout=2).json() if t["type"] == "page"]
            if pages:
                return proc, pages[0]["webSocketDebuggerUrl"]
        except (requests.RequestException, ValueError):
            pass
        time.sleep(0.2)
    raise AssertionError("Chrome exposed no page target")


# Runs inside /library: fills the picker with a real PNG, a 12 MiB "video" (random bytes, so
# the <video> metadata probe fails and nulls are sent, as for an undecodable file) and a copy
# of it (409 duplicate inside the same batch, which also keeps upload.js from reloading the
# page so the log survives), submits, and returns every progress-bar transition per row.
UPLOAD_JS = r"""
(async () => {
  const input = document.getElementById('file-input');
  const queue = document.getElementById('upload-queue');
  const status = document.getElementById('upload-status');
  const png = Uint8Array.from(atob('%(png)s'), (c) => c.charCodeAt(0));
  const big = new Uint8Array(12 * 1024 * 1024);
  for (let i = 0; i < big.length; i += 65536) crypto.getRandomValues(big.subarray(i, i + 65536));
  const dt = new DataTransfer();
  dt.items.add(new File([png], 'browser pic.png', { type: 'image/png' }));
  dt.items.add(new File([big], 'browser clip.mp4', { type: 'video/mp4' }));
  dt.items.add(new File([big], 'browser clip copy.mp4', { type: 'video/mp4' }));
  input.files = dt.files;
  const log = [], last = [];
  new MutationObserver(() => {
    Array.prototype.forEach.call(queue.children, (li, i) => {
      const state = [Math.round(li.querySelector('progress').value), li.lastElementChild.textContent];
      if (!last[i] || last[i][0] !== state[0] || last[i][1] !== state[1]) { last[i] = state; log.push([i, state[0], state[1]]); }
    });
  }).observe(queue, { subtree: true, childList: true, characterData: true });
  document.getElementById('upload-form').requestSubmit();
  await new Promise((resolve, reject) => {
    const t0 = Date.now();
    const t = setInterval(() => {
      if (status.textContent) { clearInterval(t); resolve(); }
      else if (Date.now() - t0 > 90000) { clearInterval(t); reject(new Error('upload did not finish')); }
    }, 25);
  });
  return { status: status.textContent, files: input.files.length, disabled: document.querySelector('#upload-form button').disabled,
           rows: Array.prototype.map.call(queue.children, (li) => li.lastElementChild.textContent), log };
})()
"""


# Runs inside /library after the session cookie is gone: every upload request is answered
# 303 -> /login?expired=1, which XHR follows to the 200 HTML login page. upload.js must show
# that as the session-expired error row and stop; the old code parsed the HTML as {} and
# PUT /library/upload/undefined/part/1,2,3... forever.
EXPIRED_JS = r"""
(async () => {
  const input = document.getElementById('file-input');
  const queue = document.getElementById('upload-queue');
  const status = document.getElementById('upload-status');
  const rowsBefore = queue.children.length;
  const seen = performance.getEntriesByType('resource').length;
  const dt = new DataTransfer();
  dt.items.add(new File([new Uint8Array(1000)], 'expired.png', { type: 'image/png' }));
  input.files = dt.files;
  status.textContent = '';
  document.getElementById('upload-form').requestSubmit();
  await new Promise((resolve, reject) => {
    const t0 = Date.now();
    const t = setInterval(() => {
      if (status.textContent) { clearInterval(t); resolve(); }
      else if (Date.now() - t0 > 20000) { clearInterval(t); reject(new Error('upload did not finish')); }
    }, 25);
  });
  const row = queue.children[rowsBefore].lastElementChild;
  return { status: status.textContent, row: row.textContent, rowClass: row.className,
           requests: performance.getEntriesByType('resource').slice(seen).map((e) => e.name.replace(location.origin, '')) };
})()
"""


def check_browser_upload(base, chrome):
    from websockets.sync.client import connect

    png_path = os.path.join(tempfile.mkdtemp(prefix="piplayer-upload-e2e-"), "pic.png")
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=64x64", "-frames:v", "1", png_path], check=True)
    png = open(png_path, "rb").read()
    before = d1("SELECT COUNT(*) AS n FROM media")[0]["n"]

    proc, ws_url = start_chrome(chrome)
    try:
        with connect(ws_url, max_size=None) as ws:
            cdp = Cdp(ws)
            cdp.send("Page.enable")
            cdp.send("Runtime.enable")
            # the real login form, then the library page
            cdp.navigate(base + "/login")
            cdp.evaluate("document.querySelector('input[name=username]').value = 'admin';"
                         "document.querySelector('input[name=password]').value = 'test1234';"
                         "document.querySelector('form[action=\"/login\"]').requestSubmit(); 0")
            cdp.wait_event("Page.loadEventFired")
            assert cdp.evaluate("location.pathname") == "/dashboard", cdp.evaluate("location.href")
            cdp.navigate(base + "/library")
            assert cdp.evaluate("typeof sha256 === 'object' && !!document.getElementById('file-input')")
            out = cdp.evaluate(UPLOAD_JS % {"png": base64.b64encode(png).decode()}, timeout=120)
            page = cdp.evaluate("document.body.innerHTML")
            print("browser upload:", out["status"], out["rows"])
            cdp.navigate(base + "/library")
            listing = cdp.evaluate("document.body.innerText")
            # session gone mid-session: the next upload must fail fast with the expiry message
            cdp.send("Network.enable")
            cdp.send("Network.clearBrowserCookies")
            expired = cdp.evaluate(EXPIRED_JS, timeout=60)
            print("browser upload after expiry:", expired)
    finally:
        stop(proc)

    assert out["status"] == "2 of 3 file(s) uploaded; see the errors above. Reload the page to see them in the list.", out
    assert out["rows"] == ["Done.", "Done.", "Error: Duplicate of 'browser clip.mp4' (sha256 match)"], out["rows"]
    assert out["files"] == 0 and out["disabled"] is False, out   # picker cleared, button re-enabled
    assert 'class="alert error"' in page, page[:800]
    rows = [[v, t] for i, v, t in out["log"] if i == 1]      # the 12 MiB file
    texts = [t for _, t in rows]
    for want in ["Hashing 67%", "Hashing 100%", "Starting upload...", "Uploading 8.0 / 12.0 MB (67%)",
                 "Uploading 12.0 / 12.0 MB (100%)", "Upload received, saving...", "Done."]:
        assert want in texts, (want, texts)
    order = [texts.index(w) for w in ("Hashing 67%", "Starting upload...", "Uploading 12.0 / 12.0 MB (100%)", "Done.")]
    assert order == sorted(order), texts
    uploading = [v for v, t in rows[texts.index("Starting upload..."):]]
    assert uploading == sorted(uploading) and uploading[0] == 0 and uploading[-1] == 100, uploading
    assert any(0 < v < 100 for v in uploading), uploading  # the bar visibly moved between the two parts
    hashing = [v for v, t in rows if t.startswith("Hashing")]
    assert hashing == sorted(hashing) and hashing[-1] == 100, hashing
    assert [t for i, v, t in out["log"] if i == 2][-1].startswith("Error: Duplicate"), out["log"]
    for i in (0, 1):
        assert [v for j, v, t in out["log"] if j == i][-1] == 100

    media = d1("SELECT original_name, filename, media_type, size_bytes, width, height, duration_seconds, sha256 "
               "FROM media WHERE original_name LIKE 'browser %' ORDER BY id")
    assert [(m["original_name"], m["media_type"], m["size_bytes"], m["width"], m["height"], m["duration_seconds"]) for m in media] == [
        ("browser pic.png", "image", len(png), 64, 64, None),
        ("browser clip.mp4", "video", 12 * MiB, None, None, None)], media
    assert d1("SELECT COUNT(*) AS n FROM media")[0]["n"] == before + 2
    assert media[0]["sha256"] == hashlib.sha256(png).hexdigest(), media[0]
    # the 12 MiB object was hashed by the vendored JS in the browser; hashlib on what R2 holds agrees
    s = login(base)
    r = s.get("%s/api/media/%s" % (base, media[1]["filename"]), stream=True)
    assert r.status_code == 200 and int(r.headers["Content-Length"]) == 12 * MiB, (r.status_code, r.headers)
    got = hashlib.sha256()
    for chunk in r.iter_content(1024 * 1024):
        got.update(chunk)
    assert got.hexdigest() == media[1]["sha256"], (got.hexdigest(), media[1]["sha256"])
    assert "browser pic.png" in listing and "browser clip.mp4" in listing and "64\u00d764" in listing, listing[:800]

    assert expired["status"] == "0 of 1 file(s) uploaded; see the errors above.", expired
    assert expired["row"] == "Error: Your session has expired; please sign in again.", expired
    assert expired["rowClass"] == "alert error", expired
    ours = [u for u in expired["requests"] if "/library/upload" in u or "/login" in u]
    assert len(ours) == 1 and not any("/part/" in u for u in expired["requests"]), expired["requests"]
    assert d1("SELECT COUNT(*) AS n FROM uploads")[0]["n"] == 0
    print("browser upload e2e checks OK")


def main():
    global PERSIST
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8790)
    ap.add_argument("--persist-to", default=None, help="fresh temp dir by default")
    ap.add_argument("--no-browser", action="store_true", help="skip the headless-Chrome half")
    args = ap.parse_args()
    PERSIST = args.persist_to or tempfile.mkdtemp(prefix="piplayer-cloud-upload-e2e-")
    chrome = None if args.no_browser else find_chrome()
    proc, base, log = start_dev(args.port, PERSIST)
    try:
        check_uploads(base)
        if chrome:
            check_browser_upload(base, chrome)
    finally:
        stop(proc)
        log.close()
    print("upload e2e OK")


if __name__ == "__main__":
    main()
