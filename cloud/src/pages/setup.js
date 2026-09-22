// /setup: one-time first-admin creation. While `users` is empty every other page redirects
// here (index.js); the form is only shown with ?token=<SETUP_TOKEN>. Once a user exists -> 404.
import * as audit from "../audit.js";
import * as auth from "../auth.js";
import * as db from "../db.js";
import { esc, fail, HttpError, redirect, str } from "../util.js";
import { csrfInput } from "./layout.js";
import { authBrand, authPage } from "./login.js";

function setupPage(ctx, token, error, status = 200) {
  const card = `<div class="auth-card">
    ${authBrand()}
    ${error ? `<div class="alert error" role="alert">${esc(error)}</div>` : ""}
    <form method="post" action="/setup">
      ${csrfInput(ctx)}
      <input type="hidden" name="token" value="${esc(token)}">
      <label>Username
        <input type="text" name="username" autocomplete="username" autofocus required>
      </label>
      <label>Password
        <input type="password" name="password" autocomplete="new-password" required minlength="6">
      </label>
      <label>Password (again)
        <input type="password" name="password2" autocomplete="new-password" required minlength="6">
      </label>
      <button type="submit" class="primary">Create admin</button>
    </form>
    <span class="auth-foot">p5k-console · create the first administrator account</span>
  </div>`;
  return authPage(ctx, { title: "Setup", card, status });
}

async function gate(ctx, token) {
  if (await auth.hasUsers(ctx.env)) fail(404, "Not Found");
  auth.requireSetupToken(ctx, token);
}

async function setupForm(ctx) {
  const token = ctx.url.searchParams.get("token");
  try {
    await gate(ctx, token);
  } catch (e) {
    // Wrong or missing token on the page itself (first visit before setup lands here): a
    // friendly card, not a JSON blob. The POST keeps the plain 403.
    if (!(e instanceof HttpError) || e.status !== 403) throw e;
    const card = `<div class="auth-card">
    ${authBrand()}
    <div class="alert error" role="alert">This console has not been set up yet. Open the setup link from your deployment notes.</div>
  </div>`;
    return authPage(ctx, { title: "Setup", card, status: 403 });
  }
  return setupPage(ctx, token, null);
}

async function setupSubmit(ctx) {
  const form = await ctx.form();
  const token = str(form, "token");
  await gate(ctx, token);
  const username = str(form, "username").trim();
  const password = str(form, "password");
  const password2 = str(form, "password2");
  if (!username) return setupPage(ctx, token, "Enter a username", 400);
  const nameProblem = auth.usernameProblem(username);
  if (nameProblem) return setupPage(ctx, token, nameProblem, 400);
  const problem = auth.passwordProblem(password);
  if (problem) return setupPage(ctx, token, problem, 400);
  if (password !== password2) return setupPage(ctx, token, "passwords do not match", 400);
  const hash = await auth.hashPassword(password);
  let id;
  try {
    id = (await db.run(ctx.env,
      "INSERT INTO users (username, password_hash, role) VALUES (?, ?, 'admin')", username, hash)).last_row_id;
  } catch (e) {
    // Two setup submissions racing: the second one loses and the page is gone.
    if (db.isConstraintError(e)) fail(404, "Not Found");
    throw e;
  }
  await auth.rotateSession(ctx, id);
  await audit.log(ctx, "user_create", "user", id, { username, role: "admin", setup: true });
  return redirect("/dashboard");
}

export function register(router) {
  router.get("/setup", setupForm);
  router.post("/setup", setupSubmit);
}
