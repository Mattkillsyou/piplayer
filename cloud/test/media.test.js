// /api/media: filename validation, session-or-device auth, device scoping through the
// schedule resolver (contract 15), R2 range serving (contract 6), HEAD, headers.
import { beforeAll, describe, expect, it } from "vitest";
import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { parseRange } from "../src/media.js";
import { BASE, query, setupAdmin } from "./helpers.js";

const SHA = (c) => c.repeat(64);
const ins = async (sql, ...p) => (await env.DB.prepare(sql).bind(...p).run()).meta.last_row_id;
const bearer = (token) => ({ authorization: `Bearer ${token}` });
const FULL = new Uint8Array(1000).map((_, i) => i % 251);

let admin;
const ids = {};

const get = (path, headers = {}, method = "GET") => SELF.fetch(BASE + path, { headers, method });
const bytes = async (r) => new Uint8Array(await r.arrayBuffer());

beforeAll(async () => {
  admin = await setupAdmin("admin", "test1234");
  await env.MEDIA.put("media/a.mp4", FULL, { httpMetadata: { contentType: "video/mp4" } });
  await env.MEDIA.put("media/b.png", FULL.slice(0, 10), { httpMetadata: { contentType: "image/png" } });
  ids.mA = await ins("INSERT INTO media (filename, original_name, media_type, size_bytes, sha256) VALUES ('a.mp4', 'a.mp4', 'video', 1000, ?)", SHA("a"));
  ids.mB = await ins("INSERT INTO media (filename, original_name, media_type, size_bytes, sha256) VALUES ('b.png', 'b.png', 'image', 10, ?)", SHA("b"));
  ids.mGhost = await ins("INSERT INTO media (filename, original_name, media_type, size_bytes, sha256) VALUES ('ghost.png', 'ghost.png', 'image', 10, ?)", SHA("c"));
  ids.plA = await ins("INSERT INTO playlists (name) VALUES ('scope-a')");
  ids.plB = await ins("INSERT INTO playlists (name) VALUES ('scope-b')");
  await ins("INSERT INTO playlist_items (playlist_id, media_id, position) VALUES (?, ?, 0)", ids.plA, ids.mA);
  await ins("INSERT INTO playlist_items (playlist_id, media_id, position) VALUES (?, ?, 1)", ids.plA, ids.mGhost);
  await ins("INSERT INTO playlist_items (playlist_id, media_id, position) VALUES (?, ?, 0)", ids.plB, ids.mB);
  ids.devA = await ins("INSERT INTO devices (device_id, name, token, playlist_id) VALUES ('scope-a', 'A', 'tok-a', ?)", ids.plA);
  ids.devB = await ins("INSERT INTO devices (device_id, name, token, playlist_id) VALUES ('scope-b', 'B', 'tok-b', ?)", ids.plB);
  await ins("INSERT INTO devices (device_id, name, token) VALUES ('scope-none', 'N', 'tok-none')");
});

describe("parseRange", () => {
  const status = (h, size) => { try { parseRange(h, size); } catch (e) { return `${e.status} ${e.detail}`; } };
  it("covers the single-range forms and the unsatisfiable ones", () => {
    expect(parseRange(null, 100)).toBeNull();
    expect(parseRange("bytes=0-9", 100)).toEqual([[0, 9]]);
    expect(parseRange("bytes=90-", 100)).toEqual([[90, 99]]);
    expect(parseRange("bytes=0-", 100)).toEqual([[0, 99]]);
    expect(parseRange("bytes=-10", 100)).toEqual([[90, 99]]);
    expect(parseRange("bytes=-500", 100)).toEqual([[0, 99]]);
    expect(parseRange("bytes=50-500", 100)).toEqual([[50, 99]]);
    expect(parseRange("bytes=0-0", 100)).toEqual([[0, 0]]);
    expect(parseRange("BYTES = 0-9", 100)).toEqual([[0, 9]]);
    expect(status("bytes=100-", 100)).toBe("416 bytes */100");
    expect(status("bytes=-0", 100)).toBe("416 bytes */100");
    expect(status("bytes=0-", 0)).toBe("416 bytes */0");
  });

  it("answers malformed and inverted ranges with Starlette's 400s", () => {
    expect(status("garbage", 100)).toBe("400 Malformed range header.");
    expect(status("items=0-1", 100)).toBe("400 Only support bytes range");
    expect(status("bytes=-", 100)).toBe("400 Range header: range must be requested");
    expect(status("bytes=abc", 100)).toBe("400 Range header: range must be requested");
    expect(status("bytes=", 100)).toBe("400 Range header: range must be requested");
    expect(status("bytes=9-5", 100)).toBe("400 Range header: start must be less than end");
    expect(status("bytes=200-100", 100)).toBe("416 bytes */100"); // start past the end wins
  });

  it("merges overlapping multi-ranges, ignores junk parts, keeps disjoint ones sorted", () => {
    expect(parseRange("bytes=0-9,5-19", 100)).toEqual([[0, 19]]);
    expect(parseRange("bytes=0-9,10-19", 100)).toEqual([[0, 19]]);
    expect(parseRange("bytes=0-9,abc,,-", 100)).toEqual([[0, 9]]);
    expect(parseRange("bytes=5-6,0-1", 100)).toEqual([[0, 1], [5, 6]]);
    expect(parseRange("bytes=0-1,11-19,5-6", 100)).toEqual([[0, 1], [5, 6], [11, 19]]);
    // more than max_ranges parts: Starlette sends the whole object
    expect(parseRange("bytes=" + Array.from({ length: 101 }, (_, i) => `${i * 2}-${i * 2}`).join(","), 1000)).toBeNull();
    expect(parseRange("bytes=" + Array.from({ length: 100 }, (_, i) => `${i * 2}-${i * 2}`).join(","), 1000)).toHaveLength(100);
    expect(status("bytes=0-1,500-", 100)).toBe("416 bytes */100");
    expect(status("bytes=0-1,9-5", 100)).toBe("400 Range header: start must be less than end");
  });
});

describe("auth and scoping", () => {
  it("requires a session or a valid device token", async () => {
    expect((await get("/api/media/a.mp4")).status).toBe(401);
    expect((await get("/api/media/a.mp4", bearer("not-a-token"))).status).toBe(401);
    expect((await admin.get("/api/media/a.mp4")).status).toBe(200);
    expect((await get("/api/media/a.mp4", bearer("tok-a"))).status).toBe(200);
  });

  it("validates the filename and 404s missing objects", async () => {
    expect((await admin.get("/api/media/..%2Fcms.db")).status).toBe(400);
    expect((await admin.get("/api/media/does-not-exist.mp4")).status).toBe(404);
    // in the DB but not in R2: the device is allowed, the object is missing
    expect((await get("/api/media/ghost.png", bearer("tok-a"))).status).toBe(404);
  });

  it("scopes a device token to its resolved playlist", async () => {
    expect((await get("/api/media/a.mp4", bearer("tok-a"))).status).toBe(200);
    expect((await get("/api/media/b.png", bearer("tok-b"))).status).toBe(200);
    let r = await get("/api/media/b.png", bearer("tok-a"));
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ detail: "file is not in this device's playlist" });
    expect((await get("/api/media/a.mp4", bearer("tok-b"))).status).toBe(403);
    expect((await get("/api/media/a.mp4", bearer("tok-none"))).status).toBe(403);
    // logged-in users fetch anything
    for (const f of ["a.mp4", "b.png"]) {
      r = await admin.get(`/api/media/${f}`);
      expect(r.status).toBe(200);
      expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    }
  });

  it("follows the schedule resolver", async () => {
    const sid = await ins("INSERT INTO device_schedules (device_id, playlist_id, name, priority) VALUES (?, ?, 'always-b', 50)", ids.devA, ids.plB);
    expect((await get("/api/media/b.png", bearer("tok-a"))).status).toBe(200);
    expect((await get("/api/media/a.mp4", bearer("tok-a"))).status).toBe(403);
    await query("DELETE FROM device_schedules WHERE id = ?", sid);
    expect((await get("/api/media/a.mp4", bearer("tok-a"))).status).toBe(200);
  });
});

describe("serving", () => {
  it("full GET carries content-type, length, etag, accept-ranges, nosniff", async () => {
    const r = await admin.get("/api/media/a.mp4");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("video/mp4");
    expect(r.headers.get("content-length")).toBe("1000");
    expect(r.headers.get("accept-ranges")).toBe("bytes");
    expect(r.headers.get("etag")).toMatch(/^"?[0-9a-f]+"?$/);
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await bytes(r)).toEqual(FULL);
    const b = await get("/api/media/b.png", bearer("tok-b"));
    expect(b.headers.get("content-type")).toBe("image/png");
  });

  it("honours single Range requests with 206 and answers 416 when unsatisfiable", async () => {
    let r = await admin.fetch("/api/media/a.mp4", { headers: { range: "bytes=0-9" } });
    expect(r.status).toBe(206);
    expect(r.headers.get("content-range")).toBe("bytes 0-9/1000");
    expect(r.headers.get("content-length")).toBe("10");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await bytes(r)).toEqual(FULL.slice(0, 10));
    // resume from an offset, as the player does with a .part file
    r = await get("/api/media/a.mp4", { ...bearer("tok-a"), range: "bytes=900-" });
    expect(r.status).toBe(206);
    expect(r.headers.get("content-range")).toBe("bytes 900-999/1000");
    expect(await bytes(r)).toEqual(FULL.slice(900));
    r = await get("/api/media/a.mp4", { ...bearer("tok-a"), range: "bytes=-100" });
    expect(r.status).toBe(206);
    expect(r.headers.get("content-range")).toBe("bytes 900-999/1000");
    // 416 / 400 are Starlette PlainTextResponses: text/plain, empty body for 416, the message for 400
    r = await get("/api/media/a.mp4", { ...bearer("tok-a"), range: "bytes=1000-" });
    expect(r.status).toBe(416);
    expect(r.headers.get("content-range")).toBe("bytes */1000");
    expect(r.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(await r.text()).toBe("");
    r = await get("/api/media/a.mp4", { ...bearer("tok-a"), range: "bytes=900-100" });
    expect(r.status).toBe(400);
    expect(r.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(await r.text()).toBe("Range header: start must be less than end");
    r = await get("/api/media/a.mp4", { ...bearer("tok-a"), range: "garbage" });
    expect(r.status).toBe(400);
    expect(await r.text()).toBe("Malformed range header.");
    // If-Range that matches neither ETag nor Last-Modified: the whole object
    r = await get("/api/media/a.mp4", { ...bearer("tok-a"), range: "bytes=0-9", "if-range": '"stale"' });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-length")).toBe("1000");
    const full = await admin.get("/api/media/a.mp4");
    r = await get("/api/media/a.mp4", { ...bearer("tok-a"), range: "bytes=0-9", "if-range": full.headers.get("etag") });
    expect(r.status).toBe(206);
    // parts that merge into one range are a plain 206
    r = await get("/api/media/a.mp4", { ...bearer("tok-a"), range: "bytes=0-4,5-9" });
    expect(r.status).toBe(206);
    expect(r.headers.get("content-range")).toBe("bytes 0-9/1000");
  });

  it("answers disjoint multi-ranges with multipart/byteranges laid out like FileResponse", async () => {
    const r = await get("/api/media/a.mp4", { ...bearer("tok-a"), range: "bytes=990-, 0-1,5-6" });
    expect(r.status).toBe(206);
    expect(r.headers.get("content-range")).toBeNull();
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    const boundary = r.headers.get("content-type").match(/^multipart\/byteranges; boundary=([0-9a-f]{26})$/)[1];
    const body = await bytes(r);
    expect(String(body.length)).toBe(r.headers.get("content-length"));
    const part = (s, e) => [
      ...new TextEncoder().encode(`--${boundary}\r\nContent-Type: video/mp4\r\nContent-Range: bytes ${s}-${e}/1000\r\n\r\n`),
      ...FULL.slice(s, e + 1), 13, 10,
    ];
    expect([...body]).toEqual([...part(0, 1), ...part(5, 6), ...part(990, 999), ...new TextEncoder().encode(`--${boundary}--`)]);
    // one part past the end still poisons the whole request
    expect((await get("/api/media/a.mp4", { ...bearer("tok-a"), range: "bytes=0-1,1000-" })).status).toBe(416);
  });

  it("supports HEAD", async () => {
    const r = await get("/api/media/a.mp4", bearer("tok-a"), "HEAD");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-length")).toBe("1000");
    expect(r.headers.get("content-type")).toBe("video/mp4");
    expect(r.headers.get("accept-ranges")).toBe("bytes");
    expect((await bytes(r)).length).toBe(0);
    expect((await get("/api/media/nope.mp4", bearer("tok-a"), "HEAD")).status).toBe(403);
    expect((await admin.fetch("/api/media/nope.mp4", { method: "HEAD" })).status).toBe(404);
  });
});
