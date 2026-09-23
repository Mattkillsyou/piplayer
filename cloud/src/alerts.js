// Alerts (feature F, cloud only). evaluate(env, now) runs from the */5 cron (index.js
// scheduled): every device is checked against the conditions below, an alert row is opened
// once per (device, kind), closed when the condition clears, and the configured channels
// (email via the ALERT_MAIL send_email binding, a JSON webhook, Twilio SMS) get one digest per
// run: what opened, what recovered and what is still open past alert_repeat_minutes.
// ponytail: a failed send is logged + audited, never retried (notified_at is stamped once the
// digest has been sent, whether or not a channel failed), so a dead webhook cannot make the
// working channels repeat every 5 minutes. A run that throws before the digest leaves its rows
// unstamped and the next run announces them.
import * as audit from "./audit.js";
import * as db from "./db.js";
import * as secrets from "./secrets.js";
import { OFFLINE_AFTER_SECONDS } from "./pages/devices.js";
import { ageSeconds, esc, localTime, nowUtc } from "./util.js";

// The wrangler.toml trigger index.js scheduled() routes here (the entry module may only
// export handlers, so the string lives in this module).
export const CRON = "*/5 * * * *";
export const KINDS = ["offline", "mpv-down", "screenshot-stale", "sync-error", "update-failed", "camera-error", "projector-error"];
export const KIND_TEXT = {
  "offline": "offline (no sync)",
  "mpv-down": "player down",
  "screenshot-stale": "no new screenshot",
  "sync-error": "sync error",
  "update-failed": "remote update failed",
  "camera-error": "camera error",
  "projector-error": "projector error",
};
export const CHANNELS = ["email", "webhook", "sms"];
export const EMAIL_FROM = "alerts@photogen5000.com";
export const TWILIO_NAMES = ["twilio_account_sid", "twilio_auth_token", "twilio_from", "twilio_to"];
export const SITE = "Projection5000";
const FETCH_TIMEOUT_MS = 10000;

// Kinds active for one device row (the columns api.sync stores) at `now`. Offline wins:
// while the player is not syncing its other columns are frozen, so nothing else is opened or
// closed (evaluate keeps those alerts as they are). A device that never synced is not offline:
// it has nothing to lose yet. The screenshot is stale when it lags the last sync by 3
// intervals: measured against the sync, not the clock, so a sync gap cannot make it grow.
export function conditions(d, settings, now) {
  const seen = ageSeconds(d.last_seen_at, now);
  if (seen === null) return new Set();
  if (seen > Math.max(OFFLINE_AFTER_SECONDS, settings.alert_offline_minutes * 60)) return new Set(["offline"]);
  const out = new Set();
  if (d.player_status === "mpv-down") out.add("mpv-down");
  const shot = ageSeconds(d.last_screenshot_at, now);
  if (shot !== null && shot - seen > 3 * settings.screenshot_interval) out.add("screenshot-stale");
  if (d.last_error) out.add("sync-error");
  if (d.last_update_ok === 0) out.add("update-failed");
  if (d.camera_error) out.add("camera-error");
  if (d.projector_error) out.add("projector-error");
  return out;
}

const cronCtx = (env) => ({ env, user: null });

// One pass: returns {opened, closed, repeated, sent: [channel...], errors: [text...]}.
export async function evaluate(env, now = new Date()) {
  const settings = await db.loadSettings(env);
  const ts = nowUtc(now);
  const devices = await db.all(env,
    `SELECT id, device_id, name, last_seen_at, player_status, last_screenshot_at, last_error,
            last_update_ok, camera_error, projector_error FROM devices`);
  const open = await db.all(env, "SELECT id, device_id, kind, opened_at, notified_at FROM alerts WHERE closed_at IS NULL");
  const openBy = new Map(open.map((a) => [`${a.device_id}:${a.kind}`, a]));
  const events = { opened: [], closed: [], repeated: [] };
  const ctx = cronCtx(env);
  const repeatAfter = settings.alert_repeat_minutes * 60;
  for (const d of devices) {
    const active = conditions(d, settings, now);
    const offline = active.has("offline");
    for (const kind of KINDS) {
      const cur = openBy.get(`${d.id}:${kind}`);
      if (active.has(kind)) {
        if (!cur) {
          // OR IGNORE: an overlapping run may have opened the same (device, kind) since the
          // SELECT above (idx_alerts_one_open); that run's digest carries it, so nothing to do here.
          const ins = await db.run(env, "INSERT OR IGNORE INTO alerts (device_id, kind, opened_at) VALUES (?, ?, ?)", d.id, kind, ts);
          if (!ins.changes) continue;
          events.opened.push({ id: ins.last_row_id, device: d, kind, opened_at: ts });
          await audit.log(ctx, "alert_opened", "device", d.device_id, { kind });
        } else if (cur.notified_at === null) {
          // opened by a run that threw before its digest went out
          events.opened.push({ id: cur.id, device: d, kind, opened_at: cur.opened_at });
        } else if (repeatAfter > 0 && ageSeconds(cur.notified_at, now) >= repeatAfter) {
          events.repeated.push({ id: cur.id, device: d, kind, opened_at: cur.opened_at });
        }
      } else if (cur && !(offline && kind !== "offline")) {
        await db.run(env, "UPDATE alerts SET closed_at = ? WHERE id = ?", ts, cur.id);
        events.closed.push({ id: cur.id, device: d, kind, opened_at: cur.opened_at });
        await audit.log(ctx, "alert_closed", "device", d.device_id, { kind });
      }
    }
  }
  const result = { opened: events.opened.length, closed: events.closed.length, repeated: events.repeated.length, sent: [], errors: [] };
  if (result.opened + result.closed + result.repeated === 0) return result;
  const msg = digest(events, settings.timezone);
  for (const [channel, error] of await sendAll(env, settings, msg)) {
    if (error === null) result.sent.push(channel);
    else {
      result.errors.push(`${channel}: ${error}`);
      console.error(`alert ${channel} failed: ${error}`);
      await audit.log(ctx, "alert_notify_failed", "settings", channel, { error: error.slice(0, 200) });
    }
  }
  // Everything in the digest is stamped in one round trip (send never throws, so this runs).
  const ids = [...events.opened, ...events.closed, ...events.repeated].map((e) => e.id);
  await db.batch(env, ids.map((id) => ["UPDATE alerts SET notified_at = ? WHERE id = ?", ts, id]));
  return result;
}

// {subject, text} for one run's events; the same text goes to every channel. Times are in the
// site zone like every console page.
export function digest({ opened = [], closed = [], repeated = [] }, timeZone = "UTC") {
  const line = (e) => `${e.device.name} (${e.device.device_id}): ${KIND_TEXT[e.kind] || e.kind} since ${localTime(e.opened_at, timeZone)}`;
  const parts = [];
  if (opened.length) parts.push(`ALERT ${opened.length}`, ...opened.map(line));
  if (closed.length) parts.push(`RECOVERED ${closed.length}`, ...closed.map(line));
  if (repeated.length) parts.push(`STILL OPEN ${repeated.length}`, ...repeated.map(line));
  const summary = [opened.length && `${opened.length} opened`, closed.length && `${closed.length} recovered`, repeated.length && `${repeated.length} still open`]
    .filter(Boolean).join(", ");
  return { subject: `${SITE}: ${summary}`, text: parts.join("\n") };
}

// Which channels are set up: email needs addresses and the binding, webhook a URL, sms the
// four Twilio secrets. The Settings page shows this and the cron sends to each.
export async function configured(env, settings) {
  const have = await secrets.names(env);
  return {
    email: !!db.parseEmails(settings.alert_email),
    email_binding: !!(env.ALERT_MAIL && typeof env.ALERT_MAIL.send === "function"),
    webhook: db.isWebhookUrl(settings.alert_webhook_url),
    sms: TWILIO_NAMES.every((n) => have.has(n)),
  };
}

// [[channel, null | error text]] for every configured channel.
async function sendAll(env, settings, msg) {
  const c = await configured(env, settings);
  const out = [];
  for (const channel of CHANNELS) {
    if (!c[channel]) continue;
    out.push([channel, await send(env, settings, channel, msg)]);
  }
  return out;
}

// One channel; null on success, else the error text (never throws).
export async function send(env, settings, channel, msg) {
  try {
    if (channel === "email") return await sendEmail(env, settings, msg);
    if (channel === "webhook") return await sendWebhook(settings, msg);
    if (channel === "sms") return await sendSms(env, msg);
    return `unknown channel ${channel}`;
  } catch (e) {
    return String(e && e.message || e).slice(0, 500);
  }
}

// The Cloudflare send_email binding (wrangler.toml [[send_email]] name = "ALERT_MAIL"). The
// binding is absent in local dev / tests unless declared, and Email Routing must be enabled on
// the sender's zone with each destination verified (docs/automation.md). One raw RFC 5322
// message per address (the binding sends to exactly one recipient).
async function sendEmail(env, settings, msg) {
  const to = db.parseEmails(settings.alert_email);
  if (!to) return "no alert email address set";
  if (!env.ALERT_MAIL || typeof env.ALERT_MAIL.send !== "function") return "ALERT_MAIL send_email binding is not configured";
  const { EmailMessage } = await import("cloudflare:email");
  for (const addr of to) {
    const raw = rawEmail(EMAIL_FROM, addr, msg.subject, msg.text);
    await env.ALERT_MAIL.send(new EmailMessage(EMAIL_FROM, addr, raw));
  }
  return null;
}

// Headers + body; the subject is Q-encoded when it is not printable ASCII.
export function rawEmail(from, to, subject, text, date = new Date()) {
  const id = `<${crypto.randomUUID()}@${from.split("@")[1]}>`;
  const subj = /^[\x20-\x7e]*$/.test(subject) ? subject : `=?utf-8?B?${btoa(unescape(encodeURIComponent(subject)))}?=`;
  return [
    `From: ${SITE} alerts <${from}>`,
    `To: ${to}`,
    `Subject: ${subj.replace(/[\r\n]/g, " ")}`,
    `Date: ${date.toUTCString()}`,
    `Message-ID: ${id}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    text.replace(/\r?\n/g, "\r\n"),
    "",
  ].join("\r\n");
}

// Generic JSON POST. Slack reads `text`, Discord `content`, ntfy (topic URL) `message` +
// `title`; anything else gets the same fields.
async function sendWebhook(settings, msg) {
  if (!db.isWebhookUrl(settings.alert_webhook_url)) return "no valid https webhook URL set";
  const res = await fetch(settings.alert_webhook_url, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": `${SITE}-alerts` },
    body: JSON.stringify(webhookPayload(msg)),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  return res.ok ? null : `webhook answered ${res.status}`;
}

export const webhookPayload = (msg) => ({
  site: SITE, title: msg.subject, text: `${msg.subject}\n${msg.text}`, content: `${msg.subject}\n${msg.text}`, message: msg.text,
});

// Twilio REST: POST /2010-04-01/Accounts/{sid}/Messages.json, HTTP basic sid:token. SMS is
// short: subject + the first lines, cut at 600 chars (4 segments).
async function sendSms(env, msg) {
  const t = await secrets.getMany(env, TWILIO_NAMES);
  if (TWILIO_NAMES.some((n) => !t[n])) return "Twilio account sid, auth token, from and to must all be set";
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(t.twilio_account_sid)}/Messages.json`, {
    method: "POST",
    headers: { authorization: `Basic ${btoa(`${t.twilio_account_sid}:${t.twilio_auth_token}`)}`, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ From: t.twilio_from, To: t.twilio_to, Body: smsBody(msg) }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (res.ok) return null;
  // Twilio quotes the To / From number in its validation errors; they are stored as secrets
  // and this text lands in the audit log and the Settings banner URL, so hide any number.
  let why = "";
  try { why = String((await res.json()).message || "").replace(/\+?\d{6,}/g, "(number hidden)"); } catch { /* not JSON */ }
  return `Twilio answered ${res.status}${why ? `: ${why}` : ""}`.slice(0, 300);
}

export const smsBody = (msg) => `${msg.subject}\n${msg.text}`.slice(0, 600);

// "Send test" on the Settings page: one message through one channel; null or the error text.
export function sendTest(env, settings, channel, user) {
  return send(env, settings, channel, {
    subject: `${SITE}: test alert`,
    text: `Test message from ${SITE} alert settings (${channel}), requested by ${user}. If you can read this, the channel works.`,
  });
}

// Open alerts count for the dashboard badge.
export const openCount = (env) => db.first(env, "SELECT COUNT(*) AS n FROM alerts WHERE closed_at IS NULL").then((r) => r.n);

export const kindBadge = (kind) => `<span class="badge badge-stale">${esc(KIND_TEXT[kind] || kind)}</span>`;

export function register() {}

// Daily: prune closed rows older than 90 days (open rows are never touched).
export async function housekeeping(env) {
  await db.run(env, "DELETE FROM alerts WHERE closed_at IS NOT NULL AND closed_at < datetime('now', '-90 days')");
}
