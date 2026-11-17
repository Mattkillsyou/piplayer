// Chunked uploads (src/uploads.js) and the Library page (src/pages/library.js): naming rules
// ported from web.py, init validation, the 12 MiB happy path through R2 multipart, dedupe
// before bytes move, resume, idempotent parts, abort, housekeeping, list + delete. Every library
// is its own account's (migration 0016): dedupe is per account, the file name carries the
// account, and another account's upload id answers like an unknown one.
import { beforeAll, describe, expect, it } from "vitest";
import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import * as accounts from "../src/accounts.js";
import * as auth from "../src/auth.js";
import worker from "../src/index.js";
import { MAX_DELETE, MAX_THUMB_BYTES } from "../src/pages/library.js";
import * as uploads from "../src/uploads.js";
import { fileSize, runTime } from "../src/util.js";
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

let admin, editor, viewer, csrf, editorCsrf, viewerCsrf, edId;

async function makeUser(username, role, password = "test1234") {
  const hash = await auth.hashPassword(password);
  const id = (await env.DB.prepare("INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)").bind(username, hash, role).run()).meta.last_row_id;
  await accounts.ensureDefaultPlaylist(env, id); // what /signup and the Users page do
  const c = new Client();
  expect((await c.login(username, password)).status).toBe(303);
  return c;
}

const defaultOf = async (id) => Number((await query("SELECT value FROM account_settings WHERE user_id = ? AND key = 'default_playlist_id'", id))[0].value);

beforeAll(async () => {
  admin = await setupAdmin("admin", "test1234");
  csrf = await admin.csrf("/library");
  editor = await makeUser("ed", "editor");
  editorCsrf = await editor.csrf("/library");
  viewer = await makeUser("vi", "viewer");
  viewerCsrf = await viewer.csrf("/library");
  edId = (await query("SELECT id FROM users WHERE username = 'ed'"))[0].id;
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
      // with the account (every upload since migration 0016): after the hash, still <= 120
      const owned = uploads.finalMediaName(SHA, name, ext, 12345);
      expect(owned.startsWith("0123456789abcdef_u12345_"), name).toBe(true);
      expect(owned.length, name).toBeLessThanOrEqual(120);
      expect(owned.endsWith(ext), name).toBe(true);
    }
    expect(uploads.finalMediaName(SHA, "video.mp4", ".mp4", 7)).toBe("0123456789abcdef_u7_video.mp4");
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
      [{ name: "virus.exe" }, "That file type (.exe) is not supported. Use bmp, gif, jpeg, jpg, m4v, mkv, mov, mp4, png, webm, webp."],
      [{ name: "noext" }, "That file has no extension, so its type cannot be told. Use mp4, mov, m4v, mkv, webm, jpg, png, gif, webp or bmp."],
      [{ name: "clip.mp4." }, "That file has no extension, so its type cannot be told. Use mp4, mov, m4v, mkv, webm, jpg, png, gif, webp or bmp."],
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
    expect(await r.json()).toEqual({ detail: "This file is 5.0 GB; the limit is 5.0 GB." });
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
    expect(row.key).toBe(`media/${sha.slice(0, 16)}_u${edId}_My_Clip_1.mp4`);
    expect(row.user_id).toBe(edId);
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
      filename: `${sha.slice(0, 16)}_u${edId}_My_Clip_1.mp4`, original_name: "My Clip (1).mp4", media_type: "video",
      size_bytes: 12 * MiB, duration_seconds: 2, width: 320, height: 240, codec: null, sha256: sha, owner_id: edId,
    });
    expect(await query("SELECT id FROM uploads")).toEqual([]);
    const obj = await env.MEDIA.head("media/" + media.filename);
    expect(obj.size).toBe(12 * MiB);
    expect(obj.httpMetadata.contentType).toBe("video/mp4");
    const stored = new Uint8Array(await (await env.MEDIA.get("media/" + media.filename)).arrayBuffer());
    expect(await digest(stored)).toBe(sha);
    const audit = await query("SELECT username, action, target_id, details FROM audit_log WHERE action = 'upload_media'");
    // every upload joins the uploader's own Default playlist (test/default_playlist.test.js)
    const dflt = await defaultOf(edId);
    expect(audit).toEqual([{ username: "ed", action: "upload_media", target_id: String(mediaId), details: `{"filename": "My Clip (1).mp4", "type": "video", "playlist": ${dflt}}` }]);
    // the completed upload is gone on the R2 side too
    r = await editor.postJson(`/library/upload/${uploadId}/complete`, {}, { "X-CSRF-Token": editorCsrf });
    expect(r.status).toBe(404);
  });

  it("duplicate content is refused at init (409, friendly, no upload created)", async () => {
    const r = await init(editor, editorCsrf, initBody({ name: "other name.mp4", sha256: sha }));
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ detail: "Already in the library as 'My Clip (1).mp4'." });
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
      method: "PUT", body: part1, headers: { "X-CSRF-Token": editorCsrf, cookie: editor.cookie, "content-length": String(part1.byteLength) },
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
    expect((await p.json()).detail).toBe("This upload is no longer open. Drop the file again to start over.");
    await editor.postJson(`/library/upload/${upload_id}/abort`, {}, { "X-CSRF-Token": editorCsrf });
  });

  it("a claim older than CLAIM_STALE_SECONDS is taken over; a live one is 409", async () => {
    const small = fakeFile(1 * MiB, 10);
    let r = await init(editor, editorCsrf, initBody({ name: "stale.mp4", size: small.length, sha256: await digest(small) }));
    const { upload_id } = await r.json();
    const now = Math.floor(Date.now() / 1000);
    // a worker that died inside uploadPart 11 minutes ago left this claim behind
    await env.DB.prepare("UPDATE uploads SET parts = ? WHERE id = ?")
      .bind(JSON.stringify([{ partNumber: 1, etag: null, claim: "dead", at: now - 11 * 60 }]), upload_id).run();
    r = await putPart(editor, editorCsrf, upload_id, 1, small);
    expect(r.status, await r.clone().text()).toBe(200);
    expect(JSON.parse((await query("SELECT parts FROM uploads WHERE id = ?", upload_id))[0].parts))
      .toEqual([{ partNumber: 1, etag: expect.any(String) }]);
    // a claim from a minute ago is a live PUT of another tab
    await env.DB.prepare("UPDATE uploads SET parts = ?, received = 0 WHERE id = ?")
      .bind(JSON.stringify([{ partNumber: 1, etag: null, claim: "live", at: now - 60 }]), upload_id).run();
    r = await putPart(editor, editorCsrf, upload_id, 1, small);
    expect(r.status).toBe(409);
    expect((await r.json()).detail).toBe("part 1 is already being uploaded");
    await editor.postJson(`/library/upload/${upload_id}/abort`, {}, { "X-CSRF-Token": editorCsrf });
  });

  it("two accounts uploading the same bytes: each gets its own media row and object; the dedupe message never names the other's file", async () => {
    const same = fakeFile(1 * MiB, 20);
    const sha = await digest(same);
    const other = await makeUser("ed3", "editor");
    const otherCsrf = await other.csrf("/library");
    const otherId = (await query("SELECT id FROM users WHERE username = 'ed3'"))[0].id;
    let r = await init(editor, editorCsrf, initBody({ name: "one.mp4", size: same.length, sha256: sha }));
    const a = (await r.json()).upload_id;
    r = await init(other, otherCsrf, initBody({ name: "two.mp4", size: same.length, sha256: sha }));
    const b = (await r.json()).upload_id;
    expect((await query("SELECT COUNT(*) AS n FROM uploads WHERE sha256 = ?", sha))[0].n).toBe(2);
    expect((await putPart(editor, editorCsrf, a, 1, same)).status).toBe(200);
    expect((await putPart(other, otherCsrf, b, 1, same)).status).toBe(200);
    r = await editor.postJson(`/library/upload/${a}/complete`, {}, { "X-CSRF-Token": editorCsrf });
    expect(r.status, await r.clone().text()).toBe(200);
    r = await other.postJson(`/library/upload/${b}/complete`, {}, { "X-CSRF-Token": otherCsrf });
    expect(r.status, await r.clone().text()).toBe(200);
    const rows = await query("SELECT original_name, owner_id, filename FROM media WHERE sha256 = ? ORDER BY id", sha);
    expect(rows.map((x) => [x.original_name, x.owner_id])).toEqual([["one.mp4", edId], ["two.mp4", otherId]]);
    for (const x of rows) expect(await digest(new Uint8Array(await (await env.MEDIA.get("media/" + x.filename)).arrayBuffer()))).toBe(sha);
    // each joined its own account's Default playlist
    expect(await query("SELECT playlist_id FROM playlist_items pi JOIN media m ON m.id = pi.media_id WHERE m.sha256 = ? ORDER BY m.id", sha))
      .toEqual([{ playlist_id: await defaultOf(edId) }, { playlist_id: await defaultOf(otherId) }]);
    // the same bytes again: refused in the library that has them, with its own name only
    r = await init(other, otherCsrf, initBody({ name: "three.mp4", size: same.length, sha256: sha }));
    expect([r.status, await r.json()]).toEqual([409, { detail: "Already in the library as 'two.mp4'." }]);
    r = await init(editor, editorCsrf, initBody({ name: "three.mp4", size: same.length, sha256: sha }));
    expect([r.status, await r.json()]).toEqual([409, { detail: "Already in the library as 'one.mp4'." }]);
    // deleting one account's copy leaves the other's row and object
    const mine = await query("SELECT id, filename FROM media WHERE sha256 = ? AND owner_id = ?", sha, edId);
    expect((await editor.post(`/library/${mine[0].id}/delete`, { csrf_token: editorCsrf })).status).toBe(303);
    expect(await query("SELECT media_id FROM media_trash WHERE filename = ?", mine[0].filename)).toEqual([{ media_id: mine[0].id }]); // Recently deleted
    const theirs = rows.find((x) => x.owner_id === otherId);
    expect((await env.MEDIA.head("media/" + theirs.filename)).size).toBe(1 * MiB);
    expect((await query("SELECT COUNT(*) AS n FROM media WHERE sha256 = ?", sha))[0].n).toBe(1);
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

  it("only the uploader drives an upload: another editor and an admin get the 404 of an unknown id", async () => {
    const small = fakeFile(100, 14);
    const r = await init(editor, editorCsrf, initBody({ name: "mine.mp4", size: 100, sha256: await digest(small) }));
    const { upload_id } = await r.json();
    const other = await makeUser("ed2", "editor");
    const otherCsrf = await other.csrf("/library");
    for (const [c, token] of [[other, otherCsrf], [admin, csrf]]) {
      for (const res of [
        await c.get(`/library/upload/${upload_id}`),
        await putPart(c, token, upload_id, 1, small),
        await c.postJson(`/library/upload/${upload_id}/complete`, {}, { "X-CSRF-Token": token }),
        await c.postJson(`/library/upload/${upload_id}/abort`, {}, { "X-CSRF-Token": token }),
      ]) expect([res.status, await res.json()]).toEqual([404, { detail: "Upload not found" }]);
    }
    expect(await query("SELECT received FROM uploads WHERE id = ?", upload_id)).toEqual([{ received: 0 }]);
    expect((await editor.get(`/library/upload/${upload_id}`)).status).toBe(200);
    expect((await editor.postJson(`/library/upload/${upload_id}/abort`, {}, { "X-CSRF-Token": editorCsrf })).status).toBe(200);
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
  it("lists media as preview cards with badge, size, length, resolution, local time and playlists; viewers get no upload panel", async () => {
    let r = await editor.get("/library");
    expect(r.status).toBe(200);
    let html = await r.text();
    expect(html).toContain("<h1>Library</h1>");
    expect(html).toContain("Upload queue");
    expect(html).toMatch(/<form id="upload-form" method="post" action="\/library\/upload\/init" data-init="\/library\/upload\/init">\s*<input type="hidden" name="csrf_token" value="[^"]+">/);
    expect(html).toContain('<script src="/static/media.js"></script>');
    expect(html).toContain('<script src="/static/sha256.js"></script>');
    expect(html).toContain('<script src="/static/upload.js"></script>');
    expect(html).toContain("Max 5.0 GB per file.");
    expect(html).toContain('<span class="badge badge-video">VIDEO</span>');
    expect(html).toContain('<span class="badge badge-image">IMAGE</span>');
    // the card: a preview that links to the file (the viewer opens it), then the name and the facts
    const id = (await query("SELECT id FROM media WHERE original_name = 'My Clip (1).mp4'"))[0].id;
    expect(html).toContain(`<img src="/library/${id}/thumb" alt="" loading="lazy" decoding="async" data-thumb="${id}">`);
    expect(html).toMatch(/<a class="media-thumb" href="\/api\/media\/[0-9a-f]{16}_u\d+_My_Clip_1\.mp4" target="_blank" rel="noopener" data-view data-kind="video" data-name="My Clip \(1\)\.mp4" data-meta="12 MB · 320×240 · 2\.0 s · uploaded \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC" aria-label="Open My Clip \(1\)\.mp4">/);
    expect(html).toContain('<span class="media-length">2.0 s</span>');
    expect(html).toContain('<span class="media-name" title="My Clip (1).mp4">My Clip (1).mp4</span>');
    expect(html).toContain('<span class="media-meta">12 MB · 320×240</span>');
    expect(html).toMatch(/<span class="media-meta">\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC<\/span>/);
    expect(html).toContain('<span class="media-used" title="Default">In Default</span>'); // an upload goes into the account's Default
    expect(html).toContain('data-kind="img" data-name="pic.png"'); // a picture opens as an <img>, a video as a <video>
    // one form round the grid: a Delete per card, a tick box per card and Delete selected
    // autocomplete="off": Back must not restore ticks by position onto other files; data-max caps Select all
    expect(html).toMatch(new RegExp(`<form id="library-form" method="post" action="/library/delete" autocomplete="off" data-max="${MAX_DELETE}">\\s*<input type="hidden" name="csrf_token" value="[^"]+">`));
    expect(html).toContain(`<input type="checkbox" name="media_id" value="${id}" aria-label="Select My Clip (1).mp4">`);
    expect(html).toContain(`<button type="submit" name="one" value="${id}" class="danger small" data-confirm="Delete My Clip (1).mp4? It is removed from every playlist that uses it.">Delete</button>`);
    expect(html).toContain('data-delete-selected data-confirm="Delete the selected files? They are removed from every playlist that uses them.">Delete selected</button>');
    expect(html).toContain('<ul class="media-grid" data-thumb-put>');
    expect(html).not.toContain("onsubmit");
    expect(html).not.toContain("<table");
    expect(html).toMatch(/Media \(\d+\)/);

    r = await viewer.get("/library");
    html = await r.text();
    expect(html).not.toContain("Upload queue");
    expect(html).not.toContain("upload.js");
    expect(html).toContain('<script src="/static/media.js"></script>'); // a viewer can still open a file
    expect(html).not.toContain("Delete</button>");
    expect(html).not.toContain("data-thumb-put");
    expect((await new Client().get("/library")).status).toBe(303);
    // another account's library, an admin's included, holds none of the editor's files
    for (const c of [viewer, admin]) {
      html = await (await c.get("/library")).text();
      expect(html).not.toContain("My Clip (1).mp4");
      expect(html).toContain("Media (0)");
    }
  });

  it("escapes names", async () => {
    const d = fakeFile(300, 17);
    const r = await uploadWhole(editor, editorCsrf, `x<img src=x onerror=alert(1)>.png`, d, { media_type: "image" });
    expect(r.status, await r.clone().text()).toBe(200);
    const html = await editor.get("/library").then((x) => x.text());
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("x&lt;img src=x onerror=alert(1)&gt;.png");
  });

  it("delete moves the row to Recently deleted (the R2 object stays), renumbers playlists, audits; 404 after; viewers 403", async () => {
    const d = fakeFile(2000, 18);
    let r = await uploadWhole(editor, editorCsrf, "todelete.png", d, { media_type: "image" });
    const { media_id } = await r.json();
    const other = (await query("SELECT id FROM media WHERE original_name = 'pic.png'"))[0].id;
    const filename = (await query("SELECT filename FROM media WHERE id = ?", media_id))[0].filename;
    await env.DB.batch([
      env.DB.prepare("INSERT INTO playlists (id, owner_id, name, legacy_name, updated_at) VALUES (77, ?, 'pl', 'pl', '2000-01-01 00:00:00')").bind(edId),
      env.DB.prepare("INSERT INTO playlist_items (playlist_id, media_id, position) VALUES (77, ?, 0)").bind(other),
      env.DB.prepare("INSERT INTO playlist_items (playlist_id, media_id, position) VALUES (77, ?, 1)").bind(media_id),
      env.DB.prepare("INSERT INTO playlist_items (playlist_id, media_id, position) VALUES (77, ?, 2)").bind(other),
    ]);
    expect(await env.MEDIA.head("media/" + filename)).not.toBeNull();

    r = await viewer.post(`/library/${media_id}/delete`, { csrf_token: viewerCsrf });
    expect(r.status).toBe(403);
    r = await editor.post(`/library/abc/delete`, { csrf_token: editorCsrf });
    expect(r.status).toBe(400);
    // an admin cannot delete another account's file: the 404 of a missing id, nothing removed
    r = await admin.post(`/library/${media_id}/delete`, { csrf_token: csrf });
    expect([r.status, await r.json()]).toEqual([404, { detail: "Not Found" }]);
    expect(await query("SELECT id FROM media WHERE id = ?", media_id)).toEqual([{ id: media_id }]);
    r = await editor.post(`/library/${media_id}/delete`, { csrf_token: editorCsrf });
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toBe("/library");
    expect(await query("SELECT id FROM media WHERE id = ?", media_id)).toEqual([]);
    expect(await env.MEDIA.head("media/" + filename)).not.toBeNull();
    expect(JSON.parse((await query("SELECT places FROM media_trash WHERE media_id = ?", media_id))[0].places))
      .toContainEqual({ playlist_id: 77, position: 1, override: null });
    expect(await query("SELECT media_id, position FROM playlist_items WHERE playlist_id = 77 ORDER BY position"))
      .toEqual([{ media_id: other, position: 0 }, { media_id: other, position: 1 }]);
    expect((await query("SELECT updated_at FROM playlists WHERE id = 77"))[0].updated_at).not.toBe("2000-01-01 00:00:00");
    const a = (await query("SELECT details FROM audit_log WHERE action = 'delete_media' ORDER BY id DESC"))[0];
    const dflt = await defaultOf(edId);
    expect(JSON.parse(a.details)).toEqual({ filename: "todelete.png", playlists: [dflt, 77] }); // the upload put it in the editor's Default too
    r = await editor.post(`/library/${media_id}/delete`, { csrf_token: editorCsrf });
    expect(r.status).toBe(404);
  });
});

describe("library previews and Delete selected", () => {
  // A preview body: any bytes that start like a JPEG (the server checks the magic, never decodes).
  const jpeg = (n, seed = 40) => { const b = fakeFile(n, seed); b.set([0xff, 0xd8, 0xff], 0); return b; };
  const putThumb = (c, token, id, body, headers = {}) => c.fetch(`/library/${id}/thumb`,
    { method: "PUT", body, headers: { "X-CSRF-Token": token, "content-type": "image/jpeg", ...headers } });
  const fileOf = async (id) => (await query("SELECT filename FROM media WHERE id = ?", id))[0].filename;
  const flash = async (c) => /<div class="alert [a-z]+" role="alert">([^<]*)<\/div>/.exec(await (await c.get("/library")).text())?.[1];
  const form = (token, pairs) => [["csrf_token", token], ...pairs];

  it("fileSize and runTime read the way a person writes them", () => {
    expect([0, -5, NaN, "x", 500, 999, 1000, 1024, 963584, 3984589, 10 * MiB - 52429, 10 * MiB, 20 * MiB, 1023.6 * MiB, 1288490189, 5 * 1024 ** 4].map(fileSize))
      .toEqual(["0 B", "0 B", "0 B", "0 B", "500 B", "999 B", "1.0 KB", "1.0 KB", "941 KB", "3.8 MB", "9.9 MB", "10 MB", "20 MB", "1.0 GB", "1.2 GB", "5120 GB"]);
    expect([0, -1, null, undefined, "x", Infinity, 6, 0.04, 59.94, 59.95, 65, 600, 3723].map(runTime))
      .toEqual(["", "", "", "", "", "", "6.0 s", "0.0 s", "59.9 s", "1:00", "1:05", "10:00", "1:02:03"]);
  });

  it("a picture with no preview yet sends the picture, a video 404; a stored preview is served to its own account only", async () => {
    let r = await uploadWhole(editor, editorCsrf, "thumb-pic.png", fakeFile(500, 41), { media_type: "image" });
    const pic = (await r.json()).media_id;
    r = await uploadWhole(editor, editorCsrf, "thumb-clip.mp4", fakeFile(700, 42));
    const clip = (await r.json()).media_id;
    const clipFile = await fileOf(clip);

    r = await editor.get(`/library/${pic}/thumb`);
    expect([r.status, r.headers.get("location"), r.headers.get("cache-control")]).toEqual([302, `/api/media/${await fileOf(pic)}`, "no-store"]);
    expect((await editor.get(`/library/${clip}/thumb`)).status).toBe(404);
    expect((await viewer.get(`/library/${clip}/thumb`)).status).toBe(404); // another account: like a missing file
    expect((await editor.get("/library/abc/thumb")).status).toBe(400);

    // only an editor of the file's own account stores one, with the CSRF token, a JPEG, small
    const body = jpeg(2000);
    expect((await putThumb(viewer, viewerCsrf, clip, body)).status).toBe(403);
    expect((await putThumb(admin, csrf, clip, body)).status).toBe(404);
    expect((await editor.fetch(`/library/${clip}/thumb`, { method: "PUT", body, headers: { "content-type": "image/jpeg" } })).status).toBe(403);
    const notJpeg = fakeFile(100, 43);
    notJpeg[0] = 0x89;
    expect((await putThumb(editor, editorCsrf, clip, notJpeg)).status).toBe(400);
    expect((await putThumb(editor, editorCsrf, clip, jpeg(MAX_THUMB_BYTES + 1))).status).toBe(413);
    const stream = new ReadableStream({ start(c) { c.enqueue(jpeg(10)); c.close(); } });
    expect((await putThumb(editor, editorCsrf, clip, stream)).status).toBe(411); // no Content-Length
    expect(await env.MEDIA.head(`thumbs/${clipFile}.jpg`)).toBeNull();

    r = await putThumb(editor, editorCsrf, clip, body);
    expect([r.status, await r.json()]).toEqual([200, { ok: true }]);
    const stored = await env.MEDIA.get(`thumbs/${clipFile}.jpg`);
    expect(stored.httpMetadata.contentType).toBe("image/jpeg");
    expect(new Uint8Array(await stored.arrayBuffer())).toEqual(body);
    r = await editor.get(`/library/${clip}/thumb`);
    expect([r.status, r.headers.get("content-type"), r.headers.get("cache-control")]).toEqual([200, "image/jpeg", "private, max-age=604800"]);
    expect(new Uint8Array(await r.arrayBuffer())).toEqual(body);
    for (const c of [viewer, admin]) expect((await c.get(`/library/${clip}/thumb`)).status).toBe(404);

    // deleting the file keeps its preview for Restore (Empty takes it along: trash.test.js)
    expect((await editor.post(`/library/${clip}/delete`, { csrf_token: editorCsrf })).status).toBe(303);
    expect(await env.MEDIA.head(`thumbs/${clipFile}.jpg`)).not.toBeNull();
    expect((await editor.post(`/library/${pic}/delete`, { csrf_token: editorCsrf })).status).toBe(303);
  });

  it("Delete selected moves the ticked files of the caller's own account to Recently deleted; a card's own Delete wins over the ticks", async () => {
    const ids = [];
    for (const [i, name] of ["sel-a.png", "sel-b.png", "sel-c.png"].entries()) {
      ids.push((await (await uploadWhole(editor, editorCsrf, name, fakeFile(300 + i, 50 + i), { media_type: "image" })).json()).media_id);
    }
    const files = await Promise.all(ids.map(fileOf));
    for (const f of files) await env.MEDIA.put(`thumbs/${f}.jpg`, jpeg(10));
    const theirs = (await (await uploadWhole(admin, csrf, "theirs.png", fakeFile(310, 60), { media_type: "image" })).json()).media_id;
    const left = async () => (await query(`SELECT id FROM media WHERE id IN (${[...ids, theirs].join(",")}) ORDER BY id`)).map((x) => x.id);

    let r = await editor.post("/library/delete", { csrf_token: editorCsrf });
    expect([r.status, r.headers.get("location")]).toEqual([303, "/library"]);
    expect(await flash(editor)).toBe("Nothing was ticked. Tick the files to delete, then press Delete selected.");
    expect((await viewer.post("/library/delete", form(viewerCsrf, [["media_id", String(ids[0])]]))).status).toBe(403);
    expect((await editor.post("/library/delete", form(editorCsrf, [["media_id", "abc"]]))).status).toBe(400);
    const tooMany = Array.from({ length: MAX_DELETE + 1 }, (_, i) => ["media_id", String(i + 1)]);
    expect((await editor.post("/library/delete", form(editorCsrf, tooMany))).status).toBe(400);
    expect(await left()).toEqual([...ids, theirs]);

    // a card's Delete button (one=) deletes that file only, whatever else is ticked
    r = await editor.post("/library/delete", form(editorCsrf, [["one", String(ids[0])], ["media_id", String(ids[1])], ["media_id", String(ids[2])]]));
    expect([r.status, r.headers.get("location")]).toEqual([303, "/library"]);
    expect(await flash(editor)).toBe("Deleted sel-a.png.");
    expect(await left()).toEqual([ids[1], ids[2], theirs]);

    // the ticked ones: a repeat counts once, another account's file is skipped like a missing one
    r = await editor.post("/library/delete", form(editorCsrf, [ids[1], ids[2], ids[2], theirs].map((id) => ["media_id", String(id)])));
    expect(r.status).toBe(303);
    expect(await flash(editor)).toBe("Deleted 2 files.");
    expect(await left()).toEqual([theirs]);
    for (const f of files) { // kept for Restore
      expect(await env.MEDIA.head(`media/${f}`), f).not.toBeNull();
      expect(await env.MEDIA.head(`thumbs/${f}.jpg`), f).not.toBeNull();
    }
    expect((await query(`SELECT media_id FROM media_trash WHERE media_id IN (${ids.join(",")}) ORDER BY media_id`)).map((t) => t.media_id)).toEqual(ids);
    expect(await env.MEDIA.head(`media/${await fileOf(theirs)}`)).not.toBeNull();
    const audited = await query(`SELECT target_id, details FROM audit_log WHERE action = 'delete_media' AND target_id IN (${ids.map((id) => `'${id}'`).join(",")}) ORDER BY id`);
    expect(audited.map((a) => [Number(a.target_id), JSON.parse(a.details).filename])).toEqual([[ids[0], "sel-a.png"], [ids[1], "sel-b.png"], [ids[2], "sel-c.png"]]);

    r = await editor.post("/library/delete", form(editorCsrf, [["media_id", String(ids[1])]]));
    expect(r.status).toBe(303);
    expect(await flash(editor)).toBe("Nothing was deleted: those files are no longer in the library.");
    expect((await admin.post(`/library/${theirs}/delete`, { csrf_token: csrf })).status).toBe(303);
  });
});
