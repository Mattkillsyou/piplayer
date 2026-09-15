// Chunked uploads (src/uploads.js) and the Library page (src/pages/library.js): naming rules
// ported from web.py, init validation, the 12 MiB happy path through R2 multipart, dedupe
// before bytes move, resume, idempotent parts, abort, housekeeping, list + delete.
import { beforeAll, describe, expect, it } from "vitest";
import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import * as auth from "../src/auth.js";
import worker from "../src/index.js";
import * as uploads from "../src/uploads.js";
import { BASE, Client, query, setupAdmin } from "./helpers.js";

// [input name, Path(name).suffix.lower(), _final_media_name(sha, name, ext), _sanitize_filename(name)]
// generated from cms/app/routes/web.py with PurePosixPath (the Pi's path semantics).
const PY_NAMES = [["video.mp4", ".mp4", "0123456789abcdef_video.mp4", "video.mp4"], ["My Movie (final) v2.MP4", ".mp4", "0123456789abcdef_My_Movie_final_v2.mp4", "My_Movie_final_v2.MP4"], ["héllo wörld.png", ".png", "0123456789abcdef_h_llo_w_rld.png", "h_llo_w_rld.png"], ["日本語ファイル.jpg", ".jpg", "0123456789abcdef_jpg.jpg", "jpg"], ["..hidden.gif", ".gif", "0123456789abcdef_hidden.gif", "hidden.gif"], ["___x___.webm", ".webm", "0123456789abcdef_x.webm", "x___.webm"], ["a b\tc.mov", ".mov", "0123456789abcdef_a_b_c.mov", "a_b_c.mov"], ["nnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnn.mp4", ".mp4", "0123456789abcdef_nnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnn.mp4", "nnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnn.mp4"], ["nnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnn._.mp4", ".mp4", "0123456789abcdef_nnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnn.mp4", "nnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnn._.mp4"], ["dir/sub/file.mkv", ".mkv", "0123456789abcdef_file.mkv", "file.mkv"], ["...", "", "0123456789abcdef_asset", "asset"], ["asset", "", "0123456789abcdef_asset", "asset"], ["a.tar.gz.mp4", ".mp4", "0123456789abcdef_a.tar.gz.mp4", "a.tar.gz.mp4"], ["xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx.jpeg", ".jpeg", "0123456789abcdef_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx.jpeg", "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx.jpeg"], ["xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx_.jpeg", ".jpeg", "0123456789abcdef_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx.jpeg", "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx_.jpeg"], ["-.mp4", ".mp4", "0123456789abcdef_-.mp4", "-.mp4"], ["noext", "", "0123456789abcdef_noext", "noext"], ["UPPER.JPG", ".jpg", "0123456789abcdef_UPPER.jpg", "UPPER.JPG"], ["spaces   .bmp", ".bmp", "0123456789abcdef_spaces.bmp", "spaces_.bmp"], ["é.png", ".png", "0123456789abcdef_e.png", "e_.png"], ["a<b>&\"'c.png", ".png", "0123456789abcdef_a_b_c.png", "a_b_c.png"]];

const SHA = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const MiB = 1024 * 1024;
const hex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
const digest = async (data) => hex(await crypto.subtle.digest("SHA-256", data));

function fakeFile(size, seed = 1) {
  const data = new Uint8Array(size);
  let x = seed >>> 0;
  for (let i = 0; i < size; i++) { x = (x * 1103515245 + 12345) >>> 0; data[i] = x >>> 24; }
  return data;
}

let admin, editor, viewer, csrf, editorCsrf, viewerCsrf;

async function makeUser(username, role, password = "test1234") {
  const hash = await auth.hashPassword(password);
  await env.DB.prepare("INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)").bind(username, hash, role).run();
  const c = new Client();
  expect((await c.login(username, password)).status).toBe(303);
  return c;
}

beforeAll(async () => {
  admin = await setupAdmin("admin", "test1234");
  csrf = await admin.csrf("/library");
  editor = await makeUser("ed", "editor");
  editorCsrf = await editor.csrf("/library");
  viewer = await makeUser("vi", "viewer");
  viewerCsrf = await viewer.csrf("/library");
});

const initBody = (over = {}) => ({
  name: "clip.mp4", size: 12 * MiB, sha256: SHA, media_type: "video", duration_seconds: 2, width: 320, height: 240, ...over,
});

async function init(c, token, body) {
  return c.postJson("/library/upload/init", body, { "X-CSRF-Token": token });
}

async function putPart(c, token, id, n, bytes) {
  return c.fetch(`/library/upload/${id}/part/${n}`, { method: "PUT", body: bytes, headers: { "X-CSRF-Token": token } });
}

// Drive the whole protocol for `data` named `name`; returns the complete() response.
async function uploadWhole(c, token, name, data, extra = {}) {
  const r = await init(c, token, initBody({ name, size: data.length, sha256: await digest(data), ...extra }));
  expect(r.status, await r.clone().text()).toBe(200);
  const { upload_id, part_size } = await r.json();
  for (let n = 1, off = 0; off < data.length; n++, off += part_size) {
    const p = await putPart(c, token, upload_id, n, data.subarray(off, Math.min(off + part_size, data.length)));
    expect(p.status, await p.clone().text()).toBe(200);
  }
  return c.postJson(`/library/upload/${upload_id}/complete`, {}, { "X-CSRF-Token": token });
}

describe("filename rules (port of web._final_media_name / _sanitize_filename)", () => {
  it("matches the Python outputs for every reference input", () => {
    for (const [name, ext, final, safe] of PY_NAMES) {
      expect(uploads.sanitizeFilename(name), name).toBe(safe);
      expect(uploads.finalMediaName(SHA, name, ext), name).toBe(final);
      expect(uploads.finalMediaName(SHA, name, ext).length).toBeLessThanOrEqual(120);
      if (name !== "...") expect(uploads.extOf(name), name).toBe(ext);
    }
  });

  it("media type by extension, gif is an image unless animated", () => {
    expect(uploads.mediaTypeForExt(".MP4")).toBe("video");
    expect(uploads.mediaTypeForExt(".gif")).toBe("image");
    expect(uploads.mediaTypeForExt(".exe")).toBeNull();
    expect(uploads.mediaTypeForExt("")).toBeNull();
    expect(uploads.expectedPartSize(12 * MiB, 1)).toBe(8 * MiB);
    expect(uploads.expectedPartSize(12 * MiB, 2)).toBe(4 * MiB);
    expect(uploads.totalParts(16 * MiB)).toBe(2);
    expect(uploads.totalParts(1)).toBe(1);
  });
});

describe("init validation", () => {
  it("requires editor role and a JSON object", async () => {
    let r = await init(viewer, viewerCsrf, initBody());
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ detail: "requires editor role" });
    r = await new Client().postJson("/library/upload/init", initBody(), { "X-CSRF-Token": "x" });
    expect([r.status, r.headers.get("location")]).toEqual([303, "/login?expired=1"]); // no session -> login form
    r = await editor.fetch("/library/upload/init", { method: "POST", body: "[1,2]", headers: { "X-CSRF-Token": editorCsrf, "content-type": "application/json" } });
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ detail: "body must be a JSON object" });
    r = await editor.fetch("/library/upload/init", { method: "POST", body: "not json", headers: { "X-CSRF-Token": editorCsrf } });
    expect(r.status).toBe(400);
  });

  it("400 for every malformed field, 413 for oversize, and creates no upload", async () => {
    const bad = [
      [{ name: "" }, "name required"],
      [{ name: 7 }, "name required"],
      [{ name: "x".repeat(1100) + ".mp4" }, "name too long"],
      [{ name: "virus.exe" }, "Unsupported extension .exe. Allowed: ['.bmp', '.gif', '.jpeg', '.jpg', '.m4v', '.mkv', '.mov', '.mp4', '.png', '.webm', '.webp']"],
      [{ name: "noext" }, "Unsupported extension . Allowed: ['.bmp', '.gif', '.jpeg', '.jpg', '.m4v', '.mkv', '.mov', '.mp4', '.png', '.webm', '.webp']"],
      [{ size: 0 }, "empty file"],
      [{ size: -1 }, "size must be a non-negative integer"],
      [{ size: 1.5 }, "size must be a non-negative integer"],
      [{ size: "12" }, "size must be a non-negative integer"],
      [{ sha256: "abc" }, "sha256 must be 64 hex chars"],
      [{ sha256: SHA.replace("0", "g") }, "sha256 must be 64 hex chars"],
      [{ sha256: null }, "sha256 must be 64 hex chars"],
      [{ media_type: "audio" }, "media_type must be 'video' or 'image'"],
      [{ animated: "yes" }, "animated must be a boolean"],
      [{ duration_seconds: -2 }, "duration_seconds must be a positive number or null"],
      [{ duration_seconds: "2" }, "duration_seconds must be a positive number or null"],
      [{ width: 1.5 }, "width must be a positive integer or null"],
      [{ height: 0 }, "height must be a positive integer or null"],
    ];
    for (const [over, detail] of bad) {
      const r = await init(editor, editorCsrf, initBody(over));
      expect(r.status, JSON.stringify(over)).toBe(400);
      expect((await r.json()).detail, JSON.stringify(over)).toBe(detail);
    }
    const max = parseInt(env.PIPLAYER_MAX_UPLOAD_BYTES, 10);
    const r = await init(editor, editorCsrf, initBody({ size: max + 1 }));
    expect(r.status).toBe(413);
    expect(await r.json()).toEqual({ detail: `File exceeds ${max} bytes` });
    expect(await query("SELECT id FROM uploads")).toEqual([]);
  });
});

describe("upload protocol", () => {
  const data = fakeFile(12 * MiB, 42);
  let sha, uploadId, mediaId;

  beforeAll(async () => { sha = await digest(data); });

  it("init creates the R2 multipart + uploads row; parts must be exact; complete inserts the media row", async () => {
    let r = await init(editor, editorCsrf, initBody({ name: "My Clip (1).mp4", sha256: sha.toUpperCase() }));
    expect(r.status, await r.clone().text()).toBe(200);
    const body = await r.json();
    expect(body).toEqual({ upload_id: expect.any(String), part_size: 8 * MiB, received: 0 });
    uploadId = body.upload_id;
    const row = (await query("SELECT * FROM uploads WHERE id = ?", uploadId))[0];
    expect(row.key).toBe(`media/${sha.slice(0, 16)}_My_Clip_1.mp4`);
    expect(row.sha256).toBe(sha);
    expect(row.media_type).toBe("video");
    expect(row.upload_id).toBeTruthy();

    // wrong part sizes / numbers
    r = await putPart(editor, editorCsrf, uploadId, 1, data.subarray(0, 5 * MiB));
    expect(r.status).toBe(400);
    expect((await r.json()).detail).toBe(`part 1 must be ${8 * MiB} bytes`);
    r = await putPart(editor, editorCsrf, uploadId, 3, data.subarray(0, 100));
    expect(r.status).toBe(400);
    expect((await r.json()).detail).toBe("part number 3 out of range (1..2)");
    r = await putPart(editor, editorCsrf, uploadId, 2, data.subarray(8 * MiB, 12 * MiB - 1));
    expect(r.status).toBe(400);
    r = await putPart(editor, "bad", uploadId, 1, data.subarray(0, 8 * MiB));
    expect(r.status).toBe(403);
    r = await putPart(viewer, viewerCsrf, uploadId, 1, data.subarray(0, 8 * MiB));
    expect(r.status).toBe(403);
    r = await putPart(editor, editorCsrf, "nope", 1, data.subarray(0, 8 * MiB));
    expect(r.status).toBe(404);

    // complete before all parts arrive
    r = await editor.postJson(`/library/upload/${uploadId}/complete`, {}, { "X-CSRF-Token": editorCsrf });
    expect(r.status).toBe(400);
    expect((await r.json()).detail).toContain("upload incomplete: 0 of");

    r = await putPart(editor, editorCsrf, uploadId, 1, data.subarray(0, 8 * MiB));
    expect(await r.json()).toEqual({ received: 8 * MiB });
    // idempotent re-PUT of part 1 does not double count
    r = await putPart(editor, editorCsrf, uploadId, 1, data.subarray(0, 8 * MiB));
    expect(await r.json()).toEqual({ received: 8 * MiB });
    // status for resume
    r = await editor.get(`/library/upload/${uploadId}`);
    expect(await r.json()).toEqual({ received: 8 * MiB, size: 12 * MiB, part_size: 8 * MiB, parts: [1] });
    // init again with the same content while in flight -> the same upload (resume), no dupe
    r = await init(editor, editorCsrf, initBody({ name: "My Clip (1).mp4", sha256: sha }));
    expect(await r.json()).toEqual({ upload_id: uploadId, part_size: 8 * MiB, received: 8 * MiB });
    expect((await query("SELECT COUNT(*) AS n FROM uploads")).at(0).n).toBe(1);

    r = await putPart(editor, editorCsrf, uploadId, 2, data.subarray(8 * MiB));
    expect(await r.json()).toEqual({ received: 12 * MiB });
    r = await editor.postJson(`/library/upload/${uploadId}/complete`, {}, { "X-CSRF-Token": editorCsrf });
    expect(r.status, await r.clone().text()).toBe(200);
    mediaId = (await r.json()).media_id;
    expect(mediaId).toEqual(expect.any(Number));

    const media = (await query("SELECT * FROM media WHERE id = ?", mediaId))[0];
    expect(media).toMatchObject({
      filename: `${sha.slice(0, 16)}_My_Clip_1.mp4`, original_name: "My Clip (1).mp4", media_type: "video",
      size_bytes: 12 * MiB, duration_seconds: 2, width: 320, height: 240, codec: null, sha256: sha,
    });
    expect(await query("SELECT id FROM uploads")).toEqual([]);
    const obj = await env.MEDIA.head("media/" + media.filename);
    expect(obj.size).toBe(12 * MiB);
    expect(obj.httpMetadata.contentType).toBe("video/mp4");
    const stored = new Uint8Array(await (await env.MEDIA.get("media/" + media.filename)).arrayBuffer());
    expect(await digest(stored)).toBe(sha);
    const audit = await query("SELECT username, action, target_id, details FROM audit_log WHERE action = 'upload_media'");
    expect(audit).toEqual([{ username: "ed", action: "upload_media", target_id: String(mediaId), details: '{"filename": "My Clip (1).mp4", "type": "video"}' }]);
    // the completed upload is gone on the R2 side too
    r = await editor.postJson(`/library/upload/${uploadId}/complete`, {}, { "X-CSRF-Token": editorCsrf });
    expect(r.status).toBe(404);
  });

  it("duplicate content is refused at init (409, friendly, no upload created)", async () => {
    const r = await init(editor, editorCsrf, initBody({ name: "other name.mp4", sha256: sha }));
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ detail: "Duplicate of 'My Clip (1).mp4' (sha256 match)" });
    expect(await query("SELECT id FROM uploads")).toEqual([]);
  });

  it("abort removes the R2 multipart and the row", async () => {
    const small = fakeFile(3 * MiB, 7);
    let r = await init(editor, editorCsrf, initBody({ name: "abort me.mov", size: small.length, sha256: await digest(small) }));
    const { upload_id } = await r.json();
    expect((await putPart(editor, editorCsrf, upload_id, 1, small)).status).toBe(200);
    const row = (await query("SELECT key, upload_id FROM uploads WHERE id = ?", upload_id))[0];
    r = await editor.postJson(`/library/upload/${upload_id}/abort`, {}, { "X-CSRF-Token": editorCsrf });
    expect(await r.json()).toEqual({ ok: true });
    expect(await query("SELECT id FROM uploads WHERE id = ?", upload_id)).toEqual([]);
    await expect(env.MEDIA.resumeMultipartUpload(row.key, row.upload_id).uploadPart(1, small)).rejects.toThrow();
    expect(await env.MEDIA.head(row.key)).toBeNull();
    r = await editor.postJson(`/library/upload/${upload_id}/abort`, {}, { "X-CSRF-Token": editorCsrf });
    expect(r.status).toBe(404);
  });

  it("racing PUTs of the same part leave exactly the part R2 holds on file; complete succeeds", async () => {
    // Two tabs resuming the same file (init hands both the in-flight upload) PUT part 1 at
    // once. R2 replaces a re-uploaded part number, so only one uploadPart may happen per
    // number: the losers get 409 (in flight) or 200 (already there), never a second etag.
    const data = fakeFile(9 * MiB, 21);
    let r = await init(editor, editorCsrf, initBody({ name: "race.mp4", size: data.length, sha256: await digest(data) }));
    const { upload_id } = await r.json();
    const part1 = data.subarray(0, 8 * MiB);
    // SELF.fetch serves one request at a time, so the handler is called directly: the three
    // invocations interleave at every await exactly as three worker requests would.
    const racer = () => worker.fetch(new Request(`${BASE}/library/upload/${upload_id}/part/1`, {
      method: "PUT", body: part1, headers: { "X-CSRF-Token": editorCsrf, cookie: editor.cookie },
    }), env, createExecutionContext());
    const results = await Promise.all([1, 2, 3].map(racer));
    const statuses = await Promise.all(results.map((x) => x.status));
    expect(statuses.filter((s) => s === 200).length).toBeGreaterThanOrEqual(1);
    for (const x of results) {
      expect([200, 409]).toContain(x.status);
      const body = await x.json();
      if (x.status === 200) expect(body).toEqual({ received: 8 * MiB });
      else expect(body.detail).toBe("part 1 is already being uploaded");
    }
    r = await editor.get(`/library/upload/${upload_id}`);
    expect(await r.json()).toEqual({ received: 8 * MiB, size: 9 * MiB, part_size: 8 * MiB, parts: [1] });
    const row = (await query("SELECT parts FROM uploads WHERE id = ?", upload_id))[0];
    expect(JSON.parse(row.parts)).toEqual([{ partNumber: 1, etag: expect.any(String) }]);
    r = await putPart(editor, editorCsrf, upload_id, 2, data.subarray(8 * MiB));
    expect(await r.json()).toEqual({ received: 9 * MiB });
    r = await editor.postJson(`/library/upload/${upload_id}/complete`, {}, { "X-CSRF-Token": editorCsrf });
    expect(r.status, await r.clone().text()).toBe(200);
    const { media_id } = await r.json();
    const filename = (await query("SELECT filename FROM media WHERE id = ?", media_id))[0].filename;
    const stored = new Uint8Array(await (await env.MEDIA.get("media/" + filename)).arrayBuffer());
    expect(await digest(stored)).toBe(await digest(data));
    expect(await query("SELECT id FROM uploads WHERE id = ?", upload_id)).toEqual([]);
  });

  it("a part PUT after the multipart vanished is a 409, not a 500", async () => {
    const small = fakeFile(1 * MiB, 9);
    const r = await init(editor, editorCsrf, initBody({ name: "gone.webm", size: small.length, sha256: await digest(small) }));
    const { upload_id } = await r.json();
    const row = (await query("SELECT key, upload_id FROM uploads WHERE id = ?", upload_id))[0];
    await env.MEDIA.resumeMultipartUpload(row.key, row.upload_id).abort();
    const p = await putPart(editor, editorCsrf, upload_id, 1, small);
    expect(p.status).toBe(409);
    expect((await p.json()).detail).toContain("no longer open");
    await editor.postJson(`/library/upload/${upload_id}/abort`, {}, { "X-CSRF-Token": editorCsrf });
  });

  it("gif: image by default, video when the browser reports animated", async () => {
    const a = fakeFile(1000, 11);
    let r = await uploadWhole(editor, editorCsrf, "still.gif", a, { media_type: "image", duration_seconds: null, width: 10, height: 10 });
    expect(r.status, await r.clone().text()).toBe(200);
    const b = fakeFile(1000, 12);
    r = await uploadWhole(editor, editorCsrf, "anim.gif", b, { media_type: "image", animated: true, duration_seconds: 3.5 });
    expect(r.status, await r.clone().text()).toBe(200);
    const rows = await query("SELECT original_name, media_type, duration_seconds FROM media WHERE original_name LIKE '%.gif' ORDER BY id");
    expect(rows).toEqual([
      { original_name: "still.gif", media_type: "image", duration_seconds: null },
      { original_name: "anim.gif", media_type: "video", duration_seconds: 3.5 },
    ]);
    // images never store a duration even when the client sends one
    const c = fakeFile(500, 13);
    r = await uploadWhole(editor, editorCsrf, "pic.png", c, { media_type: "image", duration_seconds: 9 });
    expect(r.status).toBe(200);
    expect(await query("SELECT duration_seconds FROM media WHERE original_name = 'pic.png'")).toEqual([{ duration_seconds: null }]);
  });

  it("admins may drive another user's upload, other editors may not", async () => {
    const small = fakeFile(100, 14);
    const r = await init(editor, editorCsrf, initBody({ name: "mine.mp4", size: 100, sha256: await digest(small) }));
    const { upload_id } = await r.json();
    const other = await makeUser("ed2", "editor");
    const otherCsrf = await other.csrf("/library");
    expect((await other.get(`/library/upload/${upload_id}`)).status).toBe(403);
    expect((await admin.get(`/library/upload/${upload_id}`)).status).toBe(200);
    expect((await other.postJson(`/library/upload/${upload_id}/abort`, {}, { "X-CSRF-Token": otherCsrf })).status).toBe(403);
    expect((await admin.postJson(`/library/upload/${upload_id}/abort`, {}, { "X-CSRF-Token": csrf })).status).toBe(200);
  });

  it("housekeeping aborts uploads older than 24 h and drops orphaned rows", async () => {
    const a = fakeFile(100, 15);
    const b = fakeFile(100, 16);
    const ra = await init(editor, editorCsrf, initBody({ name: "old.mp4", size: 100, sha256: await digest(a) }));
    const rb = await init(editor, editorCsrf, initBody({ name: "fresh.mp4", size: 100, sha256: await digest(b) }));
    const oldId = (await ra.json()).upload_id;
    const freshId = (await rb.json()).upload_id;
    await env.DB.prepare("UPDATE uploads SET created_at = datetime('now', '-25 hours') WHERE id = ?").bind(oldId).run();
    const oldRow = (await query("SELECT key, upload_id FROM uploads WHERE id = ?", oldId))[0];
    expect(await uploads.housekeeping(env)).toBe(1);
    expect((await query("SELECT id FROM uploads ORDER BY id")).map((r) => r.id)).toEqual([freshId]);
    await expect(env.MEDIA.resumeMultipartUpload(oldRow.key, oldRow.upload_id).uploadPart(1, a)).rejects.toThrow();
    // an orphan (multipart already gone on the R2 side) is dropped the same way once old
    await env.DB.prepare("UPDATE uploads SET created_at = datetime('now', '-2 days') WHERE id = ?").bind(freshId).run();
    await env.MEDIA.resumeMultipartUpload((await query("SELECT key FROM uploads WHERE id = ?", freshId))[0].key,
      (await query("SELECT upload_id FROM uploads WHERE id = ?", freshId))[0].upload_id).abort();
    expect(await uploads.housekeeping(env)).toBe(1);
    expect(await query("SELECT id FROM uploads")).toEqual([]);
    expect(await uploads.housekeeping(env)).toBe(0);
  });
});

describe("library page", () => {
  it("lists media with badges, size, duration, resolution, codec and local time; viewers get no upload panel", async () => {
    let r = await admin.get("/library");
    expect(r.status).toBe(200);
    let html = await r.text();
    expect(html).toContain("<h1>Library</h1>");
    expect(html).toContain("Upload media");
    expect(html).toMatch(/<form id="upload-form" method="post" action="\/library\/upload\/init" data-init="\/library\/upload\/init">\s*<input type="hidden" name="csrf_token" value="[^"]+">/);
    expect(html).toContain('<script src="/static/sha256.js"></script>');
    expect(html).toContain('<script src="/static/upload.js"></script>');
    expect(html).toContain("Max 5.0 GB per file.");
    expect(html).toContain('<span class="badge badge-video">VIDEO</span>');
    expect(html).toContain('<span class="badge badge-image">IMAGE</span>');
    expect(html).toContain("<td>My Clip (1).mp4</td>");
    expect(html).toContain("<td>12.0 MB</td>");
    expect(html).toContain("<td>2.0 s</td>");
    expect(html).toContain("<td>320×240</td>");
    expect(html).toContain("<td>—</td>");
    expect(html).toMatch(/<td>\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC<\/td>/);
    expect(html).toContain('data-confirm="Delete My Clip (1).mp4? It is removed from every playlist that uses it."');
    expect(html).not.toContain("onsubmit");
    expect(html).toMatch(/Media \(\d+\)/);

    r = await viewer.get("/library");
    html = await r.text();
    expect(html).not.toContain("Upload media");
    expect(html).not.toContain("upload.js");
    expect(html).not.toContain("Delete</button>");
    expect((await new Client().get("/library")).status).toBe(303);
  });

  it("escapes names", async () => {
    const d = fakeFile(300, 17);
    const r = await uploadWhole(editor, editorCsrf, `x<img src=x onerror=alert(1)>.png`, d, { media_type: "image" });
    expect(r.status, await r.clone().text()).toBe(200);
    const html = await admin.get("/library").then((x) => x.text());
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("x&lt;img src=x onerror=alert(1)&gt;.png");
  });

  it("delete removes the row + R2 object, renumbers playlists, audits; 404 after; viewers 403", async () => {
    const d = fakeFile(2000, 18);
    let r = await uploadWhole(editor, editorCsrf, "todelete.png", d, { media_type: "image" });
    const { media_id } = await r.json();
    const other = (await query("SELECT id FROM media WHERE original_name = 'pic.png'"))[0].id;
    const filename = (await query("SELECT filename FROM media WHERE id = ?", media_id))[0].filename;
    await env.DB.batch([
      env.DB.prepare("INSERT INTO playlists (id, name, updated_at) VALUES (77, 'pl', '2000-01-01 00:00:00')"),
      env.DB.prepare("INSERT INTO playlist_items (playlist_id, media_id, position) VALUES (77, ?, 0)").bind(other),
      env.DB.prepare("INSERT INTO playlist_items (playlist_id, media_id, position) VALUES (77, ?, 1)").bind(media_id),
      env.DB.prepare("INSERT INTO playlist_items (playlist_id, media_id, position) VALUES (77, ?, 2)").bind(other),
    ]);
    expect(await env.MEDIA.head("media/" + filename)).not.toBeNull();

    r = await viewer.post(`/library/${media_id}/delete`, { csrf_token: viewerCsrf });
    expect(r.status).toBe(403);
    r = await editor.post(`/library/abc/delete`, { csrf_token: editorCsrf });
    expect(r.status).toBe(400);
    r = await editor.post(`/library/${media_id}/delete`, { csrf_token: editorCsrf });
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toBe("/library");
    expect(await query("SELECT id FROM media WHERE id = ?", media_id)).toEqual([]);
    expect(await env.MEDIA.head("media/" + filename)).toBeNull();
    expect(await query("SELECT media_id, position FROM playlist_items WHERE playlist_id = 77 ORDER BY position"))
      .toEqual([{ media_id: other, position: 0 }, { media_id: other, position: 1 }]);
    expect((await query("SELECT updated_at FROM playlists WHERE id = 77"))[0].updated_at).not.toBe("2000-01-01 00:00:00");
    const a = (await query("SELECT details FROM audit_log WHERE action = 'delete_media'"))[0];
    expect(JSON.parse(a.details)).toEqual({ filename: "todelete.png", playlists: [77] });
    r = await editor.post(`/library/${media_id}/delete`, { csrf_token: editorCsrf });
    expect(r.status).toBe(404);
  });
});
