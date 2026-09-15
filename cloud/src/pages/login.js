// /login, /logout and / (port of web.login_form / login_submit / logout and main.root).
import * as audit from "../audit.js";
import * as auth from "../auth.js";
import * as db from "../db.js";
import { esc, redirect, str, utf8Len } from "../util.js";
import { csrfInput, layout, SCENE, wordmark } from "./layout.js";

function loginPage(ctx, error, status = 200) {
  const content = `${SCENE}
<div class="auth-card">
  ${wordmark(true)}
  <hr>
  ${error ? `<div class="alert error">${esc(error)}</div>` : ""}
  <form method="post" action="/login">
    ${csrfInput(ctx)}
    <label>Username
      <input type="text" name="username" autocomplete="username" autofocus required>
    </label>
    <label>Password
      <input type="password" name="password" autocomplete="current-password" required>
    </label>
    <button type="submit" class="primary">Connect</button>
  </form>
  <p class="foot">Sign in to manage your projector fleet.</p>
</div>`;
  return layout(ctx, { title: "Sign in", content, status, bodyClass: "login" });
}

async function loginSubmit(ctx) {
  const form = await ctx.form();
  const username = str(form, "username").trim();
  const password = str(form, "password");
  const ip = audit.clientIp(ctx);
  const wait = await auth.loginLockedFor(ctx.env, ip, username);
  if (wait) return loginPage(ctx, `Too many failed attempts; try again in ${wait} s`, 429);
  if (utf8Len(password) > auth.MAX_PASSWORD_BYTES) return loginPage(ctx, auth.PASSWORD_TOO_LONG_MSG, 400);
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
    return loginPage(ctx, "Invalid username or password");
  }
  await auth.clearLoginFailures(ctx.env, ip, username);
  await auth.rotateSession(ctx, row.id);
  await audit.log(ctx, "login", null, null, null, { id: row.id, username: row.username });
  return redirect("/dashboard");
}

async function logout(ctx) {
  await audit.log(ctx, "logout");
  await auth.destroySession(ctx);
  return redirect("/login");
}

export function register(router) {
  router.get("/", (ctx) => redirect(ctx.user ? "/dashboard" : "/login"));
  router.get("/login", (ctx) => loginPage(ctx, ctx.url.searchParams.get("expired") ? "Your session expired; please sign in again" : null));
  router.post("/login", loginSubmit);
  router.post("/logout", logout);
}
