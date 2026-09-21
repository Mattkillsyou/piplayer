// Device-code sign-in for the SD flasher (the OAuth device flow shape, no copy/paste):
//   1. flasher: POST /api/operator/device-code {hostname} (no auth) -> {device_code, user_code,
//      verification_url, expires_in, interval}; it opens verification_url?code=<user_code>.
//   2. operator: GET /authorize (session, admin: the token can fetch the enrollment key) shows
//      "Sign in the SD Flasher on <hostname>?" plus where and when the request came from;
//      POST /authorize approve mints an api_tokens row "SD Flasher on <hostname>" for the
//      signed-in user (auth.issueApiToken, audited api_token_created source "device-code").
//   3. flasher: POST /api/operator/device-token {device_code} every `interval` s ->
//      428 {status: "pending"} | 200 {token, username} once (the pending token is cleared) |
//      410 {status: "expired" | "denied"}.
// Table device_codes (migration 0004): only the SHA-256 hex of device_code is stored; the minted
// token waits in token_plain_until_claimed until the flasher collects it. Codes expire
// EXPIRES_IN seconds after creation; the row stays an hour whatever happens to it (claimed,
// denied, expired) so the per-IP rate limit keeps counting it, then it is pruned (housekeeping,
// and on every new code) together with any token nobody claimed.
import * as audit from "./audit.js";
import * as auth from "./auth.js";
import * as db from "./db.js";
import { installBaseUrl } from "./pages/devices.js";
import { alertBox, csrfInput, layout } from "./pages/layout.js";
import { esc, fail, ipBucket, json, jsonObject, randomToken, redirect, sha256Hex, str } from "./util.js";

export const EXPIRES_IN = 600;
export const INTERVAL = 3;
export const MAX_CODES_PER_IP_HOUR = 20;
export const USER_CODE_LEN = 6;
// No vowels (no accidental words) and no 0/O/1/I look-alikes.
export const USER_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ23456789";
// "SD Flasher on " + hostname must fit settings.MAX_TOKEN_NAME (60).
export const MAX_HOSTNAME = 46;
export const TOKEN_NAME_PREFIX = "SD Flasher on ";

const LIVE = "created_at > datetime('now', ?)";
const liveArg = () => `-${EXPIRES_IN} seconds`;

// Six unbiased picks from the alphabet (bytes >= 252 = 9 * 28 are skipped).
export function newUserCode() {
  const limit = 256 - (256 % USER_CODE_ALPHABET.length);
  let out = "";
  while (out.length < USER_CODE_LEN) {
    for (const b of crypto.getRandomValues(new Uint8Array(16))) {
      if (b < limit && out.length < USER_CODE_LEN) out += USER_CODE_ALPHABET[b % USER_CODE_ALPHABET.length];
    }
  }
  return out;
}

// What the operator typed or the ?code= link carried: case and the display hyphen do not matter.
export const normalizeUserCode = (s) => String(s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
export const displayUserCode = (c) => `${c.slice(0, 4)}-${c.slice(4)}`;

// Printable, at most MAX_HOSTNAME chars; a missing or empty hostname reads "unknown PC".
// \p{C} drops control, format (bidi overrides, zero-width), unassigned and private-use characters
// so the name on /authorize cannot be made to read as something else.
export function cleanHostname(v) {
  const s = (typeof v === "string" ? v : "").replace(/\p{C}/gu, "").trim().slice(0, MAX_HOSTNAME).trim();
  return s || "unknown PC";
}

// Drop rows older than an hour; a token approved but never claimed goes with its row, so it
// cannot linger as an orphan in api_tokens.
export async function prune(env) {
  const stale = await db.all(env,
    "SELECT token_plain_until_claimed AS t FROM device_codes WHERE token_plain_until_claimed IS NOT NULL AND created_at <= datetime('now', '-1 hour')");
  const stmts = [];
  for (const r of stale) stmts.push(["DELETE FROM api_tokens WHERE token_hash = ?", await auth.apiTokenHash(r.t)]);
  stmts.push(["DELETE FROM device_codes WHERE created_at <= datetime('now', '-1 hour')"]);
  await db.batch(env, stmts);
}
export const housekeeping = prune;

// Close one row (it stays for the per-IP count until pruned) and, when it holds an unclaimed
// token, delete that token.
async function discard(env, row) {
  const stmts = [["UPDATE device_codes SET token_plain_until_claimed = NULL WHERE device_code_hash = ?", row.device_code_hash]];
  if (row.token) stmts.push(["DELETE FROM api_tokens WHERE token_hash = ?", await auth.apiTokenHash(row.token)]);
  await db.batch(env, stmts);
}

// ---------------------------------------------------------------------------
// Flasher endpoints (no auth: the code is the credential, and only for 10 minutes)
// ---------------------------------------------------------------------------

async function deviceCode(ctx) {
  // Body is optional JSON {hostname}; anything else just means "unknown PC".
  let body = {};
  try { body = await ctx.request.json(); } catch { /* no body */ }
  const hostname = cleanHostname(body && typeof body === "object" ? body.hostname : "");
  await prune(ctx.env);
  const ip = ipBucket(ctx.ip);
  const { n } = await db.first(ctx.env,
    "SELECT COUNT(*) AS n FROM device_codes WHERE ip = ? AND created_at > datetime('now', '-1 hour')", ip);
  if (n >= MAX_CODES_PER_IP_HOUR) fail(429, `too many sign-in codes from this address; try again in an hour`);
  const deviceCode = randomToken(32);
  const userCode = newUserCode();
  await db.run(ctx.env, "INSERT INTO device_codes (device_code_hash, user_code, hostname, ip) VALUES (?, ?, ?, ?)",
    await sha256Hex(deviceCode), userCode, hostname, ip);
  return json({
    device_code: deviceCode,
    user_code: userCode,
    verification_url: `${installBaseUrl(ctx.env, ctx.url).base}/authorize`,
    expires_in: EXPIRES_IN,
    interval: INTERVAL,
  });
}

async function deviceToken(ctx) {
  const body = await jsonObject(ctx.request);
  if (typeof body.device_code !== "string" || !body.device_code) fail(400, "device_code is required");
  const hash = await sha256Hex(body.device_code);
  const row = await db.first(ctx.env,
    `SELECT c.device_code_hash, c.denied, c.approved_at, c.token_plain_until_claimed AS token, c.${LIVE} AS live, u.username
       FROM device_codes c LEFT JOIN users u ON u.id = c.user_id WHERE c.device_code_hash = ?`, liveArg(), hash);
  if (!row || !auth.timingSafeEqual(row.device_code_hash, hash)) return json({ status: "expired" }, 410);
  if (!row.live || row.denied) {
    await discard(ctx.env, row);
    return json({ status: row.live ? "denied" : "expired" }, 410);
  }
  if (!row.approved_at) return json({ status: "pending" }, 428);
  // One shot: the UPDATE's row count decides who wins a concurrent poll.
  const r = await db.run(ctx.env,
    "UPDATE device_codes SET token_plain_until_claimed = NULL WHERE device_code_hash = ? AND token_plain_until_claimed IS NOT NULL", hash);
  if (!r.changes) return json({ status: "expired" }, 410);
  return json({ token: row.token, username: row.username });
}

// ---------------------------------------------------------------------------
// /authorize (session, admin; reached from the flasher's link, no nav item)
// ---------------------------------------------------------------------------

const BAD_CODE = "That code is not valid or has expired. Check the SD Flasher and try again.";

// The live, not yet answered row for a user code, or null.
const pending = (env, code) => code.length === USER_CODE_LEN ? db.first(env,
  `SELECT device_code_hash, user_code, hostname, ip, CAST((julianday('now') - julianday(created_at)) * 1440 AS INTEGER) AS age_min
     FROM device_codes
    WHERE user_code = ? AND approved_at IS NULL AND denied = 0 AND ${LIVE}`, code, liveArg()) : null;

function codeForm(ctx, code, error) {
  return `<div class="panel">
  <h2>Enter the code</h2>
  <p class="muted small">The SD Flasher shows a code when you click Sign in. Enter it here to give that computer a token that acts with your role (${esc(ctx.user.role)}). The token appears under My API tokens on the Settings page and under your name on the Users page, where you can revoke it.</p>
  ${alertBox(error)}
  <form method="get" action="/authorize">
    <div class="row">
      <label>Code
        <input type="text" name="code" value="${esc(code ? displayUserCode(code) : "")}" placeholder="XXXX-XX" maxlength="${USER_CODE_LEN + 1}" autocomplete="off" spellcheck="false" autofocus required>
      </label>
      <button type="submit" class="primary">Continue</button>
    </div>
  </form>
</div>`;
}

function confirmPanel(ctx, row) {
  return `<div class="panel">
  <h2>Sign in the SD Flasher on ${esc(row.hostname)}?</h2>
  <p>Code <code>${esc(displayUserCode(row.user_code))}</code>. Approve creates an API token named "${esc(TOKEN_NAME_PREFIX + row.hostname)}" for <strong>${esc(ctx.user.username)}</strong>. Only approve if you just clicked Sign in there.</p>
  <p class="muted small">That computer calls itself "${esc(row.hostname)}". It asked ${row.age_min < 1 ? "less than a minute" : row.age_min + " minute(s)"} ago from the address <code>${esc(row.ip)}</code>; you are browsing from <code>${esc(ipBucket(ctx.ip))}</code>. If those addresses differ and you are sitting at the same computer as the SD Flasher, press Deny.</p>
  <form method="post" action="/authorize">
    ${csrfInput(ctx)}
    <input type="hidden" name="code" value="${esc(row.user_code)}">
    <div class="row">
      <button type="submit" name="action" value="approve" class="primary">Approve</button>
      <button type="submit" name="action" value="deny" class="danger">Deny</button>
    </div>
  </form>
</div>`;
}

function page(ctx, panel, status = 200) {
  const content = `<div class="page-head">
  <h1>Sign in the SD Flasher</h1>
</div>
${panel}`;
  return layout(ctx, { title: "Sign in the SD Flasher", content, status });
}

async function authorizePage(ctx) {
  const code = normalizeUserCode(ctx.url.searchParams.get("code"));
  // The flasher's link lands here before the operator has signed in: keep the code across /login.
  if (!ctx.user && code) throw redirect(`/login?next=${encodeURIComponent(`/authorize?code=${code}`)}`);
  auth.requireRole(ctx, "admin");
  if (!code) return page(ctx, codeForm(ctx, "", ""));
  const row = await pending(ctx.env, code);
  return page(ctx, row ? confirmPanel(ctx, row) : codeForm(ctx, code, BAD_CODE));
}

async function authorizeSubmit(ctx) {
  const me = auth.requireRole(ctx, "admin");
  const form = await ctx.form();
  const code = normalizeUserCode(str(form, "code"));
  const action = str(form, "action");
  if (action !== "approve" && action !== "deny") return redirect(`/authorize?code=${encodeURIComponent(code)}`);
  const row = await pending(ctx.env, code);
  if (!row) return page(ctx, codeForm(ctx, code, BAD_CODE), 400);
  if (action === "deny") {
    await db.run(ctx.env, "UPDATE device_codes SET denied = 1 WHERE device_code_hash = ?", row.device_code_hash);
    await audit.log(ctx, "device_code_denied", null, null, { hostname: row.hostname });
    return page(ctx, alertBox("Denied. The SD Flasher will report that the sign-in was refused.", "warn"));
  }
  const { id, token } = await auth.issueApiToken(ctx, me.id, TOKEN_NAME_PREFIX + row.hostname, { source: "device-code" });
  const r = await db.run(ctx.env,
    `UPDATE device_codes SET user_id = ?, token_plain_until_claimed = ?, approved_at = datetime('now')
      WHERE device_code_hash = ? AND approved_at IS NULL AND denied = 0`, me.id, token, row.device_code_hash);
  if (!r.changes) {
    // Answered from another tab in the meantime: the token we just minted has no taker.
    await db.run(ctx.env, "DELETE FROM api_tokens WHERE id = ?", id);
    return page(ctx, codeForm(ctx, code, BAD_CODE), 400);
  }
  return page(ctx, alertBox("Approved. Go back to the SD Flasher; it signs in by itself within a few seconds.", "ok"));
}

export function register(router) {
  router.post("/api/operator/device-code", deviceCode);
  router.post("/api/operator/device-token", deviceToken);
  router.get("/authorize", authorizePage);
  router.post("/authorize", authorizeSubmit);
}
