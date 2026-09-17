// Port of web.users_* + users.html (admin only), plus each admin/editor's operator API tokens
// (api_tokens; feature B): an admin issues or revokes a token for any user here, the Settings
// page holds the admin's own. A viewer's token would only ever get 401 on the operator
// endpoint, so viewers get no create form (and the route answers 400).
import * as audit from "../audit.js";
import * as auth from "../auth.js";
import * as db from "../db.js";
import { esc, fail, idParam, localTime, redirect, str } from "../util.js";
import { alertBox, csrfInput, layout } from "./layout.js";
import { newTokenBlock, tokenCreateForm, tokenName, tokenTable, userTokens } from "./settings.js";

const ROLE_OK = (role) => auth.ROLES.includes(role);

// Second row under a user: their tokens and (admin/editor only) the create form; `newToken`
// is the plaintext of a token created by this very request, shown once under its user.
async function tokensRow(ctx, u, tz, newToken) {
  const tokens = await userTokens(ctx.env, u.id);
  const canHold = u.role !== "viewer";
  if (!tokens.length && !canHold) return "";
  return `<tr class="user-tokens">
      <td colspan="6">
        <details${newToken ? " open" : ""}>
          <summary class="small">API tokens (${tokens.length})</summary>
          ${newToken ? newTokenBlock(newToken) : ""}
          ${canHold ? tokenCreateForm(ctx, `/users/${u.id}/tokens`, `Token name for ${u.username}`) : '<p class="muted small">Viewers cannot use operator tokens; change the role first.</p>'}
          ${tokenTable(ctx, tokens, tz, (t) => `/users/${u.id}/tokens/${t.id}/revoke`)}
        </details>
      </td>
    </tr>`;
}

async function usersPage(ctx, created = null) {
  const me = auth.requireRole(ctx, "admin");
  const tz = (await ctx.settings()).timezone;
  const users = await db.all(ctx.env, "SELECT id, username, role, created_at FROM users ORDER BY username");
  const revoked = ctx.url.searchParams.get("revoked") === "1";
  const row = (u) => `<tr>
      <td class="name">${esc(u.username)}${u.id === me.id ? ' <span class="muted small">(you)</span>' : ""}</td>
      <td><span class="badge badge-${esc(u.role)}">${esc(u.role)}</span></td>
      <td class="muted nowrap">${esc(localTime(u.created_at, tz))}</td>
      <td>
        <form method="post" action="/users/${u.id}/role" class="inline">
          ${csrfInput(ctx)}
          <select name="role" data-autosubmit aria-label="Role for ${esc(u.username)}"${u.id === me.id ? " disabled" : ""}>
            ${["admin", "editor", "viewer"].map((r) => `<option value="${r}"${u.role === r ? " selected" : ""}>${r}</option>`).join("\n            ")}
          </select>
        </form>
      </td>
      <td>
        <form method="post" action="/users/${u.id}/password" class="inline duration-form">
          ${csrfInput(ctx)}
          <input type="password" name="password" placeholder="new password" minlength="6" autocomplete="new-password" aria-label="New password for ${esc(u.username)}">
          <button type="submit" class="small">Set</button>
        </form>
      </td>
      <td>
        ${u.id !== me.id ? `<form method="post" action="/users/${u.id}/delete" class="inline" data-confirm="Delete ${esc(u.username)}?">
          ${csrfInput(ctx)}
          <button type="submit" class="danger small">Delete</button>
        </form>` : ""}
      </td>
    </tr>`;
  const rows = [];
  for (const u of users) rows.push(row(u), await tokensRow(ctx, u, tz, created?.userId === u.id ? created.token : ""));
  const content = `<div class="page-head">
  <h1>Users</h1>
  <span class="page-meta">${users.length} account${users.length === 1 ? "" : "s"}</span>
</div>
${revoked ? alertBox("API token revoked.", "ok") : ""}

<div class="panel">
  <h2>New user</h2>
  <form method="post" action="/users">
    ${csrfInput(ctx)}
    <div class="form-grid">
      <label>Username
        <input type="text" name="username" required autocomplete="off">
      </label>
      <label>Password (at least 6 characters)
        <input type="password" name="password" required minlength="6" autocomplete="new-password">
      </label>
      <label>Role
        <select name="role">
          <option value="editor">editor (can upload, edit playlists, manage devices)</option>
          <option value="admin">admin (everything + user management)</option>
          <option value="viewer">viewer (read-only)</option>
        </select>
      </label>
    </div>
    <div class="row">
      <button type="submit" class="primary">Create user</button>
    </div>
  </form>
</div>

<div class="table-wrap">
<table class="data">
  <thead><tr><th>Username</th><th>Role</th><th>Created</th><th>Change role</th><th>Reset password</th><th></th></tr></thead>
  <tbody>
    ${rows.filter(Boolean).join("\n    ")}
  </tbody>
</table>
</div>
<p class="help small">Operator API tokens let the flasher fetch the enrollment key (<code>GET /api/operator/enrollment</code>); a token acts with its user's role, so only admins and editors can hold one. The plain token is shown once, at creation.</p>`;
  return layout(ctx, { title: "Users", content });
}

async function usersCreate(ctx) {
  auth.requireRole(ctx, "admin");
  const form = await ctx.form();
  const username = str(form, "username").trim();
  const password = str(form, "password");
  const role = str(form, "role", "editor") || "editor";
  if (!username || password.length < 6) fail(400, "username required and password must be at least 6 chars");
  if (!ROLE_OK(role)) fail(400, "role must be admin, editor, or viewer");
  const problem = auth.passwordProblem(password);
  if (problem) fail(400, problem);
  const hash = await auth.hashPassword(password);
  let id;
  try {
    id = (await db.run(ctx.env, "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)", username, hash, role)).last_row_id;
  } catch (e) {
    if (db.isConstraintError(e)) fail(409, "A user with that username already exists");
    throw e;
  }
  await audit.log(ctx, "user_create", "user", id, { username, role });
  return redirect("/users");
}

async function usersSetRole(ctx) {
  const me = auth.requireRole(ctx, "admin");
  const userId = idParam(ctx.params.user_id, "user_id");
  const role = str(await ctx.form(), "role");
  if (!ROLE_OK(role)) fail(400, "invalid role");
  if (userId === me.id && role !== "admin") fail(400, "cannot demote yourself");
  const r = await db.run(ctx.env, "UPDATE users SET role = ? WHERE id = ?", role, userId);
  if (!r.changes) fail(404, "User not found");
  await audit.log(ctx, "user_set_role", "user", userId, { role });
  return redirect("/users");
}

async function usersSetPassword(ctx) {
  auth.requireRole(ctx, "admin");
  const userId = idParam(ctx.params.user_id, "user_id");
  const password = str(await ctx.form(), "password");
  const problem = auth.passwordProblem(password);
  if (problem) fail(400, problem);
  const hash = await auth.hashPassword(password);
  const r = await db.run(ctx.env, "UPDATE users SET password_hash = ? WHERE id = ?", hash, userId);
  if (!r.changes) fail(404, "User not found");
  await audit.log(ctx, "user_set_password", "user", userId);
  return redirect("/users");
}

async function usersDelete(ctx) {
  const me = auth.requireRole(ctx, "admin");
  const userId = idParam(ctx.params.user_id, "user_id");
  if (userId === me.id) fail(400, "cannot delete yourself");
  const n = (await db.first(ctx.env, "SELECT COUNT(*) AS n FROM users WHERE role = 'admin'")).n;
  const target = await db.first(ctx.env, "SELECT role FROM users WHERE id = ?", userId);
  if (!target) fail(404, "User not found");
  if (target.role === "admin" && n <= 1) fail(400, "cannot delete the last admin");
  await db.run(ctx.env, "DELETE FROM users WHERE id = ?", userId);
  await audit.log(ctx, "user_delete", "user", userId);
  return redirect("/users");
}

// Issue a token for another admin or editor; the page re-renders once with the plaintext
// under that user (no redirect: the secret must not travel in a URL). Only the hash is stored.
async function userTokenCreate(ctx) {
  auth.requireRole(ctx, "admin");
  const userId = idParam(ctx.params.user_id, "user_id");
  const name = tokenName(await ctx.form());
  const user = await db.first(ctx.env, "SELECT id, username, role FROM users WHERE id = ?", userId);
  if (!user) fail(404, "User not found");
  if (user.role === "viewer") fail(400, "viewers cannot hold API tokens; change the role first");
  const { token } = await auth.issueApiToken(ctx, userId, name, { username: user.username });
  return usersPage(ctx, { userId, token });
}

async function userTokenRevoke(ctx) {
  auth.requireRole(ctx, "admin");
  const userId = idParam(ctx.params.user_id, "user_id");
  const tokenId = idParam(ctx.params.token_id, "token_id");
  const row = await db.first(ctx.env,
    "SELECT t.id, t.name, u.username FROM api_tokens t JOIN users u ON u.id = t.user_id WHERE t.id = ? AND t.user_id = ?", tokenId, userId);
  if (!row) fail(404, "token not found");
  await db.run(ctx.env, "DELETE FROM api_tokens WHERE id = ?", tokenId);
  await audit.log(ctx, "api_token_revoked", "api_token", tokenId, { name: row.name, username: row.username });
  return redirect("/users?revoked=1");
}

export function register(router) {
  router.post("/users/:user_id/tokens", userTokenCreate);
  router.post("/users/:user_id/tokens/:token_id/revoke", userTokenRevoke);
  router.get("/users", usersPage);
  router.post("/users", usersCreate);
  router.post("/users/:user_id/role", usersSetRole);
  router.post("/users/:user_id/password", usersSetPassword);
  router.post("/users/:user_id/delete", usersDelete);
}
