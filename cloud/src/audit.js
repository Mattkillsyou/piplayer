// Audit log helper. Call log(ctx, action, ...) from any write route to record what changed.
// The user is taken from ctx.user (pass `user` explicitly for login, where ctx.user is not
// set yet, or null for login_failed). Never throws: a failed audit write must not fail the request.
import * as db from "./db.js";
import { envInt } from "./util.js";

export function clientIp(ctx) {
  return ctx.request.headers.get("cf-connecting-ip") || null;
}

// json.dumps() with Python's default separators and ensure_ascii, so the Details column reads
// the same here as in the Python CMS: {"a": 1, "b": "x", "c": [1, 2]}.
export function pyJson(v) {
  if (v === null || v === undefined) return "null";
  if (Array.isArray(v)) return `[${v.map(pyJson).join(", ")}]`;
  if (typeof v === "object") {
    return `{${Object.entries(v).filter(([, x]) => x !== undefined).map(([k, x]) => `${pyJson(k)}: ${pyJson(x)}`).join(", ")}}`;
  }
  if (typeof v === "string") {
    return JSON.stringify(v).replace(/[\u0080-\uffff]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
  }
  return JSON.stringify(v);
}

export async function log(ctx, action, targetType = null, targetId = null, details = null, user = undefined) {
  const u = user === undefined ? ctx.user : user;
  try {
    await db.run(ctx.env,
      `INSERT INTO audit_log (user_id, username, action, target_type, target_id, details, ip)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      u ? u.id : null,
      u ? u.username : null,
      action,
      targetType,
      targetId === null || targetId === undefined ? null : String(targetId),
      details && Object.keys(details).length ? pyJson(details) : null,
      clientIp(ctx));
  } catch (e) {
    console.error(`audit log write failed for ${action}: ${e}`);
  }
}

// Daily: prune rows older than PIPLAYER_AUDIT_RETENTION_DAYS (0 = keep forever).
export function housekeeping(env) {
  return db.pruneAuditLog(env, envInt(env, "PIPLAYER_AUDIT_RETENTION_DAYS", 365));
}
