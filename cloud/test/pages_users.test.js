// /users (admin only): create (validation, 409), role (self-demote guard), password
// (min 6 / max 1024), email (validation, 409), delete (self + last-admin guards), escaping.
import { beforeAll, describe, expect, it } from "vitest";
import * as auth from "../src/auth.js";
import { Client } from "./helpers.js";
import { audits, detail, ins, NOPE, one, post, roleMatrix, roles, XSS } from "./pages_common.js";

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
    await roleMatrix(r, "POST", `/users/${m.id}/email`, { minRole: "admin", fields: { email: "matrix@example.com" } });
    await roleMatrix(r, "POST", `/users/${m.id}/delete`, { minRole: "admin" });
    expect(await uid("matrix")).toBeNull();
    // the viewer's failed attempt created nothing
    expect(await one("SELECT id FROM users WHERE username = 'nope'")).toBeNull();
  });

  it("page lists users with (you), disabled self role select, escaped confirm, no maxlength=72", async () => {
    // the username rule refuses such a name on the form now; a row from before the rule still renders escaped
    await ins("INSERT INTO users (username, password_hash, role) VALUES (?, 'x', 'viewer')", XSS + "u");
    const page = await (await r.admin.get("/users")).text();
    expect(page).toContain('admin <span class="muted small">(you)</span>');
    expect(page).toContain('name="role" data-autosubmit aria-label="Role for admin" disabled');
    expect(page).not.toContain(XSS);
    expect(page).toContain('data-confirm="Delete x&#39;);alert(1);//u? Their API tokens stop working and any flasher using them will fail. Their projectors keep playing but have no owner until you pick one on the Devices page."');
    expect(page).toContain('name="password" placeholder="new password" minlength="6" required');
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
      .toBe("Enter a username and a password of at least 6 characters");
    expect(await detail(await post(r.admin, "/users", { username: "   ", password: "pw123456", role: "viewer" }), 400)).toContain("Enter a username");
    expect(await detail(await post(r.admin, "/users", { username: "u1", password: "pw123456", role: "god" }), 400)).toBe("Pick a role");
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
    expect(await detail(await post(r.admin, `/users/${ed.id}/role`, { role: "root" }), 400)).toBe("Pick a role");
    expect(await detail(await post(r.admin, `/users/${me.id}/role`, { role: "viewer" }), 400)).toBe("You cannot change your own role");
    expect((await post(r.admin, `/users/${me.id}/role`, { role: "admin" })).status).toBe(303);
    expect(await detail(await post(r.admin, `/users/${NOPE}/role`, { role: "viewer" }), 404)).toBe("User not found");
    expect((await post(r.admin, `/users/${ed.id}/role`, { role: "viewer" })).status).toBe(303);
    expect((await uid("ed")).role).toBe("viewer");
    expect((await audits("user_set_role"))[0]).toMatchObject({ target_id: String(ed.id), details: '{"role": "viewer"}' });
    await post(r.admin, `/users/${ed.id}/role`, { role: "editor" });
  });

  it("password: min 6 / max 1024, 404 unknown, changes the hash + audits, signs the user out everywhere", async () => {
    const vw = await uid("vw");
    const d = new Client();
    expect((await d.login("vw", "viewer-pass")).status).toBe(303);
    expect((await d.get("/dashboard")).status).toBe(200);
    expect(await detail(await post(r.admin, `/users/${vw.id}/password`, { password: "short" }), 400)).toBe("Password must be at least 6 characters");
    expect(await detail(await post(r.admin, `/users/${vw.id}/password`, { password: "p".repeat(1025) }), 400)).toBe(auth.PASSWORD_TOO_LONG_MSG);
    expect(await detail(await post(r.admin, `/users/${NOPE}/password`, { password: "pw123456" }), 404)).toBe("User not found");
    expect((await uid("vw")).password_hash).toBe(vw.password_hash);
    expect((await post(r.admin, `/users/${vw.id}/password`, { password: "brand-new-1" })).status).toBe(303);
    expect((await uid("vw")).password_hash).not.toBe(vw.password_hash);
    // every session of that user is gone with the reset (M2); r.viewer is signed out too
    expect((await d.get("/dashboard")).headers.get("location")).toBe("/login");
    expect(await one("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?", vw.id)).toEqual({ n: 0 });
    expect(await (await r.admin.get("/users")).text()).toContain('<div class="alert ok" role="alert">Password changed.</div>');
    // an admin resetting their own password keeps their own session
    const me = await uid("admin");
    expect((await post(r.admin, `/users/${me.id}/password`, { password: "test1234" })).status).toBe(303);
    expect((await r.admin.get("/users")).status).toBe(200);
    expect((await new Client().login("vw", "brand-new-1")).status).toBe(303);
    expect((await audits("user_set_password")).slice(0, 2).map((a) => a.target_id)).toEqual([String(me.id), String(vw.id)]);
  });

  it("email: column shows the address escaped, 400 invalid, 404 unknown, 409 duplicate, sets + audits", async () => {
    const ed = await uid("ed");
    const vw = await uid("vw");
    let page = await (await r.admin.get("/users")).text();
    expect(page).toContain('<th scope="col">Email</th>');
    expect(page).toContain(`<form method="post" action="/users/${ed.id}/email" class="inline duration-form">`);
    expect(page).toContain('name="email" placeholder="not set" maxlength="254" required');
    for (const [email, msg] of [["", "Enter an email address"], ["nope", "That does not look like an email address"], ["a b@example.com", "That does not look like an email address"]]) {
      expect(await detail(await post(r.admin, `/users/${ed.id}/email`, { email }), 400)).toBe(msg);
    }
    expect(await detail(await post(r.admin, `/users/${NOPE}/email`, { email: "x@example.com" }), 404)).toBe("User not found");
    expect((await post(r.admin, `/users/${ed.id}/email`, { email: " Ed@Example.com " })).status).toBe(303);
    expect(await one("SELECT email FROM users WHERE id = ?", ed.id)).toEqual({ email: "Ed@Example.com" });
    page = await (await r.admin.get("/users")).text();
    expect(page).toContain('<div class="alert ok" role="alert">Email address saved.</div>');
    expect(page).toContain('<div class="small">Ed@Example.com</div>');
    expect(page).toContain('name="email" placeholder="replace" maxlength="254" required');
    expect(await detail(await post(r.admin, `/users/${vw.id}/email`, { email: "ed@EXAMPLE.com" }), 409)).toBe("Another account already uses that email address");
    expect(await one("SELECT email FROM users WHERE id = ?", vw.id)).toEqual({ email: null });
    expect((await post(r.admin, `/users/${vw.id}/email`, { email: "<vw>@example.com" })).status).toBe(303);
    page = await (await r.admin.get("/users")).text();
    expect(page).toContain("&lt;vw&gt;@example.com");
    expect(page).not.toContain("<vw>@example.com");
    expect((await audits("user_set_email"))[0]).toMatchObject({ username: "admin", target_id: String(vw.id), details: '{"email": "<vw>@example.com"}' });
  });

  it("delete: self 400, last admin 400, 404 unknown, otherwise deletes + audits", async () => {
    const me = await uid("admin");
    expect(await detail(await post(r.admin, `/users/${me.id}/delete`), 400)).toBe("You cannot delete your own account");
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
    expect(await detail(await post(c3, `/users/${a3.id}/delete`), 400)).toBe("You cannot delete your own account");
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
    expect(await detail(await post(c4, `/users/${a4.id}/delete`), 400)).toBe("You cannot delete your own account");
    const ed = await uid("ed");
    await post(c4, `/users/${ed.id}/role`, { role: "admin" });
    await post(c4, `/users/${a4.id}/role`, { role: "viewer" }); // self-demote refused
    expect((await uid("admin4")).role).toBe("admin");
  });
});
