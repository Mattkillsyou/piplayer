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
    const res = await c.post("/signup", { username: "newbie", password: "pw123456", password2: "pw123456", csrf_token });
    expect([res.status, res.headers.get("location")]).toEqual([303, "/dashboard"]);
    const dash = await c.get("/dashboard");
    expect(dash.status).toBe(200);
    const text = await dash.text();
    expect(text).toContain("Welcome, newbie");
    expect(text).toContain('badge-editor">editor');
    expect(await query("SELECT username, role FROM users WHERE username = 'newbie'")).toEqual([{ username: "newbie", role: "editor" }]);
    const row = (await audits("user_signup"))[0];
    expect(row.username).toBe("newbie");
    expect(row.details).toBe('{"username": "newbie", "role": "editor"}');
  });

  it("re-renders the form with the message and the typed username on a mistake; a taken name is refused", async () => {
    const c = new Client();
    const csrf_token = await c.csrf("/signup");
    const cases = [
      [{ username: "", password: "pw123456", password2: "pw123456" }, 400, "Enter a username"],
      [{ username: "shorty", password: "pw1", password2: "pw1" }, 400, "at least 6"],
      [{ username: "mismatch", password: "pw123456", password2: "pw123457" }, 400, "do not match"],
      [{ username: "x".repeat(65), password: "pw123456", password2: "pw123456" }, 400, "at most 64"],
      [{ username: "newbie", password: "pw123456", password2: "pw123456" }, 409, "taken"],
      [{ username: "admin​", password: "pw123456", password2: "pw123456" }, 400, "letters, digits"],
      [{ username: "ad min", password: "pw123456", password2: "pw123456" }, 400, "letters, digits"],
      [{ username: "signup", password: "pw123456", password2: "pw123456" }, 400, "taken"],
    ];
    for (const [fields, status, message] of cases) {
      const res = await c.post("/signup", { ...fields, csrf_token });
      expect(res.status, fields.username).toBe(status);
      const text = await res.text();
      expect(text, fields.username).toContain(message);
      if (fields.username && fields.username.length <= 64) expect(text).toContain(`value="${fields.username}"`);
      expect(text).toContain('name="csrf_token"');
    }
    expect((await query("SELECT COUNT(*) AS n FROM users WHERE username IN ('shorty', 'mismatch', 'signup', 'ad min')"))[0].n).toBe(0);
  });

  it("a taken name is refused before any password hashing and still counts toward the per-address cap", async () => {
    await query("DELETE FROM login_failures");
    const ip = { "cf-connecting-ip": "198.51.100.20" };
    for (let i = 0; i < SIGNUPS_PER_IP; i++) {
      const c = new Client();
      const csrf_token = await c.csrf("/signup");
      const t0 = Date.now();
      expect((await c.post("/signup", { username: "newbie", password: "pw123456", password2: "pw123456", csrf_token }, ip)).status).toBe(409);
      expect(Date.now() - t0, "no PBKDF2 on the taken path").toBeLessThan(200);
    }
    const c = new Client();
    const csrf_token = await c.csrf("/signup");
    expect((await c.post("/signup", { username: "fresh-name", password: "pw123456", password2: "pw123456", csrf_token }, ip)).status).toBe(429);
  });

  it("sign-ups elsewhere and failed logins typed as 'signup' never lock sign-up for another address", async () => {
    await query("DELETE FROM login_failures");
    // twenty sign-ups from twenty addresses: the per-username ceiling does not apply to the synthetic key
    for (let i = 0; i < 20; i++) {
      const c = new Client();
      const csrf_token = await c.csrf("/signup");
      expect((await c.post("/signup", { username: `wide${i}`, password: "pw123456", password2: "pw123456", csrf_token }, { "cf-connecting-ip": `203.0.113.${i + 1}` })).status).toBe(303);
    }
    // a login attempt with the reserved name writes no throttle row
    const l = new Client();
    const csrf_token = await l.csrf("/login");
    expect((await l.post("/login", { username: "signup", password: "x", csrf_token }, { "cf-connecting-ip": "203.0.113.99" })).status).toBe(200);
    expect((await query("SELECT COUNT(*) AS n FROM login_failures WHERE ip = '203.0.113.99'"))[0].n).toBe(0);
    const c = new Client();
    const t2 = await c.csrf("/signup");
    expect((await c.post("/signup", { username: "twentyfirst", password: "pw123456", password2: "pw123456", csrf_token: t2 }, { "cf-connecting-ip": "203.0.113.99" })).status).toBe(303);
  });

  it("needs a live form session and the matching csrf token", async () => {
    const cold = await new Client().post("/signup", { username: "cold", password: "pw123456", password2: "pw123456" });
    expect([cold.status, cold.headers.get("location")]).toEqual([303, "/signup?expired=1"]);
    expect(await (await new Client().get("/signup?expired=1")).text()).toContain("had expired");
    const c = new Client();
    await c.csrf("/signup");
    const bad = await c.post("/signup", { username: "forged", password: "pw123456", password2: "pw123456", csrf_token: "nope" });
    expect(bad.status).toBe(403);
    expect((await query("SELECT COUNT(*) AS n FROM users WHERE username IN ('cold', 'forged')"))[0].n).toBe(0);
  });

  it(`allows ${SIGNUPS_PER_IP} accounts per address, then answers 429 with the form intact`, async () => {
    await query("DELETE FROM login_failures");
    const ip = { "cf-connecting-ip": "198.51.100.7" };
    for (let i = 0; i < SIGNUPS_PER_IP; i++) {
      const c = new Client();
      const csrf_token = await c.csrf("/signup");
      const res = await c.post("/signup", { username: `bulk${i}`, password: "pw123456", password2: "pw123456", csrf_token }, ip);
      expect(res.status, `signup ${i}`).toBe(303);
    }
    const c = new Client();
    const csrf_token = await c.csrf("/signup");
    const res = await c.post("/signup", { username: "bulk-extra", password: "pw123456", password2: "pw123456", csrf_token }, ip);
    expect(res.status).toBe(429);
    expect(await res.text()).toContain("Too many sign-ups");
    expect((await query("SELECT COUNT(*) AS n FROM users WHERE username = 'bulk-extra'"))[0].n).toBe(0);
    // another address is unaffected
    const other = new Client();
    const t2 = await other.csrf("/signup");
    expect((await other.post("/signup", { username: "elsewhere", password: "pw123456", password2: "pw123456", csrf_token: t2 }, { "cf-connecting-ip": "198.51.100.8" })).status).toBe(303);
  });
});
