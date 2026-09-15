// Port of web.users_* + users.html (admin only).
import * as audit from "../audit.js";
import * as auth from "../auth.js";
import * as db from "../db.js";
import { esc, fail, idParam, localTime, redirect, str } from "../util.js";
import { csrfInput, layout } from "./layout.js";

const ROLE_OK = (role) => auth.ROLES.includes(role);

async function usersPage(ctx) {
  const me = auth.requireRole(ctx, "admin");
  const tz = (await ctx.settings()).timezone;
  const users = await db.all(ctx.env, "SELECT id, username, role, created_at FROM users ORDER BY username");
  const row = (u) => `<tr>
      <td>${esc(u.username)}${u.id === me.id ? ' <span class="muted small">(you)</span>' : ""}</td>
      <td><span class="badge badge-${esc(u.role)}">${esc(u.role)}</span></td>
      <td>${esc(localTime(u.created_at, tz))}</td>
      <td>
        <form method="post" action="/users/${u.id}/role" class="inline">
          ${csrfInput(ctx)}
          <select name="role" data-autosubmit${u.id === me.id ? " disabled" : ""}>
            ${["admin", "editor", "viewer"].map((r) => `<option value="${r}"${u.role === r ? " selected" : ""}>${r}</option>`).join("\n            ")}
          </select>
        </form>
      </td>
      <td>
        <form method="post" action="/users/${u.id}/password" class="inline">
          ${csrfInput(ctx)}
          <input type="password" name="password" placeholder="new password" minlength="6" style="width: 9rem;">
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
  const content = `<h1>Users</h1>

<div class="panel">
  <h2>New user</h2>
  <form method="post" action="/users">
    ${csrfInput(ctx)}
    <div class="form-grid">
      <label>Username
        <input type="text" name="username" required>
      </label>
      <label>Password (at least 6 characters)
        <input type="password" name="password" required minlength="6">
      </label>
      <label>Role
        <select name="role">
          <option value="editor">editor (can upload, edit playlists, manage devices)</option>
          <option value="admin">admin (everything + user management)</option>
          <option value="viewer">viewer (read-only)</option>
        </select>
      </label>
    </div>
    <button type="submit" class="primary">Create user</button>
  </form>
</div>

<table class="data">
  <thead><tr><th>Username</th><th>Role</th><th>Created</th><th>Change role</th><th>Reset password</th><th></th></tr></thead>
  <tbody>
    ${users.map(row).join("\n    ")}
  </tbody>
</table>`;
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

export function register(router) {
  router.get("/users", usersPage);
  router.post("/users", usersCreate);
  router.post("/users/:user_id/role", usersSetRole);
  router.post("/users/:user_id/password", usersSetPassword);
  router.post("/users/:user_id/delete", usersDelete);
}
