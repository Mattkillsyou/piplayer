// Chunked uploads (spec 'Uploads'): the browser hashes the file, POSTs init (dedupe on sha256
// before any byte moves, R2 createMultipartUpload), PUTs fixed 8 MiB parts, then completes.
// Port of the validation / naming / dedupe rules of web.library_upload + _final_media_name;
// the metadata ffprobe used to produce now comes from the browser (no ffprobe in Workers).
import * as audit from "./audit.js";
import * as auth from "./auth.js";
import * as db from "./db.js";
import { envInt, fail, hex, idParam, json, jsonObject, randomToken } from "./util.js";

export const PART_SIZE = 8 * 1024 * 1024;
export const MAX_FILENAME_LEN = 120;
export const UPLOAD_MAX_AGE_HOURS = 24;
// A part claimed (etag null) this long ago belongs to a worker that died mid-uploadPart and
// may be claimed again; a live uploadPart of 8 MiB is a matter of seconds.
export const CLAIM_STALE_SECONDS = 10 * 60;
export const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".m4v", ".mkv", ".webm"]);
export const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"]);
export const ALLOWED_EXTENSIONS = [...VIDEO_EXTENSIONS, ...IMAGE_EXTENSIONS].sort();

const CONTENT_TYPES = {
  ".mp4": "video/mp4", ".mov": "video/quicktime", ".m4v": "video/x-m4v", ".mkv": "video/x-matroska",
  ".webm": "video/webm", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
  ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp",
};

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested against the Python originals)
// ---------------------------------------------------------------------------

export function mediaTypeForExt(ext) {
  ext = ext.toLowerCase();
  if (VIDEO_EXTENSIONS.has(ext)) return "video";
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  return null;
}

// Path(name).suffix.lower() of the last path component ('' for 'noext' / '.bashrc').
export function extOf(name) {
  const base = name.slice(name.lastIndexOf("/") + 1);
  const i = base.lastIndexOf(".");
  return i > 0 ? base.slice(i).toLowerCase() : "";
}

// web._sanitize_filename: last path component, non [A-Za-z0-9._-] runs -> '_', strip './_'.
export function sanitizeFilename(name) {
  const base = name.slice(name.lastIndexOf("/") + 1);
  return stripDots(base.replace(/[^A-Za-z0-9._-]+/g, "_")) || "asset";
}

const stripDots = (s) => s.replace(/^[._]+/, "").replace(/[._]+$/, "");

// web._final_media_name: '<sha16>_<sanitized original><ext>', whole name <= MAX_FILENAME_LEN.
export function finalMediaName(sha, original, ext) {
  const safe = sanitizeFilename(original || "asset");
  let stem = ext && safe.toLowerCase().endsWith(ext) ? safe.slice(0, -ext.length) : safe;
  const budget = MAX_FILENAME_LEN - 17 - ext.length;
  stem = stripDots(stem.slice(0, Math.max(budget, 0))) || "asset";
  return `${sha.slice(0, 16)}_${stem}${ext}`;
}

export const totalParts = (size) => Math.ceil(size / PART_SIZE);

// Byte length part n (1-based) must have: PART_SIZE, or the remainder for the last part.
export function expectedPartSize(size, n) {
  return n < totalParts(size) ? PART_SIZE : size - (n - 1) * PART_SIZE;
}

const maxBytes = (env) => envInt(env, "PIPLAYER_MAX_UPLOAD_BYTES", 5 * 1024 * 1024 * 1024);

// ---------------------------------------------------------------------------
// Validation of the init body (every field -> 400 {detail}, size -> 413)
// ---------------------------------------------------------------------------

function optionalNumber(body, field, { integer = false } = {}) {
  const v = body[field];
  if (v === undefined || v === null) return null;
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0 || (integer && !Number.isInteger(v))) {
    fail(400, `${field} must be a positive ${integer ? "integer" : "number"} or null`);
  }
  return v;
}

function validateInit(body, env) {
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) fail(400, "name required");
  if (name.length > 1024) fail(400, "name too long");
  const ext = extOf(name);
  let mediaType = mediaTypeForExt(ext);
  if (mediaType === null) {
    fail(400, ext.length > 1 ? `That file type (${ext}) is not supported. Use ${ALLOWED_EXTENSIONS.map((e) => e.slice(1)).join(", ")}.`
      : "That file has no extension, so its type cannot be told. Use mp4, mov, m4v, mkv, webm, jpg, png, gif, webp or bmp.");
  }
  const size = body.size;
  if (typeof size !== "number" || !Number.isInteger(size) || size < 0) fail(400, "size must be a non-negative integer");
  if (size === 0) fail(400, "empty file");
  if (size > maxBytes(env)) fail(413, `This file is ${(size / 2 ** 30).toFixed(1)} GB; the limit is ${(maxBytes(env) / 2 ** 30).toFixed(1)} GB.`);
  if (typeof body.sha256 !== "string" || !/^[0-9a-fA-F]{64}$/.test(body.sha256)) fail(400, "sha256 must be 64 hex chars");
  const sha256 = body.sha256.toLowerCase();
  if (body.media_type !== undefined && body.media_type !== null && body.media_type !== "video" && body.media_type !== "image") {
    fail(400, "media_type must be 'video' or 'image'");
  }
  if (body.animated !== undefined && body.animated !== null && typeof body.animated !== "boolean") fail(400, "animated must be a boolean");
  // An animated GIF is a short video to mpv (image-display-duration does not apply). The
  // server never sees the frames, so it trusts the browser's `animated` flag (upload.js
  // counts Graphic Control Extension blocks); a mis-detected GIF is a plain image.
  if (ext === ".gif" && (body.animated === true || body.media_type === "video")) mediaType = "video";
  const duration = optionalNumber(body, "duration_seconds");
  const width = optionalNumber(body, "width", { integer: true });
  const height = optionalNumber(body, "height", { integer: true });
  return {
    name, ext, size, sha256, mediaType,
    duration: mediaType === "video" ? duration : null,
    width, height,
    contentType: CONTENT_TYPES[ext] || "application/octet-stream",
  };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

async function duplicateOf(env, sha256) {
  const existing = await db.first(env, "SELECT id, original_name FROM media WHERE sha256 = ?", sha256);
  if (existing) fail(409, `Already in the library as '${existing.original_name}'.`);
}

async function uploadInit(ctx) {
  const user = auth.requireRole(ctx, "editor");
  const body = await jsonObject(ctx.request);
  const v = validateInit(body, ctx.env);
  await duplicateOf(ctx.env, v.sha256);

  // Same content already in flight (page reload mid-upload): hand back that upload so the
  // browser can skip the parts it already sent (GET status), instead of starting over.
  const inflight = await db.first(ctx.env,
    "SELECT id, received FROM uploads WHERE sha256 = ? AND size = ? AND user_id = ?", v.sha256, v.size, user.id);
  if (inflight) return json({ upload_id: inflight.id, part_size: PART_SIZE, received: inflight.received });

  const key = "media/" + finalMediaName(v.sha256, v.name, v.ext);
  // The key comes from the browser's sha256 prefix and name only: a different file whose
  // sha256 shares the first 16 hex chars must not open a second multipart at a key the
  // library (or another in-flight upload) already holds, or complete would replace those bytes.
  if (await db.first(ctx.env, "SELECT 1 FROM media WHERE filename = ? UNION ALL SELECT 1 FROM uploads WHERE key = ?", key.slice("media/".length), key)) {
    fail(409, "A file with this name is already in the library or being uploaded");
  }
  const mp = await ctx.env.MEDIA.createMultipartUpload(key, {
    httpMetadata: { contentType: v.contentType },
    customMetadata: { sha256: v.sha256, original_name: v.name.slice(0, 200) },
  });
  const id = randomToken(16);
  await db.run(ctx.env,
    `INSERT INTO uploads (id, user_id, key, upload_id, name, size, sha256, media_type, duration_seconds, width, height)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, user.id, key, mp.uploadId, v.name, v.size, v.sha256, v.mediaType, v.duration, v.width, v.height);
  return json({ upload_id: id, part_size: PART_SIZE, received: 0 });
}

async function loadUpload(ctx) {
  const user = auth.requireRole(ctx, "editor");
  const row = await db.first(ctx.env, "SELECT * FROM uploads WHERE id = ?", ctx.params.id);
  if (!row) fail(404, "Upload not found");
  if (row.user_id !== user.id && user.role !== "admin") fail(403, "You can only continue or cancel your own uploads");
  row.parts = JSON.parse(row.parts);
  return row;
}

// Parts R2 holds for sure (a `parts` entry without an etag is a claim still in flight).
const donePartsOf = (row) => row.parts.filter((p) => p.etag).sort((a, b) => a.partNumber - b.partNumber);
const partNumbers = (row) => donePartsOf(row).map((p) => p.partNumber);

// The row's parts JSON minus the entry for one part number (correlated on the row being
// updated), so an entry can be replaced with json_insert(<this>, '$[#]', ...).
const PARTS_WITHOUT = "(SELECT json_group_array(json(value)) FROM json_each(uploads.parts) WHERE json_extract(value, '$.partNumber') != ?)";

// Claim part n before R2 sees a byte of it: R2 (like S3) replaces a re-uploaded part number
// and the earlier etag stops being valid at complete, so two racing PUTs of the same part
// (two tabs resuming the same file both hold the in-flight upload id) must not both reach
// uploadPart. The guard admits a part nobody holds, or a stale claim of a dead worker.
async function claimPart(env, row, n, claim) {
  const { changes } = await db.run(env,
    `UPDATE uploads SET parts = json_insert(${PARTS_WITHOUT}, '$[#]', json(?))
     WHERE id = ? AND NOT EXISTS (SELECT 1 FROM json_each(uploads.parts)
       WHERE json_extract(value, '$.partNumber') = ?
         AND (json_extract(value, '$.etag') IS NOT NULL OR json_extract(value, '$.at') > ?))`,
    n, JSON.stringify(claim), row.id, n, claim.at - CLAIM_STALE_SECONDS);
  return changes === 1;
}

function releaseClaim(env, row, n, claim) {
  return db.run(env,
    `UPDATE uploads SET parts = ${PARTS_WITHOUT}
     WHERE id = ? AND EXISTS (SELECT 1 FROM json_each(uploads.parts) WHERE json_extract(value, '$.claim') = ?)`,
    n, row.id, claim.claim);
}

async function uploadPart(ctx) {
  const row = await loadUpload(ctx);
  const n = idParam(ctx.params.n, "n");
  if (n < 1 || n > totalParts(row.size)) fail(400, `part number ${n} out of range (1..${totalParts(row.size)})`);
  // Idempotent: a retried part that already landed is acknowledged without touching R2.
  if (row.parts.some((p) => p.partNumber === n && p.etag)) return json({ received: row.received });
  const expected = expectedPartSize(row.size, n);
  const declared = parseInt(ctx.request.headers.get("content-length") || "", 10);
  if (declared !== expected) fail(400, `part ${n} must be ${expected} bytes`); // a missing Content-Length fails before the body is read
  // The body is read before the claim so a tab closed mid-transfer never leaves a claim
  // behind; only a worker dying inside uploadPart can, and that one goes stale.
  const body = await ctx.request.arrayBuffer();
  if (body.byteLength !== expected) fail(400, `part ${n} must be ${expected} bytes`);

  const claim = { partNumber: n, etag: null, claim: randomToken(8), at: Math.floor(Date.now() / 1000) };
  if (!(await claimPart(ctx.env, row, n, claim))) {
    const fresh = await loadUpload(ctx);
    if (fresh.parts.some((p) => p.partNumber === n && p.etag)) return json({ received: fresh.received });
    fail(409, `part ${n} is already being uploaded`);
  }
  let part;
  try {
    part = await ctx.env.MEDIA.resumeMultipartUpload(row.key, row.upload_id).uploadPart(n, body);
  } catch (e) {
    await releaseClaim(ctx.env, row, n, claim);
    console.warn(`uploadPart ${row.id} part ${n}:`, e && e.message ? e.message : e);
    fail(409, "This upload is no longer open. Drop the file again to start over.");
  }
  // Record the etag R2 holds for this part, guarded on our claim: if it went stale and was
  // taken over meanwhile, the other request's etag is the one on file.
  const { changes } = await db.run(ctx.env,
    `UPDATE uploads SET parts = json_insert(${PARTS_WITHOUT}, '$[#]', json(?)), received = received + ?
     WHERE id = ? AND EXISTS (SELECT 1 FROM json_each(uploads.parts) WHERE json_extract(value, '$.claim') = ?)`,
    n, JSON.stringify({ partNumber: n, etag: part.etag }), expected, row.id, claim.claim);
  if (changes === 0) fail(409, `part ${n} was taken over by another upload of the same file`);
  const fresh = await db.first(ctx.env, "SELECT received FROM uploads WHERE id = ?", row.id);
  return json({ received: fresh ? fresh.received : row.received + expected });
}

async function uploadStatus(ctx) {
  const row = await loadUpload(ctx);
  return json({ received: row.received, size: row.size, part_size: PART_SIZE, parts: partNumbers(row) });
}

async function uploadComplete(ctx) {
  const row = await loadUpload(ctx);
  const total = totalParts(row.size);
  const parts = donePartsOf(row);
  if (parts.length !== total || row.received !== row.size) {
    fail(400, `upload incomplete: ${row.received} of ${row.size} bytes (${parts.length}/${total} parts)`);
  }
  // Re-check the duplicate rule: another upload of the same bytes may have won meanwhile
  // (the fast path with the friendly name; the UNIQUE index on sha256 catches the same-instant race).
  const existing = await db.first(ctx.env, "SELECT id, original_name FROM media WHERE sha256 = ?", row.sha256);
  if (existing) {
    await abortMultipart(ctx.env, row);
    await db.run(ctx.env, "DELETE FROM uploads WHERE id = ?", row.id);
    fail(409, `Already in the library as '${existing.original_name}'.`);
  }
  const filename = row.key.slice("media/".length);
  let mediaId;
  try {
    // The media row is inserted before R2 completes the object, so a name or sha256 clash
    // fails here while the multipart can still be aborted without touching the library object.
    const [ins] = await db.batch(ctx.env, [
      [`INSERT INTO media (filename, original_name, media_type, size_bytes, duration_seconds, width, height, codec, sha256)
        VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
      filename, row.name, row.media_type, row.size, row.duration_seconds, row.width, row.height, row.sha256],
      ["DELETE FROM uploads WHERE id = ?", row.id],
    ]);
    mediaId = ins.meta.last_row_id;
  } catch (e) {
    if (db.isConstraintError(e)) {
      await abortMultipart(ctx.env, row);
      await db.run(ctx.env, "DELETE FROM uploads WHERE id = ?", row.id);
      fail(409, "a file with this content or name already exists");
    }
    throw e;
  }
  const mp = ctx.env.MEDIA.resumeMultipartUpload(row.key, row.upload_id);
  let obj;
  try {
    obj = await mp.complete(parts);
  } catch (e) {
    await db.run(ctx.env, "DELETE FROM media WHERE id = ?", mediaId);
    console.warn(`uploadComplete ${row.id}:`, e && e.message ? e.message : e);
    fail(409, "This upload could not be finished. Drop the file again to start over.");
  }
  if (obj.size !== row.size) {
    // Never leave an object of the wrong size under a name a media row could point at.
    await ctx.env.MEDIA.delete(row.key);
    await db.run(ctx.env, "DELETE FROM media WHERE id = ?", mediaId);
    fail(400, `stored object is ${obj.size} bytes, expected ${row.size}`);
  }
  // The browser computed row.sha256 and the Pi rejects any download that does not match it,
  // so check the stored bytes once here instead of letting every player fail forever, up to
  // PIPLAYER_VERIFY_SHA_MAX_BYTES (8 MiB: the Workers Free CPU budget; on Paid set [limits]
  // cpu_ms and raise it). Files above it keep the browser's hash and the audit row says so.
  // ponytail: hash at completion only; per-part hashing would verify any size on Free.
  const shaVerified = row.size <= envInt(ctx.env, "PIPLAYER_VERIFY_SHA_MAX_BYTES", 8 * 1024 * 1024);
  if (shaVerified) {
    const digest = new crypto.DigestStream("SHA-256");
    await (await ctx.env.MEDIA.get(row.key)).body.pipeTo(digest);
    if (hex(await digest.digest) !== row.sha256) {
      await ctx.env.MEDIA.delete(row.key);
      await db.run(ctx.env, "DELETE FROM media WHERE id = ?", mediaId);
      fail(400, "The file did not arrive intact; please upload it again.");
    }
  }
  await audit.log(ctx, "upload_media", "media", mediaId, { filename: row.name, type: row.media_type, sha_verified: shaVerified ? undefined : false });
  return json({ media_id: mediaId });
}

async function abortMultipart(env, row) {
  try {
    await env.MEDIA.resumeMultipartUpload(row.key, row.upload_id).abort();
  } catch {
    // Already gone (completed, aborted, or expired on the R2 side): nothing to undo.
  }
}

async function uploadAbort(ctx) {
  const row = await loadUpload(ctx);
  await abortMultipart(ctx.env, row);
  await db.run(ctx.env, "DELETE FROM uploads WHERE id = ?", row.id);
  return json({ ok: true });
}

export function register(router) {
  router.post("/library/upload/init", uploadInit);
  router.put("/library/upload/:id/part/:n", uploadPart);
  router.get("/library/upload/:id", uploadStatus);
  router.post("/library/upload/:id/complete", uploadComplete);
  router.post("/library/upload/:id/abort", uploadAbort);
}

// Daily cron: abort the R2 multipart of every upload older than 24 h and drop its row
// (a row whose multipart already vanished is an orphan and is dropped the same way).
export async function housekeeping(env) {
  const stale = await db.all(env,
    "SELECT id, key, upload_id FROM uploads WHERE created_at < datetime('now', ?)", `-${UPLOAD_MAX_AGE_HOURS} hours`);
  for (const row of stale) {
    await abortMultipart(env, row);
    await db.run(env, "DELETE FROM uploads WHERE id = ?", row.id);
  }
  return stale.length;
}
