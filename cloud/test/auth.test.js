import { beforeAll, describe, expect, it } from "vitest";
import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import * as auth from "../src/auth.js";
import { HttpError } from "../src/util.js";
import { Client, query, setupAdmin } from "./helpers.js";

const CSRF_DETAIL = "CSRF token missing or invalid";
const META = /<meta name="csrf-token" content="([^"]+)">/;
const HIDDEN = /name="csrf_token" value="([^"]+)"/;
const sessionId = (c) => c.cookie.slice("piplayer_session=".length).split(".")[0];

beforeAll(async () => {
  await setupAdmin("admin", "test1234");
});

describe("passwords", () => {
  it("pbkdf2 hash round-trips and rejects the wrong password / garbage hashes", async () => {
    const h = await auth.hashPassword("hunter22");
    expect(h.startsWith("pbkdf2$100000$")).toBe(true);
    expect(await auth.verifyPassword("hunter22", h)).toBe(true);
    expect(await auth.verifyPassword("hunter23", h)).toBe(false);
    expect(await auth.verifyPassword("hunter22", "$2b$12$notpbkdf2")).toBe(false);
    expect(await auth.verifyPassword("hunter22", null)).toBe(false);
  });

  it("caps passwords at 1024 bytes and 6 chars minimum", async () => {
    await expect(auth.hashPassword("p".repeat(1025))).rejects.toMatchObject({ status: 400 });
    expect(auth.passwordProblem("short")).toContain("6");
    expect(auth.passwordProblem("é".repeat(600))).toContain("1024");
    expect(auth.passwordProblem("okpass")).toBe("");
  });

  it("timingSafeEqual", () => {
    expect(auth.timingSafeEqual("abc", "abc")).toBe(true);
    expect(auth.timingSafeEqual("abc", "abd")).toBe(false);
    expect(auth.timingSafeEqual("abc", "abcd")).toBe(false);
    expect(auth.timingSafeEqual("", "")).toBe(true);
  });
});

describe("csrf", () => {
  it("login page exposes the token in meta and hidden input, stable within a session", async () => {
    const c = new Client();
    const t1 = await (await c.get("/login")).text();
    expect(META.exec(t1)[1]).toBe(HIDDEN.exec(t1)[1]);
    expect(META.exec(t1)[1].length).toBeGreaterThanOrEqual(32);
    const t2 = await (await c.get("/login")).text();
    expect(META.exec(t2)[1]).toBe(META.exec(t1)[1]);
    expect(c.cookie).toMatch(/^piplayer_session=/);
  });

  it("POST without a token is 403 JSON; header and form field both work", async () => {
    const c = new Client();
    await c.get("/login");
    let r = await c.post("/login", { username: "admin", password: "test1234" });
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ detail: CSRF_DETAIL });
    r = await c.post("/login", { username: "admin", password: "test1234", csrf_token: "bogus" });
    expect(r.status).toBe(403);
    const token = await c.csrf();
    r = await c.post("/login", { username: "admin", password: "test1234" }, { "X-CSRF-Token": token });
    expect(r.status).toBe(303);
  });

  it("a tampered cookie is ignored (fresh anonymous session)", async () => {
    const c = new Client();
    await c.get("/login");
    const id = sessionId(c);
    c.cookie = `piplayer_session=${id}.AAAA`;
    const r = await c.get("/login");
    expect(r.status).toBe(200);
    expect(c.cookie).not.toContain(`${id}.`);
  });

  it("/api/* is exempt from CSRF (bearer auth instead)", async () => {
    const r = await new Client().postJson("/api/commands/1/result", { result: "x" });
    expect(r.status).toBe(401); // bearer auth, never the 403 csrf answer
    expect(await r.json()).toEqual({ detail: "Missing bearer token" });
  });

  // Mirrors cms/app/auth.py require_csrf: a form POST whose session is gone is sent back to
  // the login page (with the notice), never left on a JSON 403.
  it("a POST without a live session is 303 /login?expired=1, and the page says so", async () => {
    const c = new Client();
    await c.login("admin", "test1234");
    const token = await c.csrf("/dashboard");
    await query("DELETE FROM sessions WHERE id = ?", sessionId(c));
    let r = await c.post("/playlists", { name: "x", csrf_token: token });
    expect([r.status, r.headers.get("location")]).toEqual([303, "/login?expired=1"]);
    r = await c.post("/logout", {});
    expect([r.status, r.headers.get("location")]).toEqual([303, "/login?expired=1"]);
    // no cookie at all: same answer, and nothing is written (no session handed out)
    const bare = new Client();
    r = await bare.post("/playlists", { name: "x" });
    expect([r.status, r.headers.get("location"), bare.cookie]).toEqual([303, "/login?expired=1", null]);
    // an anonymous POST (valid anonymous token or not) is the same
    const anon = new Client();
    r = await anon.post("/playlists", { name: "x", csrf_token: await anon.csrf("/login") });
    expect([r.status, r.headers.get("location")]).toEqual([303, "/login?expired=1"]);
    const page = await (await anon.get("/login?expired=1")).text();
    expect(page).toContain("Your session expired; please sign in again");
    expect(await (await anon.get("/login")).text()).not.toContain("session expired");
  });

  it("a stale /login form (no session at all) gets a fresh one; a wrong token on a live session is still 403", async () => {
    const c = new Client();
    let r = await c.post("/login", { username: "admin", password: "test1234", csrf_token: "stale" });
    expect([r.status, r.headers.get("location")]).toEqual([303, "/login?expired=1"]);
    expect(c.cookie).toBeNull(); // the POST itself writes nothing; the GET it lands on does
    await c.get("/login?expired=1");
    expect(c.cookie).toMatch(/^piplayer_session=/);
    r = await c.post("/login", { username: "admin", password: "test1234", csrf_token: "stale" });
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ detail: CSRF_DETAIL });
    r = await c.post("/login", { username: "admin", password: "test1234", csrf_token: await c.csrf("/login") });
    expect([r.status, r.headers.get("location")]).toEqual([303, "/dashboard"]);
  });
});

describe("login / logout", () => {
  it("wrong password re-renders with an error, audits login_failed", async () => {
    const c = new Client();
    const r = await c.login("admin", "wrong-password");
    expect(r.status).toBe(200);
    expect(await r.text()).toContain("Invalid username or password");
    const rows = await query("SELECT details, username FROM audit_log WHERE action = 'login_failed' ORDER BY id DESC");
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].details).toContain("admin");
    expect(rows[0].details).not.toContain("wrong-password");
    expect(rows[0].username).toBeNull();
  });

  it("unknown user gets the same answer", async () => {
    const r = await new Client().login("ghost", "whatever1");
    expect(r.status).toBe(200);
    expect(await r.text()).toContain("Invalid username or password");
  });

  it("over-long password is 400, never 500", async () => {
    const r = await new Client().login("admin", "p".repeat(1025));
    expect(r.status).toBe(400);
  });

  it("success rotates the session, sets the cookie flags and audits", async () => {
    const c = new Client();
    const anonCsrf = await c.csrf();
    const anonCookie = c.cookie;
    const r = await c.login("admin", "test1234");
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toBe("/dashboard");
    const sc = r.headers.get("set-cookie").toLowerCase();
    expect(sc).toContain("httponly");
    expect(sc).toContain("samesite=lax");
    expect(sc).toContain("max-age=1209600");
    expect(c.cookie).not.toBe(anonCookie);
    const home = await c.get("/");
    expect(home.headers.get("location")).toBe("/dashboard");
    const page = await (await c.get("/login")).text();
    expect(META.exec(page)[1]).not.toBe(anonCsrf);
    expect(page).toContain('class="badge badge-admin"');
    expect(page).toContain('href="/settings"');
    expect(await query("SELECT user_id FROM sessions WHERE id = ?", sessionId(c))).toEqual([{ user_id: 1 }]);
    const login = await query("SELECT username FROM audit_log WHERE action = 'login' ORDER BY id DESC LIMIT 1");
    expect(login).toEqual([{ username: "admin" }]);
  });

  it("cookie is Secure on http and https alike; only PIPLAYER_INSECURE_COOKIES=1 drops it", async () => {
    for (const base of ["http://piplayer.test", "https://piplayer.test"]) {
      const r = await SELF.fetch(base + "/login", { redirect: "manual" });
      expect(r.headers.get("set-cookie"), base).toMatch(/; HttpOnly; Secure; SameSite=Lax; Path=\/; Max-Age=/);
    }
    // the dev opt-out, exercised on createSession directly since the vitest env is fixed
    const ctx = { env: { ...env, PIPLAYER_INSECURE_COOKIES: "1" }, cookies: [] };
    await auth.createSession(ctx, null);
    expect(ctx.cookies[0]).toMatch(/^piplayer_session=[^;]+; HttpOnly; SameSite=Lax; Path=\/; Max-Age=3600$/);
    await query("DELETE FROM sessions WHERE id = ?", ctx.session.id);
  });

  it("anonymous sessions are short-lived and only GET /login and GET /setup create one", async () => {
    await query("DELETE FROM sessions WHERE user_id IS NULL");
    const c = new Client();
    for (const path of ["/", "/dashboard", "/devices", "/audit", "/nope"]) {
      const r = await c.get(path);
      expect(r.headers.get("set-cookie"), path).toBeNull();
    }
    expect((await SELF.fetch("http://piplayer.test/login", { method: "HEAD", redirect: "manual" })).headers.get("set-cookie")).toBeNull();
    expect((await c.post("/login", { username: "admin", password: "x" })).headers.get("set-cookie")).toBeNull();
    expect((await c.post("/setup", { token: "x" })).status).toBe(403); // no session -> plain csrf 403, no row
    expect(await query("SELECT COUNT(*) AS n FROM sessions WHERE user_id IS NULL")).toEqual([{ n: 0 }]);
    const r = await c.get("/login");
    expect(r.headers.get("set-cookie")).toMatch(/Max-Age=3600$/);
    const rows = await query("SELECT expires_at FROM sessions WHERE id = ?", sessionId(c));
    expect(rows).toHaveLength(1);
    const ttl = (Date.parse(rows[0].expires_at + "Z") - Date.now()) / 1000;
    expect(ttl).toBeGreaterThan(3500);
    expect(ttl).toBeLessThanOrEqual(3600);
    // login upgrades to the 14-day session
    const login = await c.login("admin", "test1234");
    expect(login.headers.get("set-cookie")).toMatch(/Max-Age=1209600$/);
  });

  it("logout deletes the session row and clears the cookie", async () => {
    const c = new Client();
    await c.login("admin", "test1234");
    const id = sessionId(c);
    const token = await c.csrf("/login");
    const r = await c.post("/logout", { csrf_token: token });
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toBe("/login");
    expect(r.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(await query("SELECT id FROM sessions WHERE id = ?", id)).toEqual([]);
    expect(c.cookie).toBeNull();
    expect((await c.get("/")).headers.get("location")).toBe("/login");
    const rows = await query("SELECT username FROM audit_log WHERE action = 'logout' ORDER BY id DESC LIMIT 1");
    expect(rows).toEqual([{ username: "admin" }]);
  });

  it("a deleted user is no longer logged in", async () => {
    const hash = await auth.hashPassword("temp1234");
    await env.DB.prepare("INSERT INTO users (username, password_hash, role) VALUES ('temp', ?, 'viewer')").bind(hash).run();
    const c = new Client();
    await c.login("temp", "temp1234");
    expect((await c.get("/")).headers.get("location")).toBe("/dashboard");
    await env.DB.prepare("DELETE FROM users WHERE username = 'temp'").run();
    expect((await c.get("/")).headers.get("location")).toBe("/login");
  });

  it("throttles after five failures per ip+username", async () => {
    const codes = [];
    for (let i = 0; i < 6; i++) codes.push((await new Client().login("admin", "incorrect")).status);
    expect(codes.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
    expect(codes[5]).toBe(429);
    const r = await new Client().login("admin", "test1234");
    expect(r.status).toBe(429);
    expect(await r.text()).toContain("Too many failed attempts");
    // another username is unaffected
    expect((await new Client().login("someone-else", "x".repeat(8))).status).toBe(200);
    await auth.clearLoginFailures(env, null, "admin");
    expect((await new Client().login("admin", "test1234")).status).toBe(303);
  });
});

describe("roles and routing", () => {
  it("requireUser / requireRole", () => {
    expect(() => auth.requireUser({ user: null })).toThrow(Response);
    const editor = { user: { id: 2, username: "e", role: "editor" } };
    expect(auth.requireRole(editor, "viewer")).toBe(editor.user);
    expect(auth.requireRole(editor, "editor")).toBe(editor.user);
    let err;
    try { auth.requireRole(editor, "admin"); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(HttpError);
    expect(err.status).toBe(403);
    expect(err.detail).toBe("requires admin role");
  });

  it("unknown routes, docs and wrong methods are JSON errors; static assets are served", async () => {
    const c = new Client();
    for (const p of ["/openapi.json", "/docs", "/redoc", "/nope"]) {
      const r = await c.get(p);
      expect(r.status, p).toBe(404);
      expect(await r.json()).toEqual({ detail: "Not Found" });
    }
    expect((await c.get("/logout")).status).toBe(405);
    for (const p of ["/playlists/%E0", "/api/media/%E0%A4%A", "/library/upload/%zz"]) {
      const r = await c.get(p);
      expect(r.status, p).toBe(400);
      expect(await r.json()).toEqual({ detail: "malformed path" });
    }
    const css = await c.get("/static/style.css");
    expect(css.status).toBe(200);
    expect(css.headers.get("content-type")).toContain("text/css");
    expect((await c.get("/static/app.js")).status).toBe(200);
  });

  it("every route is registered for a logged-in admin (pages 200, unknown rows 404, device api 401)", async () => {
    const c = new Client();
    await c.login("admin", "test1234");
    for (const p of ["/dashboard", "/library", "/playlists", "/devices", "/groups", "/audit", "/users", "/settings"]) {
      expect((await c.get(p)).status, p).toBe(200);
    }
    for (const p of ["/devices/1/schedule", "/playlists/1", "/library/upload/x", "/api/media/a.mp4"]) {
      expect((await c.get(p)).status, p).toBe(404);
    }
    expect((await c.get("/api/sync/x")).status).toBe(401);
  });
});
