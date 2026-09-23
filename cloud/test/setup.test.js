import { describe, expect, it } from "vitest";
import { Client, query, SETUP_TOKEN } from "./helpers.js";

// Order matters within this file: the worker caches "users exist" once /setup succeeds.
describe("first-run setup", () => {
  it("redirects every page to /setup while users is empty", async () => {
    const c = new Client();
    for (const path of ["/", "/login", "/dashboard", "/devices"]) {
      const r = await c.get(path);
      expect(r.status, path).toBe(303);
      expect(r.headers.get("location")).toBe("/setup");
    }
    expect((await c.get("/api/health")).status).toBe(200);
    expect(await (await c.get("/api/health")).json()).toEqual({ ok: true });
  });

  it("refuses /setup without the right token: a friendly page on GET, plain 403 on POST", async () => {
    const c = new Client();
    expect((await c.get("/setup")).status).toBe(403);
    const r = await c.get("/setup?token=nope");
    expect(r.status).toBe(403);
    expect(r.headers.get("content-type")).toContain("text/html");
    const text = await r.text();
    expect(text).toContain("Projection5000 has not been set up yet");
    expect(text).not.toContain('name="token"');
    const p = await c.post("/setup", { token: "nope", username: "admin", password: "test1234", password2: "test1234", csrf_token: await c.csrf("/setup?token=nope") });
    expect(p.status).toBe(403);
    expect(await p.json()).toEqual({ detail: "invalid setup token" });
  });

  it("shows the form with csrf + hidden token, validates, creates the admin and logs in", async () => {
    const c = new Client();
    const page = await c.get(`/setup?token=${SETUP_TOKEN}`);
    expect(page.status).toBe(200);
    const text = await page.text();
    expect(text).toContain('name="token" value="test-setup-token"');
    const csrf_token = /<meta name="csrf-token" content="([^"]+)">/.exec(text)[1];

    let r = await c.post("/setup", { token: SETUP_TOKEN, username: "admin", password: "test1234", password2: "test1234" });
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ detail: "CSRF token missing or invalid" });

    r = await c.post("/setup", { token: "wrong", username: "admin", password: "test1234", password2: "test1234", csrf_token });
    expect(r.status).toBe(403);
    r = await c.post("/setup", { token: SETUP_TOKEN, username: "admin", password: "test1234", password2: "other123", csrf_token });
    expect(r.status).toBe(400);
    expect(await r.text()).toContain("passwords do not match");
    r = await c.post("/setup", { token: SETUP_TOKEN, username: "admin", password: "short", password2: "short", csrf_token });
    expect(r.status).toBe(400);
    expect(await query("SELECT id FROM users")).toEqual([]);

    r = await c.post("/setup", { token: SETUP_TOKEN, username: "admin", password: "test1234", password2: "test1234", csrf_token });
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toBe("/dashboard");
    const cookie = r.headers.get("set-cookie");
    expect(cookie).toMatch(/^piplayer_session=[^;]+\.[^;]+; HttpOnly; Secure; SameSite=Lax; Path=\/; Max-Age=1209600$/);

    const users = await query("SELECT username, role, password_hash FROM users");
    expect(users.length).toBe(1);
    expect(users[0].role).toBe("admin");
    expect(users[0].password_hash).toMatch(/^pbkdf2\$100000\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/);

    // logged in: / goes to the dashboard, which renders
    r = await c.get("/");
    expect(r.headers.get("location")).toBe("/dashboard");
    expect((await c.get("/dashboard")).status).toBe(200);
    // setup is gone
    expect((await c.get(`/setup?token=${SETUP_TOKEN}`)).status).toBe(404);
    expect((await new Client().get("/login")).status).toBe(200);
    const audit = await query("SELECT action, username, target_type FROM audit_log ORDER BY id");
    expect(audit).toEqual([{ action: "user_create", username: "admin", target_type: "user" }]);
  });
});
