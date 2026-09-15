// /users (admin only): create (validation, 409), role (self-demote guard), password
// (min 6 / max 1024), delete (self + last-admin guards), escaping.
import { beforeAll, describe, expect, it } from "vitest";
import * as auth from "../src/auth.js";
import { Client } from "./helpers.js";
import { audits, detail, NOPE, one, post, roleMatrix, roles, XSS } from "./pages_common.js";

let r;
const uid = (username) => one("SELECT id, role, password_hash FROM users WHERE username = ?", username);

beforeAll(async () => {
  r = await roles();
});

describe("users", () => {
  it("admin only for every route", async () => {
    await roleMatrix(r, "GET", "/users", { minRole: "admin" });
    await roleMatrix(r, "POST", "/users", { minRole: "admin", fields: { username: "matrix", password: "pw123456", role: "viewer" } });
    const m = await uid("matrix");
    await roleMatrix(r, "POST", `/users/${m.id}/role`, { minRole: "admin", fields: { role: "editor" } });
    await roleMatrix(r, "POST", `/users/${m.id}/password`, { minRole: "admin", fields: { password: "newpass1" } });
    await roleMatrix(r, "POST", `/users/${m.id}/delete`, { minRole: "admin" });
    expect(await uid("matrix")).toBeNull();
    // the viewer's failed attempt created nothing
    expect(await one("SELECT id FROM users WHERE username = 'nope'")).toBeNull();
  });

  it("page lists users with (you), disabled self role select, escaped confirm, no maxlength=72", async () => {
    await post(r.admin, "/users", { username: XSS + "u", password: "pw123456", role: "viewer" });
    const page = await (await r.admin.get("/users")).text();
    expect(page).toContain('admin <span class="muted small">(you)</span>');
    expect(page).toContain('name="role" data-autosubmit disabled');
    expect(page).not.toContain(XSS);
    expect(page).toContain('data-confirm="Delete x&#39;);alert(1);//u?"');
    expect(page).toContain('<span class="badge badge-editor">editor</span>');
    expect(page).not.toContain("onchange");
    expect(page).not.toContain('maxlength="72"');
    expect(page).toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/);
    // the admin's own row has no delete form
    const me = await uid("admin");
    expect(page).not.toContain(`/users/${me.id}/delete`);
  });

  it("create validation: 400s, 409 duplicate, default role editor, audits", async () => {
    expect(await detail(await post(r.admin, "/users", { username: "u1", password: "short", role: "viewer" }), 400))
      .toBe("username required and password must be at least 6 chars");
    expect(await detail(await post(r.admin, "/users", { username: "   ", password: "pw123456", role: "viewer" }), 400)).toContain("username required");
    expect(await detail(await post(r.admin, "/users", { username: "u1", password: "pw123456", role: "god" }), 400)).toBe("role must be admin, editor, or viewer");
    expect(await detail(await post(r.admin, "/users", { username: "u1", password: "p".repeat(1025), role: "viewer" }), 400)).toBe(auth.PASSWORD_TOO_LONG_MSG);
    expect(await detail(await post(r.admin, "/users", { username: "u1", password: "é".repeat(600), role: "viewer" }), 400)).toContain("1024");
    expect(await uid("u1")).toBeNull();
    expect((await post(r.admin, "/users", { username: " u1 ", password: "pw123456" })).status).toBe(303);
    const u = await uid("u1");
    expect(u.role).toBe("editor");
    expect(u.password_hash).toMatch(/^pbkdf2\$/);
    expect(await detail(await post(r.admin, "/users", { username: "u1", password: "pw123456", role: "viewer" }), 409)).toBe("A user with that username already exists");
    expect((await audits("user_create"))[0]).toMatchObject({ username: "admin", target_id: String(u.id), details: '{"username": "u1", "role": "editor"}' });
    // and the new user can log in
    expect((await new Client().login("u1", "pw123456")).status).toBe(303);
  });

  it("role: invalid 400, self-demote 400, 404 unknown, updates + audits", async () => {
    const me = await uid("admin");
    const ed = await uid("ed");
    expect(await detail(await post(r.admin, `/users/${ed.id}/role`, { role: "root" }), 400)).toBe("invalid role");
    expect(await detail(await post(r.admin, `/users/${me.id}/role`, { role: "viewer" }), 400)).toBe("cannot demote yourself");
    expect((await post(r.admin, `/users/${me.id}/role`, { role: "admin" })).status).toBe(303);
    expect(await detail(await post(r.admin, `/users/${NOPE}/role`, { role: "viewer" }), 404)).toBe("User not found");
    expect((await post(r.admin, `/users/${ed.id}/role`, { role: "viewer" })).status).toBe(303);
    expect((await uid("ed")).role).toBe("viewer");
    expect((await audits("user_set_role"))[0]).toMatchObject({ target_id: String(ed.id), details: '{"role": "viewer"}' });
    await post(r.admin, `/users/${ed.id}/role`, { role: "editor" });
  });

  it("password: min 6 / max 1024, 404 unknown, changes the hash + audits", async () => {
    const vw = await uid("vw");
    expect(await detail(await post(r.admin, `/users/${vw.id}/password`, { password: "short" }), 400)).toBe("password must be at least 6 chars");
    expect(await detail(await post(r.admin, `/users/${vw.id}/password`, { password: "p".repeat(1025) }), 400)).toBe(auth.PASSWORD_TOO_LONG_MSG);
    expect(await detail(await post(r.admin, `/users/${NOPE}/password`, { password: "pw123456" }), 404)).toBe("User not found");
    expect((await uid("vw")).password_hash).toBe(vw.password_hash);
    expect((await post(r.admin, `/users/${vw.id}/password`, { password: "brand-new-1" })).status).toBe(303);
    expect((await uid("vw")).password_hash).not.toBe(vw.password_hash);
    expect((await new Client().login("vw", "brand-new-1")).status).toBe(303);
    expect((await audits("user_set_password"))[0].target_id).toBe(String(vw.id));
  });

  it("delete: self 400, last admin 400, 404 unknown, otherwise deletes + audits", async () => {
    const me = await uid("admin");
    expect(await detail(await post(r.admin, `/users/${me.id}/delete`), 400)).toBe("cannot delete yourself");
    expect(await detail(await post(r.admin, `/users/${NOPE}/delete`), 404)).toBe("User not found");
    await post(r.admin, "/users", { username: "admin2", password: "pw123456", role: "admin" });
    const a2 = await uid("admin2");
    // two admins: admin2 may go; then admin is the last one and admin2 (re-created) cannot delete it
    expect((await post(r.admin, `/users/${a2.id}/delete`)).status).toBe(303);
    expect(await uid("admin2")).toBeNull();
    await post(r.admin, "/users", { username: "admin3", password: "pw123456", role: "admin" });
    const c3 = new Client();
    await c3.login("admin3", "pw123456");
    c3.token = await c3.csrf("/users");
    const a3 = await uid("admin3");
    expect((await post(c3, `/users/${me.id}/delete`)).status).toBe(303);   // 2 admins, fine
    expect(await uid("admin")).toBeNull();
    expect(await detail(await post(c3, `/users/${a3.id}/delete`), 400)).toBe("cannot delete yourself");
    // the deleted admin's session is gone
    expect((await r.admin.get("/users")).status).toBe(303);
    expect((await audits("user_delete"))[0]).toMatchObject({ username: "admin3", target_id: String(me.id) });
    // last-admin guard from a second admin's point of view
    await post(c3, "/users", { username: "admin4", password: "pw123456", role: "admin" });
    const c4 = new Client();
    await c4.login("admin4", "pw123456");
    c4.token = await c4.csrf("/users");
    expect((await post(c4, `/users/${a3.id}/delete`)).status).toBe(303);
    const a4 = await uid("admin4");
    expect(await detail(await post(c4, `/users/${a4.id}/delete`), 400)).toBe("cannot delete yourself");
    const ed = await uid("ed");
    await post(c4, `/users/${ed.id}/role`, { role: "admin" });
    await post(c4, `/users/${a4.id}/role`, { role: "viewer" }); // self-demote refused
    expect((await uid("admin4")).role).toBe("admin");
  });
});
