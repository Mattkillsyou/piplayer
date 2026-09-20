// Device API (port of cms/app/routes/api.py): health, sync manifest, screenshot and camera
// snapshot uploads, command results. Auth is `Authorization: Bearer <device token>`; the device_id in the
// path must be the token's own device.
import * as audit from "./audit.js";
import * as auth from "./auth.js";
import * as cloudflare from "./cloudflare.js";
import * as db from "./db.js";
import * as manifest from "./manifest.js";
import * as media from "./media.js";
import * as secrets from "./secrets.js";
import { installBaseUrl } from "./pages/devices.js";
import { envInt, fail, HttpError, json, jsonObject, nowUtc, randomToken } from "./util.js";
import { cameraConfig } from "./pages/devices.js";

export const MAX_SYNC_ERROR_LEN = 200;
const MAX_PI_MODEL_LEN = 64;
export const MAX_UPDATE_REF_LEN = 100;
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
  // projector_state (on | off | unknown) is kept when the player does not send one (no
  // projector control); projector_error clears like camera_error.
  const projectorState = manifest.PROJECTOR_STATES.includes(q.get("projector_state")) ? q.get("projector_state") : null;
  const projectorError = (q.get("projector_error") || "").trim().slice(0, MAX_SYNC_ERROR_LEN) || null;
  // pi_model / camera_supported: kept like player_version when the player does not send them
  // (old players); "" model = unreadable on the Pi, stored as NULL (unknown).
  const piModel = (q.get("pi_model") || "").trim().slice(0, MAX_PI_MODEL_LEN) || null;
  const cameraSupported = ["0", "1"].includes(q.get("camera_supported")) ? Number(q.get("camera_supported")) : null;
  await db.run(ctx.env,
    `UPDATE devices SET
        last_seen_at = datetime('now'),
        last_ip = ?,
        current_position = ?,
        current_filename = ?,
        player_status = ?,
        player_version = COALESCE(?, player_version),
        last_error = ?,
        camera_error = ?,
        projector_power_state = COALESCE(?, projector_power_state),
        projector_error = ?,
        pi_model = COALESCE(?, pi_model),
        camera_supported = COALESCE(?, camera_supported)
      WHERE id = ?`,
    ctx.ip,
    intQuery(q, "current_position"),
    q.get("current_filename"),
    q.get("player_status"),
    q.get("player_version"),
    lastError,
    cameraError,
    projectorState,
    projectorError,
    piModel,
    cameraSupported,
    device.id);

  await storeUpdateStatus(ctx, device, q.get("update_status"));

  const settings = await ctx.settings();
  const body = await manifest.manifest_for_device(ctx.env, device, ctx.url.origin, settings);
  body.tunnel = await tunnelBlock(ctx.env, device);
  return new Response(manifest.manifest_json(body), { headers: { "content-type": "application/json" } });
}

// Auto tunnel (G): {token, hostname} for the device's own Cloudflare Tunnel, the token fetched
// from the API on every sync and never stored or rendered anywhere else (this handler only
// answers the device's own bearer). null when the device has no tunnel, the secrets are not
// set or the API is down: absence = feature off, the player keeps the token it already wrote.
// ponytail: one API call per sync per tunnelled device (2/min each; the API allows 1200 per
// 5 min), cache the token in KV past a few dozen devices.
async function tunnelBlock(env, device) {
  if (!device.tunnel_id || !cloudflare.configured(env)) return null;
  try {
    return { token: await cloudflare.tunnelToken(env, device.tunnel_id), hostname: device.tunnel_hostname };
  } catch (e) {
    console.error(`tunnel token for ${device.device_id}: ${e && e.message || e}`);
    return null;
  }
}

// ?update_status=<json> is sent once by the daemon that starts after update-player.sh /
// update-os.sh ran (the script restarts the service last, so the daemon that queued the command
// is gone): {ref, started, finished, ok, message, previous_version}. Stored in the devices
// last_update_* columns for the Devices page and audited as device_update_reported. Anything
// that is not a JSON object is ignored: a malformed status must not break the sync.
async function storeUpdateStatus(ctx, device, raw) {
  if (!raw) return;
  let st;
  try {
    st = JSON.parse(raw);
  } catch {
    return;
  }
  if (!st || typeof st !== "object" || Array.isArray(st)) return;
  const ok = st.ok === true || st.ok === 1 ? 1 : 0;
  const message = String(st.message ?? "").trim().slice(0, MAX_SYNC_ERROR_LEN) || null;
  const ref = String(st.ref ?? "").trim().slice(0, MAX_UPDATE_REF_LEN) || null;
  // finished is the Pi's clock (ISO 8601); fall back to now when it is missing or unparsable
  const finished = Date.parse(String(st.finished ?? ""));
  const at = Number.isFinite(finished) ? nowUtc(new Date(finished)) : null;
  await db.run(ctx.env,
    `UPDATE devices SET last_update_at = COALESCE(?, datetime('now')), last_update_ok = ?,
        last_update_message = ?, last_update_ref = ? WHERE id = ?`, at, ok, message, ref, device.id);
  await audit.log(ctx, "device_update_reported", "device", device.id,
    { device_id: device.device_id, ref: ref ?? undefined, ok: Boolean(ok), message: message ?? undefined }, null);
}

async function reportCommandResult(ctx) {
  const device = await auth.deviceFromHeader(ctx);
  const commandId = intPath(ctx.params, "command_id"); // after auth, as FastAPI orders it
  const body = await jsonObject(ctx.request);
  const result = (body.result === undefined ? "" : String(body.result)).slice(0, 1000);

  const row = await db.first(ctx.env, "SELECT id, device_id, command FROM device_commands WHERE id = ?", commandId);
  if (!row) fail(404, "command not found");
  if (row.device_id !== device.id) fail(403, "command belongs to another device");
  await db.run(ctx.env,
    "UPDATE device_commands SET completed_at = datetime('now'), result = ? WHERE id = ?", result, commandId);
  await storeLearnedCode(ctx, device, row.command, body);
  return json({ ok: true });
}

// A Broadlink packet is 16 bytes of header + the pulses; the player reports it as base64.
const IR_CODE_RE = /^[A-Za-z0-9+/]{20,4000}={0,2}$/;

// ir-learn:<name>: the player reports the learned packet as base64, as the `result` string
// '{"learned": <name>, "code": <b64>}' (player/player/projector.py), in a `code` field, or as
// a bare base64 `result`; it is stored under that name in the device's projector_ir_codes JSON
// and shown as a learned badge on the Devices page. Anything else (a "timeout" result) leaves
// the stored codes alone. Audited without the packet.
async function storeLearnedCode(ctx, device, command, body) {
  if (!command.startsWith("ir-learn:")) return;
  const name = command.slice("ir-learn:".length);
  if (!manifest.IR_CODE_NAMES.includes(name)) return;
  let nested = null;
  if (typeof body.result === "string" && body.result.trimStart().startsWith("{")) {
    try {
      nested = JSON.parse(body.result).code;
    } catch {
      nested = null;
    }
  }
  const code = [body.code, nested, body.result].find((v) => typeof v === "string" && IR_CODE_RE.test(v.trim()));
  if (!code) return;
  const row = await db.first(ctx.env, "SELECT projector_ir_codes FROM devices WHERE id = ?", device.id);
  const codes = { ...manifest.ir_codes(row && row.projector_ir_codes), [name]: code.trim() };
  await db.run(ctx.env, "UPDATE devices SET projector_ir_codes = ? WHERE id = ?", JSON.stringify(codes), device.id);
  await audit.log(ctx, "device_ir_code_learned", "device", device.id, { device_id: device.device_id, name }, null);
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
// the token is never logged or audited. With the Cloudflare secrets set, a device without a
// tunnel gets one here (cloudflare.tryProvisionDevice: a failure is audited, never fatal).
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

  const existing = () => db.first(ctx.env, "SELECT id, name, token, tunnel_id FROM devices WHERE device_id = ?", deviceId);
  let row = await existing();
  if (!row) {
    const token = randomToken(32);
    const { group_id, playlist_id } = await enrollDefaults(ctx.env, settings);
    try {
      const id = (await db.run(ctx.env, "INSERT INTO devices (device_id, name, token, group_id, playlist_id) VALUES (?, ?, ?, ?, ?)",
        deviceId, name, token, group_id, playlist_id)).last_row_id;
      await audit.log(ctx, "device_enrolled", "device", id,
        { device_id: deviceId, name, group_id: group_id ?? undefined, playlist_id: playlist_id ?? undefined }, null);
      if (cloudflare.configured(ctx.env)) await cloudflare.tryProvisionDevice(ctx, { id, device_id: deviceId });
      return json({ device_id: deviceId, token, cms_url: ctx.url.origin });
    } catch (e) {
      if (!db.isConstraintError(e)) throw e;
      row = await existing(); // lost a race with a concurrent enroll of the same id
      if (!row) throw e;
    }
  }
  if (row.name !== name) {
    await db.run(ctx.env, "UPDATE devices SET name = ? WHERE id = ?", name, row.id);
    // The Wyze camera name can derive from the device name (wyze_camera_pattern), so a rename
    // must make the Pi refetch its camera config.
    await db.bumpCameraConfigVersion(ctx.env);
  }
  await audit.log(ctx, "device_reenrolled", "device", row.id, { device_id: deviceId, name }, null);
  if (!row.tunnel_id && cloudflare.configured(ctx.env)) await cloudflare.tryProvisionDevice(ctx, { id: row.id, device_id: deviceId });
  return json({ device_id: deviceId, token: row.token, cms_url: ctx.url.origin });
}

// Operator endpoint for the flasher (tools/flasher): `Authorization: Bearer p5k_...` (Settings
// page "My API tokens", editor+ user) -> the live enrollment key plus what the operator needs
// to sanity-check the console. Audited as api_token_used at most once per hour per token.
// wyze_configured is true once the Settings page holds a Wyze email + password (the
// provision script then passes --with-wyze).
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
    wyze_configured: await secrets.wyzeConfigured(ctx.env),
  });
}

// Camera zero-config (device bearer): what the player's camera capture and the wyze-bridge
// need, resolved from the device's override (Devices page) over the site default (Settings):
// {source: "none"} | {source: "rtsp", rtsp_url} | {source: "wyze", wyze: {email, password,
// api_id, api_key, camera}}, plus the camera_config_version it corresponds to. The Wyze
// credentials travel only here, only to the device's own token. Audited as
// camera_config_fetched at most once a day per device (the player fetches on every start).
async function getCameraConfig(ctx) {
  const device = await ownDevice(ctx);
  const row = await db.first(ctx.env, "SELECT camera_source, camera_rtsp_url, camera_wyze_name FROM devices WHERE id = ?", device.id);
  const settings = await ctx.settings();
  const body = await cameraConfig(ctx.env, { ...device, ...row }, settings);
  const r = await db.run(ctx.env,
    `UPDATE devices SET camera_config_audited_at = datetime('now')
      WHERE id = ? AND (camera_config_audited_at IS NULL OR camera_config_audited_at <= datetime('now', '-1 day'))`, device.id);
  if (r.changes > 0) await audit.log(ctx, "camera_config_fetched", "device", device.id, { device_id: device.device_id, source: body.source }, null);
  return json(body);
}

export function register(router) {
  router.get("/api/health", () => json({ ok: true }));
  router.post("/api/enroll", enroll);
  router.get("/api/operator/enrollment", operatorEnrollment);
  router.get("/api/sync/:device_id", sync);
  router.get("/api/camera-config/:device_id", getCameraConfig);
  router.post("/api/screenshots/:device_id", uploadScreenshot);
  router.post("/api/camera/:device_id", uploadCamera);
  router.post("/api/commands/:command_id/result", reportCommandResult);
}
