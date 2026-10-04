// Accounts end to end (migration 0016, src/accounts.js): two people sign up on their own (alice and
// bob, each a private space) and build the same things through the real forms and APIs: a
// projector flashed with the SD Flasher's sign-in, the same file uploaded, playlists (one with the
// same name in both), a group, a schedule rule, their own settings, alert webhook and API token.
// Then: every page lists only the reader's own things, every route given the other account's id
// answers exactly as it does for a missing id and changes nothing, each projector's manifest and
// media come from its own account only, the alert cron reports through the projector's own
// account, and the site admin sees every projector on the Devices page but nobody's content, and
// hands a projector over without it keeping the old account's playlists.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import * as alerts from "../src/alerts.js";
import { BASE, Client, query, setupAdmin } from "./helpers.js";

const NOPE = 999999;
const hex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
const digest = async (data) => hex(await crypto.subtle.digest("SHA-256", data));
const SAME = new Uint8Array(4096).map((_, i) => (i * 7 + 3) & 255); // the file both accounts upload
const OTHER = new Uint8Array(2048).map((_, i) => (i * 13 + 1) & 255);
const one = (sql, ...p) => query(sql, ...p).then((r) => r[0] ?? null);
const bearer = (t) => ({ authorization: `Bearer ${t}` });
const SETTINGS = { screenshot_interval: "60", camera_interval: "10", default_image_duration: "10" };

// The answer to a request, comparable across ids: status, redirect target and the JSON detail
// (error responses are JSON for a client that does not ask for HTML).
async function answer(res) {
  const type = res.headers.get("content-type") || "";
  return { status: res.status, location: res.headers.get("location"), body: type.includes("json") ? await res.json() : (await res.text()).length > 0 };
}

const post = (c, path, fields = {}) => c.post(path, fields, { "X-CSRF-Token": c.token });
const postJson = (c, path, data) => c.postJson(path, data, { "X-CSRF-Token": c.token });

async function signup(username) {
  const c = new Client();
  const csrf_token = await c.csrf("/signup");
  const res = await c.post("/signup", { username, email: `${username}@example.net`, password: `${username}-pass`, password2: `${username}-pass`, csrf_token });
  expect([res.status, res.headers.get("location")]).toEqual([303, "/dashboard"]);
  c.token = await c.csrf("/dashboard");
  c.id = (await one("SELECT id FROM users WHERE username = ?", username)).id;
  c.name = username;
  return c;
}

// The upload protocol of the Library page (uploads.js), whole file in one part.
async function upload(c, name, data) {
  let res = await postJson(c, "/library/upload/init", { name, size: data.length, sha256: await digest(data), media_type: "image", width: 10, height: 10 });
  if (res.status !== 200) return res;
  const { upload_id } = await res.json();
  res = await c.fetch(`/library/upload/${upload_id}/part/1`, { method: "PUT", body: data, headers: { "X-CSRF-Token": c.token } });
  expect(res.status).toBe(200);
  return postJson(c, `/library/upload/${upload_id}/complete`, {});
}

// Everything one account builds, through the same routes a person or the flasher uses.
async function build(c) {
  const w = { c };
  const p = c.name; // every name carries the account's name, so a page leaking one is easy to spot
  expect((await upload(c, `${p}-clip.png`, SAME)).status).toBe(200);
  w.media = await one("SELECT id, filename FROM media WHERE owner_id = ?", c.id);
  // a playlist named like the other account's, and one of its own name
  expect((await post(c, "/playlists", { name: "Lobby" })).status).toBe(303);
  const res = await post(c, "/playlists", { name: `${p}-loop` });
  w.pid = Number(res.headers.get("location").split("/").pop());
  expect((await post(c, `/playlists/${w.pid}/items`, { media_id: String(w.media.id) })).status).toBe(303);
  w.item = (await one("SELECT id FROM playlist_items WHERE playlist_id = ?", w.pid)).id;
  expect((await post(c, "/groups", { name: `${p}-group` })).status).toBe(303);
  w.gid = (await one("SELECT id FROM device_groups WHERE owner_id = ?", c.id)).id;
  expect((await post(c, `/groups/${w.gid}/assign`, { playlist_id: String(w.pid) })).status).toBe(303);
  // the projector, as the SD Flasher registers it
  const login = await SELF.fetch(`${BASE}/api/operator/login`, { method: "POST", body: JSON.stringify({ username: p, password: `${p}-pass`, hostname: `${p}-pc` }), headers: { "content-type": "application/json" } });
  w.operator = (await login.json()).token;
  const reg = await SELF.fetch(`${BASE}/api/operator/devices`, { method: "POST", body: JSON.stringify({ device_id: `${p}-proj`, name: `${p} projector` }), headers: { "content-type": "application/json", ...bearer(w.operator) } });
  expect(reg.status).toBe(201);
  w.deviceToken = (await reg.json()).token;
  w.dev = await one("SELECT id, device_id FROM devices WHERE device_id = ?", `${p}-proj`);
  expect((await post(c, `/devices/${w.dev.id}/group`, { group_id: String(w.gid) })).status).toBe(303);
  expect((await post(c, `/devices/${w.dev.id}/assign`, { playlist_id: String(w.pid) })).status).toBe(303);
  expect((await post(c, `/devices/${w.dev.id}/schedule`, { name: `${p}-rule`, playlist_id: String(w.pid), priority: "5", start_date: "2099-01-01" })).status).toBe(303);
  w.rule = (await one("SELECT id FROM device_schedules WHERE device_id = ?", w.dev.id)).id;
  // its own settings, alert channels and API token
  expect((await post(c, "/settings", { ...SETTINGS, timezone: p === "alice" ? "Europe/Paris" : "Asia/Tokyo" })).status).toBe(303);
  expect((await post(c, "/settings/alerts", { alert_offline_minutes: "10", alert_repeat_minutes: "0", alert_email: `${p}-alerts@example.net`, alert_webhook_url: `https://hooks.example.net/${p}` })).status).toBe(303);
  expect((await post(c, "/settings/tokens", { name: `${p}-laptop` })).status).toBe(200);
  w.token = (await one("SELECT id FROM api_tokens WHERE user_id = ? AND name = ?", c.id, `${p}-laptop`)).id;
  // an upload left in flight
  const init = await postJson(c, "/library/upload/init", { name: `${p}-half.png`, size: OTHER.length, sha256: await digest(OTHER), media_type: "image" });
  w.upload = (await init.json()).upload_id;
  return w;
}

// What one account holds, row by row, to prove another account's requests changed none of it.
async function snapshot(w) {
  const id = w.c.id;
  return {
    media: await query("SELECT * FROM media WHERE owner_id = ? ORDER BY id", id),
    playlists: await query("SELECT * FROM playlists WHERE owner_id = ? ORDER BY id", id),
    items: await query("SELECT pi.* FROM playlist_items pi JOIN playlists p ON p.id = pi.playlist_id WHERE p.owner_id = ? ORDER BY pi.id", id),
    groups: await query("SELECT * FROM device_groups WHERE owner_id = ? ORDER BY id", id),
    devices: await query("SELECT id, name, token, owner_id, playlist_id, group_id, camera_source, camera_live_url, projector_control, tunnel_id FROM devices WHERE owner_id = ? ORDER BY id", id),
    rules: await query("SELECT s.* FROM device_schedules s JOIN devices d ON d.id = s.device_id WHERE d.owner_id = ? ORDER BY s.id", id),
    commands: await query("SELECT c.* FROM device_commands c JOIN devices d ON d.id = c.device_id WHERE d.owner_id = ? ORDER BY c.id", id),
    settings: await query("SELECT * FROM account_settings WHERE user_id = ? ORDER BY key", id),
    tokens: await query("SELECT * FROM api_tokens WHERE user_id = ? ORDER BY id", id),
    uploads: await query("SELECT id, received, parts FROM uploads WHERE user_id = ? ORDER BY id", id),
  };
}

let admin, a, b;
const markers = (w) => [`${w.c.name}-clip`, `${w.c.name}-loop`, `${w.c.name}-group`, `${w.c.name} projector`, `${w.c.name}-proj`, `${w.c.name}-rule`,
  `${w.c.name}-alerts@example.net`, `hooks.example.net/${w.c.name}`, `${w.c.name}-laptop`, `${w.c.name}-half`, w.media.filename];

beforeAll(async () => {
  admin = await setupAdmin("admin", "test1234");
  admin.token = await admin.csrf("/dashboard");
  admin.id = (await one("SELECT id FROM users WHERE username = 'admin'")).id;
  a = await build(await signup("alice"));
  b = await build(await signup("bob"));
});

afterEach(() => vi.unstubAllGlobals());

describe("each sign-up is its own account", () => {
  it("has its own Default playlist, holding its own upload of the same file", async () => {
    const defaults = [];
    for (const w of [a, b]) {
      const pid = Number((await one("SELECT value FROM account_settings WHERE user_id = ? AND key = 'default_playlist_id'", w.c.id)).value);
      expect(await one("SELECT name, owner_id FROM playlists WHERE id = ?", pid)).toEqual({ name: "Default", owner_id: w.c.id });
      expect(await query("SELECT media_id FROM playlist_items WHERE playlist_id = ?", pid)).toEqual([{ media_id: w.media.id }]);
      defaults.push(pid);
      w.defaultPid = pid;
    }
    expect(defaults[0]).not.toBe(defaults[1]);
  });

  it("the same file is two library entries and two objects; refused again only in the account that has it", async () => {
    expect(a.media.filename).not.toBe(b.media.filename);
    for (const w of [a, b]) expect((await env.MEDIA.head(`media/${w.media.filename}`)).size).toBe(SAME.length);
    const again = await upload(a.c, "again.png", SAME);
    expect([again.status, await again.json()]).toEqual([409, { detail: "Already in the library as 'alice-clip.png'." }]);
  });

  it("names are per account: both have a Lobby and a Default", async () => {
    for (const name of ["Lobby", "Default"]) {
      expect((await query("SELECT owner_id FROM playlists WHERE name = ? AND owner_id IN (?, ?) ORDER BY owner_id", name, a.c.id, b.c.id)).map((x) => x.owner_id)).toEqual([a.c.id, b.c.id]);
    }
  });
});

describe("pages list only the reader's own things", () => {
  const pages = (w) => ["/dashboard", "/library", "/playlists", `/playlists/${w.pid}`, "/groups", "/devices", `/devices/${w.dev.id}/schedule`,
    "/alerts", "/audit?limit=1000", "/settings", "/flasher"];

  it("alice's pages never name bob's things and bob's never alice's", async () => {
    for (const [me, them] of [[a, b], [b, a]]) {
      for (const path of pages(me)) {
        const res = await me.c.get(path);
        expect(res.status, path).toBe(200);
        const html = await res.text();
        for (const m of markers(them)) expect(html, `${me.c.name} ${path} shows ${m}`).not.toContain(m);
      }
      // and they do show its own
      const all = (await Promise.all(pages(me).map(async (p) => (await me.c.get(p)).text()))).join("\n");
      for (const m of markers(me).filter((x) => !x.endsWith("-half") && x !== me.media.filename)) expect(all, `${me.c.name} misses ${m}`).toContain(m);
    }
  });

  it("the dashboard counts its own library, playlists, projectors and alerts", async () => {
    const page = await (await a.c.get("/dashboard")).text();
    expect(page).toMatch(/<span class="card-label">media files<\/span>\s*<span class="card-value">1<\/span>/);
    expect(page).toMatch(/<span class="card-label">playlists<\/span>\s*<span class="card-value">3<\/span>/); // Default, Lobby, alice-loop
    expect(page).toMatch(/<span class="card-label">devices<\/span>\s*<span class="card-value">1<\/span>/);
  });

  it("the operator API lists its own groups and playlists; a projector id is the one thing the id namespace shares", async () => {
    const me = await (await SELF.fetch(`${BASE}/api/operator/me`, { headers: bearer(a.operator) })).json();
    expect(me.groups).toEqual([{ id: a.gid, name: "alice-group" }]);
    expect(me.playlists.map((p) => p.name)).toEqual(["Default", "Lobby", "alice-loop"]);
    expect(me.timezone).toBe("Europe/Paris");
    // device ids are global (the Pi uses its id in every URL): a taken one says so, naming nothing
    const res = await SELF.fetch(`${BASE}/api/operator/devices/bob-proj`, { headers: bearer(a.operator) });
    expect([res.status, await res.json()]).toEqual([409, { detail: "A projector with that ID belongs to another account; pick another name" }]);
  });
});

describe("another account's id answers exactly like a missing one and changes nothing", () => {
  it("every page, form and API route", async () => {
    const before = await snapshot(b);
    const missingUpload = b.upload.slice(0, -1) + (b.upload.endsWith("A") ? "B" : "A");
    const missingFile = b.media.filename.replace(/^[0-9a-f]{4}/, "ffff");
    // [method, path, body] with B standing for bob's id and N for a missing one
    const routes = (B, N) => [
      ["GET", `/playlists/${B.pid}`],
      ["GET", `/devices/${B.dev}/schedule`],
      ["GET", `/devices/${B.dev}/screenshot`],
      ["GET", `/devices/${B.dev}/camera`],
      ["GET", `/library/upload/${B.upload}`],
      ["GET", `/api/media/${B.file}`],
      ["POST", `/playlists/${B.pid}/rename`, { name: "taken over" }],
      ["POST", `/playlists/${B.pid}/delete`],
      ["POST", `/playlists/${B.pid}/items`, { media_id: String(a.media.id) }],
      ["POST", `/playlists/${a.pid}/items`, { media_id: String(B.media) }],
      ["POST", `/playlists/${B.pid}/items/${B.item}/duration`, { duration: "5" }],
      ["POST", `/playlists/${a.pid}/items/${B.item}/duration`, { duration: "5" }],
      ["POST", `/playlists/${B.pid}/items/${B.item}/delete`],
      ["POST", `/playlists/${a.pid}/items/${B.item}/delete`],
      ["JSON", `/playlists/${B.pid}/items/reorder`, { order: [B.item] }],
      ["POST", `/groups/${B.gid}/assign`, { playlist_id: String(a.pid) }],
      ["POST", `/groups/${a.gid}/assign`, { playlist_id: String(B.pid) }],
      ["POST", `/groups/${B.gid}/delete`],
      ["POST", `/library/${B.media}/delete`],
      ["POST", `/devices/${B.dev}/rename`, { name: "taken over" }],
      ["POST", `/devices/${B.dev}/assign`, { playlist_id: String(a.pid) }],
      ["POST", `/devices/${B.dev}/group`, { group_id: String(a.gid) }],
      ["POST", `/devices/${a.dev.id}/assign`, { playlist_id: String(B.pid) }],
      ["POST", `/devices/${a.dev.id}/group`, { group_id: String(B.gid) }],
      ["POST", `/devices/${B.dev}/regen-token`],
      ["POST", `/devices/${B.dev}/command`, { command: "reboot" }],
      ["POST", `/devices/${B.dev}/command/cancel`],
      ["POST", `/devices/${B.dev}/camera-url`, { camera_live_url: "https://cam.example.net/" }],
      ["POST", `/devices/${B.dev}/camera-source`, { camera_source: "none" }],
      ["POST", `/devices/${B.dev}/projector`, { projector_control: "cec", projector_power_mode: "auto" }],
      ["POST", `/devices/${B.dev}/tunnel`],
      ["POST", `/devices/${B.dev}/owner`, { owner_id: String(a.c.id) }],
      ["POST", `/devices/${B.dev}/schedule`, { name: "x", playlist_id: String(a.pid), priority: "1" }],
      ["POST", `/devices/${a.dev.id}/schedule`, { name: "x", playlist_id: String(B.pid), priority: "1" }],
      ["POST", `/devices/${B.dev}/schedule/${B.rule}/delete`],
      ["POST", `/devices/${a.dev.id}/schedule/${B.rule}/delete`],
      ["POST", `/devices/${B.dev}/delete`],
      ["POST", `/settings/tokens/${B.token}/revoke`],
      ["PUT", `/library/upload/${B.upload}/part/1`, OTHER],
      ["JSON", `/library/upload/${B.upload}/complete`, {}],
      ["JSON", `/library/upload/${B.upload}/abort`, {}],
    ];
    const send = (c, [method, path, body]) => {
      if (method === "GET") return c.get(path);
      if (method === "JSON") return postJson(c, path, body);
      if (method === "PUT") return c.fetch(path, { method: "PUT", body, headers: { "X-CSRF-Token": c.token } });
      return post(c, path, body);
    };
    const B = { pid: b.pid, dev: b.dev.id, upload: b.upload, file: b.media.filename, media: b.media.id, item: b.item, gid: b.gid, rule: b.rule, token: b.token };
    const N = { pid: NOPE, dev: NOPE, upload: missingUpload, file: missingFile, media: NOPE, item: NOPE, gid: NOPE, rule: NOPE, token: NOPE };
    const theirs = routes(B, N);
    const missing = routes(N, N);
    for (let i = 0; i < theirs.length; i++) {
      const got = await answer(await send(a.c, theirs[i]));
      const want = await answer(await send(a.c, missing[i]));
      expect(got, `${theirs[i][0]} ${theirs[i][1]}`).toEqual(want);
      expect(got.status, `${theirs[i][0]} ${theirs[i][1]}`).toBeGreaterThanOrEqual(400);
    }
    expect(await snapshot(b)).toEqual(before);
  });

  it("a projector's token reaches neither another projector nor another account's file", async () => {
    for (const path of [`/api/sync/${b.dev.device_id}`, `/api/camera-config/${b.dev.device_id}`]) {
      const theirs = await answer(await SELF.fetch(`${BASE}${path}`, { headers: bearer(a.deviceToken) }));
      const missing = await answer(await SELF.fetch(`${BASE}${path.replace("bob-proj", "nobody-proj")}`, { headers: bearer(a.deviceToken) }));
      expect(theirs).toEqual(missing);
      expect(theirs.status).toBe(403);
    }
    const theirs = await answer(await SELF.fetch(`${BASE}/api/media/${b.media.filename}`, { headers: bearer(a.deviceToken) }));
    const missing = await answer(await SELF.fetch(`${BASE}/api/media/${b.media.filename.replace(/^[0-9a-f]{4}/, "ffff")}`, { headers: bearer(a.deviceToken) }));
    expect(theirs).toEqual(missing);
    expect(theirs.status).toBe(403);
  });
});

describe("projectors play their own account's content", () => {
  it("each manifest holds its own playlist and file only, in its own zone", async () => {
    for (const [w, them, offset] of [[a, b, /\+0[12]:00$/], [b, a, /\+09:00$/]]) {
      const res = await SELF.fetch(`${BASE}/api/sync/${w.dev.device_id}`, { headers: bearer(w.deviceToken) });
      expect(res.status).toBe(200);
      const text = await res.text();
      const m = JSON.parse(text);
      expect([m.playlist.id, m.playlist.name, m.playlist.source]).toEqual([w.pid, `${w.c.name}-loop`, "device-default"]);
      expect(m.playlist.items.map((i) => [i.filename, i.url])).toEqual([[w.media.filename, `${BASE}/api/media/${w.media.filename}`]]);
      expect(m.server_time).toMatch(offset);
      for (const x of markers(them)) expect(text).not.toContain(x);
      // the file it plays downloads with its token
      expect((await SELF.fetch(`${BASE}/api/media/${w.media.filename}`, { headers: bearer(w.deviceToken) })).status).toBe(200);
    }
  });

  it("the alert cron reports each projector through its own account's channels", async () => {
    const calls = [];
    vi.stubGlobal("fetch", async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(init.body).text });
      return new Response("{}", { status: 200 });
    });
    await query("UPDATE devices SET last_seen_at = datetime('now', '-2 hours') WHERE id IN (?, ?)", a.dev.id, b.dev.id);
    const result = await alerts.evaluate(env);
    expect(result.opened).toBe(2);
    const to = (who) => calls.filter((c) => c.url === `https://hooks.example.net/${who}`);
    for (const [me, them] of [["alice", "bob"], ["bob", "alice"]]) {
      expect(to(me)).toHaveLength(1);
      expect(to(me)[0].body).toContain(`${me}-proj`);
      expect(to(me)[0].body).not.toContain(`${them}-proj`);
    }
    expect(calls).toHaveLength(2);
    // and each sees its own alert, not the other's
    const page = await (await a.c.get("/alerts")).text();
    expect(page).toContain("<strong>1 open</strong>");
    expect(page).not.toContain("bob-proj");
    await query("UPDATE devices SET last_seen_at = datetime('now') WHERE id IN (?, ?)", a.dev.id, b.dev.id);
  });
});

describe("the site admin", () => {
  it("sees every projector on the Devices page, nobody's library, playlists, groups or settings", async () => {
    const devices = await (await admin.get("/devices")).text();
    for (const w of [a, b]) {
      expect(devices).toContain(`<code>${w.dev.device_id}</code>`);
      expect(devices).toContain(` · ${w.c.name}</span>`); // its owner
      expect(devices).not.toContain(`action="/devices/${w.dev.id}/assign"`); // what it plays is its account's
      expect(devices).not.toContain(w.deviceToken);
    }
    for (const path of ["/dashboard", "/library", "/playlists", "/groups", "/alerts", "/settings", "/audit?limit=1000"]) {
      const html = await (await admin.get(path)).text();
      for (const w of [a, b]) {
        for (const m of [`${w.c.name}-clip`, `${w.c.name}-loop`, `${w.c.name}-group`, `${w.c.name}-alerts@example.net`, `${w.c.name}-laptop`, w.media.filename]) {
          expect(html, `admin ${path} shows ${m}`).not.toContain(m);
        }
      }
    }
    for (const path of [`/playlists/${a.pid}`, `/api/media/${a.media.filename}`]) expect((await admin.get(path)).status, path).toBe(404);
  });

  it("hands alice's projector to bob: it keeps nothing of alice's and plays bob's Default", async () => {
    expect((await post(admin, `/devices/${a.dev.id}/owner`, { owner_id: String(b.c.id) })).status).toBe(303);
    expect(await one("SELECT owner_id, playlist_id, group_id FROM devices WHERE id = ?", a.dev.id)).toEqual({ owner_id: b.c.id, playlist_id: null, group_id: null });
    expect(await query("SELECT id FROM device_schedules WHERE device_id = ?", a.dev.id)).toEqual([]);
    const [del] = await query("SELECT details, owner_id FROM audit_log WHERE action = 'device_schedule_delete' ORDER BY id DESC LIMIT 1");
    expect(JSON.parse(del.details)).toEqual({ device_id: a.dev.id, name: "alice-rule", cascade_from_owner_change: true });
    expect(del.owner_id).toBe(a.c.id);
    const m = await (await SELF.fetch(`${BASE}/api/sync/${a.dev.device_id}`, { headers: bearer(a.deviceToken) })).json();
    expect([m.playlist.id, m.playlist.source]).toEqual([b.defaultPid, "site-default"]);
    expect(m.playlist.items.map((i) => i.filename)).toEqual([b.media.filename]);
    expect(m.server_time).toMatch(/\+09:00$/); // bob's zone now
    // alice no longer sees it; bob does, and may now pick what it plays
    expect((await a.c.get(`/devices/${a.dev.id}/schedule`)).status).toBe(404);
    expect(await (await a.c.get("/devices")).text()).not.toContain("alice-proj");
    expect((await post(b.c, `/devices/${a.dev.id}/assign`, { playlist_id: String(b.pid) })).status).toBe(303);
    expect(await (await b.c.get("/devices")).text()).toContain(`<code>alice-proj</code>`);
  });
});
