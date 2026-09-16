// D1 query helpers. Thin wrappers over env.DB.prepare(...).bind(...) so routes read like
// the Python cursor code: all()/first()/run()/batch(). Plus the site settings.
import { envFloat, envInt, HttpError, randomToken } from "./util.js";

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

// Fail loudly (once per isolate) when migrations were never applied.
let migrated = false;
export async function assertMigrated(env) {
  if (migrated) return;
  try {
    await env.DB.prepare("SELECT 1 FROM meta").first();
  } catch (e) {
    throw new HttpError(500, "database not migrated: run npm run migrate:local (or migrate:remote)");
  }
  migrated = true;
}

// ---------------------------------------------------------------------------
// Settings (/settings page). Stored as strings in `settings`; env vars are the defaults.
// ---------------------------------------------------------------------------

export const SETTING_KEYS = ["timezone", "screenshot_interval", "camera_interval", "default_image_duration", "enrollment_key",
  "enroll_group_id", "enroll_playlist_id", "player_release", "auto_update", "auto_update_window",
  "wyze_camera_pattern", "camera_config_version"];

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
  };
}

// {timezone, screenshot_interval (int seconds), camera_interval (int seconds), default_image_duration
// (float seconds), enrollment_key (secret shared with the flasher; POST /api/enroll), enroll_group_id /
// enroll_playlist_id (int or null), player_release (git ref), auto_update ('off' | 'nightly'),
// auto_update_window ('HH:MM-HH:MM'), wyze_camera_pattern, camera_config_version (int)}.
export async function loadSettings(env) {
  const s = defaultSettings(env);
  for (const row of await all(env, "SELECT key, value FROM settings")) {
    if (row.key === "timezone" && row.value) s.timezone = row.value;
    else if (row.key === "screenshot_interval" && Number.isFinite(+row.value)) s.screenshot_interval = parseInt(row.value, 10);
    else if (row.key === "camera_interval" && Number.isFinite(+row.value)) s.camera_interval = parseInt(row.value, 10);
    else if (row.key === "default_image_duration" && Number.isFinite(+row.value)) s.default_image_duration = parseFloat(row.value);
    else if (row.key === "enrollment_key" && row.value) s.enrollment_key = row.value;
    else if ((row.key === "enroll_group_id" || row.key === "enroll_playlist_id") && /^\d+$/.test(row.value)) s[row.key] = parseInt(row.value, 10);
    else if (row.key === "player_release" && isGitRef(row.value)) s.player_release = row.value;
    else if (row.key === "auto_update" && AUTO_UPDATE_MODES.includes(row.value)) s.auto_update = row.value;
    else if (row.key === "auto_update_window" && UPDATE_WINDOW_RE.test(row.value)) s.auto_update_window = row.value;
    else if (row.key === "wyze_camera_pattern" && isCameraPattern(row.value)) s.wyze_camera_pattern = row.value;
    else if (row.key === "camera_config_version" && /^\d+$/.test(row.value)) s.camera_config_version = parseInt(row.value, 10);
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
