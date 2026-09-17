// /login, /logout and / (port of web.login_form / login_submit / logout and main.root).
import * as audit from "../audit.js";
import * as auth from "../auth.js";
import * as db from "../db.js";
import { esc, redirect, str, utf8Len } from "../util.js";
import { APP_EYEBROW, csrfInput, layout, wordmark } from "./layout.js";

// The auth-stage decoration + centered card shared by /login and /setup (port of login.html).
export function authPage(ctx, { title, card, status = 200 }) {
  const content = `<div class="auth-stage" aria-hidden="true">
  <div class="drift"></div>
  <div class="floor"></div>
  <div class="skyline"><span></span><span></span><span></span></div>
  <div class="fog"></div>
</div>
<div class="auth-wrap">
  ${card}
</div>`;
  return layout(ctx, { title, content, status, bodyClass: "login-body" });
}

export function authBrand() {
  return `<div class="brand">
      <span class="brand-eyebrow">${esc(APP_EYEBROW)}</span>
      ${wordmark(true, "h1")}
    </div>
    <hr class="rule">`;
}

// Where to land after login (?next= on GET, the hidden next field on POST): a same-origin path
// only, so the flasher's /authorize?code=... link survives the sign-in; anything else is dropped.
function nextPath(v) {
  return typeof v === "string" && /^\/(?![\/\\])/.test(v) ? v : "";
}

function loginPage(ctx, error, status = 200, locked = false, next = "") {
  const alert = !error ? "" : locked
    ? `<div class="alert warn" role="alert">TERMINAL LOCKED: ${esc(error)} · <a href="/login">retry</a></div>`
    : `<div class="alert error" role="alert">ACCESS DENIED: ${esc(error)}</div>`;
  const dis = locked ? " disabled" : "";
  const card = `<div class="auth-card${locked ? " is-locked" : ""}">
    ${authBrand()}
    ${alert}
    <form method="post" action="/login">
      ${csrfInput(ctx)}
      ${next ? `<input type="hidden" name="next" value="${esc(next)}">` : ""}
      <label>Username
        <input type="text" name="username" autocomplete="username" autofocus required${dis}>
      </label>
      <label>Password
        <input type="password" name="password" autocomplete="current-password" required${dis}>
      </label>
      <button type="submit" class="primary"${dis}>${locked ? "Locked" : "Connect"}</button>
    </form>
    <span class="auth-foot">p5k-console · sign in to manage your projector fleet</span>
  </div>`;
  return authPage(ctx, { title: "Sign in", card, status });
}

async function loginSubmit(ctx) {
  const form = await ctx.form();
  const username = str(form, "username").trim();
  const password = str(form, "password");
  const next = nextPath(str(form, "next"));
  const ip = audit.clientIp(ctx);
  const wait = await auth.loginLockedFor(ctx.env, ip, username);
  if (wait) return loginPage(ctx, `Too many failed attempts; try again in ${wait} s`, 429, true, next);
  if (utf8Len(password) > auth.MAX_PASSWORD_BYTES) return loginPage(ctx, auth.PASSWORD_TOO_LONG_MSG, 400, false, next);
  const row = await db.first(ctx.env,
    "SELECT id, username, password_hash, role FROM users WHERE username = ?", username);
  if (!row) await auth.burnPasswordCheck(password);
  if (!row || !(await auth.verifyPassword(password, row.password_hash))) {
    // Collapse anything outside printable ASCII (whitespace, control chars, newlines) so an
    // attacker-chosen username cannot plant a fake "ip=" token; the real ip= stays last.
    const safeUser = username.replace(/[^!-~]+/g, "_").slice(0, 64);
    console.warn(`login failed for user=${safeUser} ip=${ip}`);
    await audit.log(ctx, "login_failed", "user", null, { username }, null);
    await auth.recordLoginFailure(ctx.env, ip, username);
    return loginPage(ctx, "Invalid username or password", 200, false, next);
  }
  await auth.clearLoginFailures(ctx.env, ip, username);
  await auth.rotateSession(ctx, row.id);
  await audit.log(ctx, "login", null, null, null, { id: row.id, username: row.username });
  return redirect(next || "/dashboard");
}

async function logout(ctx) {
  await audit.log(ctx, "logout");
  await auth.destroySession(ctx);
  return redirect("/login");
}

export function register(router) {
  router.get("/", (ctx) => redirect(ctx.user ? "/dashboard" : "/login"));
  router.get("/login", (ctx) => loginPage(ctx, ctx.url.searchParams.get("expired") ? "Your session expired; please sign in again" : null,
    200, false, nextPath(ctx.url.searchParams.get("next"))));
  router.post("/login", loginSubmit);
  router.post("/logout", logout);
}
