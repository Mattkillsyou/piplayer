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

// {admin, editor, viewer}: the first admin via /setup, the others created on /users.
export async function roles() {
  const admin = await setupAdmin("admin", "test1234");
  admin.token = await admin.csrf("/dashboard");
  for (const [username, role] of [["ed", "editor"], ["vw", "viewer"]]) {
    const r = await post(admin, "/users", { username, password: `${role}-pass`, role });
    if (r.status !== 303) throw new Error(`create ${role}: ${r.status} ${await r.text()}`);
  }
  return { admin, editor: await loginAs("ed", "editor-pass"), viewer: await loginAs("vw", "viewer-pass") };
}

export const post = (c, path, fields = {}) => c.post(path, fields, { "X-CSRF-Token": c.token });
export const postJson = (c, path, data) => c.postJson(path, data, { "X-CSRF-Token": c.token });

let mediaSeq = 0;
export const media = (name, type = "image", extra = {}) => ins(
  `INSERT INTO media (filename, original_name, media_type, size_bytes, duration_seconds, sha256)
   VALUES (?, ?, ?, ?, ?, ?)`,
  extra.filename || `${++mediaSeq}_${name}`, name, type, extra.size ?? 1000, extra.duration ?? null,
  SHA("a").slice(0, 56) + String(mediaSeq).padStart(8, "0"));
export const playlist = (name) => ins("INSERT INTO playlists (name) VALUES (?)", name);
// Device row; `cols` adds columns ({playlist_id, group_id, last_seen_at, ...}).
export async function device(deviceId, name = deviceId, cols = {}) {
  const keys = Object.keys(cols);
  const id = await ins(
    `INSERT INTO devices (device_id, name, token${keys.map((k) => ", " + k).join("")})
     VALUES (?, ?, ?${", ?".repeat(keys.length)})`,
    deviceId, name, `tok-${deviceId}`, ...keys.map((k) => cols[k]));
  return { id, device_id: deviceId, name, token: `tok-${deviceId}` };
}
export const group = (name) => ins("INSERT INTO device_groups (name) VALUES (?)", name);

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
