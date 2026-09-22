// D1 query helpers. Thin wrappers over env.DB.prepare(...).bind(...) so routes read like
// the Python cursor code: all()/first()/run()/batch(). Plus the site settings.
import { envFloat, envInt, HttpError, isValidTimeZone, randomToken } from "./util.js";

// Rows for a SELECT.
export async function all(env, sql, ...params) {
  const r = await env.DB.prepare(sql).bind(...params).all();
  return r.results;
}

// First row or null.
export function first(env, sql, ...params) {
  return env.DB.prepare(sql).bind(...params).first();
}

// INSERT/UPDATE/DELETE: returns {changes, last_row_id}.
export async function run(env, sql, ...params) {
  const r = await env.DB.prepare(sql).bind(...params).run();
  return { changes: r.meta.changes, last_row_id: r.meta.last_row_id };
}

// Several statements in one implicit transaction: batch(env, [[sql, p1, p2], [sql2]]).
// Returns the D1 result per statement (results[i].results / .meta).
export function batch(env, statements) {
  return env.DB.batch(statements.map(([sql, ...params]) => env.DB.prepare(sql).bind(...params)));
}

// True for a UNIQUE / FOREIGN KEY / CHECK violation (sqlite3.IntegrityError in Python);
// index.js maps those to 409 with a friendly message, routes can map them more precisely.
export function isConstraintError(e) {
  return /constraint failed|SQLITE_CONSTRAINT/i.test(String(e && e.message));
}

// The meta.schema_version the code expects: bump with each new migrations/000N file (the last
// statement of every migration writes it).
export const SCHEMA_VERSION = 11;

// Fail loudly (once per isolate) when migrations were never applied or stopped short of this
// release: a worker deployed before `npm run migrate:remote` must say so on every request
// (including /api/health, which index.js guards like everything else) instead of answering
// raw SQL errors on some routes and ok on others.
let migrated = false;
export async function assertMigrated(env) {
  if (migrated) return;
  let v;
  try {
    v = await env.DB.prepare("SELECT value FROM meta WHERE key = 'schema_version'").first("value");
  } catch (e) {
    throw new HttpError(500, "The database has not been set up yet: run npm run migrate:remote (or npm run migrate:local on a dev machine) and try again");
  }
  if (Number(v) < SCHEMA_VERSION) {
    throw new HttpError(500, `The database is behind this version of the console (it is at version ${v}, this release needs ${SCHEMA_VERSION}): run npm run migrate:remote and try again`);
  }
  migrated = true;
}

// ---------------------------------------------------------------------------
// Settings (/settings page). Stored as strings in `settings`; env vars are the defaults.
// ---------------------------------------------------------------------------

export const SETTING_KEYS = ["timezone", "screenshot_interval", "camera_interval", "default_image_duration", "enrollment_key",
  "enroll_group_id", "enroll_playlist_id", "player_release", "auto_update", "auto_update_window",
  "wyze_camera_pattern", "camera_config_version", "projector_lead_minutes", "projector_idle_minutes",
  "alert_offline_minutes", "alert_repeat_minutes", "alert_email", "alert_webhook_url", "default_playlist_id"];

// Remote updates (manifest `update` block). player_release is a git ref the Pi checks out
// (tag, branch or sha): starts with an alphanumeric so it can never read as a shell/git option,
// no '..', at most 100 chars. auto_update_window is "HH:MM-HH:MM" site-local (may wrap midnight).
export const GIT_REF_RE = /^[A-Za-z0-9][A-Za-z0-9._\/-]{0,99}$/;
export const isGitRef = (v) => typeof v === "string" && GIT_REF_RE.test(v) && !v.includes("..");
export const UPDATE_WINDOW_RE = /^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/;
export const AUTO_UPDATE_MODES = ["off", "nightly"];
// Camera zero-config: the Wyze camera name a device gets unless overridden on the Devices page
// ({device_name} / {device_id} are substituted); printable, at most 100 chars.
export const DEFAULT_WYZE_CAMERA_PATTERN = "{device_name}";
export const isCameraPattern = (v) => typeof v === "string" && v.length > 0 && v.length <= 100 && !/[\x00-\x1f\x7f]/.test(v);

// Projector power (manifest `projector.want`, manifest.projector_want): switch on this many
// minutes before a schedule rule starts, off once nothing has played for this many minutes.
export const PROJECTOR_LEAD_MINUTES = 3;
export const PROJECTOR_IDLE_MINUTES = 10;
export const MAX_PROJECTOR_MINUTES = 1440;
export const isProjectorMinutes = (v) => Number.isInteger(v) && v >= 0 && v <= MAX_PROJECTOR_MINUTES;

// Alerts (alerts.js, the */5 cron): a device is "offline" after this many minutes without a
// sync; an alert still open after alert_repeat_minutes since its last notification is sent
// again (0 = notify once on open and once on recovery). alert_email holds one or more
// addresses (comma-separated); alert_webhook_url an absolute https URL (Slack / Discord / ntfy).
export const ALERT_OFFLINE_MINUTES = 10;
export const ALERT_REPEAT_MINUTES = 240;
export const isAlertOfflineMinutes = (v) => Number.isInteger(v) && v >= 1 && v <= 1440;
export const isAlertRepeatMinutes = (v) => Number.isInteger(v) && v >= 0 && v <= 10080;
const EMAIL_RE = /^[^\s@,<>"']+@[^\s@,<>"']+\.[^\s@,<>"']+$/;
// "a@x.com, b@y.org" -> ["a@x.com", "b@y.org"]; null when any entry is not an address.
export function parseEmails(v) {
  const list = String(v || "").split(",").map((e) => e.trim()).filter(Boolean);
  return list.length && list.every((e) => e.length <= 254 && EMAIL_RE.test(e)) ? list : null;
}
export function isWebhookUrl(v) {
  if (typeof v !== "string" || !v || v.length > 2048) return false;
  try {
    const u = new URL(v);
    return u.protocol === "https:" && !!u.hostname && !u.username && !u.password;
  } catch {
    return false;
  }
}

export function defaultSettings(env) {
  return {
    timezone: "UTC",
    screenshot_interval: envInt(env, "PIPLAYER_SCREENSHOT_INTERVAL", 60),
    camera_interval: envInt(env, "PIPLAYER_CAMERA_INTERVAL", 10),
    default_image_duration: envFloat(env, "PIPLAYER_DEFAULT_IMAGE_DURATION", 10),
    enrollment_key: "", // generated on first read (loadSettings), never from env
    enroll_group_id: null, // group / playlist applied to a device on its FIRST enrollment (api.enroll);
    enroll_playlist_id: null, // null = none; a deleted row is treated as none at enrollment time
    player_release: env.PIPLAYER_PLAYER_RELEASE && isGitRef(env.PIPLAYER_PLAYER_RELEASE) ? env.PIPLAYER_PLAYER_RELEASE : "main",
    auto_update: AUTO_UPDATE_MODES.includes(env.PIPLAYER_AUTO_UPDATE) ? env.PIPLAYER_AUTO_UPDATE : "off",
    auto_update_window: UPDATE_WINDOW_RE.test(env.PIPLAYER_AUTO_UPDATE_WINDOW || "") ? env.PIPLAYER_AUTO_UPDATE_WINDOW : "03:00-05:00",
    wyze_camera_pattern: DEFAULT_WYZE_CAMERA_PATTERN,
    camera_config_version: 0, // bumped by bumpCameraConfigVersion on any camera / Wyze change; manifest key
    projector_lead_minutes: PROJECTOR_LEAD_MINUTES,
    projector_idle_minutes: PROJECTOR_IDLE_MINUTES,
    alert_offline_minutes: ALERT_OFFLINE_MINUTES,
    alert_repeat_minutes: ALERT_REPEAT_MINUTES,
    alert_email: "", // comma-separated destination addresses; "" = email channel off
    alert_webhook_url: "", // "" = webhook channel off
    default_playlist_id: null, // the site default playlist (migration 0010; Settings page); null only when its row is gone
  };
}

// {timezone, screenshot_interval (int seconds), camera_interval (int seconds), default_image_duration
// (float seconds), enrollment_key (secret shared with the flasher; POST /api/enroll), enroll_group_id /
// enroll_playlist_id (int or null), player_release (git ref), auto_update ('off' | 'nightly'),
// auto_update_window ('HH:MM-HH:MM'), wyze_camera_pattern, camera_config_version (int),
// projector_lead_minutes / projector_idle_minutes (int, 0-1440), alert_offline_minutes (int, 1-1440),
// alert_repeat_minutes (int, 0-10080), alert_email (comma-separated addresses or ''),
// alert_webhook_url (https URL or ''), default_playlist_id (int, or null when the playlist row no
// longer exists)}. timezone_problem (string, at most 64 chars) is only
// present when the stored timezone is no longer accepted: timezone is UTC then and the Settings
// page shows the offending value so the admin can pick a real one.
export async function loadSettings(env) {
  const s = defaultSettings(env);
  // A default_playlist_id whose playlist was deleted underneath it (D1 console) is left out, so it reads as null.
  for (const row of await all(env, "SELECT key, value FROM settings WHERE key != 'default_playlist_id' OR value IN (SELECT CAST(id AS TEXT) FROM playlists)")) {
    if (row.key === "timezone" && isValidTimeZone(row.value)) s.timezone = row.value;
    else if (row.key === "timezone") s.timezone_problem = String(row.value).slice(0, 64); // a bad zone (D1 edit, restore) falls back to UTC like any other malformed row, but visibly
    else if (row.key === "screenshot_interval" && Number.isFinite(+row.value)) s.screenshot_interval = parseInt(row.value, 10);
    else if (row.key === "camera_interval" && Number.isFinite(+row.value)) s.camera_interval = parseInt(row.value, 10);
    else if (row.key === "default_image_duration" && Number.isFinite(+row.value)) s.default_image_duration = parseFloat(row.value);
    else if (row.key === "enrollment_key" && row.value) s.enrollment_key = row.value;
    else if ((row.key === "enroll_group_id" || row.key === "enroll_playlist_id" || row.key === "default_playlist_id") && /^\d+$/.test(row.value)) s[row.key] = parseInt(row.value, 10);
    else if (row.key === "player_release" && isGitRef(row.value)) s.player_release = row.value;
    else if (row.key === "auto_update" && AUTO_UPDATE_MODES.includes(row.value)) s.auto_update = row.value;
    else if (row.key === "auto_update_window" && UPDATE_WINDOW_RE.test(row.value)) s.auto_update_window = row.value;
    else if (row.key === "wyze_camera_pattern" && isCameraPattern(row.value)) s.wyze_camera_pattern = row.value;
    else if (row.key === "camera_config_version" && /^\d+$/.test(row.value)) s.camera_config_version = parseInt(row.value, 10);
    else if ((row.key === "projector_lead_minutes" || row.key === "projector_idle_minutes") && isProjectorMinutes(+row.value)) s[row.key] = +row.value;
    else if (row.key === "alert_offline_minutes" && isAlertOfflineMinutes(+row.value)) s.alert_offline_minutes = +row.value;
    else if (row.key === "alert_repeat_minutes" && isAlertRepeatMinutes(+row.value)) s.alert_repeat_minutes = +row.value;
    else if (row.key === "alert_email" && parseEmails(row.value)) s.alert_email = row.value;
    else if (row.key === "alert_webhook_url" && isWebhookUrl(row.value)) s.alert_webhook_url = row.value;
  }
  if (!s.enrollment_key) s.enrollment_key = await generateEnrollmentKey(env, false);
  return s;
}

// Random 32-byte urlsafe key. With replace=false a concurrent first request may win the
// insert; both then read back the same stored value.
export async function generateEnrollmentKey(env, replace = true) {
  const key = randomToken(32);
  await run(env, `INSERT INTO settings (key, value) VALUES ('enrollment_key', ?) ON CONFLICT(key) DO ${replace ? "UPDATE SET value = excluded.value" : "NOTHING"}`, key);
  if (replace) return key;
  return (await first(env, "SELECT value FROM settings WHERE key = 'enrollment_key'")).value;
}

export function saveSetting(env, key, value) {
  return run(env, "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    key, String(value));
}

// Any change to the Wyze account, the camera pattern or a device's camera source bumps this
// so every player refetches GET /api/camera-config on its next sync.
export function bumpCameraConfigVersion(env) {
  return run(env, `INSERT INTO settings (key, value) VALUES ('camera_config_version', '1')
      ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)`);
}

export function pruneAuditLog(env, retentionDays) {
  if (!(retentionDays > 0)) return Promise.resolve({ changes: 0 });
  return run(env, "DELETE FROM audit_log WHERE created_at < datetime('now', ?)", `-${Math.floor(retentionDays)} days`);
}
