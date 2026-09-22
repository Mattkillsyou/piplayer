// Cross-cutting security checks: cookie flags, session invalidation, throttle, XSS escaping on
// every page, docs routes 404, device API auth, media scoping + Range, screenshot JPEG rule,
// command delivery cap, settings timezone effects, audit ordering/limit, contract-10 sweep.
// Mirrors the black-box groups in e2e/run_e2e.py inside workerd.
import { beforeAll, describe, expect, it } from "vitest";
import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { BASE, Client, query } from "./helpers.js";
import { NOPE, XSS, device, group, ins, media, one, playlist, post, postJson, roles } from "./pages_common.js";

const XSS_ESC = "x&#39;);alert(1);//";
const bearer = (token) => ({ authorization: `Bearer ${token}` });
const api = (path, init = {}) => SELF.fetch(BASE + path, { redirect: "manual", ...init });
const sync = (dev, params = "") => api(`/api/sync/${dev.device_id}${params}`, { headers: bearer(dev.token) });
const detail = async (res, status) => { expect(res.status).toBe(status); return (await res.json()).detail; };
const jpeg = (n, fill = 7) => { const b = new Uint8Array(n).fill(fill); b.set([0xff, 0xd8, 0xff, 0xe0]); return b; };
const shot = (dev, body, field = "file") => {
  const fd = new FormData();
  fd.set(field, new Blob([body], { type: "image/jpeg" }), "s.jpg");
  return api(`/api/screenshots/${dev.device_id}`, { method: "POST", body: fd, headers: bearer(dev.token) });
};
const settings = (c, fields) => post(c, "/settings", { timezone: "UTC", screenshot_interval: "60", camera_interval: "10", default_image_duration: "10", ...fields });

let r, pid, dev, dev2, dev3, mA, mB;
const FULL = new Uint8Array(1000).map((_, i) => i % 251);

beforeAll(async () => {
  r = await roles();
  pid = await playlist("sec");
  mA = await media("a.mp4", "video", { filename: "sec-a.mp4", size: 1000, duration: 2 });
  mB = await media("b.png", "image", { filename: "sec-b.png", size: 10 });
  await env.MEDIA.put("media/sec-a.mp4", FULL, { httpMetadata: { contentType: "video/mp4" } });
  await env.MEDIA.put("media/sec-b.png", FULL.slice(0, 10), { httpMetadata: { contentType: "image/png" } });
  await ins("INSERT INTO playlist_items (playlist_id, media_id, position) VALUES (?, ?, 0)", pid, mA);
  dev = await device("sec-dev", "Sec Dev", { playlist_id: pid });
  dev2 = await device("sec-dev2", "Sec Dev2");
  dev3 = await device("sec-dev3", "Sec Dev3", { last_seen_at: "2026-01-05 12:00:00" }); // never syncs: fixed timestamp
});

describe("cookies and sessions", () => {
  it("session cookie is HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=14d on http and https", async () => {
    const c = new Client();
    const csrf_token = await c.csrf("/login");
    const res = await c.post("/login", { username: "admin", password: "test1234", csrf_token });
    const ck = res.headers.getSetCookie().find((x) => x.startsWith("piplayer_session="));
    expect(ck).toMatch(/^piplayer_session=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+; HttpOnly; Secure; SameSite=Lax; Path=\/; Max-Age=1209600$/);
    // over https the same login carries the same Secure cookie
    const s = await SELF.fetch("https://piplayer.test/login", { redirect: "manual" });
    const cookie = s.headers.getSetCookie()[0].split(";")[0];
    const token = /name="csrf-token" content="([^"]+)"/.exec(await s.text())[1];
    const https = await SELF.fetch("https://piplayer.test/login", {
      method: "POST", redirect: "manual", body: new URLSearchParams({ username: "admin", password: "test1234", csrf_token: token }),
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    });
    expect(https.status).toBe(303);
    expect(https.headers.getSetCookie().find((x) => x.startsWith("piplayer_session="))).toMatch(/; HttpOnly; Secure; SameSite=Lax; Path=\//);
  });

  it("login rotates the session; forged and stale cookies are anonymous", async () => {
    const c = new Client();
    await c.csrf("/login");
    const anon = c.cookie;
    await c.login("admin", "test1234");
    expect(c.cookie).not.toBe(anon);
    for (const cookie of [anon, "piplayer_session=forged.forged", "piplayer_session=" + c.cookie.split("=")[1].split(".")[0] + ".bad"]) {
      const res = await api("/dashboard", { headers: { cookie } });
      expect([res.status, res.headers.get("location")], cookie).toEqual([303, "/login"]);
    }
  });

  it("logout invalidates the old cookie", async () => {
    const c = new Client();
    await c.login("admin", "test1234");
    const old = c.cookie;
    expect((await c.get("/dashboard")).status).toBe(200);
    await c.post("/logout", { csrf_token: await c.csrf("/dashboard") });
    const res = await api("/dashboard", { headers: { cookie: old } });
    expect([res.status, res.headers.get("location")]).toEqual([303, "/login"]);
  });

  it("deleting a user kills their session; a role change applies on the next request", async () => {
    expect((await post(r.admin, "/users", { username: "doomed", password: "pw123456", role: "viewer" })).status).toBe(303);
    const d = new Client();
    expect((await d.login("doomed", "pw123456")).status).toBe(303);
    expect((await d.get("/dashboard")).status).toBe(200);
    const uid = (await one("SELECT id FROM users WHERE username = 'doomed'")).id;
    expect((await post(r.admin, `/users/${uid}/delete`)).status).toBe(303);
    let res = await d.get("/dashboard");
    expect([res.status, res.headers.get("location")]).toEqual([303, "/login"]);
    res = await d.post("/playlists", { name: "x" }, { "X-CSRF-Token": "x" });
    expect([res.status, res.headers.get("location")]).toEqual([303, "/login?expired=1"]); // session row gone: back to the form
    const vid = (await one("SELECT id FROM users WHERE username = 'vw'")).id;
    expect((await post(r.admin, `/users/${vid}/role`, { role: "editor" })).status).toBe(303);
    expect((await post(r.viewer, "/playlists", { name: "promoted" })).status).toBe(303);
    expect((await post(r.admin, `/users/${vid}/role`, { role: "viewer" })).status).toBe(303);
    expect((await post(r.viewer, "/playlists", { name: "demoted" })).status).toBe(403);
  });

  it("five failed logins in 30 s lock that ip+username for 30 s (429), others unaffected", async () => {
    await post(r.admin, "/users", { username: "throttled", password: "correct-pw", role: "viewer" });
    const codes = [];
    for (let i = 0; i < 6; i++) codes.push((await new Client().login("throttled", "incorrect")).status);
    expect(codes.slice(0, 4)).not.toContain(429);
    expect(codes[5]).toBe(429);
    expect((await new Client().login("throttled", "correct-pw")).status).toBe(429);
    expect((await new Client().login("admin", "test1234")).status).toBe(303);
    expect((await query("SELECT username FROM audit_log WHERE action = 'login_failed'")).length).toBeGreaterThanOrEqual(5);
  });
});

describe("not served", () => {
  it("/openapi.json, /docs, /redoc and unknown paths are JSON 404 for everyone", async () => {
    for (const p of ["/openapi.json", "/docs", "/redoc", "/nope"]) {
      for (const res of [await api(p), await r.admin.get(p)]) {
        expect(res.status, p).toBe(404);
        expect(await res.json()).toEqual({ detail: "Not Found" });
      }
    }
    expect((await api("/static/style.css")).headers.get("content-type")).toMatch(/^text\/css/);
    expect((await api("/static/nope.css")).status).toBe(404);
  });
});

describe("xss (contract 9)", () => {
  it("payload names are escaped on every page, never inside a script or a raw attribute", async () => {
    const a = r.admin;
    // through the UI (so the audit log carries the payload too) and by row where the UI has no form
    const created = await post(a, "/playlists", { name: XSS + "pl" });
    expect(created.status).toBe(303);
    const xpid = Number(created.headers.get("location").split("/").pop());
    expect((await post(a, "/devices", { device_id: "xss-dev", name: XSS + "dev" })).status).toBe(303);
    expect((await post(a, "/groups", { name: XSS + "grp" })).status).toBe(303);
    expect((await post(a, "/users", { username: XSS + "usr", password: "pw123456", role: "viewer" })).status).toBe(400); // the username rule
    await ins("INSERT INTO users (username, password_hash, role) VALUES (?, 'x', 'viewer')", XSS + "usr"); // a row from before the rule
    await media(XSS + "media.png", "image", { filename: "xss.png" });
    const xdev = await one("SELECT id, device_id, token FROM devices WHERE device_id = 'xss-dev'");
    expect((await post(a, `/devices/${xdev.id}/schedule`, { name: XSS + "rule", playlist_id: String(xpid), priority: "1" })).status).toBe(303);
    expect((await api(`/api/sync/${xdev.device_id}?sync_error=${encodeURIComponent("<b>" + XSS)}`, { headers: bearer(xdev.token) })).status).toBe(200);

    const pages = ["/dashboard", "/library", "/playlists", `/playlists/${xpid}`, "/devices", `/devices/${xdev.id}/schedule`, "/groups", "/users", "/audit"];
    for (const p of pages) {
      const res = await a.get(p);
      expect(res.status, p).toBe(200);
      const html = await res.text();
      expect(html, `${p}: raw payload`).not.toContain(XSS);
      expect(html, `${p}: inline handler`).not.toMatch(/onsubmit=|onchange=|onclick=/);
      for (const m of html.matchAll(/alert\(1\)/g)) expect(html.slice(Math.max(0, m.index - 40), m.index), p).not.toContain("x');");
      for (const m of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) expect(m[1], `${p}: payload in script`).not.toContain("alert(1)");
      for (const m of html.matchAll(/data-confirm="([^"]*)"/g)) expect(m[1], `${p}: data-confirm`).not.toMatch(/['<>]/);
    }
    const expectConfirm = async (page, fragment) => {
      const confirms = [...(await (await a.get(page)).text()).matchAll(/data-confirm="([^"]*)"/g)].map((m) => m[1]);
      expect(confirms.some((c) => c.includes(fragment)), `${page}: ${fragment}`).toBe(true);
    };
    await expectConfirm("/playlists", "Delete playlist " + XSS_ESC + "pl");
    await expectConfirm("/devices", "Delete device " + XSS_ESC + "dev");
    await expectConfirm("/groups", "Delete " + XSS_ESC + "grp");
    await expectConfirm("/users", "Delete " + XSS_ESC + "usr");
    await expectConfirm("/library", "Delete " + XSS_ESC + "media.png");
    await expectConfirm(`/devices/${xdev.id}/schedule`, "Delete rule " + XSS_ESC + "rule");
    expect(await (await a.get("/devices")).text()).toContain("Sync problem: &lt;b&gt;" + XSS_ESC);
    const appJs = await (await api("/static/app.js")).text();
    expect(appJs).toContain("dataset.confirm");
    expect(appJs).toContain("preventDefault");
  });
});

describe("device api auth", () => {
  it("401 without / with a bad token, 403 for another device's id, cookies do not count", async () => {
    expect((await api(`/api/sync/${dev.device_id}`)).status).toBe(401);
    expect((await api(`/api/sync/${dev.device_id}`, { headers: bearer("nope") })).status).toBe(401);
    expect((await api(`/api/sync/${dev.device_id}`, { headers: { authorization: "Basic abc" } })).status).toBe(401);
    expect((await api(`/api/sync/${dev2.device_id}`, { headers: bearer(dev.token) })).status).toBe(403);
    expect((await r.admin.get(`/api/sync/${dev.device_id}`)).status).toBe(401);
    expect((await api(`/api/commands/1/result`, { method: "POST", body: "{}" })).status).toBe(401);
    expect((await shot({ device_id: dev.device_id, token: dev2.token }, jpeg(100))).status).toBe(403);
    expect((await shot({ device_id: dev.device_id, token: "nope" }, jpeg(100))).status).toBe(401);
  });
});

describe("media scoping and Range (contracts 6, 15)", () => {
  it("session or in-playlist device only; safe filenames; nosniff; 206/416; HEAD", async () => {
    expect((await api("/api/media/sec-a.mp4")).status).toBe(401);
    expect((await api("/api/media/sec-a.mp4", { headers: bearer("nope") })).status).toBe(401);
    expect((await r.admin.get("/api/media/..%2Fx")).status).toBe(400);
    expect((await r.admin.get("/api/media/a%20b.mp4")).status).toBe(400);
    expect((await r.admin.get("/api/media/missing.mp4")).status).toBe(404);
    const full = await r.viewer.get("/api/media/sec-a.mp4");
    expect(full.status).toBe(200);
    expect(full.headers.get("content-type")).toMatch(/^video\/mp4/);
    expect(full.headers.get("accept-ranges")).toBe("bytes");
    expect(full.headers.get("x-content-type-options")).toBe("nosniff");
    expect(full.headers.get("content-length")).toBe("1000");
    expect(full.headers.get("etag")).toBeTruthy();
    expect(full.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(new Uint8Array(await full.arrayBuffer())).toEqual(FULL);
    expect((await api("/api/media/sec-a.mp4", { headers: bearer(dev.token) })).status).toBe(200);
    expect((await api("/api/media/sec-b.png", { headers: bearer(dev.token) })).status).toBe(403);
    expect((await api("/api/media/sec-a.mp4", { headers: bearer(dev2.token) })).status).toBe(403);
    const head = await api("/api/media/sec-a.mp4", { method: "HEAD", headers: bearer(dev.token) });
    expect([head.status, head.headers.get("content-length")]).toEqual([200, "1000"]);
    expect((await head.arrayBuffer()).byteLength).toBe(0);
    let part = await api("/api/media/sec-a.mp4", { headers: { ...bearer(dev.token), range: "bytes=0-9" } });
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe("bytes 0-9/1000");
    expect(new Uint8Array(await part.arrayBuffer())).toEqual(FULL.slice(0, 10));
    part = await api("/api/media/sec-a.mp4", { headers: { ...bearer(dev.token), range: "bytes=900-" } });
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe("bytes 900-999/1000");
    expect(new Uint8Array(await part.arrayBuffer())).toEqual(FULL.slice(900));
    expect((await api("/api/media/sec-a.mp4", { headers: { ...bearer(dev.token), range: "bytes=1000-" } })).status).toBe(416);
    // scoping follows the schedule resolver
    const pidB = await playlist("sec-b");
    await ins("INSERT INTO playlist_items (playlist_id, media_id, position) VALUES (?, ?, 0)", pidB, mB);
    expect((await post(r.admin, `/devices/${dev.id}/schedule`, { name: "b-now", playlist_id: String(pidB), priority: "50" })).status).toBe(303);
    expect((await sync(dev).then((x) => x.json())).playlist.source).toBe("schedule:b-now");
    expect((await api("/api/media/sec-b.png", { headers: bearer(dev.token) })).status).toBe(200);
    expect((await api("/api/media/sec-a.mp4", { headers: bearer(dev.token) })).status).toBe(403);
    await env.DB.prepare("DELETE FROM device_schedules WHERE name = 'b-now'").run();
  });
});

describe("screenshots", () => {
  it("must start with FF D8 FF, are capped at PIPLAYER_MAX_SCREENSHOT_BYTES, served with nosniff/no-store", async () => {
    expect((await shot(dev, new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]))).status).toBe(400);
    expect((await shot(dev, new Uint8Array(0))).status).toBe(400);
    // A form with no file part at all is a 400.
    const noFile = new FormData();
    noFile.set("file", "not a file");
    expect((await api(`/api/screenshots/${dev.device_id}`, { method: "POST", body: noFile, headers: bearer(dev.token) })).status).toBe(400);
    expect((await r.admin.get(`/devices/${dev.id}/screenshot`)).status).toBe(404);
    // Like the CMS (web._receive_upload) the first file part is taken whatever its field name.
    expect((await shot(dev, jpeg(100), "other")).status).toBe(200);
    const max = parseInt(env.PIPLAYER_MAX_SCREENSHOT_BYTES, 10);
    expect((await shot(dev, jpeg(max + 1))).status).toBe(413);
    const ok = await shot(dev, jpeg(4096, 9));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true, size_bytes: 4096 });
    expect((await one("SELECT last_screenshot_at AS t FROM devices WHERE id = ?", dev.id)).t).toBeTruthy();
    const view = await r.editor.get(`/devices/${dev.id}/screenshot`);
    expect(view.status).toBe(200);
    expect(view.headers.get("content-type")).toMatch(/^image\/jpeg/);
    expect(view.headers.get("x-content-type-options")).toBe("nosniff");
    expect(view.headers.get("cache-control")).toContain("no-store");
    expect(new Uint8Array(await view.arrayBuffer())).toEqual(jpeg(4096, 9));
    const anon = await api(`/devices/${dev.id}/screenshot`);
    expect([anon.status, anon.headers.get("location")]).toEqual([303, "/login"]);
  });
});

describe("commands", () => {
  it("delivered at most 5 times, then closed as undeliverable and shown on /devices", async () => {
    expect((await post(r.editor, `/devices/${dev2.id}/command`, { command: "reboot" })).status).toBe(303);
    const cid = (await one("SELECT id FROM device_commands WHERE device_id = ? ORDER BY id DESC", dev2.id)).id;
    for (let n = 1; n <= 5; n++) {
      const m = await (await sync(dev2)).json();
      expect(m.commands.map((c) => c.id), `delivery ${n}`).toContain(cid);
      expect(m.commands[0]).toEqual({ id: cid, command: "reboot", issued_at: expect.any(String) });
    }
    expect((await (await sync(dev2)).json()).commands).toEqual([]);
    expect(await one("SELECT delivery_count, result FROM device_commands WHERE id = ?", cid))
      .toEqual({ delivery_count: 5, result: "undeliverable: no result after 5 deliveries" });
    const html = await (await r.editor.get("/devices")).text();
    expect(html).toContain("undeliverable: no result after 5 deliveries");
    expect(html).toContain("<details");
  });

  it("result: 400 non-object, 403 other device, 404 unknown, truncated to 1000 and stops delivery", async () => {
    await post(r.editor, `/devices/${dev2.id}/command`, { command: "force-sync" });
    const cid = (await one("SELECT id FROM device_commands WHERE device_id = ? ORDER BY id DESC", dev2.id)).id;
    const res = (token, body) => api(`/api/commands/${cid}/result`, { method: "POST", body, headers: { ...bearer(token), "content-type": "application/json" } });
    for (const body of ["notjson", '["list"]', "null", '"str"', ""]) expect((await res(dev2.token, body)).status, body).toBe(400);
    expect((await res(dev.token, '{"result":"x"}')).status).toBe(403);
    expect((await api(`/api/commands/${NOPE}/result`, { method: "POST", body: "{}", headers: bearer(dev2.token) })).status).toBe(404);
    expect((await (await sync(dev2)).json()).commands.map((c) => c.id)).toContain(cid);
    const ok = await res(dev2.token, JSON.stringify({ result: "R".repeat(1500) }));
    expect(await ok.json()).toEqual({ ok: true });
    expect((await one("SELECT length(result) AS n, completed_at FROM device_commands WHERE id = ?", cid)).n).toBe(1000);
    expect((await (await sync(dev2)).json()).commands.map((c) => c.id)).not.toContain(cid);
  });
});

describe("settings: site timezone", () => {
  it("drives server_time, displayed timestamps and schedule evaluation", async () => {
    const a = r.admin;
    expect((await settings(a, { timezone: "Not/AZone" })).status).toBe(400);
    expect((await settings(a, { screenshot_interval: "abc" })).status).toBe(400);
    expect((await settings(a, { default_image_duration: "0" })).status).toBe(400);
    expect((await settings(a, { timezone: "Asia/Tokyo", screenshot_interval: "45" })).status).toBe(303);
    const m = await (await sync(dev)).json();
    expect(m.server_time).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+09:00$/);
    expect(m.screenshot_interval_seconds).toBe(45);
    const html = await (await a.get("/devices")).text();
    expect(html).toContain("2026-01-05 21:00"); // dev3.last_seen_at 12:00 UTC rendered in Asia/Tokyo
    expect(html).toMatch(/GMT\+9|JST/);
    // a 2 h window around 'now' in UTC-12 matches; the same rule in UTC+14 (wall clock +26 h) does not
    expect((await settings(a, { timezone: "Etc/GMT+12" })).status).toBe(303);
    const h = (new Date().getUTCHours() + 12) % 24;
    const hh = (x) => String(x % 24).padStart(2, "0") + ":00";
    expect((await post(a, `/devices/${dev.id}/schedule`, { name: "tz", playlist_id: String(pid), priority: "77", start_time: hh(h), end_time: hh(h + 2) })).status).toBe(303);
    expect((await (await sync(dev)).json()).playlist.source).toBe("schedule:tz");
    expect((await settings(a, { timezone: "Etc/GMT-14" })).status).toBe(303);
    expect((await (await sync(dev)).json()).playlist.source).toBe("device-default");
    await env.DB.prepare("DELETE FROM device_schedules WHERE name = 'tz'").run();
    expect((await settings(a, {})).status).toBe(303);
    expect((await query("SELECT action FROM audit_log WHERE action = 'settings_update'")).length).toBeGreaterThan(0);
    expect((await settings(r.editor, {})).status).toBe(403);
  });
});

describe("audit", () => {
  it("is newest-first with id as tiebreak; limit is validated (1..1000)", async () => {
    for (let i = 0; i < 5; i++) await post(r.admin, "/playlists", { name: `audit-${i}` });
    const html = await (await r.admin.get("/audit?limit=1000")).text();
    const pos = [0, 1, 2, 3, 4].map((i) => html.indexOf(`audit-${i}`));
    expect(pos.every((p) => p >= 0)).toBe(true);
    expect(pos).toEqual([...pos].sort((x, y) => y - x));
    for (const l of ["0", "5000", "abc", "-1"]) expect((await r.admin.get(`/audit?limit=${l}`)).status, l).toBe(400);
    expect((await r.admin.get("/audit?limit=1")).status).toBe(200);
    expect((await r.viewer.get("/audit")).status).toBe(200);
  });
});

describe("validation sweep (contract 10)", () => {
  it("400 malformed, 404 missing rows, 409 friendly conflicts, never 500", async () => {
    const a = r.editor;
    const sched = (over) => post(a, `/devices/${dev.id}/schedule`, { name: "Rule", playlist_id: String(pid), priority: "10", ...over });
    for (const v of ["25:99", "24:00", "12:60", "7", "0800", "8am", "07:00:00", "junk", "1:5"]) {
      expect((await sched({ start_time: v })).status, v).toBe(400);
      expect((await sched({ end_time: v })).status, v).toBe(400);
    }
    expect(await detail(await sched({ start_time: "09:00", end_time: "09:00" }), 400)).toContain("Start and end must differ");
    for (const [f, v] of [["start_date", "2026-13-01"], ["start_date", "01/02/2026"], ["start_date", "2026-1-5"], ["end_date", "junk"], ["end_date", "2026-02-30"]]) {
      expect((await sched({ [f]: v })).status, `${f}=${v}`).toBe(400);
    }
    expect((await sched({ start_date: "2026-03-02", end_date: "2026-03-01" })).status).toBe(400);
    for (const v of ["-1", "1001", "abc"]) expect((await sched({ priority: v })).status, v).toBe(400);
    for (const v of ["abc", "1.0", "1e3", ""]) expect((await sched({ playlist_id: v })).status, v).toBe(400);
    expect((await sched({ playlist_id: String(NOPE) })).status).toBe(404);
    expect((await sched({ name: "norm", start_time: "7:05", end_time: "18:30", days_of_week: "531" })).status).toBe(303);
    expect(await one("SELECT start_time, end_time, days_of_week FROM device_schedules WHERE name = 'norm'"))
      .toEqual({ start_time: "07:05", end_time: "18:30", days_of_week: "135" });
    expect((await sched({ name: "wrap", start_time: "22:00", end_time: "02:00" })).status).toBe(303);
    await env.DB.prepare("DELETE FROM device_schedules WHERE name IN ('norm', 'wrap')").run();
    // a malformed stored row never 500s anything
    await ins("INSERT INTO device_schedules (device_id, playlist_id, name, priority, start_time, end_time) VALUES (?, ?, 'bad', 50, 'junk', '25:99')", dev.id, pid);
    expect((await a.get("/devices")).status).toBe(200);
    expect((await a.get(`/devices/${dev.id}/schedule`)).status).toBe(200);
    expect((await (await sync(dev)).json()).playlist.source).toBe("device-default");
    await env.DB.prepare("DELETE FROM device_schedules WHERE name = 'bad'").run();

    for (const bad of ["abc", "1.5", "1e3"]) expect((await post(a, `/devices/${dev.id}/assign`, { playlist_id: bad })).status, bad).toBe(400);
    expect((await post(a, `/devices/${dev.id}/assign`, { playlist_id: String(NOPE) })).status).toBe(404);
    expect((await post(a, `/devices/${dev.id}/group`, { group_id: "abc" })).status).toBe(400);
    expect((await post(a, `/devices/${dev.id}/group`, { group_id: String(NOPE) })).status).toBe(404);
    expect((await post(a, `/devices/${dev.id}/command`, { command: "rm-rf" })).status).toBe(400);
    expect((await post(a, "/devices", { device_id: "Bad_ID!", name: "x" })).status).toBe(400);
    expect((await post(a, "/devices", { device_id: dev.device_id, name: "again" })).status).toBe(409);
    const gid = await group("sec-grp");
    expect((await post(a, `/groups/${gid}/assign`, { playlist_id: "abc" })).status).toBe(400);
    expect((await post(a, `/groups/${gid}/assign`, { playlist_id: String(NOPE) })).status).toBe(404);
    expect(await detail(await post(a, "/groups", { name: "sec-grp" }), 409)).not.toMatch(/unique|sqlite|constraint/i);
    expect(await detail(await post(a, "/playlists", { name: "sec" }), 409)).not.toMatch(/unique|sqlite|constraint/i);
    expect((await post(a, `/playlists/${pid}/rename`, { name: "  " })).status).toBe(400);
    expect((await post(a, `/playlists/${pid}/items`, { media_id: "abc" })).status).toBe(400);
    expect((await post(a, `/playlists/${pid}/items`, { media_id: String(NOPE) })).status).toBe(404);
    expect((await post(a, `/playlists/${pid}/items`, { media_id: String(mA) })).status).toBe(409);
    for (const body of ["notjson", "[1, 2]", "null", '"str"', "42", ""]) {
      const res = await a.fetch(`/playlists/${pid}/items/reorder`, { method: "POST", body, headers: { "content-type": "application/json", "X-CSRF-Token": a.token } });
      expect(res.status, body).toBe(400);
    }
    for (const p of [{ order: "x" }, { order: [1, "a"] }, { nope: 1 }, { order: [] }]) expect((await postJson(a, `/playlists/${pid}/items/reorder`, p)).status).toBe(400);
    const iid = (await one("SELECT id FROM playlist_items WHERE playlist_id = ?", pid)).id;
    for (const v of ["inf", "Infinity", "1e999", "nan", "-1", "0", "abc", "86401"]) {
      expect((await post(a, `/playlists/${pid}/items/${iid}/duration`, { duration: v })).status, v).toBe(400);
    }
    expect((await post(a, `/playlists/${pid}/items/${iid}/duration`, { duration: "7.5" })).status).toBe(303);
    expect((await post(a, `/playlists/${pid}/items/${NOPE}/duration`, { duration: "5" })).status).toBe(404);
    // users (admin)
    expect((await post(r.admin, "/users", { username: "u", password: "short", role: "viewer" })).status).toBe(400);
    expect((await post(r.admin, "/users", { username: "u", password: "pw123456", role: "god" })).status).toBe(400);
    expect((await post(r.admin, "/users", { username: "u", password: "p".repeat(1025), role: "viewer" })).status).toBe(400);
    expect(await detail(await post(r.admin, "/users", { username: "vw", password: "pw123456", role: "viewer" }), 409)).not.toMatch(/unique|sqlite/i);
    const adminId = (await one("SELECT id FROM users WHERE username = 'admin'")).id;
    expect((await post(r.admin, `/users/${adminId}/role`, { role: "viewer" })).status).toBe(400);
    expect((await post(r.admin, `/users/${adminId}/delete`)).status).toBe(400);
    // uploads init
    const init = (o) => postJson(a, "/library/upload/init", { name: "x.png", size: 10, sha256: "a".repeat(64), media_type: "image", duration_seconds: null, width: 1, height: 1, ...o });
    expect((await init({ name: "x.exe" })).status).toBe(400);
    expect((await init({ sha256: "zz" })).status).toBe(400);
    expect((await init({ size: 0 })).status).toBe(400);
    expect([400, 413]).toContain((await init({ size: 5 * 1024 ** 3 + 1 })).status);
    expect((await a.get(`/library/upload/${NOPE}`)).status).toBe(404);
    // non-integer path ids
    for (const p of ["/playlists/abc", "/devices/abc/schedule"]) expect([400, 404]).toContain((await a.get(p)).status);
  });
});
