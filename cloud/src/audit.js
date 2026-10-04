// Audit log helper. Call log(ctx, action, ...) from any write route to record what changed.
// The user is taken from ctx.user (pass `user` explicitly for login, where ctx.user is not
// set yet, or null for login_failed). Never throws: a failed audit write must not fail the request.
// Each row also names the account it is about (audit_log.owner_id, migration 0016): what a
// non-admin sees on /audit. By default the acting user's own account; a row about someone else's
// projector or account (an admin acting on it, a device report, the alert cron) passes `owner`.
import * as db from "./db.js";
import { envInt } from "./util.js";

// null for a cron-driven ctx (alerts.evaluate) that has no request.
export function clientIp(ctx) {
  return ctx.request ? ctx.request.headers.get("cf-connecting-ip") || null : null;
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
    return JSON.stringify(v).replace(/[\u0080-￿]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
  }
  return JSON.stringify(v);
}

// `owner`: the account id the row is about (null = none: only admins see it); undefined = the
// acting user's own account.
export async function log(ctx, action, targetType = null, targetId = null, details = null, user = undefined, owner = undefined) {
  const u = user === undefined ? ctx.user : user;
  const o = owner === undefined ? (u ? u.id : null) : owner;
  try {
    await db.run(ctx.env,
      `INSERT INTO audit_log (user_id, username, action, target_type, target_id, details, ip, owner_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      u ? u.id : null,
      u ? u.username : null,
      action,
      targetType,
      targetId === null || targetId === undefined ? null : String(targetId),
      details && Object.keys(details).length ? pyJson(details) : null,
      clientIp(ctx),
      o ?? null);
  } catch (e) {
    console.error(`audit log write failed for ${action}: ${e}`);
  }
}

// Daily: prune rows older than PIPLAYER_AUDIT_RETENTION_DAYS (0 = keep forever).
export function housekeeping(env) {
  return db.pruneAuditLog(env, envInt(env, "PIPLAYER_AUDIT_RETENTION_DAYS", 365));
}
