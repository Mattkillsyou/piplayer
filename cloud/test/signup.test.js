// /signup: open self sign-up from the login page; new accounts are editors (the owner's choice).
import { beforeAll, describe, expect, it } from "vitest";
import { SIGNUPS_PER_IP } from "../src/pages/signup.js";
import { Client, query, wipe } from "./helpers.js";
import { audits, roles } from "./pages_common.js";

describe("sign-up", () => {
  let r;
  beforeAll(async () => {
    await wipe();
    r = await roles();
  });

  it("the login page links to it; the form carries a csrf token; a signed-in user is sent to the dashboard", async () => {
    const c = new Client();
    expect(await (await c.get("/login")).text()).toContain('href="/signup"');
    const page = await c.get("/signup");
    expect(page.status).toBe(200);
    const text = await page.text();
    expect(text).toContain('name="csrf_token"');
    expect(text).toContain("Create account");
    expect(text).not.toContain("ACCESS DENIED");
    const mine = await r.viewer.get("/signup");
    expect([mine.status, mine.headers.get("location")]).toEqual([303, "/dashboard"]);
  });

  it("creates an editor, signs them in with a welcome notice, and audits user_signup", async () => {
    const c = new Client();
    const csrf_token = await c.csrf("/signup");
    const res = await c.post("/signup", { username: "newbie", email: " Newbie@Example.com ", password: "pw123456", password2: "pw123456", csrf_token });
    expect([res.status, res.headers.get("location")]).toEqual([303, "/dashboard"]);
    const dash = await c.get("/dashboard");
    expect(dash.status).toBe(200);
    const text = await dash.text();
    expect(text).toContain("Welcome, newbie");
    expect(text).toContain('badge-editor">editor');
    expect(await query("SELECT username, email, role FROM users WHERE username = 'newbie'")).toEqual([{ username: "newbie", email: "Newbie@Example.com", role: "editor" }]);
    const row = (await audits("user_signup"))[0];
    expect(row.username).toBe("newbie");
    expect(row.details).toBe('{"username": "newbie", "email": "Newbie@Example.com", "role": "editor"}');
  });

  it("re-renders the form with the message and the typed username and email on a mistake; a taken name or address is refused", async () => {
    const c = new Client();
    const csrf_token = await c.csrf("/signup");
    const page = await (await c.get("/signup")).text();
    expect(page).toContain('<input type="email" name="email" value="" autocomplete="email" maxlength="254" required>');
    const ok = { email: "someone@example.com", password: "pw123456", password2: "pw123456" };
    const cases = [
      [{ ...ok, username: "" }, 400, "Enter a username"],
      [{ ...ok, username: "shorty", password: "pw1", password2: "pw1" }, 400, "at least 6"],
      [{ ...ok, username: "mismatch", password: "pw123456", password2: "pw123457" }, 400, "do not match"],
      [{ ...ok, username: "x".repeat(65) }, 400, "at most 64"],
      [{ ...ok, username: "newbie" }, 409, "taken"],
      [{ ...ok, username: "admin​" }, 400, "letters, digits"],
      [{ ...ok, username: "ad min" }, 400, "letters, digits"],
      [{ ...ok, username: "signup" }, 400, "taken"],
      [{ ...ok, username: "forgot" }, 400, "taken"],
      [{ ...ok, username: "noemail", email: "" }, 400, "Enter an email address"],
      [{ ...ok, username: "noat", email: "someone.example.com" }, 400, "does not look like an email address"],
      [{ ...ok, username: "twoat", email: "some@one@example.com" }, 400, "does not look like an email address"],
      [{ ...ok, username: "spacey", email: "some one@example.com" }, 400, "does not look like an email address"],
      [{ ...ok, username: "bare", email: "@example.com" }, 400, "does not look like an email address"],
      [{ ...ok, username: "long", email: "a".repeat(250) + "@x.io" }, 400, "at most 254"],
      [{ ...ok, username: "dupe", email: "newbie@example.com" }, 409, "That email address already has an account"],
      [{ ...ok, username: "dupe2", email: "NEWBIE@EXAMPLE.COM" }, 409, "That email address already has an account"],
    ];
    for (const [fields, status, message] of cases) {
      const res = await c.post("/signup", { ...fields, csrf_token });
      expect(res.status, fields.username).toBe(status);
      const text = await res.text();
      expect(text, fields.username).toContain(message);
      if (fields.username && fields.username.length <= 64) expect(text).toContain(`value="${fields.username}"`);
      if (fields.email.length <= 254) expect(text).toContain(`name="email" value="${fields.email}"`);
      expect(text).toContain('name="csrf_token"');
    }
    expect((await query("SELECT COUNT(*) AS n FROM users WHERE username IN ('shorty', 'mismatch', 'signup', 'ad min', 'noemail', 'noat', 'dupe', 'dupe2')"))[0].n).toBe(0);
  });

  it("a taken address is refused before any password hashing; the address is stored as typed", async () => {
    await query("DELETE FROM login_failures");
    const c = new Client();
    const csrf_token = await c.csrf("/signup");
    const t0 = Date.now();
    expect((await c.post("/signup", { username: "dupe3", email: "newbie@example.com", password: "pw123456", password2: "pw123456", csrf_token })).status).toBe(409);
    expect(Date.now() - t0, "no PBKDF2 on the taken path").toBeLessThan(200);
    expect((await c.post("/signup", { username: "dupe3", email: "Dupe3@Example.org", password: "pw123456", password2: "pw123456", csrf_token })).status).toBe(303);
    expect(await query("SELECT email FROM users WHERE username = 'dupe3'")).toEqual([{ email: "Dupe3@Example.org" }]);
  });

  it("a taken name is refused before any password hashing and still counts toward the per-address cap", async () => {
    await query("DELETE FROM login_failures");
    const ip = { "cf-connecting-ip": "198.51.100.20" };
    for (let i = 0; i < SIGNUPS_PER_IP; i++) {
      const c = new Client();
      const csrf_token = await c.csrf("/signup");
      const t0 = Date.now();
      expect((await c.post("/signup", { username: "newbie", email: "x@example.com", password: "pw123456", password2: "pw123456", csrf_token }, ip)).status).toBe(409);
      expect(Date.now() - t0, "no PBKDF2 on the taken path").toBeLessThan(200);
    }
    const c = new Client();
    const csrf_token = await c.csrf("/signup");
    expect((await c.post("/signup", { username: "fresh-name", email: "fresh@example.com", password: "pw123456", password2: "pw123456", csrf_token }, ip)).status).toBe(429);
  });

  it("sign-ups elsewhere and failed logins typed as 'signup' never lock sign-up for another address", async () => {
    await query("DELETE FROM login_failures");
    // twenty sign-ups from twenty addresses: the per-username ceiling does not apply to the synthetic key
    for (let i = 0; i < 20; i++) {
      const c = new Client();
      const csrf_token = await c.csrf("/signup");
      expect((await c.post("/signup", { username: `wide${i}`, email: `wide${i}@example.com`, password: "pw123456", password2: "pw123456", csrf_token }, { "cf-connecting-ip": `203.0.113.${i + 1}` })).status).toBe(303);
    }
    // a login attempt with the reserved name writes no throttle row
    const l = new Client();
    const csrf_token = await l.csrf("/login");
    expect((await l.post("/login", { username: "signup", password: "x", csrf_token }, { "cf-connecting-ip": "203.0.113.99" })).status).toBe(200);
    expect((await query("SELECT COUNT(*) AS n FROM login_failures WHERE ip = '203.0.113.99'"))[0].n).toBe(0);
    const c = new Client();
    const t2 = await c.csrf("/signup");
    expect((await c.post("/signup", { username: "twentyfirst", email: "twentyfirst@example.com", password: "pw123456", password2: "pw123456", csrf_token: t2 }, { "cf-connecting-ip": "203.0.113.99" })).status).toBe(303);
  });

  it("needs a live form session and the matching csrf token", async () => {
    const cold = await new Client().post("/signup", { username: "cold", email: "cold@example.com", password: "pw123456", password2: "pw123456" });
    expect([cold.status, cold.headers.get("location")]).toEqual([303, "/signup?expired=1"]);
    expect(await (await new Client().get("/signup?expired=1")).text()).toContain("had expired");
    const c = new Client();
    await c.csrf("/signup");
    const bad = await c.post("/signup", { username: "forged", email: "forged@example.com", password: "pw123456", password2: "pw123456", csrf_token: "nope" });
    expect(bad.status).toBe(403);
    expect((await query("SELECT COUNT(*) AS n FROM users WHERE username IN ('cold', 'forged')"))[0].n).toBe(0);
  });

  it(`allows ${SIGNUPS_PER_IP} accounts per address, then answers 429 with the form intact`, async () => {
    await query("DELETE FROM login_failures");
    const ip = { "cf-connecting-ip": "198.51.100.7" };
    for (let i = 0; i < SIGNUPS_PER_IP; i++) {
      const c = new Client();
      const csrf_token = await c.csrf("/signup");
      const res = await c.post("/signup", { username: `bulk${i}`, email: `bulk${i}@example.com`, password: "pw123456", password2: "pw123456", csrf_token }, ip);
      expect(res.status, `signup ${i}`).toBe(303);
    }
    const c = new Client();
    const csrf_token = await c.csrf("/signup");
    const res = await c.post("/signup", { username: "bulk-extra", email: "bulk-extra@example.com", password: "pw123456", password2: "pw123456", csrf_token }, ip);
    expect(res.status).toBe(429);
    expect(await res.text()).toContain("Too many sign-ups");
    expect((await query("SELECT COUNT(*) AS n FROM users WHERE username = 'bulk-extra'"))[0].n).toBe(0);
    // another address is unaffected
    const other = new Client();
    const t2 = await other.csrf("/signup");
    expect((await other.post("/signup", { username: "elsewhere", email: "elsewhere@example.com", password: "pw123456", password2: "pw123456", csrf_token: t2 }, { "cf-connecting-ip": "198.51.100.8" })).status).toBe(303);
  });
});
