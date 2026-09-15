// Device API: sync status + manifest, command delivery cap (contract 4), sync_error
// (contract 5), command results, screenshot upload, docs routes 404.
import { beforeAll, describe, expect, it, vi } from "vitest";
import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { BASE, query, setupAdmin } from "./helpers.js";

const SHA = (c) => c.repeat(64);
const UNDELIVERABLE = "undeliverable: no result after 5 deliveries";
const ins = async (sql, ...p) => (await env.DB.prepare(sql).bind(...p).run()).meta.last_row_id;
const one = (sql, ...p) => query(sql, ...p).then((r) => r[0]);
const bearer = (token) => ({ authorization: `Bearer ${token}` });
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]);

const ids = {};
let admin;

function sync(dev, params = {}, headers = {}) {
  const qs = new URLSearchParams(params).toString();
  return SELF.fetch(`${BASE}/api/sync/${dev.device_id}${qs ? "?" + qs : ""}`,
    { headers: { ...bearer(dev.token), ...headers } });
}

function postShot(dev, bytes, headers = {}) {
  const fd = new FormData();
  fd.append("file", new Blob([bytes], { type: "image/jpeg" }), `${dev.device_id}.jpg`);
  return SELF.fetch(`${BASE}/api/screenshots/${dev.device_id}`, { method: "POST", body: fd, headers: { ...bearer(dev.token), ...headers } });
}

function postResult(dev, cmdId, body, raw = false) {
  return SELF.fetch(`${BASE}/api/commands/${cmdId}/result`, {
    method: "POST", headers: { ...bearer(dev.token), "content-type": "application/json" },
    body: raw ? body : JSON.stringify(body),
  });
}

async function issue(dev, command = "force-sync") {
  return ins("INSERT INTO device_commands (device_id, command) VALUES (?, ?)", dev.id, command);
}

beforeAll(async () => {
  admin = await setupAdmin("admin", "test1234");
  ids.pl = await ins("INSERT INTO playlists (name) VALUES ('A')");
  ids.media = await ins(`INSERT INTO media (filename, original_name, media_type, size_bytes, sha256)
                         VALUES ('i.png', 'i.png', 'image', 50, ?)`, SHA("2"));
  await ins("INSERT INTO playlist_items (playlist_id, media_id, position) VALUES (?, ?, 0)", ids.pl, ids.media);
  ids.dev = { id: await ins("INSERT INTO devices (device_id, name, token, playlist_id) VALUES ('dev-1', 'Dev 1', 'tok-1', ?)", ids.pl), device_id: "dev-1", token: "tok-1" };
  ids.other = { id: await ins("INSERT INTO devices (device_id, name, token) VALUES ('dev-2', 'Dev 2', 'tok-2')"), device_id: "dev-2", token: "tok-2" };
});

describe("auth", () => {
  it("health needs nothing; sync needs a matching bearer token", async () => {
    expect(await (await SELF.fetch(`${BASE}/api/health`)).json()).toEqual({ ok: true });
    let r = await SELF.fetch(`${BASE}/api/sync/dev-1`);
    expect(r.status).toBe(401);
    expect(await r.json()).toEqual({ detail: "Missing bearer token" });
    r = await SELF.fetch(`${BASE}/api/sync/dev-1`, { headers: bearer("nope") });
    expect(r.status).toBe(401);
    r = await sync({ device_id: "dev-1", token: "tok-2" });
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ detail: "Token does not match device id" });
  });

  it("docs routes are 404", async () => {
    for (const p of ["/openapi.json", "/docs", "/redoc"]) {
      expect((await SELF.fetch(BASE + p)).status, p).toBe(404);
    }
  });
});

describe("sync", () => {
  it("records status and returns the manifest", async () => {
    const r = await sync(ids.dev, { current_position: "0", current_filename: "i.png", player_status: "playing", player_version: "test-0.0.1" },
      { "cf-connecting-ip": "203.0.113.9" });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("application/json");
    const text = await r.text();
    // byte-identical to FastAPI's JSONResponse: compact separators, floats printed like Python
    expect(text).toContain('"effective_duration_seconds":10.0,');
    expect(text).toContain('"natural_duration_seconds":null,');
    const m = JSON.parse(text);
    expect(m.device).toEqual({ id: "dev-1", name: "Dev 1" });
    expect(m.playlist.id).toBe(ids.pl);
    expect(m.playlist.source).toBe("device-default");
    expect(m.playlist.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(m.playlist.items[0].url).toBe(`${BASE}/api/media/i.png`);
    expect(m.playlist.items[0].effective_duration_seconds).toBe(10);
    expect(m.screenshot_interval_seconds).toBe(60);
    expect(m.server_time).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
    expect(m.commands).toEqual([]);
    const row = await one("SELECT current_position, current_filename, player_status, player_version, last_seen_at, last_ip FROM devices WHERE id = ?", ids.dev.id);
    expect(row).toMatchObject({ current_position: 0, current_filename: "i.png", player_status: "playing", player_version: "test-0.0.1", last_ip: "203.0.113.9" });
    expect(row.last_seen_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    // omitted player_version keeps the old one (COALESCE)
    await sync(ids.dev, { player_status: "idle" });
    expect(await one("SELECT player_version, player_status FROM devices WHERE id = ?", ids.dev.id)).toEqual({ player_version: "test-0.0.1", player_status: "idle" });
  });

  it("non-integer current_position is the fixed CMS's 400 {detail: 'query.<name>: <msg>'}", async () => {
    for (const bad of ["abc", "1.5", "", "1.", "1e3"]) {
      const r = await sync(ids.dev, { current_position: bad });
      expect(r.status, bad).toBe(400);
      expect(await r.json()).toEqual({
        detail: "query.current_position: Input should be a valid integer, unable to parse string as an integer",
      });
    }
    // pydantic's lax int
    for (const [ok, want] of [[" 7 ", 7], ["+5", 5], ["007", 7], ["1.0", 1], ["-2.00", -2]]) {
      expect((await sync(ids.dev, { current_position: ok })).status, ok).toBe(200);
      expect((await one("SELECT current_position FROM devices WHERE id = ?", ids.dev.id)).current_position, ok).toBe(want);
    }
  });

  it("device with nothing assigned gets a null playlist", async () => {
    const m = await (await sync(ids.other)).json();
    expect(m.playlist).toBeNull();
  });

  it("stores sync_error (capped at 200, cleared by empty/omitted)", async () => {
    const msg = "2 of 5 items missing: a.mp4, b.png";
    expect((await sync(ids.dev, { sync_error: msg })).status).toBe(200);
    expect((await one("SELECT last_error FROM devices WHERE id = ?", ids.dev.id)).last_error).toBe(msg);
    await sync(ids.dev, { sync_error: "" });
    expect((await one("SELECT last_error FROM devices WHERE id = ?", ids.dev.id)).last_error).toBeNull();
    await sync(ids.dev, { sync_error: "x".repeat(300) });
    expect((await one("SELECT last_error FROM devices WHERE id = ?", ids.dev.id)).last_error.length).toBe(200);
    await sync(ids.dev);
    expect((await one("SELECT last_error FROM devices WHERE id = ?", ids.dev.id)).last_error).toBeNull();
  });
});

describe("commands", () => {
  it("is delivered at most five times, then closed as undeliverable (warned like api.py)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cmdId = await issue(ids.dev, "reboot");
    for (let n = 1; n <= 5; n++) {
      const m = await (await sync(ids.dev)).json();
      const cmd = m.commands.find((c) => c.id === cmdId);
      expect(cmd, `delivery ${n}`).toMatchObject({ id: cmdId, command: "reboot" });
      expect(cmd.issued_at).toMatch(/^\d{4}-\d{2}-\d{2} /);
      const row = await one("SELECT delivery_count, delivered_at, completed_at FROM device_commands WHERE id = ?", cmdId);
      expect(row.delivery_count).toBe(n);
      expect(row.delivered_at).not.toBeNull();
      expect(row.completed_at).toBeNull();
    }
    let m = await (await sync(ids.dev)).json();
    expect(m.commands.map((c) => c.id)).not.toContain(cmdId);
    const row = await one("SELECT delivery_count, completed_at, result FROM device_commands WHERE id = ?", cmdId);
    expect(row).toMatchObject({ delivery_count: 5, result: UNDELIVERABLE });
    expect(row.completed_at).not.toBeNull();
    expect(warn).toHaveBeenCalledWith(`command ${cmdId} (reboot) for device ${ids.dev.id} closed as undeliverable`);
    m = await (await sync(ids.dev)).json();
    expect(m.commands.map((c) => c.id)).not.toContain(cmdId);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("a reported result stops delivery; result is truncated to 1000 chars", async () => {
    const cmdId = await issue(ids.dev);
    let m = await (await sync(ids.dev)).json();
    expect(m.commands.some((c) => c.id === cmdId && c.command === "force-sync")).toBe(true);
    const r = await postResult(ids.dev, cmdId, { result: "queued resync" });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
    const row = await one("SELECT completed_at, result FROM device_commands WHERE id = ?", cmdId);
    expect(row.result).toBe("queued resync");
    expect(row.completed_at).not.toBeNull();
    m = await (await sync(ids.dev)).json();
    expect(m.commands.map((c) => c.id)).not.toContain(cmdId);

    const long = await issue(ids.dev);
    await postResult(ids.dev, long, { result: "y".repeat(1500) });
    expect((await one("SELECT result FROM device_commands WHERE id = ?", long)).result.length).toBe(1000);
    const none = await issue(ids.dev);
    await postResult(ids.dev, none, {});
    expect((await one("SELECT result FROM device_commands WHERE id = ?", none)).result).toBe("");
  });

  it("result: 404 unknown, 403 other device, 400 non-JSON / non-object / bad id, 401 no token", async () => {
    const cmdId = await issue(ids.dev);
    expect((await postResult(ids.dev, 999999, { result: "x" })).status).toBe(404);
    expect((await postResult(ids.other, cmdId, { result: "x" })).status).toBe(403);
    let r = await postResult(ids.dev, cmdId, "notjson", true);
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ detail: "body must be a JSON object" });
    expect((await postResult(ids.dev, cmdId, ["list"])).status).toBe(400);
    expect((await postResult(ids.dev, cmdId, null)).status).toBe(400);
    for (const bad of ["abc", "1.5"]) {
      r = await postResult(ids.dev, bad, { result: "x" });
      expect(r.status, bad).toBe(400); // FastAPI's `command_id: int` path param through the CMS's handler
      expect(await r.json()).toEqual({ detail: "path.command_id: Input should be a valid integer, unable to parse string as an integer" });
    }
    // auth is resolved before the path parses (FastAPI solves Depends first)
    r = await SELF.fetch(`${BASE}/api/commands/abc/result`, { method: "POST", body: "{}", headers: { "content-type": "application/json" } });
    expect(r.status).toBe(401);
    r = await SELF.fetch(`${BASE}/api/commands/${cmdId}/result`, { method: "POST", body: "{}", headers: { "content-type": "application/json" } });
    expect(r.status).toBe(401);
    expect((await one("SELECT completed_at FROM device_commands WHERE id = ?", cmdId)).completed_at).toBeNull();
  });
});

describe("screenshots", () => {
  it("must be a JPEG, are stored in R2 and stamp last_screenshot_at", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    let r = await postShot(ids.dev, png);
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ detail: "screenshot must be a JPEG image" });
    expect(await env.MEDIA.head("screenshots/dev-1.jpg")).toBeNull();
    expect((await one("SELECT last_screenshot_at FROM devices WHERE id = ?", ids.dev.id)).last_screenshot_at).toBeNull();
    expect((await postShot(ids.dev, new Uint8Array(0))).status).toBe(400);

    r = await postShot(ids.dev, JPEG);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, size_bytes: JPEG.length });
    const obj = await env.MEDIA.get("screenshots/dev-1.jpg");
    expect(new Uint8Array(await obj.arrayBuffer())).toEqual(JPEG);
    expect(obj.httpMetadata.contentType).toBe("image/jpeg");
    expect((await one("SELECT last_screenshot_at FROM devices WHERE id = ?", ids.dev.id)).last_screenshot_at).not.toBeNull();
  });

  it("rejects other devices' tokens, non-multipart, missing file and oversize bodies (CMS wording)", async () => {
    let r = await SELF.fetch(`${BASE}/api/screenshots/dev-1`, { method: "POST", body: new FormData(), headers: bearer("tok-2") });
    expect(r.status).toBe(403);
    r = await SELF.fetch(`${BASE}/api/screenshots/dev-1`, { method: "POST", body: new FormData(), headers: bearer("tok-1") });
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ detail: "no file in upload (field 'file')" });
    // raw / non-multipart bodies
    r = await SELF.fetch(`${BASE}/api/screenshots/dev-1`, { method: "POST", body: JPEG, headers: { ...bearer("tok-1"), "content-type": "image/jpeg" } });
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ detail: "expected a multipart/form-data upload" });
    r = await SELF.fetch(`${BASE}/api/screenshots/dev-1`, { method: "POST", body: "not a form", headers: { ...bearer("tok-1"), "content-type": "multipart/form-data; boundary=xyz" } });
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ detail: "expected a multipart/form-data upload" });
    // the first file part is taken whatever its field name, as the CMS's streaming parser does
    const fd = new FormData();
    fd.append("other", new Blob([JPEG], { type: "image/jpeg" }), "x.jpg");
    r = await SELF.fetch(`${BASE}/api/screenshots/dev-1`, { method: "POST", body: fd, headers: bearer("tok-1") });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, size_bytes: JPEG.length });
    // oversize: declared length past max + 64 KiB, or the file itself past max
    r = await postShot(ids.dev, JPEG, { "content-length": String(6 * 1024 * 1024) });
    expect(r.status).toBe(413);
    const big = new Uint8Array(5 * 1024 * 1024 + 1);
    big.set(JPEG);
    r = await postShot(ids.dev, big);
    expect(r.status).toBe(413);
    expect(await r.json()).toEqual({ detail: "File exceeds 5242880 bytes" });
  });

  it("a logged-in browser is not a device", async () => {
    const r = await admin.fetch("/api/sync/dev-1");
    expect(r.status).toBe(401);
  });
});
