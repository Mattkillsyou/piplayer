// /forgot and /reset: self-service password reset by email. /forgot takes a username or email
// address and always answers the same card (no account enumeration); when the account has an
// address on file a link with a one-off token goes out through the EMAIL send_email binding
// (wrangler.toml; on Workers Free only to addresses verified in the Cloudflare dashboard).
// Only the sha256 of the token is stored (password_resets, migration 0011); the link works
// once and for RESET_MINUTES. /reset checks the token again on POST, changes the password,
// ends every session of that user and sends them to /login. Throttled per address under
// auth.FORGOT_KEY like /signup, and RESETS_PER_HOUR per account so one address cannot be
// flooded with mail.
import * as audit from "../audit.js";
import * as auth from "../auth.js";
import * as db from "../db.js";
import { esc, randomToken, redirect, sha256Hex, str } from "../util.js";
import { installBaseUrl } from "./devices.js";
import { csrfInput } from "./layout.js";
import { authBrand, authPage } from "./login.js";

export const FORGOTS_PER_IP = 5;
export const FORGOT_WINDOW_SECONDS = auth.LOGIN_USER_WINDOW_SECONDS;
export const RESETS_PER_HOUR = 3;
export const RESET_MINUTES = 30;
export const MAIL_FROM = "no-reply@photogen5000.com";
export const MAIL_SUBJECT = "Reset your Projection5000 password";
export const SENT_MSG = `If that account has an email address on file, a reset link is on its way. It works for ${RESET_MINUTES} minutes.`;
export const EXPIRED_MSG = "This link has expired or was already used.";
// Tests reach the worker through SELF.fetch and cannot put a binding into env, so a send()
// set here (same {from, to, subject, text} argument) is used instead of env.EMAIL; `last` is
// the background work of the latest POST /forgot (see forgotSubmit), for tests to await.
export const mail = { send: null, last: Promise.resolve() };

function forgotPage(ctx, message, kind = "error", who = "", status = 200) {
  const card = `<div class="auth-card">
    ${authBrand()}
    <h2>Forgot your password?</h2>
    ${message ? `<div class="alert ${kind}" role="alert">${esc(message)}</div>` : ""}
    <form method="post" action="/forgot">
      ${csrfInput(ctx)}
      <label>Username or email
        <input type="text" name="who" value="${esc(who)}" autocomplete="username" maxlength="${auth.MAX_EMAIL_CHARS}" autofocus required>
      </label>
      <button type="submit" class="primary">Send reset link</button>
    </form>
    <span class="auth-foot">p5k-console · <a href="/login">back to sign in</a></span>
  </div>`;
  return authPage(ctx, { title: "Forgot password", card, status });
}

async function sendResetMail(ctx, user) {
  const token = randomToken(32);
  const recent = await db.first(ctx.env,
    "SELECT COUNT(*) AS n FROM password_resets WHERE user_id = ? AND created_at > datetime('now', '-1 hour')", user.id);
  if (recent.n >= RESETS_PER_HOUR) return;
  // Earlier links keep working until one is used (resetSubmit retires them all): anyone can
  // name an account here, and that must not kill the link its owner is about to open.
  await db.run(ctx.env,
    "INSERT INTO password_resets (user_id, token_hash, expires_at, ip) VALUES (?, ?, datetime('now', ?), ?)",
    user.id, await sha256Hex(token), `+${RESET_MINUTES} minutes`, ctx.ip);
  const link = `${installBaseUrl(ctx.env, ctx.url).base}/reset?token=${token}`;
  const msg = {
    from: ctx.env.MAIL_FROM || MAIL_FROM,
    to: user.email,
    subject: MAIL_SUBJECT,
    text: `${link}\nThe link works for ${RESET_MINUTES} minutes.\nIf you did not ask for this, ignore this message.\n`,
  };
  try {
    const binding = ctx.env.EMAIL && typeof ctx.env.EMAIL.send === "function" ? ctx.env.EMAIL : null;
    if (!mail.send && !binding) throw new Error("EMAIL send_email binding is not configured");
    await (mail.send ? mail.send(msg) : binding.send(msg));
  } catch (e) {
    console.error(`password reset mail failed for user id=${user.id}: ${e && e.message || e}`);
    await audit.log(ctx, "password_reset_mail_failed", "user", user.id, null, user);
    return;
  }
  await audit.log(ctx, "password_reset_requested", "user", user.id, null, user);
}

async function forgotSubmit(ctx) {
  if (ctx.user) return redirect("/dashboard");
  const who = str(await ctx.form(), "who").trim();
  const wait = await auth.loginLockedFor(ctx.env, ctx.ip, auth.FORGOT_KEY, FORGOTS_PER_IP, FORGOT_WINDOW_SECONDS);
  if (wait) {
    const minutes = Math.ceil(wait / 60);
    return forgotPage(ctx, `Too many requests from this address; try again in ${minutes} minute${minutes === 1 ? "" : "s"}`, "error", who, 429);
  }
  await auth.recordLoginFailure(ctx.env, ctx.ip, auth.FORGOT_KEY);
  const user = who && await db.first(ctx.env,
    "SELECT id, username, email FROM users WHERE username = ? OR lower(email) = lower(?)", who, who);
  // The card goes out before the rows are written and the mail is sent, so the reply takes
  // the same time whether or not the account exists (the mail send is a network round trip).
  mail.last = user && user.email ? sendResetMail(ctx, user) : Promise.resolve();
  ctx.exec.waitUntil(mail.last);
  return forgotPage(ctx, SENT_MSG, "ok");
}

// The live row for a mailed token (unused, unexpired), else null.
async function resetRow(env, token) {
  if (typeof token !== "string" || !token) return null;
  return db.first(env,
    "SELECT id, user_id FROM password_resets WHERE token_hash = ? AND used_at IS NULL AND expires_at > datetime('now')", await sha256Hex(token));
}

function resetPage(ctx, token, message = "", status = 200) {
  const form = token ? `<form method="post" action="/reset">
      ${csrfInput(ctx)}
      <input type="hidden" name="token" value="${esc(token)}">
      <label>Password (at least ${auth.MIN_PASSWORD_CHARS} characters)
        <input type="password" name="password" autocomplete="new-password" autofocus required minlength="${auth.MIN_PASSWORD_CHARS}">
      </label>
      <label>Password (again)
        <input type="password" name="password2" autocomplete="new-password" required minlength="${auth.MIN_PASSWORD_CHARS}">
      </label>
      <button type="submit" class="primary">Change password</button>
    </form>` : `<p><a href="/forgot">request a new one</a></p>`;
  const card = `<div class="auth-card">
    ${authBrand()}
    <h2>Choose a new password</h2>
    ${message ? `<div class="alert error" role="alert">${esc(message)}</div>` : ""}
    ${form}
    <span class="auth-foot">p5k-console · <a href="/login">back to sign in</a></span>
  </div>`;
  return authPage(ctx, { title: "Choose a new password", card, status });
}

async function resetForm(ctx) {
  if (ctx.user) return redirect("/dashboard");
  const token = ctx.url.searchParams.get("token");
  if (!token && ctx.url.searchParams.get("expired")) {
    return resetPage(ctx, "", "That form had expired; open the link from the email again", 400);
  }
  if (!(await resetRow(ctx.env, token))) return resetPage(ctx, "", EXPIRED_MSG, 400);
  return resetPage(ctx, token);
}

async function resetSubmit(ctx) {
  if (ctx.user) return redirect("/dashboard");
  const form = await ctx.form();
  const token = str(form, "token");
  const row = await resetRow(ctx.env, token);
  if (!row) return resetPage(ctx, "", EXPIRED_MSG, 400);
  const password = str(form, "password");
  const problem = auth.passwordProblem(password);
  if (problem) return resetPage(ctx, token, problem, 400);
  if (password !== str(form, "password2")) return resetPage(ctx, token, "The two passwords do not match", 400);
  const hash = await auth.hashPassword(password);
  const user = await db.first(ctx.env, "SELECT id, username FROM users WHERE id = ?", row.user_id);
  // Nobody is signed in here, so every session of the account ends with the change (the
  // admin's /users/:id/password does the same for other sessions).
  await db.batch(ctx.env, [
    ["UPDATE users SET password_hash = ? WHERE id = ?", hash, row.user_id],
    ["UPDATE password_resets SET used_at = datetime('now') WHERE user_id = ? AND used_at IS NULL", row.user_id],
    ["DELETE FROM sessions WHERE user_id = ?", row.user_id],
  ]);
  await audit.log(ctx, "password_reset", "user", row.user_id, null, user);
  return auth.flashRedirect(ctx, "/login", "Password changed. Sign in with the new one.");
}

export function register(router) {
  router.get("/forgot", (ctx) => (ctx.user ? redirect("/dashboard")
    : forgotPage(ctx, ctx.url.searchParams.get("expired") ? "That form had expired; please fill it in again" : "", "warn")));
  router.post("/forgot", forgotSubmit);
  router.get("/reset", resetForm);
  router.post("/reset", resetSubmit);
}
