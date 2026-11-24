// /account (account track): every role changes its own password and email. Nothing changes
// without the current password, wrong ones count against the login throttle (the same ip + username
// budget), a new password ends the user's other sessions, either change retires the mailed reset
// links, and the name in the top bar links here.
import { beforeAll, describe, expect, it } from "vitest";
import * as auth from "../src/auth.js";
import { Client, query } from "./helpers.js";
import { audits, ins, one, post, roles } from "./pages_common.js";

let r;
const OLD = "first-pass";

// A new account made on /users, so the throttle and the password changes touch no other test's sign-in.
async function account(username, role = "editor") {
  expect((await post(r.admin, "/users", { username, password: OLD, role })).status).toBe(303);
  return (await one("SELECT id FROM users WHERE username = ?", username)).id;
}
async function signIn(username, password) {
  const c = new Client();
  const res = await c.login(username, password);
  expect([res.status, res.headers.get("location")], `sign in as ${username}`).toEqual([303, "/dashboard"]);
  c.token = await c.csrf("/account");
  return c;
}
const signsIn = async (username, password) => (await new Client().login(username, password)).headers.get("location") === "/dashboard";
// The page's notice: [kind, text], or null.
const notice = (html) => /<div class="alert (\w+)" role="alert">([^<]*)<\/div>/.exec(html)?.slice(1) ?? null;
const save = async (c, fields) => {
  const res = await post(c, "/account", fields);
  return { status: res.status, location: res.headers.get("location"), html: await res.text() };
};
const failures = (username) => query("SELECT COUNT(*) AS n FROM login_failures WHERE username = ?", username).then((x) => x[0].n);
const reset = (userId, hash) => ins("INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES (?, ?, datetime('now', '+30 minutes'))", userId, hash);

beforeAll(async () => {
  r = await roles();
});

describe("the page", () => {
  it("opens for every role with its own address filled in; the name in the top bar links to it", async () => {
    await query("UPDATE users SET email = 'vw@example.net' WHERE id = ?", r.ids.viewer);
    for (const c of [r.viewer, r.editor, r.admin]) {
      const res = await c.get("/account");
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("<h1>Your account</h1>");
      expect(html).toMatch(/<form method="post" action="\/account">\s*<input type="hidden" name="csrf_token" value="[^"]+">/);
      for (const name of ["current_password", "password", "password2"]) expect(html).toContain(`<input type="password" name="${name}"`);
      expect(html).toContain('autocomplete="current-password"');
    }
    const viewer = await (await r.viewer.get("/account")).text();
    expect(viewer).toContain('<input type="email" name="email" value="vw@example.net"');
    expect(viewer).toContain('<a class="username" href="/account" title="vw">vw</a>');
    expect(await (await r.editor.get("/dashboard")).text()).toContain('<a class="username" href="/account" title="ed">ed</a>');
    // a finger-sized link in the phone menu
    expect(await (await r.viewer.get("/static/style.css")).text()).toContain(
      "@media (max-width: 1240px), (pointer: coarse) { .topbar .user a.username { display: flex; align-items: center; min-width: var(--p5k-touch); min-height: var(--p5k-touch); } }");
    const anon = await new Client().get("/account");
    expect([anon.status, anon.headers.get("location")]).toEqual([303, "/login"]);
  });
});

describe("a new password", () => {
  it("needs the current one; then it signs in, the old one does not, and the user's other sessions end", async () => {
    const id = await account("pat");
    const here = await signIn("pat", OLD);
    const elsewhere = await signIn("pat", OLD);
    await reset(id, "a".repeat(64));
    const res = await save(here, { current_password: OLD, password: "second-pass", password2: "second-pass" });
    expect([res.status, res.location]).toEqual([303, "/account"]);
    expect(notice(await (await here.get("/account")).text())).toEqual(["ok", "Password changed."]);
    expect((await here.get("/dashboard")).status).toBe(200); // this session stays
    const gone = await elsewhere.get("/dashboard");
    expect([gone.status, gone.headers.get("location")]).toEqual([303, "/login"]);
    expect(await signsIn("pat", OLD)).toBe(false);
    expect(await signsIn("pat", "second-pass")).toBe(true);
    expect(await one("SELECT used_at IS NOT NULL AS used FROM password_resets WHERE user_id = ?", id)).toEqual({ used: 1 });
    expect((await audits("user_set_password"))[0]).toMatchObject({ username: "pat", target_type: "user", target_id: String(id) });
    expect(await one("SELECT owner_id FROM audit_log WHERE action = 'user_set_password' AND username = 'pat'")).toEqual({ owner_id: id });
  });

  it("a viewer changes its own too", async () => {
    await account("val", "viewer");
    const c = await signIn("val", OLD);
    expect((await save(c, { current_password: OLD, password: "val-second", password2: "val-second" })).status).toBe(303);
    expect(await signsIn("val", "val-second")).toBe(true);
  });

  it("a wrong current password changes nothing and counts as a failed sign-in: five lock /account and /login alike", async () => {
    await account("quinn");
    const c = await signIn("quinn", OLD);
    const hash = (await one("SELECT password_hash FROM users WHERE username = 'quinn'")).password_hash;
    for (let i = 1; i <= auth.LOGIN_MAX_FAILURES; i++) {
      const res = await save(c, { current_password: "not-it", password: "third-pass", password2: "third-pass" });
      expect(res.status).toBe(400);
      expect(notice(res.html)).toEqual(["error", "The current password is wrong"]);
      expect(await failures("quinn")).toBe(i);
    }
    // locked: even the right one is refused, here and on the sign-in form
    const locked = await save(c, { current_password: OLD, password: "third-pass", password2: "third-pass" });
    expect(locked.status).toBe(429);
    expect(notice(locked.html)[1]).toMatch(/^Too many failed attempts; try again in \d+ s$/);
    expect((await new Client().login("quinn", OLD)).status).toBe(429);
    expect((await one("SELECT password_hash FROM users WHERE username = 'quinn'")).password_hash).toBe(hash);
    expect(await audits("user_set_password").then((a) => a.filter((x) => x.username === "quinn"))).toEqual([]);
  });

  it("a right one clears the earlier failures, as a sign-in does", async () => {
    await account("rae");
    const c = await signIn("rae", OLD);
    await save(c, { current_password: "nope-nope", password: "rae-second", password2: "rae-second" });
    expect(await failures("rae")).toBe(1);
    expect((await save(c, { current_password: OLD, password: "rae-second", password2: "rae-second" })).status).toBe(303);
    expect(await failures("rae")).toBe(0);
  });

  it("is refused before the current password is checked when the two differ, it is too short, or nothing changes", async () => {
    await account("sky");
    const c = await signIn("sky", OLD);
    for (const [fields, message] of [
      [{ password: "sky-second", password2: "sky-secnod" }, "The two new passwords do not match"],
      [{ password: "short", password2: "short" }, auth.PASSWORD_TOO_SHORT_MSG],
      [{ password: "p".repeat(1025), password2: "p".repeat(1025) }, auth.PASSWORD_TOO_LONG_MSG],
      [{}, "Enter a new password or a new email address"],
      [{ email: "not-an-address" }, "That does not look like an email address"],
    ]) {
      const res = await save(c, { current_password: "wrong-anyway", ...fields });
      expect(res.status, message).toBe(400);
      expect(notice(res.html)).toEqual(["error", message]);
    }
    expect(await failures("sky")).toBe(0);
    expect(await signsIn("sky", OLD)).toBe(true);
  });
});

describe("a new email address", () => {
  it("is saved with the current password, keeps the sessions and retires the mailed links; an empty box keeps the address", async () => {
    const id = await account("tam");
    const here = await signIn("tam", OLD);
    const elsewhere = await signIn("tam", OLD);
    await reset(id, "b".repeat(64));
    expect((await save(here, { current_password: OLD, email: " tam@example.net " })).location).toBe("/account");
    const html = await (await here.get("/account")).text();
    expect(notice(html)).toEqual(["ok", "Email address saved."]);
    expect(html).toContain('<input type="email" name="email" value="tam@example.net"');
    expect(await one("SELECT email FROM users WHERE id = ?", id)).toEqual({ email: "tam@example.net" });
    expect((await elsewhere.get("/dashboard")).status).toBe(200);
    expect(await one("SELECT used_at IS NOT NULL AS used FROM password_resets WHERE user_id = ?", id)).toEqual({ used: 1 });
    expect((await audits("user_set_email"))[0]).toMatchObject({ username: "tam", target_id: String(id), details: '{"email": "tam@example.net"}' });
    // a password change with the box left empty, or as it was, leaves the address alone
    for (const email of ["", "tam@example.net"]) {
      const res = await save(here, { current_password: OLD, email, password: OLD, password2: OLD });
      expect(res.status).toBe(303);
      expect(notice(await (await here.get("/account")).text())).toEqual(["ok", "Password changed."]);
    }
    expect(await one("SELECT email FROM users WHERE id = ?", id)).toEqual({ email: "tam@example.net" });
  });

  it("another account's address (any case) is a 409 that changes nothing, the new password included", async () => {
    const id = await account("uma");
    await query("UPDATE users SET email = 'Taken@Example.net' WHERE username = 'ed'");
    const c = await signIn("uma", OLD);
    const res = await save(c, { current_password: OLD, email: "taken@example.NET", password: "uma-second", password2: "uma-second" });
    expect(res.status).toBe(409);
    expect(notice(res.html)).toEqual(["error", "Another account already uses that email address"]);
    expect(res.html).toContain('<input type="email" name="email" value="taken@example.NET"'); // what was typed stays in the box
    expect(await one("SELECT email FROM users WHERE id = ?", id)).toEqual({ email: null });
    expect(await signsIn("uma", OLD)).toBe(true);
    expect(await signsIn("uma", "uma-second")).toBe(false);
  });

  it("with a new password says both", async () => {
    await account("vic");
    const c = await signIn("vic", OLD);
    expect((await save(c, { current_password: OLD, email: "vic@example.net", password: "vic-second", password2: "vic-second" })).status).toBe(303);
    expect(notice(await (await c.get("/account")).text())).toEqual(["ok", "Password changed and email address saved."]);
  });
});
