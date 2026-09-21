// Port of web.users_* + users.html (admin only), plus each admin/editor's operator API tokens
// (api_tokens; feature B): an admin issues or revokes a token for any user here, the Settings
// page holds the admin's own. A viewer's token would only ever get 401 on the operator
// endpoint, so viewers get no create form (and the route answers 400).
import * as audit from "../audit.js";
import * as auth from "../auth.js";
import * as cloudflare from "../cloudflare.js";
import * as db from "../db.js";
import { esc, fail, idParam, localTime, str } from "../util.js";
import { csrfInput, layout } from "./layout.js";
import { newTokenBlock, tokenCreateForm, tokenName, tokenTable, userTokens } from "./settings.js";

const ROLE_OK = (role) => auth.ROLES.includes(role);

// Back to the list with the acknowledgement. Admin usernames stand in for the camera operator
// list while no alert email is set (cloudflare.operatorEmails), so a created, deleted or
// re-roled user may change who can open the live camera pages: push that to every tunnel now.
async function done(ctx, message) {
  const accessError = await cloudflare.syncAccess(ctx);
  if (accessError) return auth.flashRedirect(ctx, "/users", `${message}, but the camera access list could not be updated on every device: ${accessError}. Click Recreate tunnel on each device on the Devices page.`, "error");
  return auth.flashRedirect(ctx, "/users", `${message}.`);
}

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
          <input type="password" name="password" placeholder="new password" minlength="6" required autocomplete="new-password" aria-label="New password for ${esc(u.username)}">
          <button type="submit" class="small" title="Also signs them out everywhere">Set</button>
        </form>
      </td>
      <td>
        ${u.id !== me.id ? `<form method="post" action="/users/${u.id}/delete" class="inline" data-confirm="Delete ${esc(u.username)}? Their API tokens stop working and any flasher using them will fail.">
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
  <caption class="sr-only">Users</caption>
  <thead><tr><th scope="col">Username</th><th scope="col">Role</th><th scope="col">Created</th><th scope="col">Change role</th><th scope="col">Set password</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead>
  <tbody>
    ${rows.filter(Boolean).join("\n    ")}
  </tbody>
</table>
</div>
<p class="help small">Resetting a password also signs that user out everywhere; their API tokens keep working until revoked. Operator API tokens let the flasher fetch the enrollment key (<code>GET /api/operator/enrollment</code>); only an admin's token can fetch it, so editor tokens are for scripts that need nothing more than a login. The plain token is shown once, at creation.</p>`;
  return layout(ctx, { title: "Users", content });
}

async function usersCreate(ctx) {
  auth.requireRole(ctx, "admin");
  const form = await ctx.form();
  const username = str(form, "username").trim();
  const password = str(form, "password");
  const role = str(form, "role", "editor") || "editor";
  if (!username || password.length < 6) fail(400, "username required and password must be at least 6 chars");
  if (username.length > auth.MAX_USERNAME_CHARS) fail(400, "Username too long");
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
  return done(ctx, "User created");
}

async function usersSetRole(ctx) {
  const me = auth.requireRole(ctx, "admin");
  const userId = idParam(ctx.params.user_id, "user_id");
  const role = str(await ctx.form(), "role");
  if (!ROLE_OK(role)) fail(400, "invalid role");
  if (userId === me.id && role !== "admin") fail(400, "cannot demote yourself");
  // The last-admin guard sits inside the statement: two admins demoting each other at the same
  // instant serialise in SQLite, so the second one sees the count already at 1 and changes nothing.
  const r = await db.run(ctx.env,
    "UPDATE users SET role = ? WHERE id = ? AND (? = 'admin' OR role != 'admin' OR (SELECT COUNT(*) FROM users WHERE role = 'admin') > 1)", role, userId, role);
  if (!r.changes) {
    if (!(await db.first(ctx.env, "SELECT 1 AS one FROM users WHERE id = ?", userId))) fail(404, "User not found");
    fail(400, "cannot demote the last admin");
  }
  await audit.log(ctx, "user_set_role", "user", userId, { role });
  return done(ctx, "Role updated");
}

async function usersSetPassword(ctx) {
  auth.requireRole(ctx, "admin");
  const userId = idParam(ctx.params.user_id, "user_id");
  const password = str(await ctx.form(), "password");
  const problem = auth.passwordProblem(password);
  if (problem) fail(400, problem);
  const hash = await auth.hashPassword(password);
  // The hash change and the sign-out land together: a reset is what an admin does when the
  // account is suspected compromised, so every other session of that user ends now (the
  // acting admin keeps their own when resetting their own password). API tokens are untouched.
  const [r] = await db.batch(ctx.env, [
    ["UPDATE users SET password_hash = ? WHERE id = ?", hash, userId],
    ["DELETE FROM sessions WHERE user_id = ? AND id != ?", userId, ctx.session.id],
  ]);
  if (!r.meta.changes) fail(404, "User not found");
  await audit.log(ctx, "user_set_password", "user", userId);
  return auth.flashRedirect(ctx, "/users", "Password changed.");
}

async function usersDelete(ctx) {
  const me = auth.requireRole(ctx, "admin");
  const userId = idParam(ctx.params.user_id, "user_id");
  if (userId === me.id) fail(400, "cannot delete yourself");
  // One guarded statement (see usersSetRole); `changes` counts the cascaded session rows too.
  const r = await db.run(ctx.env,
    "DELETE FROM users WHERE id = ? AND (role != 'admin' OR (SELECT COUNT(*) FROM users WHERE role = 'admin') > 1)", userId);
  if (!r.changes) {
    if (!(await db.first(ctx.env, "SELECT 1 AS one FROM users WHERE id = ?", userId))) fail(404, "User not found");
    fail(400, "cannot delete the last admin");
  }
  await audit.log(ctx, "user_delete", "user", userId);
  return done(ctx, "User deleted");
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
  return auth.flashRedirect(ctx, "/users", "API token revoked.");
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
