// Shared fixtures for the pages_*.test.js files: admin/editor/viewer clients with cached
// CSRF tokens, direct-SQL row factories, and the role-matrix helper.
import { expect } from "vitest";
import { env } from "cloudflare:workers";
import { Client, query, setupAdmin } from "./helpers.js";

export const SHA = (c) => c.repeat(64);
export const NOPE = 999999;
export const XSS = "x');alert(1);//";
export const ins = async (sql, ...p) => (await env.DB.prepare(sql).bind(...p).run()).meta.last_row_id;
export const one = (sql, ...p) => query(sql, ...p).then((r) => r[0] ?? null);

async function loginAs(username, password) {
  const c = new Client();
  const r = await c.login(username, password);
  if (r.status !== 303) throw new Error(`login as ${username}: ${r.status}`);
  c.token = await c.csrf("/dashboard");
  return c;
}

// The editor's user id once roles() has run: device(), media(), playlist() and group() make it
// the owner of every fixture row, so the editor client sees and may act on what a test creates
// (projectors per account since migration 0009, everything else since 0016). Pass an owner to
// put a row in another account (the admin's, for the Settings tests).
let editorId = null;
export const editor = () => editorId;

// {admin, editor, viewer, ids: {admin, editor, viewer}}: the first admin via /setup, the others created on /users.
export async function roles() {
  const admin = await setupAdmin("admin", "test1234");
  admin.token = await admin.csrf("/dashboard");
  for (const [username, role] of [["ed", "editor"], ["vw", "viewer"]]) {
    const r = await post(admin, "/users", { username, password: `${role}-pass`, role });
    if (r.status !== 303) throw new Error(`create ${role}: ${r.status} ${await r.text()}`);
  }
  const ids = {};
  for (const u of await query("SELECT id, username FROM users")) ids[{ admin: "admin", ed: "editor", vw: "viewer" }[u.username]] = u.id;
  editorId = ids.editor;
  return { admin, editor: await loginAs("ed", "editor-pass"), viewer: await loginAs("vw", "viewer-pass"), ids };
}

export const post = (c, path, fields = {}) => c.post(path, fields, { "X-CSRF-Token": c.token });
export const postJson = (c, path, data) => c.postJson(path, data, { "X-CSRF-Token": c.token });

let mediaSeq = 0;
// The sequence also feeds the sha256, unique per account since migration 0016 (0006: site-wide):
// bump it for every row. extra.owner: the account (default the roles() editor; null = none).
export const media = (name, type = "image", extra = {}) => (mediaSeq++, ins(
  `INSERT INTO media (filename, original_name, media_type, size_bytes, duration_seconds, sha256, owner_id)
   VALUES (?, ?, ?, ?, ?, ?, ?)`,
  extra.filename || `${mediaSeq}_${name}`, name, type, extra.size ?? 1000, extra.duration ?? null,
  extra.sha256 || SHA("a").slice(0, 56) + String(mediaSeq).padStart(8, "0"), extra.owner === undefined ? editorId : extra.owner));
// legacy_name: the old site-wide unique name column (migration 0016); any unique value does.
export const playlist = (name, owner = editorId) => ins("INSERT INTO playlists (owner_id, name, legacy_name) VALUES (?, ?, lower(hex(randomblob(16))))", owner, name);
// Device row; `cols` adds columns ({playlist_id, group_id, last_seen_at, ...}). Owned by the
// roles() editor unless cols.owner_id says otherwise (null = no owner, admin-only).
export async function device(deviceId, name = deviceId, cols = {}) {
  cols = { owner_id: editorId, ...cols };
  const keys = Object.keys(cols);
  const id = await ins(
    `INSERT INTO devices (device_id, name, token${keys.map((k) => ", " + k).join("")})
     VALUES (?, ?, ?${", ?".repeat(keys.length)})`,
    deviceId, name, `tok-${deviceId}`, ...keys.map((k) => cols[k]));
  return { id, device_id: deviceId, name, token: `tok-${deviceId}` };
}
export const group = (name, owner = editorId) => ins("INSERT INTO device_groups (owner_id, name, legacy_name) VALUES (?, ?, lower(hex(randomblob(16))))", owner, name);
// An account's own settings row (account_settings, migration 0016), e.g. its timezone.
export const setting = (owner, key, value) => ins(
  "INSERT INTO account_settings (user_id, key, value) VALUES (?, ?, ?) ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value", owner, key, String(value));
// The account's Default playlist id (default_playlist_id).
export const defaultPlaylistOf = async (owner) => Number((await one("SELECT value FROM account_settings WHERE user_id = ? AND key = 'default_playlist_id'", owner)).value);

// Status + JSON detail for an error response.
export async function detail(res, status) {
  expect(res.status).toBe(status);
  const body = await res.json();
  expect(typeof body.detail).toBe("string");
  return body.detail;
}

// Anonymous -> 303 /login (GET) / 303 /login?expired=1 (POST); roles below minRole -> 403 JSON; the
// lowest allowed role gets `ok` (default: 200 for GET). Writes are sent by the lowest allowed
// role only, so the caller knows exactly one write happened.
export async function roleMatrix(r, method, path, { minRole, fields = {}, ok } = {}) {
  minRole = minRole || (method === "GET" ? "viewer" : "editor");
  ok = ok || (method === "GET" ? 200 : 303);
  const send = (c) => (method === "GET" ? c.get(path) : post(c, path, fields));
  const anon = await new Client().fetch(path, method === "GET" ? {} : { method: "POST" });
  if (method === "GET") {
    expect(anon.status, `anon ${path}`).toBe(303);
    expect(anon.headers.get("location")).toBe("/login");
  } else {
    expect(anon.status, `anon ${path}`).toBe(303); // no session -> back to the login form
    expect(anon.headers.get("location")).toBe("/login?expired=1");
  }
  const order = [r.viewer, r.editor, r.admin];
  const rank = { viewer: 0, editor: 1, admin: 2 }[minRole];
  for (const c of order.slice(0, rank)) {
    const res = await send(c);
    expect(res.status, `${method} ${path} denied`).toBe(403);
    expect((await res.json()).detail).toBe(`requires ${minRole} role`);
  }
  if (method === "GET") {
    for (const c of order.slice(rank)) expect((await send(c)).status, `${method} ${path} allowed`).toBe(ok);
  } else {
    expect((await send(order[rank])).status, `${method} ${path} allowed`).toBe(ok);
  }
}

export const audits = (action) => query("SELECT username, target_type, target_id, details, ip FROM audit_log WHERE action = ? ORDER BY id DESC", action);
