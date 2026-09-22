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
// Re-serialised through the URL parser: a tab or newline ("/\t/evil.example") would otherwise
// resolve off-origin in the browser, and a raw newline is not a valid Location header at all.
function nextPath(ctx, v) {
  if (typeof v !== "string" || !/^\/(?![\/\\])/.test(v)) return "";
  try {
    const u = new URL(v, ctx.url.origin);
    return u.origin === ctx.url.origin ? u.pathname + u.search : "";
  } catch { return ""; }
}

// `expired` is the "session expired" notice from ?expired=1: a neutral warning, not the
// ACCESS DENIED line a wrong password gets.
function loginPage(ctx, error, status = 200, locked = false, next = "", expired = false) {
  const alert = !error ? "" : locked
    ? `<div class="alert warn" role="alert">TERMINAL LOCKED: ${esc(error)} · <a href="/login">retry</a></div>`
    : expired ? `<div class="alert warn" role="alert">${esc(error)}</div>`
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
    <span class="auth-foot">p5k-console · sign in to manage your projector fleet · <a href="/signup">create an account</a></span>
  </div>`;
  return authPage(ctx, { title: "Sign in", card, status });
}

// The public home page (public/download.html, served by Workers Assets under /download): the
// Sign in / Create an account buttons; the SD flasher downloads sit behind sign-in on /flasher.
// It carries its own <style> block, so it gets a CSP that allows inline styles (scripts still not).
async function homePage(ctx) {
  const asset = await ctx.env.ASSETS.fetch(new Request(new URL("/download", ctx.url), { method: ctx.request.method === "HEAD" ? "HEAD" : "GET" }));
  const page = new Response(asset.body, asset);
  page.headers.set("content-security-policy", "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'");
  return page;
}

async function loginSubmit(ctx) {
  const form = await ctx.form();
  const username = str(form, "username").trim();
  const password = str(form, "password");
  const next = nextPath(ctx, str(form, "next"));
  // Before the throttle and any PBKDF2: the audit and login_failures rows stay bounded.
  if (username.length > auth.MAX_USERNAME_CHARS) return loginPage(ctx, "Username must be at most 64 characters", 400, false, next);
  // The throttle's synthetic keys are not accounts: answer as a wrong password without writing a
  // row under that name (it would count against enrollment or sign-up for everyone).
  if (auth.RESERVED_USERNAMES.has(username.toLowerCase())) return loginPage(ctx, "Invalid username or password", 200, false, next);
  const ip = audit.clientIp(ctx);
  const wait = await auth.loginLockedFor(ctx.env, ip, username);
  if (wait) return loginPage(ctx, `Too many failed attempts; try again in ${wait} s`, 429, true, next);
  if (utf8Len(password) > auth.MAX_PASSWORD_BYTES) return loginPage(ctx, auth.PASSWORD_TOO_LONG_MSG, 400, false, next);
  const row = await db.first(ctx.env,
    "SELECT id, username, password_hash, role FROM users WHERE username = ?", username);
  if (!row) await auth.burnPasswordCheck(password);
  if (!row || !(await auth.verifyPassword(password, row.password_hash))) {
    // Only a real account's name reaches the log and the audit row (viewers can read /audit):
    // whatever was typed into the box, often a password, is never stored. Collapse anything
    // outside printable ASCII so a username cannot plant a fake "ip=" token; the real ip= stays last.
    const who = row ? row.username : "(no such user)";
    console.warn(`login failed for user=${who.replace(/[^!-~]+/g, "_").slice(0, 64)} ip=${ip}`);
    await audit.log(ctx, "login_failed", "user", row ? row.id : null, { username: who }, null);
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
  router.get("/", (ctx) => (ctx.user ? redirect("/dashboard") : homePage(ctx)));
  // The old address of the SD flasher downloads (docs and old flashers still print it): signed
  // in it is the flasher page now, otherwise the home page with its Sign in button.
  router.get("/download", (ctx) => (ctx.user ? redirect("/flasher") : redirect("/", 301)));
  router.get("/login", (ctx) => loginPage(ctx, ctx.url.searchParams.get("expired") ? "Your session expired; please sign in again" : null,
    200, false, nextPath(ctx, ctx.url.searchParams.get("next")), Boolean(ctx.url.searchParams.get("expired"))));
  router.post("/login", loginSubmit);
  router.post("/logout", logout);
}
