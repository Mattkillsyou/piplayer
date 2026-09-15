// D1 query helpers. Thin wrappers over env.DB.prepare(...).bind(...) so routes read like
// the Python cursor code: all()/first()/run()/batch(). Plus the site settings.
import { envFloat, envInt, HttpError } from "./util.js";

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

export const SETTING_KEYS = ["timezone", "screenshot_interval", "default_image_duration"];

export function defaultSettings(env) {
  return {
    timezone: "UTC",
    screenshot_interval: envInt(env, "PIPLAYER_SCREENSHOT_INTERVAL", 60),
    default_image_duration: envFloat(env, "PIPLAYER_DEFAULT_IMAGE_DURATION", 10),
  };
}

// {timezone, screenshot_interval (int seconds), default_image_duration (float seconds)}.
export async function loadSettings(env) {
  const s = defaultSettings(env);
  for (const row of await all(env, "SELECT key, value FROM settings")) {
    if (row.key === "timezone" && row.value) s.timezone = row.value;
    else if (row.key === "screenshot_interval" && Number.isFinite(+row.value)) s.screenshot_interval = parseInt(row.value, 10);
    else if (row.key === "default_image_duration" && Number.isFinite(+row.value)) s.default_image_duration = parseFloat(row.value);
  }
  return s;
}

export function saveSetting(env, key, value) {
  return run(env, "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    key, String(value));
}

export function pruneAuditLog(env, retentionDays) {
  if (!(retentionDays > 0)) return Promise.resolve({ changes: 0 });
  return run(env, "DELETE FROM audit_log WHERE created_at < datetime('now', ?)", `-${Math.floor(retentionDays)} days`);
}
