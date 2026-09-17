// Passwords (PBKDF2-SHA256 via WebCrypto), sessions (D1 row + HMAC-signed cookie), CSRF,
// roles, the failed-login throttle and device bearer auth. Port of cms/app/auth.py.
import * as audit from "./audit.js";
import * as db from "./db.js";
import { b64url, fail, fromB64url, HttpError, randomToken, redirect, sha256Hex, utf8Len } from "./util.js";

export const SESSION_COOKIE = "piplayer_session";
export const SESSION_MAX_AGE = 60 * 60 * 24 * 14;
// Anonymous sessions only carry the CSRF token for the /login and /setup forms; login rotates
// them into a full-length one, so keep the row (and the cookie) short-lived.
export const ANON_SESSION_MAX_AGE = 60 * 60;
export const PBKDF2_ITERATIONS = 100000;
// No bcrypt here, so no 72-byte rule; still cap the input so a multi-MB password cannot
// burn CPU in PBKDF2, and keep the CMS's 6-char minimum.
export const MAX_PASSWORD_BYTES = 1024;
export const MIN_PASSWORD_CHARS = 6;
export const PASSWORD_TOO_LONG_MSG = `password must be at most ${MAX_PASSWORD_BYTES} bytes (UTF-8)`;
export const PASSWORD_TOO_SHORT_MSG = `password must be at least ${MIN_PASSWORD_CHARS} chars`;
export const CSRF_ERROR = "CSRF token missing or invalid";
export const LOGIN_MAX_FAILURES = 5;
export const LOGIN_LOCK_SECONDS = 30;
// POST /api/enroll shares the login_failures table, keyed by ip + ENROLL_KEY.
export const ENROLL_KEY = "enroll";
export const ENROLL_MAX_FAILURES = 10;
export const ENROLL_LOCK_SECONDS = 60;
const MAX_LOCK_SECONDS = Math.max(LOGIN_LOCK_SECONDS, ENROLL_LOCK_SECONDS);
export const ROLES = ["viewer", "editor", "admin"];

const enc = new TextEncoder();

// ---------------------------------------------------------------------------
// Passwords
// ---------------------------------------------------------------------------

// '' when acceptable, else the 400 message to show (used by /setup, /users, /login).
export function passwordProblem(password) {
  if (typeof password !== "string" || password.length < MIN_PASSWORD_CHARS) return PASSWORD_TOO_SHORT_MSG;
  if (utf8Len(password) > MAX_PASSWORD_BYTES) return PASSWORD_TOO_LONG_MSG;
  return "";
}

async function pbkdf2(password, salt, iterations) {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256));
}

// 'pbkdf2$<iterations>$<salt b64url>$<hash b64url>'. Throws HttpError(400) when too long.
export async function hashPassword(password) {
  if (utf8Len(password) > MAX_PASSWORD_BYTES) fail(400, PASSWORD_TOO_LONG_MSG);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${b64url(salt)}$${b64url(hash)}`;
}

export async function verifyPassword(password, passwordHash) {
  try {
    const [scheme, iters, saltB64, hashB64] = String(passwordHash).split("$");
    if (scheme !== "pbkdf2" || utf8Len(password) > MAX_PASSWORD_BYTES) return false;
    const computed = await pbkdf2(password, fromB64url(saltB64), parseInt(iters, 10));
    return timingSafeEqual(computed, fromB64url(hashB64));
  } catch {
    return false;
  }
}

// Constant-time comparison of two strings or byte arrays (length is allowed to leak, as
// with secrets.compare_digest).
export function timingSafeEqual(a, b) {
  const ab = typeof a === "string" ? enc.encode(a) : new Uint8Array(a);
  const bb = typeof b === "string" ? enc.encode(b) : new Uint8Array(b);
  if (ab.byteLength !== bb.byteLength) return false;
  if (ab.byteLength === 0) return true;
  return crypto.subtle.timingSafeEqual(ab, bb);
}

const DUMMY_SALT = new Uint8Array(16);

// Spend one PBKDF2 derivation when the username does not exist, so a failed login takes
// the same time whether or not the user is real (no username enumeration).
export function burnPasswordCheck(password) {
  return pbkdf2(password.slice(0, 256), DUMMY_SALT, PBKDF2_ITERATIONS);
}

// ---------------------------------------------------------------------------
// Sessions and cookies
// ---------------------------------------------------------------------------

async function hmacKey(secret) {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

async function sign(secret, value) {
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(value));
  return b64url(sig);
}

function sessionSecret(env) {
  if (!env.SESSION_SECRET) throw new HttpError(500, "SESSION_SECRET is not configured");
  return env.SESSION_SECRET;
}

export function readCookie(request, name) {
  const header = request.headers.get("cookie") || "";
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

// Session id from a valid 'id.sig' cookie, else null.
export async function verifiedSessionId(request, env) {
  const raw = readCookie(request, SESSION_COOKIE);
  if (!raw) return null;
  const dot = raw.lastIndexOf(".");
  if (dot <= 0) return null;
  const id = raw.slice(0, dot);
  const expected = await sign(sessionSecret(env), id);
  return timingSafeEqual(raw.slice(dot + 1), expected) ? id : null;
}

function cookieHeader(ctx, value, maxAge) {
  // Always Secure (the spec's cookie). Plain-http `wrangler dev` is the one exception: browsers
  // and python-requests drop Secure cookies there, so the dev/e2e command lines pass
  // --var PIPLAYER_INSECURE_COOKIES:1. Never set it in production.
  const secure = ctx.env.PIPLAYER_INSECURE_COOKIES === "1" ? "" : "; Secure";
  return `${SESSION_COOKIE}=${value}; HttpOnly${secure}; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

// Insert a session row (user_id may be null = anonymous) and queue its cookie on ctx.
export async function createSession(ctx, userId) {
  const id = randomToken(32);
  const csrf = randomToken(32);
  const maxAge = userId ? SESSION_MAX_AGE : ANON_SESSION_MAX_AGE;
  const expires = new Date(Date.now() + maxAge * 1000).toISOString().slice(0, 19).replace("T", " ");
  await db.run(ctx.env, "INSERT INTO sessions (id, user_id, csrf, expires_at) VALUES (?, ?, ?, ?)", id, userId, csrf, expires);
  ctx.session = { id, user_id: userId, csrf, expires_at: expires };
  ctx.csrf = csrf;
  ctx.cookies.push(cookieHeader(ctx, `${id}.${await sign(sessionSecret(ctx.env), id)}`, maxAge));
  return ctx.session;
}

// Resolve the cookie into ctx.session / ctx.user / ctx.csrf. With create, an anonymous
// session is started when there is none (GET /login and /setup need a CSRF token); every
// other request only reads, so a cookieless GET or a scanner never writes a row.
export async function loadSession(ctx, { create = false } = {}) {
  ctx.session = null;
  ctx.user = null;
  ctx.csrf = null;
  const id = await verifiedSessionId(ctx.request, ctx.env);
  if (id) {
    const row = await db.first(ctx.env,
      `SELECT s.id, s.user_id, s.csrf, s.expires_at, u.username, u.role
         FROM sessions s LEFT JOIN users u ON u.id = s.user_id
        WHERE s.id = ? AND s.expires_at > datetime('now')`, id);
    if (row) {
      ctx.session = { id: row.id, user_id: row.user_id, csrf: row.csrf, expires_at: row.expires_at };
      ctx.csrf = row.csrf;
      // A deleted user leaves the row (FK cascade) or a null join: either way no user.
      if (row.user_id && row.username) ctx.user = { id: row.user_id, username: row.username, role: row.role };
      return ctx.session;
    }
  }
  return create ? createSession(ctx, null) : null;
}

// Login: drop the old (anonymous or previous) session and start a fresh one for userId.
export async function rotateSession(ctx, userId) {
  if (ctx.session) await db.run(ctx.env, "DELETE FROM sessions WHERE id = ?", ctx.session.id);
  await createSession(ctx, userId);
  ctx.user = await db.first(ctx.env, "SELECT id, username, role FROM users WHERE id = ?", userId);
  return ctx.session;
}

// Logout: delete the row and expire the cookie.
export async function destroySession(ctx) {
  if (ctx.session) await db.run(ctx.env, "DELETE FROM sessions WHERE id = ?", ctx.session.id);
  ctx.session = null;
  ctx.user = null;
  ctx.csrf = null;
  ctx.cookies.push(cookieHeader(ctx, "", 0));
}

export function currentUser(ctx) {
  return ctx.user || null;
}

// User or a 303 to /login (thrown; index.js returns thrown Responses as-is).
export function requireUser(ctx) {
  if (!ctx.user) throw redirect("/login");
  return ctx.user;
}

export function roleRank(role) {
  const i = ROLES.indexOf(role);
  return i < 0 ? 0 : i;
}

// User with at least minRole ('viewer' | 'editor' | 'admin') or 303 /login / 403 JSON.
export function requireRole(ctx, minRole) {
  const user = requireUser(ctx);
  if (roleRank(user.role) < roleRank(minRole)) fail(403, `requires ${minRole} role`);
  return user;
}

// ---------------------------------------------------------------------------
// CSRF (contract 8)
// ---------------------------------------------------------------------------

export function csrfToken(ctx) {
  return ctx.csrf;
}

// Token from the X-CSRF-Token header or the csrf_token form field must equal the session's.
// index.js calls this for every non-/api/ request that is not GET/HEAD/OPTIONS.
export async function requireCsrf(ctx) {
  let supplied = ctx.request.headers.get("x-csrf-token");
  if (supplied === null) {
    const ctype = (ctx.request.headers.get("content-type") || "").toLowerCase();
    if (ctype.startsWith("application/x-www-form-urlencoded") || ctype.startsWith("multipart/form-data")) {
      const form = await ctx.form();
      const v = form.get("csrf_token");
      supplied = typeof v === "string" ? v : null;
    }
  }
  if (!ctx.csrf || !supplied || !timingSafeEqual(supplied, ctx.csrf)) fail(403, CSRF_ERROR);
}

// ---------------------------------------------------------------------------
// Failed-login throttle (per ip+username, in D1)
// ---------------------------------------------------------------------------

const unix = () => Math.floor(Date.now() / 1000);

// Seconds remaining on the lock for this ip+username, 0 when not locked. `max` failures
// within `seconds` lock it (login: 5 / 30 s; enroll: 10 / 60 s).
export async function loginLockedFor(env, ip, username, max = LOGIN_MAX_FAILURES, seconds = LOGIN_LOCK_SECONDS) {
  const now = unix();
  const rows = await db.all(env,
    "SELECT at FROM login_failures WHERE ip = ? AND username = ? AND at > ? ORDER BY at",
    ip || "-", username, now - seconds);
  if (rows.length < max) return 0;
  const last = rows[rows.length - 1].at;
  return Math.max(1, seconds - (now - last) + 1);
}

export async function recordLoginFailure(env, ip, username) {
  const now = unix();
  await db.batch(env, [
    ["INSERT INTO login_failures (ip, username, at) VALUES (?, ?, ?)", ip || "-", username, now],
    // Keep the table bounded if someone sprays usernames.
    ["DELETE FROM login_failures WHERE at <= ?", now - MAX_LOCK_SECONDS],
  ]);
}

export function clearLoginFailures(env, ip, username) {
  return db.run(env, "DELETE FROM login_failures WHERE ip = ? AND username = ?", ip || "-", username);
}

// ---------------------------------------------------------------------------
// Devices and setup
// ---------------------------------------------------------------------------

// Device row for `Authorization: Bearer <token>` or 401 JSON (auth.authenticate_device).
export async function deviceFromHeader(ctx) {
  const authorization = ctx.request.headers.get("authorization") || "";
  if (!authorization.toLowerCase().startsWith("bearer ")) fail(401, "Missing bearer token");
  const token = authorization.slice(7).trim();
  const row = token && await db.first(ctx.env,
    `SELECT id, device_id, name, playlist_id, group_id,
            projector_control, projector_power_mode, projector_ir_codes, broadlink_host,
            tunnel_id, tunnel_hostname
       FROM devices WHERE token = ?`, token);
  if (!row) fail(401, "Invalid device token");
  return row;
}

// ---------------------------------------------------------------------------
// Operator API tokens (api_tokens table; Settings page "My API tokens")
// ---------------------------------------------------------------------------

export const API_TOKEN_PREFIX = "p5k_";
export const API_TOKEN_USED_AUDIT_HOURS = 1;

// Mint a token: `p5k_` + 32 urlsafe chars (24 random bytes). Only its SHA-256 hex is stored.
export function newApiToken() {
  return API_TOKEN_PREFIX + randomToken(24);
}

export const apiTokenHash = (token) => sha256Hex(token);

// Mint a token for `userId`, store only its hash and audit api_token_created (the name plus
// `details`, never the token). Returns {id, token}; the caller shows the plaintext once.
// Shared by the Settings and Users pages and the device-code sign-in (device_codes.js).
export async function issueApiToken(ctx, userId, name, details = {}) {
  const token = newApiToken();
  const id = (await db.run(ctx.env, "INSERT INTO api_tokens (user_id, name, token_hash) VALUES (?, ?, ?)",
    userId, name, await apiTokenHash(token))).last_row_id;
  await audit.log(ctx, "api_token_created", "api_token", id, { name, ...details });
  return { id, token };
}

// {token_id, token_name, id, username, role} for `Authorization: Bearer p5k_...` or 401 JSON.
// The lookup is by hash (constant-time compare on the stored hash); the role check is the
// caller's (operator endpoints want editor+, a demoted viewer's token stops working).
export async function operatorFromHeader(ctx) {
  const authorization = ctx.request.headers.get("authorization") || "";
  if (!authorization.toLowerCase().startsWith("bearer ")) fail(401, "Missing bearer token");
  const token = authorization.slice(7).trim();
  const hash = token.startsWith(API_TOKEN_PREFIX) && await apiTokenHash(token);
  const row = hash && await db.first(ctx.env,
    `SELECT t.id AS token_id, t.name AS token_name, t.token_hash, u.id, u.username, u.role
       FROM api_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = ?`, hash);
  if (!row || !timingSafeEqual(row.token_hash, hash)) fail(401, "Invalid API token");
  delete row.token_hash;
  return row;
}

// Stamp last_used_at at most once per hour; true when this call did (the caller audits then).
export async function touchApiToken(env, tokenId) {
  const r = await db.run(env,
    `UPDATE api_tokens SET last_used_at = datetime('now')
      WHERE id = ? AND (last_used_at IS NULL OR last_used_at <= datetime('now', ?))`,
    tokenId, `-${API_TOKEN_USED_AUDIT_HOURS} hours`);
  return r.changes > 0;
}

// 403 unless `supplied` equals the SETUP_TOKEN secret.
export function requireSetupToken(ctx, supplied) {
  const expected = ctx.env.SETUP_TOKEN;
  if (!expected || typeof supplied !== "string" || !timingSafeEqual(supplied, expected)) fail(403, "invalid setup token");
}

// Whether any user exists. Cached once true: the answer only changes on /setup.
let anyUsers = false;
export async function hasUsers(env) {
  if (anyUsers) return true;
  const row = await db.first(env, "SELECT 1 AS one FROM users LIMIT 1");
  anyUsers = !!row;
  return anyUsers;
}

// Daily housekeeping: expired sessions and stale throttle rows.
export async function housekeeping(env) {
  await db.batch(env, [
    ["DELETE FROM sessions WHERE expires_at <= datetime('now')"],
    ["DELETE FROM login_failures WHERE at <= ?", unix() - MAX_LOCK_SECONDS],
  ]);
}
