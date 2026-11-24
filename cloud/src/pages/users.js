// Port of web.users_* + users.html (admin only), plus each admin/editor's operator API tokens
// (api_tokens; feature B): an admin issues or revokes a token for any user here, the Settings
// page holds each user's own. A viewer's token would only ever get 401 on the operator
// endpoint, so viewers get no create form (and the route answers 400). Every account is its own
// private space (accounts.js): a new user gets an empty library and their own Default playlist,
// and deleting a user deletes their library, playlists, groups and settings with them.
import * as accounts from "../accounts.js";
import * as audit from "../audit.js";
import * as auth from "../auth.js";
import * as cloudflare from "../cloudflare.js";
import * as db from "../db.js";
import * as media from "../media.js";
import { esc, fail, idParam, localTime, str } from "../util.js";
import { csrfInput, layout } from "./layout.js";
import { newTokenBlock, tokenCreateForm, tokenName, tokenTable } from "./settings.js";

const ROLE_OK = (role) => auth.ROLES.includes(role);

// Back to the list with the acknowledgement. `accessOwner` is the account whose projectors may
// have a new camera operator list (cloudflare.operatorEmails): an account's own address (or
// email-like username) stands in for that list while it has no alert email set, and a deleted
// user's projectors, now ownerless, follow the site admin's. Only that account's tunnels are
// re-pushed: the whole fleet ran past the Free plan's subrequest limit. Creating a user or changing
// a role moves no list (operatorEmails never reads the role, and the site admin is recorded, not
// recomputed), so those push nothing.
async function done(ctx, message, accessOwner, back = "/users") {
  const accessError = accessOwner === undefined ? null : await cloudflare.syncAccess(ctx, accessOwner);
  if (accessError) return auth.flashRedirect(ctx, back, `${message}, but the camera access list could not be updated on every device: ${accessError}. Click Recreate tunnel on each device on the Devices page.`, "error");
  return auth.flashRedirect(ctx, back, `${message}.`);
}

// '2026-11-17 10:00 UTC' in two unbreakable halves: a squeezed column puts the time under the
// date instead of breaking the date at a hyphen.
const stamp = (value, tz) => esc(localTime(value, tz)).replace(/^(\S+) (.+)$/, '<span class="nowrap">$1</span> <span class="nowrap">$2</span>');

// Second row under a user: their tokens and (admin/editor only) the create form; `newToken`
// is the plaintext of a token created by this very request, shown once under its user.
function tokensRow(ctx, u, tokens, tz, newToken) {
  const canHold = u.role !== "viewer";
  if (!tokens.length && !canHold) return "";
  return `<tr class="user-tokens">
      <td colspan="8">
        <details${newToken ? " open" : ""}>
          <summary class="small">API tokens (${tokens.length})</summary>
          <div>
            ${newToken ? newTokenBlock(newToken) : ""}
            ${canHold ? tokenCreateForm(ctx, `/users/${u.id}/tokens`, `Token name for ${u.username}`) : '<p class="muted small">Viewers cannot use operator tokens; change the role first.</p>'}
            ${tokenTable(ctx, tokens, tz, (t) => `/users/${u.id}/tokens/${t.id}/revoke`)}
          </div>
        </details>
      </td>
    </tr>`;
}

async function usersPage(ctx, created = null) {
  const me = auth.requireRole(ctx, "admin");
  const tz = (await ctx.settings()).timezone;
  const site = await accounts.siteAdminId(ctx.env);
  const users = await db.all(ctx.env,
    `SELECT u.id, u.username, u.email, u.role, u.created_at, (SELECT COUNT(*) FROM devices d WHERE d.owner_id = u.id) AS device_count
       FROM users u ORDER BY u.username`);
  // Every account's tokens in one statement, sorted out here: a query per account ran past the
  // Free plan's 50 D1 queries a request at about 45 accounts.
  const tokensOf = Map.groupBy(await db.all(ctx.env,
    "SELECT user_id, id, name, created_at, last_used_at FROM api_tokens ORDER BY created_at DESC, id DESC"), (t) => t.user_id);
  // data-label: each cell's heading, shown above it where a phone stacks the row into a card.
  const row = (u) => `<tr>
      <td class="name">${esc(u.username)}${u.id === me.id ? ' <span class="muted small">(you)</span>' : ""}${u.id === site ? ' <span class="badge badge-muted" title="Projectors without an owner play this account\'s content: it cannot be deleted or given another role">site admin</span>' : ""}</td>
      <td data-label="Role"><span class="badge badge-${esc(u.role)}">${esc(u.role)}</span></td>
      <td data-label="Email">
        ${u.email ? `<div class="small">${esc(u.email)}</div>` : ""}
        <form method="post" action="/users/${u.id}/email" class="inline duration-form">
          ${csrfInput(ctx)}
          <input type="email" name="email" placeholder="${u.email ? "replace" : "not set"}" maxlength="${auth.MAX_EMAIL_CHARS}" required autocomplete="off" aria-label="Email for ${esc(u.username)}">
          <button type="submit" class="small">Set</button>
        </form>
      </td>
      <td data-label="Projectors" title="Projectors this account owns (set on the Devices page)">${u.device_count}</td>
      <td data-label="Created" class="muted">${stamp(u.created_at, tz)}</td>
      <td data-label="Change role">
        <form method="post" action="/users/${u.id}/role" class="inline">
          ${csrfInput(ctx)}
          <select name="role" data-autosubmit aria-label="Role for ${esc(u.username)}"${u.id === me.id || u.id === site ? " disabled" : ""}>
            ${["admin", "editor", "viewer"].map((r) => `<option value="${r}"${u.role === r ? " selected" : ""}>${r}</option>`).join("\n            ")}
          </select>
        </form>
      </td>
      <td data-label="Set password">
        <form method="post" action="/users/${u.id}/password" class="inline duration-form">
          ${csrfInput(ctx)}
          <input type="password" name="password" placeholder="new password" minlength="6" required autocomplete="new-password" aria-label="New password for ${esc(u.username)}">
          <button type="submit" class="small" title="Also signs them out everywhere">Set</button>
        </form>
      </td>
      <td>
        ${u.id !== me.id && u.id !== site ? `<form method="post" action="/users/${u.id}/delete" class="inline" data-confirm="Delete ${esc(u.username)}? Their library, playlists, groups and settings are deleted with the account, and their API tokens stop working. Their projectors stay on the Devices page with no owner, signed out until each gets a new token there.">
          ${csrfInput(ctx)}
          <button type="submit" class="danger small">Delete</button>
        </form>` : ""}
      </td>
    </tr>`;
  const rows = users.flatMap((u) => [row(u), tokensRow(ctx, u, tokensOf.get(u.id) || [], tz, created?.userId === u.id ? created.token : "")]);
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
          <option value="editor">editor (full control of their own account, like a sign-up)</option>
          <option value="admin">admin (their own account, plus every projector and user management)</option>
          <option value="viewer">viewer (their own account, read-only)</option>
        </select>
      </label>
    </div>
    <div class="row">
      <button type="submit" class="primary">Create user</button>
    </div>
  </form>
</div>

<div class="table-wrap">
<table class="data stack users">
  <caption class="sr-only">Users</caption>
  <thead><tr><th scope="col">Username</th><th scope="col">Role</th><th scope="col">Email</th><th scope="col">Projectors</th><th scope="col">Created</th><th scope="col">Change role</th><th scope="col">Set password</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead>
  <tbody>
    ${rows.filter(Boolean).join("\n    ")}
  </tbody>
</table>
</div>
<p class="help small">Resetting a password signs that user out everywhere.</p>`;
  return layout(ctx, { title: "Users", content });
}

async function usersCreate(ctx) {
  auth.requireRole(ctx, "admin");
  const form = await ctx.form();
  const username = str(form, "username").trim();
  const password = str(form, "password");
  const role = str(form, "role", "editor") || "editor";
  if (!username || password.length < 6) fail(400, "Enter a username and a password of at least 6 characters");
  const nameProblem = auth.usernameProblem(username);
  if (nameProblem) fail(400, nameProblem);
  if (!ROLE_OK(role)) fail(400, "Pick a role");
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
  await accounts.ensureDefaultPlaylist(ctx.env, id);
  await audit.log(ctx, "user_create", "user", id, { username, role }, undefined, id);
  return done(ctx, "User created");
}

async function usersSetRole(ctx) {
  const me = auth.requireRole(ctx, "admin");
  const userId = idParam(ctx.params.user_id, "user_id");
  const role = str(await ctx.form(), "role");
  if (!ROLE_OK(role)) fail(400, "Pick a role");
  if (userId === me.id && role !== "admin") fail(400, "You cannot change your own role");
  if (role !== "admin" && userId === await accounts.siteAdminId(ctx.env)) fail(400, accounts.SITE_ADMIN_KEPT);
  // The last-admin guard sits inside the statement: two admins demoting each other at the same
  // instant serialise in SQLite, so the second one sees the count already at 1 and changes nothing.
  const r = await db.run(ctx.env,
    "UPDATE users SET role = ? WHERE id = ? AND (? = 'admin' OR role != 'admin' OR (SELECT COUNT(*) FROM users WHERE role = 'admin') > 1)", role, userId, role);
  if (!r.changes) {
    if (!(await db.first(ctx.env, "SELECT 1 AS one FROM users WHERE id = ?", userId))) fail(404, "User not found");
    fail(400, "The last admin cannot be given another role");
  }
  await audit.log(ctx, "user_set_role", "user", userId, { role }, undefined, userId);
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
    ["UPDATE password_resets SET used_at = datetime('now') WHERE user_id = ? AND used_at IS NULL", userId],
  ]);
  if (!r.meta.changes) fail(404, "User not found");
  await audit.log(ctx, "user_set_password", "user", userId, null, undefined, userId);
  return auth.flashRedirect(ctx, "/users", "Password changed.");
}

// The address /forgot mails the reset link to; accounts from before sign-up asked for one get
// theirs here. A value replaces, the form refuses an empty one (nothing is ever cleared).
async function usersSetEmail(ctx) {
  auth.requireRole(ctx, "admin");
  const userId = idParam(ctx.params.user_id, "user_id");
  const email = str(await ctx.form(), "email").trim();
  const problem = auth.emailProblem(email);
  if (problem) fail(400, problem);
  let r;
  try {
    r = await db.run(ctx.env, "UPDATE users SET email = ? WHERE id = ?", email, userId);
  } catch (e) {
    if (db.isConstraintError(e)) fail(409, "Another account already uses that email address");
    throw e;
  }
  if (!r.changes) fail(404, "User not found");
  // A reset link mailed to the old address must not change the password after this.
  await db.run(ctx.env, "UPDATE password_resets SET used_at = datetime('now') WHERE user_id = ? AND used_at IS NULL", userId);
  await audit.log(ctx, "user_set_email", "user", userId, { email }, undefined, userId);
  // The address may be the account's camera operator (cloudflare.operatorEmails).
  return done(ctx, "Email address saved", userId);
}

// The account goes with everything in it: its media rows, playlists, groups, settings and
// secrets cascade (migration 0016), and the media files are removed from R2 once the rows are gone
// (an R2 error is logged, never undoes the delete). Its projectors stay, without an owner, so an
// admin can hand them on; but an ownerless projector plays the site admin's content and reads the
// site admin's Wyze login, so their tokens are replaced in the same transaction as the delete: a
// card of the deleted account gets 401 from then on (the Pi keeps playing what it has) and comes
// back only with a token made on the Devices page. Rotated rather than deleted, so the rows, their
// history and their tunnels stay for whoever gets the hardware next. The site admin is never
// deleted (SITE_ADMIN_KEPT).
async function usersDelete(ctx) {
  const me = auth.requireRole(ctx, "admin");
  const userId = idParam(ctx.params.user_id, "user_id");
  if (userId === me.id) fail(400, "You cannot delete your own account");
  const site = await accounts.siteAdminId(ctx.env);
  if (userId === site) fail(400, accounts.SITE_ADMIN_KEPT);
  const keys = await accounts.mediaKeys(ctx.env, userId);
  // Both statements carry the last-admin guard (see usersSetRole), so a refused delete signs
  // nothing out; `changes` of the delete counts the cascaded session rows too.
  const guard = "EXISTS (SELECT 1 FROM users u WHERE u.id = ?1 AND (u.role != 'admin' OR (SELECT COUNT(*) FROM users WHERE role = 'admin') > 1))";
  const [signedOut, r] = await db.batch(ctx.env, [
    [`UPDATE devices SET token = lower(hex(randomblob(32))) WHERE owner_id = ?1 AND ${guard}`, userId],
    [`DELETE FROM users WHERE id = ?1 AND ${guard}`, userId],
  ]);
  if (!r.meta.changes) {
    if (!(await db.first(ctx.env, "SELECT 1 AS one FROM users WHERE id = ?", userId))) fail(404, "User not found");
    fail(400, "The last admin cannot be deleted");
  }
  // Each file and its Library preview (media.thumbKey: thumbs/<filename>.jpg beside media/<filename>),
  // 1000 keys an R2 call: one call per file ran past the Free plan's 1000 subrequests on a big library.
  const objects = keys.flatMap((key) => [key, media.thumbKey(key.slice("media/".length))]);
  for (let i = 0; i < objects.length; i += 1000) {
    try { await ctx.env.MEDIA.delete(objects.slice(i, i + 1000)); }
    catch (e) { console.error(`R2 delete failed for ${objects.slice(i, i + 1000).length} object(s) from ${objects[i]} of deleted user ${userId}:`, e && e.stack || e); }
  }
  const details = {};
  if (keys.length) details.media_deleted = keys.length;
  if (signedOut.meta.changes) details.projectors_signed_out = signedOut.meta.changes;
  await audit.log(ctx, "user_delete", "user", userId, details, undefined, null);
  // Its projectors are ownerless now: they follow the site admin's operator list.
  return done(ctx, "User deleted", site);
}

// /account (every role, linked from the name in the top bar): the user's own password and email.
// Nothing changes without the current password, checked under the login throttle (the same
// ip + username failures, so the two share one budget). A new password ends the user's other
// sessions like an admin's Set password above; either change retires the reset links already
// mailed. The form comes back with the message on a mistake, keeping the typed address.
async function accountPage(ctx, message = "", status = 200, email = null) {
  const me = auth.requireUser(ctx);
  if (email === null) email = (await db.first(ctx.env, "SELECT email FROM users WHERE id = ?", me.id))?.email || "";
  const content = `<div class="page-head">
  <h1>Your account</h1>
  <span class="page-meta">${esc(me.username)}</span>
</div>
<div class="panel">
  <h2>Password and email</h2>
  <form method="post" action="/account">
    ${csrfInput(ctx)}
    <div class="form-grid">
      <label>Email
        <input type="email" name="email" value="${esc(email)}" placeholder="not set" maxlength="${auth.MAX_EMAIL_CHARS}" autocomplete="email">
      </label>
      <label>New password (at least ${auth.MIN_PASSWORD_CHARS} characters)
        <input type="password" name="password" minlength="${auth.MIN_PASSWORD_CHARS}" autocomplete="new-password">
      </label>
      <label>New password (again)
        <input type="password" name="password2" minlength="${auth.MIN_PASSWORD_CHARS}" autocomplete="new-password">
      </label>
      <label>Current password
        <input type="password" name="current_password" required autocomplete="current-password">
      </label>
    </div>
    <div class="row">
      <button type="submit" class="primary">Save</button>
    </div>
  </form>
</div>`;
  return layout(ctx, { title: "Your account", content, status, message });
}

async function accountSave(ctx) {
  const me = auth.requireUser(ctx);
  const form = await ctx.form();
  const email = str(form, "email").trim();
  const password = str(form, "password");
  const again = (message, status = 400) => accountPage(ctx, message, status, email);
  const row = await db.first(ctx.env, "SELECT email, password_hash FROM users WHERE id = ?", me.id);
  const newEmail = email && email !== row.email ? email : ""; // an empty box keeps the address
  const problem = (newEmail && auth.emailProblem(newEmail)) || (password && auth.passwordProblem(password));
  if (problem) return again(problem);
  if (password !== str(form, "password2")) return again("The two new passwords do not match");
  if (!newEmail && !password) return again("Enter a new password or a new email address");
  const wait = await auth.loginLockedFor(ctx.env, ctx.ip, me.username);
  if (wait) return again(`Too many failed attempts; try again in ${wait} s`, 429);
  if (!(await auth.verifyPassword(str(form, "current_password"), row.password_hash))) {
    await auth.recordLoginFailure(ctx.env, ctx.ip, me.username);
    return again("The current password is wrong");
  }
  await auth.clearLoginFailures(ctx.env, ctx.ip, me.username);
  // One batch: an address another account uses changes nothing, the new password included.
  const writes = [["UPDATE password_resets SET used_at = datetime('now') WHERE user_id = ? AND used_at IS NULL", me.id]];
  if (newEmail) writes.push(["UPDATE users SET email = ? WHERE id = ?", newEmail, me.id]);
  // ponytail: the check and the new hash are two PBKDF2 derivations (about 13-15 ms CPU each), past
  // the Free plan's 10 ms where /login's one sits at the edge (README, Limits); an 1102 there fails
  // before this batch, so nothing is half-changed. Workers Paid lifts it.
  if (password) {
    writes.push(["UPDATE users SET password_hash = ? WHERE id = ?", await auth.hashPassword(password), me.id],
      ["DELETE FROM sessions WHERE user_id = ? AND id != ?", me.id, ctx.session.id]);
  }
  try {
    await db.batch(ctx.env, writes);
  } catch (e) {
    if (db.isConstraintError(e)) return again("Another account already uses that email address", 409);
    throw e;
  }
  if (password) await audit.log(ctx, "user_set_password", "user", me.id);
  if (newEmail) await audit.log(ctx, "user_set_email", "user", me.id, { email: newEmail });
  const message = password && newEmail ? "Password changed and email address saved" : password ? "Password changed" : "Email address saved";
  // The address may be the account's camera operator (cloudflare.operatorEmails).
  return done(ctx, message, newEmail ? me.id : undefined, "/account");
}

// Issue a token for another admin or editor; the page re-renders once with the plaintext
// under that user (no redirect: the secret must not travel in a URL). Only the hash is stored.
async function userTokenCreate(ctx) {
  auth.requireRole(ctx, "admin");
  const userId = idParam(ctx.params.user_id, "user_id");
  const name = tokenName(await ctx.form());
  const user = await db.first(ctx.env, "SELECT id, username, role FROM users WHERE id = ?", userId);
  if (!user) fail(404, "User not found");
  if (user.role === "viewer") fail(400, "Viewers cannot hold API tokens; change the role first");
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
  await audit.log(ctx, "api_token_revoked", "api_token", tokenId, { name: row.name, username: row.username }, undefined, userId);
  return auth.flashRedirect(ctx, "/users", "API token revoked.");
}

export function register(router) {
  router.get("/account", accountPage);
  router.post("/account", accountSave);
  router.post("/users/:user_id/tokens", userTokenCreate);
  router.post("/users/:user_id/tokens/:token_id/revoke", userTokenRevoke);
  router.get("/users", usersPage);
  router.post("/users", usersCreate);
  router.post("/users/:user_id/role", usersSetRole);
  router.post("/users/:user_id/password", usersSetPassword);
  router.post("/users/:user_id/email", usersSetEmail);
  router.post("/users/:user_id/delete", usersDelete);
}
