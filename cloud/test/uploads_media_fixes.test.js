// Audit fixes for uploads / library (package uploads-media): a forged sha256 prefix cannot
// overwrite a library object (M9), complete verifies the browser's sha256 (M10), a failing R2
// delete does not lose the audit row (L10), media.sha256 is UNIQUE (L11) and one open alert
// per (device, kind) is enforced by the schema (L13, index only; alerts.js is another package).
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import * as auth from "../src/auth.js";
import worker from "../src/index.js";
import { BASE, Client, query, setupAdmin } from "./helpers.js";

const hex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
const digest = async (data) => hex(await crypto.subtle.digest("SHA-256", data));

function fakeFile(size, seed = 1) {
  const data = new Uint8Array(size);
  let x = seed >>> 0;
  for (let i = 0; i < size; i++) { x = (x * 1103515245 + 12345) >>> 0; data[i] = x >>> 24; }
  return data;
}

let admin, editor, editorCsrf, other, otherCsrf;

async function makeUser(username, role, password = "test1234") {
  const hash = await auth.hashPassword(password);
  await env.DB.prepare("INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)").bind(username, hash, role).run();
  const c = new Client();
  expect((await c.login(username, password)).status).toBe(303);
  return c;
}

beforeAll(async () => {
  admin = await setupAdmin("admin", "test1234");
  editor = await makeUser("ed", "editor");
  editorCsrf = await editor.csrf("/library");
  other = await makeUser("ed2", "editor");
  otherCsrf = await other.csrf("/library");
});

const initBody = (over = {}) => ({ name: "clip.mp4", size: 3000, sha256: "0".repeat(64), media_type: "video", ...over });
const init = (c, token, body) => c.postJson("/library/upload/init", body, { "X-CSRF-Token": token });
const putPart = (c, token, id, n, bytes) =>
  c.fetch(`/library/upload/${id}/part/${n}`, { method: "PUT", body: bytes, headers: { "X-CSRF-Token": token } });
const complete = (c, token, id) => c.postJson(`/library/upload/${id}/complete`, {}, { "X-CSRF-Token": token });

// init + every part (small files: one part) for `data` sent under `name` with `sha` claimed;
// returns the upload id.
async function stage(c, token, name, data, sha) {
  const r = await init(c, token, initBody({ name, size: data.length, sha256: sha || await digest(data) }));
  expect(r.status, await r.clone().text()).toBe(200);
  const { upload_id } = await r.json();
  const p = await putPart(c, token, upload_id, 1, data);
  expect(p.status, await p.clone().text()).toBe(200);
  return upload_id;
}

// The handler called directly (like a second worker request) with a patched env.
const direct = (c, path, initOpts, envOverride = {}) => worker.fetch(new Request(BASE + path, {
  ...initOpts, headers: { ...(initOpts.headers || {}), cookie: c.cookie },
}), { ...env, ...envOverride }, createExecutionContext());

describe("M9: a forged sha256 prefix cannot reuse a library object's key", () => {
  const honest = fakeFile(3000, 1);
  let sha, filename;

  beforeAll(async () => {
    sha = await digest(honest);
    const r = await complete(editor, editorCsrf, await stage(editor, editorCsrf, "clip.mp4", honest));
    expect(r.status, await r.clone().text()).toBe(200);
    filename = (await query("SELECT filename FROM media WHERE sha256 = ?", sha))[0].filename;
    expect(filename).toBe(`${sha.slice(0, 16)}_clip.mp4`);
  });

  it("init refuses a different sha256 that shares the first 16 hex chars of a library file", async () => {
    const forged = sha.slice(0, 16) + "f".repeat(48);
    const r = await init(other, otherCsrf, initBody({ name: "clip.mp4", size: 5000, sha256: forged }));
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ detail: "A file with this name is already in the library or being uploaded" });
    expect(await query("SELECT id FROM uploads")).toEqual([]);
    expect((await env.MEDIA.head("media/" + filename)).size).toBe(3000);
    expect(await query("SELECT username, action FROM audit_log WHERE action = 'upload_media'")).toEqual([{ username: "ed", action: "upload_media" }]);
  });

  it("init refuses the key of another in-flight upload; the owner's own re-init still resumes", async () => {
    const mine = fakeFile(2000, 2);
    const mySha = await digest(mine);
    let r = await init(editor, editorCsrf, initBody({ name: "flight.mp4", size: 2000, sha256: mySha }));
    const { upload_id } = await r.json();
    r = await init(other, otherCsrf, initBody({ name: "flight.mp4", size: 4000, sha256: mySha.slice(0, 16) + "e".repeat(48) }));
    expect(r.status).toBe(409);
    expect((await r.json()).detail).toBe("A file with this name is already in the library or being uploaded");
    r = await init(editor, editorCsrf, initBody({ name: "flight.mp4", size: 2000, sha256: mySha }));
    expect(await r.json()).toEqual({ upload_id, part_size: 8 * 1024 * 1024, received: 0 });
    expect((await query("SELECT COUNT(*) AS n FROM uploads")).at(0).n).toBe(1);
    await editor.postJson(`/library/upload/${upload_id}/abort`, {}, { "X-CSRF-Token": editorCsrf });
  });

  it("complete inserts the media row before R2 completes: a name clash aborts the multipart and leaves no object", async () => {
    const data = fakeFile(1500, 3);
    const id = await stage(other, otherCsrf, "clash.mp4", data);
    const row = (await query("SELECT key FROM uploads WHERE id = ?", id))[0];
    // the same-instant race: another request took this filename between init and complete
    await env.DB.prepare("INSERT INTO media (filename, original_name, media_type, size_bytes, sha256) VALUES (?, 'winner.mp4', 'video', 1, ?)")
      .bind(row.key.slice("media/".length), "a".repeat(64)).run();
    const r = await complete(other, otherCsrf, id);
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ detail: "a file with this content or name already exists" });
    expect(await query("SELECT original_name FROM media WHERE filename = ?", row.key.slice("media/".length))).toEqual([{ original_name: "winner.mp4" }]);
    expect(await env.MEDIA.head(row.key)).toBeNull();
    expect(await query("SELECT id FROM uploads WHERE id = ?", id)).toEqual([]);
  });
});

describe("M10: complete verifies the browser-supplied sha256", () => {
  it("garbage bytes sent with the sha256 of a real file are refused, cleaned up, and the real file can still be uploaded", async () => {
    const real = fakeFile(900, 4);
    const realSha = await digest(real);
    const garbage = fakeFile(700, 5);
    const id = await stage(editor, editorCsrf, "garbage.mp4", garbage, realSha);
    const key = (await query("SELECT key FROM uploads WHERE id = ?", id))[0].key;
    let r = await complete(editor, editorCsrf, id);
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ detail: "The file did not arrive intact; please upload it again." });
    expect(await query("SELECT id FROM media WHERE sha256 = ?", realSha)).toEqual([]);
    expect(await query("SELECT id FROM uploads WHERE id = ?", id)).toEqual([]);
    expect(await env.MEDIA.head(key)).toBeNull();
    expect(await query("SELECT id FROM audit_log WHERE action = 'upload_media' AND details LIKE '%garbage%'")).toEqual([]);
    // dedupe is keyed on a real digest now: the honest upload is not "a duplicate of garbage.mp4"
    r = await init(other, otherCsrf, initBody({ name: "real.mp4", size: real.length, sha256: realSha }));
    expect(r.status, await r.clone().text()).toBe(200);
    await other.postJson(`/library/upload/${(await r.json()).upload_id}/abort`, {}, { "X-CSRF-Token": otherCsrf });
  });

  it("above PIPLAYER_VERIFY_SHA_MAX_BYTES the hash is not checked and the audit row says so", async () => {
    const data = fakeFile(600, 6);
    const claimed = "b".repeat(64);
    const id = await stage(editor, editorCsrf, "big.mp4", data, claimed);
    const r = await direct(editor, `/library/upload/${id}/complete`,
      { method: "POST", body: "{}", headers: { "X-CSRF-Token": editorCsrf, "content-type": "application/json" } },
      { PIPLAYER_VERIFY_SHA_MAX_BYTES: "500" });
    expect(r.status, await r.clone().text()).toBe(200);
    const { media_id } = await r.json();
    expect((await query("SELECT sha256 FROM media WHERE id = ?", media_id))[0].sha256).toBe(claimed);
    const a = (await query("SELECT details FROM audit_log WHERE action = 'upload_media' AND target_id = ?", String(media_id)))[0];
    expect(a.details).toBe('{"filename": "big.mp4", "type": "video", "sha_verified": false}');
    // an honest upload under the cap audits without the flag
    const ok = fakeFile(650, 7);
    const r2 = await complete(editor, editorCsrf, await stage(editor, editorCsrf, "ok.mp4", ok));
    expect(r2.status).toBe(200);
    const b = (await query("SELECT details FROM audit_log WHERE action = 'upload_media' AND target_id = ?", String((await r2.json()).media_id)))[0];
    expect(b.details).toBe('{"filename": "ok.mp4", "type": "video"}');
  });
});

describe("L10: library delete survives an R2 delete failure", () => {
  it("the row is gone, the audit row is written, the editor is redirected; the object is logged as an orphan", async () => {
    const data = fakeFile(800, 8);
    const r0 = await complete(editor, editorCsrf, await stage(editor, editorCsrf, "orphan.png", data));
    const { media_id } = await r0.json();
    const filename = (await query("SELECT filename FROM media WHERE id = ?", media_id))[0].filename;
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await direct(editor, `/library/${media_id}/delete`,
      { method: "POST", body: new URLSearchParams({ csrf_token: editorCsrf }), headers: { "content-type": "application/x-www-form-urlencoded" } },
      { MEDIA: { delete: async () => { throw new Error("R2 is down"); } } });
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toBe("/library");
    expect(await query("SELECT id FROM media WHERE id = ?", media_id)).toEqual([]);
    expect(await query("SELECT details FROM audit_log WHERE action = 'delete_media'")).toEqual([{ details: '{"filename": "orphan.png", "playlists": []}' }]);
    expect(await env.MEDIA.head("media/" + filename)).not.toBeNull();
    expect(errors).toHaveBeenCalledWith(`R2 delete failed for media/${filename}:`, expect.stringContaining("R2 is down"));
    errors.mockRestore();
    await env.MEDIA.delete("media/" + filename);
  });
});

describe("L11 / L13: schema-level dedupe (migration 0006)", () => {
  it("media.sha256 is UNIQUE, one open alert per (device, kind), schema_version is 6", async () => {
    expect(await query("SELECT value FROM meta WHERE key = 'schema_version'")).toEqual([{ value: "6" }]);
    await env.DB.prepare("INSERT INTO media (filename, original_name, media_type, size_bytes, sha256) VALUES ('u1.mp4', 'u1', 'video', 1, ?)").bind("c".repeat(64)).run();
    await expect(env.DB.prepare("INSERT INTO media (filename, original_name, media_type, size_bytes, sha256) VALUES ('u2.mp4', 'u2', 'video', 1, ?)").bind("c".repeat(64)).run())
      .rejects.toThrow(/UNIQUE constraint failed: media.sha256/);
    const dev = (await env.DB.prepare("INSERT INTO devices (device_id, name, token) VALUES ('d-idx', 'D', 'tok-idx')").run()).meta.last_row_id;
    await env.DB.prepare("INSERT INTO alerts (device_id, kind, closed_at) VALUES (?, 'offline', '2026-01-01 00:00:00')").bind(dev).run();
    await env.DB.prepare("INSERT INTO alerts (device_id, kind) VALUES (?, 'offline')").bind(dev).run();
    await expect(env.DB.prepare("INSERT INTO alerts (device_id, kind) VALUES (?, 'offline')").bind(dev).run())
      .rejects.toThrow(/UNIQUE constraint failed: alerts.device_id, alerts.kind/);
    await env.DB.prepare("INSERT INTO alerts (device_id, kind) VALUES (?, 'mpv-down')").bind(dev).run();
  });

  it("two completes of the same bytes under different names at the same instant leave one media row", async () => {
    const same = fakeFile(1200, 9);
    const sha = await digest(same);
    const a = await stage(editor, editorCsrf, "one.mp4", same);
    const b = await stage(other, otherCsrf, "two.mp4", same);
    const keyB = (await query("SELECT key FROM uploads WHERE id = ?", b))[0].key;
    const racer = (c, token, id) => direct(c, `/library/upload/${id}/complete`,
      { method: "POST", body: "{}", headers: { "X-CSRF-Token": token, "content-type": "application/json" } });
    const results = await Promise.all([racer(editor, editorCsrf, a), racer(other, otherCsrf, b)]);
    expect(results.map((x) => x.status).sort()).toEqual([200, 409]);
    expect((await query("SELECT COUNT(*) AS n FROM media WHERE sha256 = ?", sha))[0].n).toBe(1);
    expect(await query("SELECT id FROM uploads WHERE sha256 = ?", sha)).toEqual([]);
    const filename = (await query("SELECT filename FROM media WHERE sha256 = ?", sha))[0].filename;
    expect(await digest(new Uint8Array(await (await env.MEDIA.get("media/" + filename)).arrayBuffer()))).toBe(sha);
    if (filename !== keyB.slice("media/".length)) expect(await env.MEDIA.head(keyB)).toBeNull();
  });
});
