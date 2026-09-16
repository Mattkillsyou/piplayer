// Device API (port of cms/app/routes/api.py): health, sync manifest, screenshot and camera
// snapshot uploads, command results. Auth is `Authorization: Bearer <device token>`; the device_id in the
// path must be the token's own device.
import * as audit from "./audit.js";
import * as auth from "./auth.js";
import * as db from "./db.js";
import * as manifest from "./manifest.js";
import * as media from "./media.js";
import { installBaseUrl } from "./pages/devices.js";
import { envInt, fail, HttpError, json, jsonObject, randomToken } from "./util.js";

export const MAX_SYNC_ERROR_LEN = 200;
export const DEVICE_ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/; // same rule as the Devices page
export const MAX_DEVICE_NAME = 120;

async function ownDevice(ctx) {
  const device = await auth.deviceFromHeader(ctx);
  if (device.device_id !== ctx.params.device_id) fail(403, "Token does not match device id");
  return device;
}

// The fixed CMS turns FastAPI's 422 for a typed path/query parameter into contract 10's
// 400 {detail: "<loc>: <msg>"} (main.py validation_error); same words here. Pydantic's lax
// int accepts '+5', ' 5 ', '007' and '1.0' (-> 1) but not '1.5', '' or 'abc'.
const LAX_INT = /^[+-]?\d+(\.0+)?$/;

function intParam(where, name, v) {
  if (!LAX_INT.test(v.trim())) {
    fail(400, `${where}.${name}: Input should be a valid integer, unable to parse string as an integer`);
  }
  return parseInt(v, 10);
}

// Optional integer query parameter (`int | None = Query(None)`): absent -> null. The player
// omits it when it has none.
function intQuery(params, name) {
  const v = params.get(name);
  return v === null ? null : intParam("query", name, v);
}

// Integer path parameter (`command_id: int`).
const intPath = (params, name) => intParam("path", name, params[name]);

async function sync(ctx) {
  const device = await ownDevice(ctx);
  const q = ctx.url.searchParams;

  // Empty string = last sync fully succeeded; store NULL so the UI can test truthiness.
  // camera_error works the same way for the player's last camera capture.
  const lastError = (q.get("sync_error") || "").trim().slice(0, MAX_SYNC_ERROR_LEN) || null;
  const cameraError = (q.get("camera_error") || "").trim().slice(0, MAX_SYNC_ERROR_LEN) || null;
  await db.run(ctx.env,
    `UPDATE devices SET
        last_seen_at = datetime('now'),
        last_ip = ?,
        current_position = ?,
        current_filename = ?,
        player_status = ?,
        player_version = COALESCE(?, player_version),
        last_error = ?,
        camera_error = ?
      WHERE id = ?`,
    ctx.ip,
    intQuery(q, "current_position"),
    q.get("current_filename"),
    q.get("player_status"),
    q.get("player_version"),
    lastError,
    cameraError,
    device.id);

  const settings = await ctx.settings();
  const body = await manifest.manifest_for_device(ctx.env, device, ctx.url.origin, settings);
  return new Response(manifest.manifest_json(body), { headers: { "content-type": "application/json" } });
}

async function reportCommandResult(ctx) {
  const device = await auth.deviceFromHeader(ctx);
  const commandId = intPath(ctx.params, "command_id"); // after auth, as FastAPI orders it
  const body = await jsonObject(ctx.request);
  const result = (body.result === undefined ? "" : String(body.result)).slice(0, 1000);

  const row = await db.first(ctx.env, "SELECT id, device_id FROM device_commands WHERE id = ?", commandId);
  if (!row) fail(404, "command not found");
  if (row.device_id !== device.id) fail(403, "command belongs to another device");
  await db.run(ctx.env,
    "UPDATE device_commands SET completed_at = datetime('now'), result = ? WHERE id = ?", result, commandId);
  return json({ ok: true });
}

// Multipart JPEG upload shared by /api/screenshots and /api/camera: `what` names the image in
// the 400 wording, `maxBytes` caps the file, `store(deviceId, bytes)` writes it to R2.
async function receiveJpeg(ctx, what, maxBytes, store) {
  const device = await ownDevice(ctx);
  const tooLarge = () => fail(413, `File exceeds ${maxBytes} bytes`);
  // Same wording as web._receive_upload, which streams the body and rejects as it goes.
  if (!/^multipart\/form-data\s*;.*boundary=/i.test(ctx.request.headers.get("content-type") || "")) {
    fail(400, "expected a multipart/form-data upload");
  }
  const declared = parseInt(ctx.request.headers.get("content-length") || "", 10);
  if (declared > maxBytes + 64 * 1024) tooLarge();

  let form;
  try {
    form = await ctx.form();
  } catch {
    fail(400, "expected a multipart/form-data upload");
  }
  // The CMS takes the first file part whatever its field name; the spec names it 'file'.
  const file = [...form.values()].find((v) => v instanceof File);
  if (!file) fail(400, "no file in upload (field 'file')");
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!media.isJpeg(bytes)) fail(400, `${what} must be a JPEG image`);
  if (bytes.length > maxBytes) tooLarge();

  await store(device.device_id, bytes);
  return { device, bytes };
}

async function uploadScreenshot(ctx) {
  const maxBytes = envInt(ctx.env, "PIPLAYER_MAX_SCREENSHOT_BYTES", 5 * 1024 * 1024);
  const { device, bytes } = await receiveJpeg(ctx, "screenshot", maxBytes, (id, b) => media.putScreenshot(ctx.env, id, b));
  await db.run(ctx.env, "UPDATE devices SET last_screenshot_at = datetime('now') WHERE id = ?", device.id);
  return json({ ok: true, size_bytes: bytes.length });
}

// Camera snapshot (player/player/camera.py): same protocol as screenshots, stored at
// camera/<device_id>.jpg, stamps last_camera_at and clears camera_error.
async function uploadCamera(ctx) {
  const maxBytes = envInt(ctx.env, "PIPLAYER_MAX_CAMERA_BYTES", 2 * 1024 * 1024);
  const { device, bytes } = await receiveJpeg(ctx, "camera snapshot", maxBytes, (id, b) => media.putCamera(ctx.env, id, b));
  await db.run(ctx.env, "UPDATE devices SET last_camera_at = datetime('now'), camera_error = NULL WHERE id = ?", device.id);
  return json({ ok: true, size_bytes: bytes.length });
}

// Settings enroll_group_id / enroll_playlist_id resolved against the live rows: a deleted
// group or playlist counts as "none" (the settings row is not cleared on delete).
async function enrollDefaults(env, settings) {
  const live = async (table, id) => (id !== null && await db.first(env, `SELECT id FROM ${table} WHERE id = ?`, id)) ? id : null;
  return { group_id: await live("device_groups", settings.enroll_group_id), playlist_id: await live("playlists", settings.enroll_playlist_id) };
}

// Zero-touch enrollment: a freshly flashed Pi trades the site's enrollment key for its device
// token. Re-enrolling an existing device_id returns the existing token so a re-flashed card
// keeps the console's view of that device (group/playlist untouched; only a FIRST enrollment
// applies the Settings defaults, and the audit row says which). Throttled per ip like login;
// the token is never logged or audited.
async function enroll(ctx) {
  const wait = await auth.loginLockedFor(ctx.env, ctx.ip, auth.ENROLL_KEY, auth.ENROLL_MAX_FAILURES, auth.ENROLL_LOCK_SECONDS);
  if (wait) throw new HttpError(429, `Too many failed attempts; try again in ${wait} s`, { "Retry-After": String(wait) });
  const body = await jsonObject(ctx.request);
  const settings = await ctx.settings();
  const expected = settings.enrollment_key;
  if (typeof body.key !== "string" || !auth.timingSafeEqual(body.key, expected)) {
    await auth.recordLoginFailure(ctx.env, ctx.ip, auth.ENROLL_KEY);
    fail(401, "invalid enrollment key");
  }
  const deviceId = typeof body.device_id === "string" ? body.device_id.trim().toLowerCase() : "";
  if (!DEVICE_ID_RE.test(deviceId)) fail(400, "device_id must be lowercase alphanumeric + hyphens, 1-63 chars");
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name || [...name].length > MAX_DEVICE_NAME) fail(400, `name must be 1-${MAX_DEVICE_NAME} chars`);

  const existing = () => db.first(ctx.env, "SELECT id, name, token FROM devices WHERE device_id = ?", deviceId);
  let row = await existing();
  if (!row) {
    const token = randomToken(32);
    const { group_id, playlist_id } = await enrollDefaults(ctx.env, settings);
    try {
      const id = (await db.run(ctx.env, "INSERT INTO devices (device_id, name, token, group_id, playlist_id) VALUES (?, ?, ?, ?, ?)",
        deviceId, name, token, group_id, playlist_id)).last_row_id;
      await audit.log(ctx, "device_enrolled", "device", id,
        { device_id: deviceId, name, group_id: group_id ?? undefined, playlist_id: playlist_id ?? undefined }, null);
      return json({ device_id: deviceId, token, cms_url: ctx.url.origin });
    } catch (e) {
      if (!db.isConstraintError(e)) throw e;
      row = await existing(); // lost a race with a concurrent enroll of the same id
      if (!row) throw e;
    }
  }
  if (row.name !== name) await db.run(ctx.env, "UPDATE devices SET name = ? WHERE id = ?", name, row.id);
  await audit.log(ctx, "device_reenrolled", "device", row.id, { device_id: deviceId, name }, null);
  return json({ device_id: deviceId, token: row.token, cms_url: ctx.url.origin });
}

// Operator endpoint for the flasher (tools/flasher): `Authorization: Bearer p5k_...` (Settings
// page "My API tokens", editor+ user) -> the live enrollment key plus what the operator needs
// to sanity-check the console. Audited as api_token_used at most once per hour per token.
// wyze_configured is D's hook: true once Wyze credentials exist (the provision script then
// passes --with-wyze); always false until D lands.
async function operatorEnrollment(ctx) {
  const op = await auth.operatorFromHeader(ctx);
  if (auth.roleRank(op.role) < auth.roleRank("editor")) fail(401, "API token's user is not an editor or admin");
  if (await auth.touchApiToken(ctx.env, op.token_id)) {
    await audit.log(ctx, "api_token_used", "api_token", op.token_id, { name: op.token_name }, { id: op.id, username: op.username });
  }
  const settings = await ctx.settings();
  return json({
    console_url: installBaseUrl(ctx.env, ctx.url).base,
    enrollment_key: settings.enrollment_key,
    groups: await db.all(ctx.env, "SELECT id, name FROM device_groups ORDER BY name"),
    playlists: await db.all(ctx.env, "SELECT id, name FROM playlists ORDER BY name"),
    timezone: settings.timezone,
    wyze_configured: false,
  });
}

export function register(router) {
  router.get("/api/health", () => json({ ok: true }));
  router.post("/api/enroll", enroll);
  router.get("/api/operator/enrollment", operatorEnrollment);
  router.get("/api/sync/:device_id", sync);
  router.post("/api/screenshots/:device_id", uploadScreenshot);
  router.post("/api/camera/:device_id", uploadCamera);
  router.post("/api/commands/:command_id/result", reportCommandResult);
}
