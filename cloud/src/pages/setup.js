// /setup: one-time first-admin creation. While `users` is empty every other page redirects
// here (index.js); the form is only shown with ?token=<SETUP_TOKEN>. Once a user exists -> 404.
import * as audit from "../audit.js";
import * as auth from "../auth.js";
import * as db from "../db.js";
import { esc, fail, redirect, str } from "../util.js";
import { APP_NAME, csrfInput, layout } from "./layout.js";

function setupPage(ctx, token, error, status = 200) {
  const content = `<div class="auth-card">
  <h1>${APP_NAME}</h1>
  <p class="muted">Create the first administrator account.</p>
  ${error ? `<div class="alert error">${esc(error)}</div>` : ""}
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
</div>`;
  return layout(ctx, { title: "Setup", content, status });
}

async function gate(ctx, token) {
  if (await auth.hasUsers(ctx.env)) fail(404, "Not Found");
  auth.requireSetupToken(ctx, token);
}

async function setupForm(ctx) {
  const token = ctx.url.searchParams.get("token");
  await gate(ctx, token);
  return setupPage(ctx, token, null);
}

async function setupSubmit(ctx) {
  const form = await ctx.form();
  const token = str(form, "token");
  await gate(ctx, token);
  const username = str(form, "username").trim();
  const password = str(form, "password");
  const password2 = str(form, "password2");
  if (!username) return setupPage(ctx, token, "username required", 400);
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
