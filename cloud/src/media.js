// R2 media serving with Range (port of api.get_media over FileResponse) + screenshot storage.
// Media objects live at `media/<filename>`, screenshots at `screenshots/<device_id>.jpg`,
// camera snapshots at `camera/<device_id>.jpg`.
import * as auth from "./auth.js";
import * as db from "./db.js";
import * as manifest from "./manifest.js";
import { fail, HttpError, wallClock } from "./util.js";

export const SAFE_FILENAME = /^[A-Za-z0-9._-]+$/;
export const JPEG_MAGIC = [0xff, 0xd8, 0xff];

export const mediaKey = (filename) => `media/${filename}`;
export const screenshotKey = (deviceId) => `screenshots/${deviceId}.jpg`;
export const cameraKey = (deviceId) => `camera/${deviceId}.jpg`;
export const MEDIA_CACHE_CONTROL = "public, max-age=31536000, immutable";

// ---------------------------------------------------------------------------
// Serving an R2 object the way Starlette's FileResponse does: Content-Type from the stored
// metadata, ETag, Accept-Ranges, 206 (single range or multipart/byteranges) / 416, HEAD, nosniff.
// ---------------------------------------------------------------------------

// Range header -> list of merged [start, end] pairs (inclusive), null when absent or when the
// object should go out whole, or a thrown 400 / 416 the way Starlette's FileResponse
// _parse_range_header answers: a header without '=', a unit other than bytes or no usable
// 'a-b' part is 400; a start past the end of the object is 416; an inverted range
// ('bytes=200-100') is 400, not 416. Junk parts ('bytes=abc') are skipped. Overlapping and
// adjacent parts merge; more than MAX_RANGES parts means the whole object (200), as in Starlette.
export const MAX_RANGES = 100;

export function parseRange(header, size) {
  if (header === null || header === undefined) return null;
  const eq = header.indexOf("=");
  if (eq < 0) fail(400, "Malformed range header.");
  if (header.slice(0, eq).trim().toLowerCase() !== "bytes") fail(400, "Only support bytes range");
  const parts = header.slice(eq + 1).split(",");
  if (parts.length > MAX_RANGES) return null;
  const ranges = [];
  for (let part of parts) {
    part = part.trim();
    const dash = part.indexOf("-");
    if (!part || part === "-" || dash < 0) continue;
    const a = part.slice(0, dash).trim();
    const b = part.slice(dash + 1).trim();
    if (!/^\d*$/.test(a) || !/^\d*$/.test(b)) continue;
    // suffix form: the last n bytes
    const start = a ? parseInt(a, 10) : Math.max(size - parseInt(b, 10), 0);
    const end = a && b && parseInt(b, 10) < size ? parseInt(b, 10) : size - 1;
    ranges.push([start, end]);
  }
  if (!ranges.length) fail(400, "Range header: range must be requested");
  if (ranges.some(([start]) => start >= size)) fail(416, `bytes */${size}`);
  if (ranges.some(([start, end]) => start > end)) fail(400, "Range header: start must be less than end");
  ranges.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const merged = [ranges[0]];
  for (const [start, end] of ranges.slice(1)) {
    const last = merged[merged.length - 1];
    if (start <= last[1] + 1) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

function baseHeaders(obj, extra) {
  const h = new Headers(extra);
  obj.writeHttpMetadata(h);
  if (!h.has("content-type")) h.set("content-type", "application/octet-stream");
  h.set("accept-ranges", "bytes");
  h.set("etag", obj.httpEtag);
  h.set("last-modified", obj.uploaded.toUTCString());
  h.set("x-content-type-options", "nosniff");
  return h;
}

// 206 multipart/byteranges laid out exactly as FileResponse.generate_multipart: one part per
// range, each fetched from R2 with its own ranged get and streamed straight through.
function serveMultipart(bucket, key, ranges, size, h) {
  const boundary = [...crypto.getRandomValues(new Uint8Array(13))].map((b) => b.toString(16).padStart(2, "0")).join("");
  const enc = new TextEncoder();
  const contentType = h.get("content-type");
  const partHead = ([start, end]) =>
    enc.encode(`--${boundary}\r\nContent-Type: ${contentType}\r\nContent-Range: bytes ${start}-${end}/${size}\r\n\r\n`);
  const crlf = enc.encode("\r\n");
  const tail = enc.encode(`--${boundary}--`);
  const length = ranges.reduce((n, r) => n + partHead(r).length + (r[1] - r[0] + 1) + crlf.length, 0) + tail.length;

  // FixedLengthStream is what makes workerd send Content-Length instead of chunked encoding
  // for a streamed body (and it errors if the pump writes a different number of bytes).
  const { readable, writable } = new FixedLengthStream(length);
  const write = async (bytes) => {
    const w = writable.getWriter();
    await w.write(bytes);
    w.releaseLock();
  };
  (async () => {
    try {
      for (const r of ranges) {
        await write(partHead(r));
        const obj = await bucket.get(key, { range: { offset: r[0], length: r[1] - r[0] + 1 } });
        if (!obj) throw new Error(`${key} vanished mid-response`);
        await obj.body.pipeTo(writable, { preventClose: true });
        await write(crlf);
      }
      await write(tail);
      await writable.close();
    } catch (e) {
      await writable.abort(e).catch(() => {});
    }
  })();

  h.set("content-type", `multipart/byteranges; boundary=${boundary}`);
  h.set("content-length", String(length));
  return new Response(readable, { status: 206, headers: h });
}

// Response for `key` in `bucket` honouring HEAD and Range; 404 JSON when the key is absent.
export async function serveObject(request, bucket, key, extraHeaders = {}) {
  const head = await bucket.head(key);
  if (!head) fail(404, "Not Found");
  const size = head.size;

  if (request.method === "HEAD") {
    const h = baseHeaders(head, extraHeaders);
    h.set("content-length", String(size));
    return new Response(null, { status: 200, headers: h });
  }

  // If-Range that matches neither validator means "send it all" (FileResponse._should_use_range).
  const ifRange = request.headers.get("if-range");
  const useRange = ifRange === null || ifRange === head.httpEtag || ifRange === head.uploaded.toUTCString();
  let ranges = null;
  try {
    if (useRange) ranges = parseRange(request.headers.get("range"), size);
  } catch (e) {
    if (!(e instanceof HttpError)) throw e;
    // Starlette answers both as PlainTextResponse: the message for 400, an empty body for 416.
    const h = new Headers({ ...extraHeaders, "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff" });
    if (e.status === 416) h.set("content-range", e.detail);
    return new Response(e.status === 416 ? null : e.detail, { status: e.status, headers: h });
  }

  if (ranges && ranges.length > 1) return serveMultipart(bucket, key, ranges, size, baseHeaders(head, extraHeaders));

  const range = ranges && ranges[0];
  const obj = range
    ? await bucket.get(key, { range: { offset: range[0], length: range[1] - range[0] + 1 } })
    : await bucket.get(key);
  if (!obj) fail(404, "Not Found");
  const h = baseHeaders(obj, extraHeaders);
  if (range) {
    h.set("content-range", `bytes ${range[0]}-${range[1]}/${size}`);
    h.set("content-length", String(range[1] - range[0] + 1));
    return new Response(obj.body, { status: 206, headers: h });
  }
  h.set("content-length", String(size));
  return new Response(obj.body, { status: 200, headers: h });
}

// ---------------------------------------------------------------------------
// /api/media/{filename}
// ---------------------------------------------------------------------------

// A device token only unlocks the files in that device's currently served playlist.
async function deviceMayFetch(env, device, filename, timezone) {
  const [pid] = await manifest.resolve_active_playlist_id(env, device, wallClock(timezone));
  if (!pid) return false;
  const row = await db.first(env,
    `SELECT 1 AS one FROM playlist_items pi JOIN media m ON m.id = pi.media_id
      WHERE pi.playlist_id = ? AND m.filename = ? LIMIT 1`, pid, filename);
  return row !== null;
}

async function getMedia(ctx) {
  const filename = ctx.params.filename;
  if (!SAFE_FILENAME.test(filename)) fail(400, "Invalid filename");

  const isUser = ctx.user !== null;
  let device = null;
  if (ctx.request.headers.get("authorization")) {
    try {
      device = await auth.deviceFromHeader(ctx);
    } catch (e) {
      if (!(e instanceof HttpError)) throw e;
    }
  }
  if (!isUser && !device) fail(401, "Authentication required");
  if (!isUser && !(await deviceMayFetch(ctx.env, device, filename, (await ctx.settings()).timezone))) {
    fail(403, "file is not in this device's playlist");
  }
  // A media filename starts with 16 hex chars of the object's sha256 (uploads.js), so the bytes
  // behind a name never change: a year of immutable caching, and the edge cache in front of R2
  // (keyed on the URL alone, only after the checks above) so the next projector on the same
  // edge gets the edge copy. Range requests go to R2: a 206 must not be stored, and the Cache
  // API's own range answers do not match the FileResponse shapes above.
  const cacheable = ctx.request.method === "GET" && !ctx.request.headers.has("range");
  const cacheKey = new Request(ctx.url.origin + ctx.url.pathname);
  if (cacheable) {
    const hit = await caches.default.match(cacheKey);
    if (hit) return hit;
  }
  const res = await serveObject(ctx.request, ctx.env.MEDIA, mediaKey(filename), { "cache-control": MEDIA_CACHE_CONTROL });
  if (cacheable && res.status === 200) ctx.exec.waitUntil(caches.default.put(cacheKey, res.clone()));
  return res;
}

// ---------------------------------------------------------------------------
// Screenshots (used by api.js for the upload and by the devices page to show / delete one)
// ---------------------------------------------------------------------------

export function isJpeg(bytes) {
  return bytes.length >= 3 && JPEG_MAGIC.every((b, i) => bytes[i] === b);
}

export function putScreenshot(env, deviceId, bytes) {
  return env.MEDIA.put(screenshotKey(deviceId), bytes, { httpMetadata: { contentType: "image/jpeg" } });
}

export function deleteScreenshot(env, deviceId) {
  return env.MEDIA.delete(screenshotKey(deviceId));
}

// Response for the stored screenshot (no-store, nosniff) or 404.
export function serveScreenshot(request, env, deviceId) {
  return serveObject(request, env.MEDIA, screenshotKey(deviceId), { "cache-control": "no-store" });
}

// Camera snapshots: same shape as screenshots under `camera/<device_id>.jpg`.
export function putCamera(env, deviceId, bytes) {
  return env.MEDIA.put(cameraKey(deviceId), bytes, { httpMetadata: { contentType: "image/jpeg" } });
}

export function deleteCamera(env, deviceId) {
  return env.MEDIA.delete(cameraKey(deviceId));
}

export function serveCamera(request, env, deviceId) {
  return serveObject(request, env.MEDIA, cameraKey(deviceId), { "cache-control": "no-store" });
}

export function register(router) {
  router.get("/api/media/:filename", getMedia);
}
