// Audit fixes for the auth-web-core package: login throttle ceilings (H1, M3), the ?next=
// open redirect (M1), anonymous session writes (M5), HTML error pages (H6), security headers
// (L1), no-store on pages (L2), Allow on 405 (L15) and the flashRedirect() notice mechanism.
import { beforeAll, describe, expect, it } from "vitest";
import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import * as auth from "../src/auth.js";
import { layout } from "../src/pages/layout.js";
import { BASE, Client, query, setupAdmin } from "./helpers.js";

const HTML = { accept: "text/html,application/xhtml+xml,*/*;q=0.8" };
const ipHeaders = (ip) => ({ "cf-connecting-ip": ip });
let admin;

beforeAll(async () => {
  admin = await setupAdmin("admin", "test1234");
  admin.token = await admin.csrf("/dashboard");
});

async function loginFrom(ip, username, password) {
  const c = new Client();
  const csrf_token = await c.csrf("/login");
  return c.post("/login", { username, password, csrf_token }, ipHeaders(ip));
}

describe("H1: username cap and per-ip ceiling", () => {
  it("a username over 64 chars is 400 before the throttle, writes no rows", async () => {
    const before = (await query("SELECT COUNT(*) AS n FROM audit_log"))[0].n;
    const r = await loginFrom("203.0.113.1", "u".repeat(auth.MAX_USERNAME_CHARS + 1), "x");
    expect(r.status).toBe(400);
    expect(await r.text()).toContain("Username too long");
    expect((await query("SELECT COUNT(*) AS n FROM audit_log"))[0].n).toBe(before);
    expect(await query("SELECT username FROM login_failures WHERE ip = '203.0.113.1'")).toEqual([]);
    // exactly 64 is still a normal (failed) login
    expect((await loginFrom("203.0.113.1", "u".repeat(auth.MAX_USERNAME_CHARS), "x")).status).toBe(200);
  });

  it("twenty failures from one ip under rotating usernames lock that ip", async () => {
    const codes = [];
    for (let i = 0; i < 21; i++) codes.push((await loginFrom("203.0.113.2", `user${i}`, "x")).status);
    expect(codes.slice(0, 20)).toEqual(Array(20).fill(200));
    expect(codes[20]).toBe(429);
    // the right password from that ip is refused too; another ip is unaffected
    expect((await loginFrom("203.0.113.2", "admin", "test1234")).status).toBe(429);
    expect((await loginFrom("203.0.113.3", "admin", "test1234")).status).toBe(303);
    await query("DELETE FROM login_failures WHERE ip = '203.0.113.2'");
  });
});

describe("M3: per-username ceiling across ips", () => {
  it("twenty wrong passwords for one user from twenty ips lock the account from anywhere", async () => {
    const codes = [];
    for (let i = 0; i < 20; i++) codes.push((await loginFrom(`198.51.100.${i}`, "admin", "wrong")).status);
    expect(codes).toEqual(Array(20).fill(200));
    expect((await loginFrom("198.51.100.99", "admin", "wrong")).status).toBe(429);
    const r = await loginFrom("198.51.100.100", "admin", "test1234");
    expect(r.status).toBe(429);
    expect(await r.text()).toContain("Too many failed attempts");
    // other accounts are not locked, and the rows survive the prune (10 minute window)
    expect((await loginFrom("198.51.100.100", "someone", "wrong")).status).toBe(200);
    expect(await auth.loginLockedFor(env, "198.51.100.5", "admin")).toBeGreaterThan(0);
    await query("UPDATE login_failures SET at = at - 601 WHERE username = 'admin'");
    expect(await auth.loginLockedFor(env, "198.51.100.101", "admin")).toBe(0);
    await query("DELETE FROM login_failures");
  });

  it("the shared enroll key is exempt from the per-username ceiling", async () => {
    for (let i = 0; i < 25; i++) await auth.recordLoginFailure(env, `192.0.2.${i}`, auth.ENROLL_KEY);
    expect(await auth.loginLockedFor(env, "192.0.2.200", auth.ENROLL_KEY, auth.ENROLL_MAX_FAILURES, auth.ENROLL_LOCK_SECONDS)).toBe(0);
    await query("DELETE FROM login_failures");
  });
});

describe("M1: ?next= is a same-origin path, re-serialised", () => {
  it("tab, newline, scheme-relative and absolute forms are dropped; a real path survives", async () => {
    for (const bad of ["/\t/evil.example", "/\n/x", "//evil.example/x", "https://evil.example/x", "/\\evil.example"]) {
      const c = new Client();
      const page = await c.get(`/login?next=${encodeURIComponent(bad)}`);
      expect(await page.text(), JSON.stringify(bad)).not.toContain('name="next"');
      const t = await c.csrf(`/login?next=${encodeURIComponent(bad)}`);
      const l = await c.post("/login", { username: "admin", password: "test1234", csrf_token: t, next: bad });
      expect([l.status, l.headers.get("location")], JSON.stringify(bad)).toEqual([303, "/dashboard"]);
      expect(l.headers.get("set-cookie")).toMatch(/^piplayer_session=/); // signed in, never a 500
    }
    const c = new Client();
    const next = "/authorize?code=ABCD-EF";
    expect(await (await c.get(`/login?next=${encodeURIComponent(next)}`)).text()).toContain(`name="next" value="${next}"`);
    const l = await c.post("/login", { username: "admin", password: "test1234", csrf_token: await c.csrf("/login"), next: "/authorize?code=ABCD-EF\nx" });
    expect(l.headers.get("location")).toBe("/authorize?code=ABCD-EFx");
  });
});

describe("M5: anonymous session writes", () => {
  it("GET /setup after setup is a 404 without a session row; expired rows are pruned on insert", async () => {
    await query("DELETE FROM sessions WHERE user_id IS NULL");
    const r = await new Client().get("/setup");
    expect(r.status).toBe(404);
    expect(r.headers.get("set-cookie")).toBeNull();
    expect((await query("SELECT COUNT(*) AS n FROM sessions WHERE user_id IS NULL"))[0].n).toBe(0);
    await query("INSERT INTO sessions (id, user_id, csrf, expires_at) VALUES ('stale', NULL, 'c', '2000-01-01 00:00:00')");
    await new Client().get("/login");
    expect(await query("SELECT id FROM sessions WHERE id = 'stale'")).toEqual([]);
  });
});

describe("H6: browser errors are pages, API and script errors stay JSON", () => {
  it("a duplicate name posted by a browser renders in the layout with a Back link", async () => {
    await admin.post("/playlists", { name: "Lobby Loop" }, { "X-CSRF-Token": admin.token });
    const r = await admin.post("/playlists", { name: "Lobby Loop" }, { "X-CSRF-Token": admin.token, ...HTML, referer: `${BASE}/playlists` });
    expect(r.status).toBe(409);
    expect(r.headers.get("content-type")).toContain("text/html");
    const text = await r.text();
    expect(text).toContain('<div class="alert error" role="alert">A playlist with that name already exists</div>');
    expect(text).toContain(`<a href="${BASE}/playlists" class="back">`);
    expect(text).toContain('href="/dashboard"'); // nav is there
  });

  it("a role denial page for a viewer; the same request without Accept: text/html is JSON", async () => {
    await admin.post("/users", { username: "vw", password: "viewer-pass", role: "viewer" }, { "X-CSRF-Token": admin.token });
    const vw = new Client();
    await vw.login("vw", "viewer-pass");
    const page = await vw.fetch("/settings", { headers: { ...HTML, referer: "https://evil.example/" } });
    expect(page.status).toBe(403);
    expect(page.headers.get("content-type")).toContain("text/html");
    const text = await page.text();
    expect(text).toContain("requires admin role");
    expect(text).toContain('<a href="/dashboard" class="back">'); // off-site referer is not used
    const j = await vw.get("/settings");
    expect(j.status).toBe(403);
    expect(await j.json()).toEqual({ detail: "requires admin role" });
    // the device api never renders HTML, whatever Accept says
    const api = await SELF.fetch(BASE + "/api/sync/x", { headers: HTML, redirect: "manual" });
    expect(api.status).toBe(401);
    expect(api.headers.get("content-type")).toBe("application/json");
  });
});

describe("L1 + L2 + L15: response headers", () => {
  it("security headers on pages, JSON errors and static assets", async () => {
    const anon = await new Client().get("/login");
    const page = await admin.get("/dashboard");
    const missing = await new Client().get("/nope");
    const css = await new Client().get("/static/style.css");
    for (const res of [anon, page, missing, css]) {
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("x-frame-options")).toBe("DENY");
      expect(res.headers.get("referrer-policy")).toBe("same-origin");
      expect(res.headers.get("content-security-policy")).toBe("default-src 'self'; img-src 'self' data:; frame-src https:; frame-ancestors 'none'");
      expect(res.headers.get("strict-transport-security")).toBe("max-age=31536000");
    }
  });

  it("every HTML page is Cache-Control: no-store", async () => {
    for (const p of ["/login", "/settings", "/devices", "/users"]) {
      const r = await admin.get(p);
      expect(r.status, p).toBe(200);
      expect(r.headers.get("cache-control"), p).toBe("no-store");
    }
  });

  it("405 carries Allow, including for OPTIONS", async () => {
    const r = await SELF.fetch(BASE + "/api/enroll", { method: "PUT", redirect: "manual" });
    expect(r.status).toBe(405);
    expect(r.headers.get("allow")).toBe("POST");
    expect(await r.json()).toEqual({ detail: "Method Not Allowed" });
    expect((await SELF.fetch(BASE + "/login", { method: "OPTIONS", redirect: "manual" })).headers.get("allow")).toBe("GET, HEAD, POST");
  });
});

describe("flashRedirect + layout", () => {
  const ctx = (cookie) => ({
    env, request: new Request(BASE + "/x", { headers: cookie ? { cookie } : {} }),
    url: new URL(BASE + "/x"), user: null, csrf: "t", cookies: [],
  });

  it("sets a one-shot HttpOnly cookie and returns the redirect", async () => {
    const c = ctx();
    const res = auth.flashRedirect(c, "/settings", "Saved & done", "ok");
    expect([res.status, res.headers.get("location")]).toEqual([303, "/settings"]);
    expect(c.cookies).toHaveLength(1);
    expect(c.cookies[0]).toMatch(/^piplayer_flash=[^;]+; HttpOnly; Secure; SameSite=Lax; Path=\/; Max-Age=60$/);
    const value = decodeURIComponent(c.cookies[0].split(";")[0].slice("piplayer_flash=".length));
    expect(JSON.parse(value)).toEqual({ m: "Saved & done", k: "ok" });
  });

  it("layout shows the notice once (escaped, in the given kind) and clears the cookie", async () => {
    const flashed = ctx();
    auth.flashRedirect(flashed, "/x", "Saved <b>ok</b>", "warn");
    const c = ctx(flashed.cookies[0].split(";")[0]);
    const text = await layout(c, { title: "T", content: "<p>body</p>" }).text();
    expect(text).toContain('<div class="alert warn" role="alert">Saved &lt;b&gt;ok&lt;/b&gt;</div>');
    expect(c.cookies).toEqual([`piplayer_flash=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`]);
    // an explicit message wins and leaves the cookie alone; a junk cookie is just cleared
    const c2 = ctx(flashed.cookies[0].split(";")[0]);
    expect(await layout(c2, { content: "", message: "mine" }).text()).toContain(">mine</div>");
    expect(c2.cookies).toEqual([]);
    const c3 = ctx("piplayer_flash=%7Bnot-json");
    expect(await layout(c3, { content: "" }).text()).not.toContain('role="alert"');
    expect(c3.cookies[0]).toContain("Max-Age=0");
  });

  it("end to end: the redirect's cookie is set, the next page shows it, the page after does not", async () => {
    // No call site uses flashRedirect yet (stage 2), so drive it through a real page by cookie.
    const c = ctx();
    auth.flashRedirect(c, "/dashboard", "Settings saved");
    const cookie = `${admin.cookie}; ${c.cookies[0].split(";")[0]}`;
    const r = await SELF.fetch(BASE + "/dashboard", { headers: { cookie }, redirect: "manual" });
    expect(await r.text()).toContain('<div class="alert ok" role="alert">Settings saved</div>');
    expect(r.headers.get("set-cookie")).toMatch(/^piplayer_flash=; .*Max-Age=0$/);
    expect(await (await admin.get("/dashboard")).text()).not.toContain("Settings saved");
  });
});
