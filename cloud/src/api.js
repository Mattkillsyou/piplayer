// Device API (port of cms/app/routes/api.py): health, sync manifest, screenshot and camera
// snapshot uploads, command results. Auth is `Authorization: Bearer <device token>`; the device_id in the
// path must be the token's own device.
import * as audit from "./audit.js";
import * as auth from "./auth.js";
import * as cloudflare from "./cloudflare.js";
import * as db from "./db.js";
import { cleanHostname, TOKEN_NAME_PREFIX } from "./device_codes.js";
import * as manifest from "./manifest.js";
import * as media from "./media.js";
import * as secrets from "./secrets.js";
import { installBaseUrl, MAX_DEVICE_NAME } from "./pages/devices.js";
import { FLASHER_VERSION, RELEASE } from "./pages/flasher.js";
import { envInt, fail, HttpError, json, jsonObject, nowUtc, randomToken, utf8Len } from "./util.js";
import { cameraConfig } from "./pages/devices.js";

export const MAX_SYNC_ERROR_LEN = 200;
const MAX_PI_MODEL_LEN = 64;
export const MAX_UPDATE_REF_LEN = 100;
export const DEVICE_ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/; // same rule as the Devices page
// Successful enrollments of NEW device ids are capped fleet-wide (the key is on every card and
// flasher PC; each new device is a row, an audit row and, with the secrets set, a tunnel).
export const MAX_NEW_DEVICES_PER_HOUR = 20;

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
  // pi_model / camera_supported: kept like player_version when the player omits them (old
  // players) or sends "" / a value other than 0|1; a device can never clear them back to NULL
  // (unknown).
  const piModel = (q.get("pi_model") || "").trim().slice(0, MAX_PI_MODEL_LEN) || null;
  const cameraSupported = ["0", "1"].includes(q.get("camera_supported")) ? Number(q.get("camera_supported")) : null;
  // What the player reports about itself is capped like its error strings (it lands on every
  // Devices / Dashboard card).
  const currentFilename = (q.get("current_filename") || "").trim().slice(0, MAX_SYNC_ERROR_LEN) || null;
  const playerStatus = (q.get("player_status") || "").trim().slice(0, MAX_SYNC_ERROR_LEN) || null;
  const playerVersion = (q.get("player_version") || "").trim().slice(0, MAX_SYNC_ERROR_LEN) || null;
  // What mpv is doing with the file on screen ("software" = no hardware decoder, which is why a
  // Pi 4 can play a 1080p H.264 clip in slow motion). Kept like player_version when the player
  // omits them: an older player, or one showing a status screen rather than a video.
  const decodeMode = (q.get("decode_mode") || "").trim().slice(0, MAX_PI_MODEL_LEN) || null;
  // play_rate: 1.0 = real speed, measured on the Pi from time-pos against the clock (mpv's own
  // frame rate counts decoded timestamps, so it reads fine while the picture crawls).
  const reported = Number(q.get("play_rate"));
  const playRate = Number.isFinite(reported) && reported > 0 && reported <= 4 ? reported : null;
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
        camera_supported = COALESCE(?, camera_supported),
        decode_mode = COALESCE(?, decode_mode),
        play_rate = COALESCE(?, play_rate)
      WHERE id = ?`,
    ctx.ip,
    intQuery(q, "current_position"),
    currentFilename,
    playerStatus,
    playerVersion,
    lastError,
    cameraError,
    projectorState,
    projectorError,
    piModel,
    cameraSupported,
    decodeMode,
    playRate,
    device.id);

  await storeUpdateStatus(ctx, device, q.get("update_status"));

  const settings = await ctx.settings();
  const body = await manifest.manifest_for_device(ctx.env, device, ctx.url.origin, settings);
  // A board that cannot run the camera bridge (Zero / Pi 1, camera_supported=0) never runs
  // cloudflared either: no point fetching a connector token for it on every sync.
  body.tunnel = cameraSupported === 0 ? null : await tunnelBlock(ctx.env, device);
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
  // Same wording as web._receive_upload. That one streams the body and rejects as it goes;
  // this port parses the whole body in memory (ctx.form), so the declared length is enforced
  // up front and a body without one (chunked) is refused before anything is read.
  if (!/^multipart\/form-data\s*;.*boundary=/i.test(ctx.request.headers.get("content-type") || "")) {
    fail(400, "expected a multipart/form-data upload");
  }
  const declared = parseInt(ctx.request.headers.get("content-length") || "", 10);
  if (!Number.isFinite(declared)) fail(411, "Content-Length is required");
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

// The device_id / name rules shared by POST /api/enroll and POST /api/operator/devices.
function deviceFields(body) {
  const deviceId = typeof body.device_id === "string" ? body.device_id.trim().toLowerCase() : "";
  if (!DEVICE_ID_RE.test(deviceId)) fail(400, "device_id must be lowercase alphanumeric + hyphens, 1-63 chars");
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name || [...name].length > MAX_DEVICE_NAME) fail(400, `name must be 1-${MAX_DEVICE_NAME} chars`);
  return { deviceId, name };
}

// Create the row for a NEW device id, or issue a fresh token for a known one: the re-flashed
// card works, the old card and anything that learned the old token stop. The console's view of
// that device is kept (group/playlist untouched; only a FIRST registration applies the Settings
// defaults, and the audit row says which; a rename is audited as renamed_from). New device ids
// are capped per hour fleet-wide; the token is never logged or audited. With the Cloudflare
// secrets set, a device without a tunnel gets one here (cloudflare.tryProvisionDevice: a
// failure is audited, never fatal). `owner` is null for the enrollment key (it may re-register
// any device id) or the operator token's user, who becomes the owner of a new row and of an
// ownerless one, and may only re-register their own unless they are an admin. `actions` names
// the create / re-register audit rows. Returns {id, token, created}.
async function registerDevice(ctx, { deviceId, name, piModel = null, owner = null }, [createdAction, againAction]) {
  const existing = () => db.first(ctx.env, "SELECT id, name, tunnel_id, owner_id FROM devices WHERE device_id = ?", deviceId);
  let row = await existing();
  if (!row) {
    const { n } = await db.first(ctx.env, "SELECT COUNT(*) AS n FROM devices WHERE created_at > datetime('now', '-1 hour')");
    if (n >= MAX_NEW_DEVICES_PER_HOUR) {
      await audit.log(ctx, "device_enroll_capped", "device", null, { device_id: deviceId, name }, owner);
      throw new HttpError(429, "Too many new projectors enrolled in the last hour; try again later", { "Retry-After": "3600" });
    }
    const token = randomToken(32);
    const { group_id, playlist_id } = await enrollDefaults(ctx.env, await ctx.settings());
    try {
      const id = (await db.run(ctx.env,
        "INSERT INTO devices (device_id, name, token, group_id, playlist_id, owner_id, pi_model) VALUES (?, ?, ?, ?, ?, ?, ?)",
        deviceId, name, token, group_id, playlist_id, owner ? owner.id : null, piModel)).last_row_id;
      await audit.log(ctx, createdAction, "device", id,
        { device_id: deviceId, name, owner: owner ? owner.username : undefined, group_id: group_id ?? undefined, playlist_id: playlist_id ?? undefined }, owner);
      if (cloudflare.configured(ctx.env)) await cloudflare.tryProvisionDevice(ctx, { id, device_id: deviceId });
      return { id, token, created: true };
    } catch (e) {
      if (!db.isConstraintError(e)) throw e;
      row = await existing(); // lost a race with a concurrent enroll of the same id
      if (!row) throw e;
    }
  }
  if (owner && owner.role !== "admin" && row.owner_id !== owner.id) {
    fail(409, "A projector with that ID belongs to another account; pick another name");
  }
  const token = randomToken(32);
  await db.run(ctx.env, "UPDATE devices SET token = ?, name = ?, pi_model = COALESCE(?, pi_model), owner_id = COALESCE(owner_id, ?) WHERE id = ?",
    token, name, piModel, owner ? owner.id : null, row.id);
  // The Wyze camera name can derive from the device name (wyze_camera_pattern), so a rename
  // must make the Pi refetch its camera config.
  if (row.name !== name) await db.bumpCameraConfigVersion(ctx.env);
  await audit.log(ctx, againAction, "device", row.id,
    { device_id: deviceId, name, renamed_from: row.name !== name ? row.name : undefined }, owner);
  if (!row.tunnel_id && cloudflare.configured(ctx.env)) await cloudflare.tryProvisionDevice(ctx, { id: row.id, device_id: deviceId });
  return { id: row.id, token, created: false };
}

// Zero-touch enrollment (legacy: cards written by flashers before v0.7.0): a freshly flashed
// Pi trades the site's enrollment key for its device token. The key alone must never hand out a
// live token, so a known device_id gets a NEW one (registerDevice). Wrong keys are throttled
// per ip like login. The row it creates has no owner (only admins see it until one is set).
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
  const fields = deviceFields(body);
  const { token } = await registerDevice(ctx, fields, ["device_enrolled", "device_reenrolled"]);
  return json({ device_id: fields.deviceId, token, cms_url: ctx.url.origin });
}

const VIEW_ONLY = "This account can only view; ask an admin to make it an editor";

// Sign-in for the SD flasher (v0.7.0+): the username and password typed into the app, no
// browser. Same throttle, audit and no-enumeration rules as POST /login (pages/login.js); a
// good password mints an api_tokens row "SD Flasher on <hostname>" for editors and admins
// (viewers get 403 and no token: every projector the flasher registers belongs to this account).
async function operatorLogin(ctx) {
  const body = await jsonObject(ctx.request);
  const username = typeof body.username === "string" ? body.username.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (username.length > auth.MAX_USERNAME_CHARS) fail(400, `Username must be at most ${auth.MAX_USERNAME_CHARS} characters`);
  if (auth.RESERVED_USERNAMES.has(username.toLowerCase())) fail(401, "Invalid username or password");
  const wait = await auth.loginLockedFor(ctx.env, ctx.ip, username);
  if (wait) throw new HttpError(429, `Too many failed attempts; try again in ${wait} s`, { "Retry-After": String(wait) });
  if (utf8Len(password) > auth.MAX_PASSWORD_BYTES) fail(400, auth.PASSWORD_TOO_LONG_MSG);
  const row = await db.first(ctx.env, "SELECT id, username, password_hash, role FROM users WHERE username = ?", username);
  if (!row) await auth.burnPasswordCheck(password);
  if (!row || !(await auth.verifyPassword(password, row.password_hash))) {
    await audit.log(ctx, "login_failed", "user", row ? row.id : null, { username: row ? row.username : "(no such user)", source: "flasher" }, null);
    await auth.recordLoginFailure(ctx.env, ctx.ip, username);
    fail(401, "Invalid username or password");
  }
  await auth.clearLoginFailures(ctx.env, ctx.ip, username);
  if (row.role === "viewer") fail(403, VIEW_ONLY);
  const hostname = cleanHostname(body.hostname);
  ctx.user = { id: row.id, username: row.username, role: row.role }; // the api_token_created row is this user's
  const { token } = await auth.issueApiToken(ctx, row.id, TOKEN_NAME_PREFIX + hostname, { source: "flasher", hostname });
  return json({ token, username: row.username, role: row.role });
}

// `Authorization: Bearer p5k_...` of an editor or admin for the flasher endpoints below (a
// viewer's token: 403, same words as the sign-in), stamped and audited as api_token_used at
// most once per hour per token.
async function flasherOperator(ctx) {
  const op = await auth.operatorFromHeader(ctx);
  if (auth.roleRank(op.role) < auth.roleRank("editor")) fail(403, VIEW_ONLY);
  if (await auth.touchApiToken(ctx.env, op.token_id)) {
    await audit.log(ctx, "api_token_used", "api_token", op.token_id, { name: op.token_name }, { id: op.id, username: op.username });
  }
  return op;
}

// Who the flasher is signed in as, plus what it needs to sanity-check the console (the same
// fields as operatorEnrollment minus the enrollment key: cards carry their device token now).
async function operatorMe(ctx) {
  const op = await flasherOperator(ctx);
  const settings = await ctx.settings();
  return json({
    username: op.username,
    role: op.role,
    console_url: installBaseUrl(ctx.env, ctx.url).base,
    timezone: settings.timezone,
    wyze_configured: await secrets.wyzeConfigured(ctx.env),
    groups: await db.all(ctx.env, "SELECT id, name FROM device_groups ORDER BY name"),
    playlists: await db.all(ctx.env, "SELECT id, name FROM playlists ORDER BY name"),
  });
}

// The flasher registers the projector it is about to flash, as the signed-in account, and
// writes the device token it gets onto the card (no enrollment key on cards any more).
// {device_id, name, pi_model?} -> 201 {device_id, token, cms_url, owner, created: true} for a
// new id (owner_id = this user), 200 {..., created: false} with a NEW token for the user's own
// id (or any id for an admin; an ownerless one becomes theirs), 409 for another account's id.
async function operatorDevices(ctx) {
  const op = await flasherOperator(ctx);
  const body = await jsonObject(ctx.request);
  const fields = deviceFields(body);
  const piModel = typeof body.pi_model === "string" ? body.pi_model.trim().slice(0, MAX_PI_MODEL_LEN) || null : null;
  const { token, created } = await registerDevice(ctx, { ...fields, piModel, owner: op }, ["device_registered", "device_reregistered"]);
  return json({ device_id: fields.deviceId, token, cms_url: ctx.url.origin, owner: op.username, created }, created ? 201 : 200);
}

// Legacy operator endpoint (flashers before v0.7.0): `Authorization: Bearer p5k_...` (Settings
// page "My API tokens", admin user: the key it returns can enroll any device id) -> the live
// enrollment key plus what the operator needs to sanity-check the console. Audited as
// api_token_used at most once per hour per token.
// wyze_configured is true once the Settings page holds a Wyze email + password (the
// provision script then passes --with-wyze).
async function operatorEnrollment(ctx) {
  const op = await auth.operatorFromHeader(ctx);
  if (op.role !== "admin") fail(401, "API token's user is not an admin");
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
  const row = await db.first(ctx.env, "SELECT camera_source, camera_rtsp_url, camera_wyze_name, camera_supported FROM devices WHERE id = ?", device.id);
  const settings = await ctx.settings();
  const body = await cameraConfig(ctx.env, { ...device, ...row }, settings);
  const r = await db.run(ctx.env,
    `UPDATE devices SET camera_config_audited_at = datetime('now')
      WHERE id = ? AND (camera_config_audited_at IS NULL OR camera_config_audited_at <= datetime('now', '-1 day'))`, device.id);
  if (r.changes > 0) await audit.log(ctx, "camera_config_fetched", "device", device.id, { device_id: device.device_id, source: body.source }, null);
  return json(body);
}

// What the flasher polls weekly to decide whether to update itself: the keys here are a
// contract with every installed flasher, so add to them but do not rename or drop one.
function flasherLatest() {
  return json({
    version: FLASHER_VERSION,
    windows: `${RELEASE}/Projection5000-SD-Flasher-Setup.exe`,
    mac_arm64: `${RELEASE}/Projection5000-SD-Flasher-mac-arm64.dmg`,
    mac_intel: `${RELEASE}/Projection5000-SD-Flasher-mac-intel.dmg`,
    notes: `https://github.com/Mattkillsyou/piplayer/releases/tag/v${FLASHER_VERSION}`,
  }, 200, { "cache-control": "public, max-age=3600" });
}

export function register(router) {
  router.get("/api/health", () => json({ ok: true }));
  router.get("/api/flasher/latest", flasherLatest);
  router.post("/api/enroll", enroll);
  router.post("/api/operator/login", operatorLogin);
  router.get("/api/operator/me", operatorMe);
  router.post("/api/operator/devices", operatorDevices);
  router.get("/api/operator/enrollment", operatorEnrollment);
  router.get("/api/sync/:device_id", sync);
  router.get("/api/camera-config/:device_id", getCameraConfig);
  router.post("/api/screenshots/:device_id", uploadScreenshot);
  router.post("/api/camera/:device_id", uploadCamera);
  router.post("/api/commands/:command_id/result", reportCommandResult);
}
