// The SD flasher's sign-in and per-account projectors (v0.7.0): POST /api/operator/login
// (username + password -> p5k_ token named after the PC; viewers refused; /login's throttle and
// audit), GET /api/operator/me, and POST /api/operator/devices (create with owner_id and the
// Settings defaults, re-register with a NEW token, 409 for another account's id, admin takeover
// of an ownerless id, the per-hour cap on new ids).
import { beforeAll, describe, expect, it } from "vitest";
import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import * as auth from "../src/auth.js";
import { MAX_NEW_DEVICES_PER_HOUR } from "../src/api.js";
import { BASE, query } from "./helpers.js";
import { audits, detail, device, group, playlist, roles } from "./pages_common.js";

let r;
const TOKEN_RX = /^p5k_[A-Za-z0-9_-]{32}$/;
const DEVICE_TOKEN_RX = /^[A-Za-z0-9_-]{43}$/;
const bearer = (t) => ({ authorization: `Bearer ${t}` });
const post = (path, body, headers = {}) => SELF.fetch(`${BASE}${path}`, {
  method: "POST", body: typeof body === "string" ? body : JSON.stringify(body),
  headers: { "content-type": "application/json", ...headers },
});
const login = (username, password, extra = {}, headers = {}) => post("/api/operator/login", { username, password, hostname: "MATTS-PC", ...extra }, headers);
const me = (headers = {}) => SELF.fetch(`${BASE}/api/operator/me`, { headers });
const register = (token, body, headers = {}) => post("/api/operator/devices", body, { ...bearer(token), ...headers });
const sync = (deviceId, token) => SELF.fetch(`${BASE}/api/sync/${deviceId}`, { headers: bearer(token) });
const dev = (deviceId) => query("SELECT id, device_id, name, token, group_id, playlist_id, owner_id, pi_model FROM devices WHERE device_id = ?", deviceId).then((x) => x[0] ?? null);
const userId = (username) => query("SELECT id FROM users WHERE username = ?", username).then((x) => x[0].id);
const tokens = () => query("SELECT id, user_id, name FROM api_tokens ORDER BY id");
const signIn = async (username, password) => {
  const res = await login(username, password);
  expect(res.status).toBe(200);
  return (await res.json()).token;
};

beforeAll(async () => {
  r = await roles();
});

describe("POST /api/operator/login", () => {
  it("editor and admin get a token named after the PC that works on /me; audited as api_token_created", async () => {
    await query("DELETE FROM audit_log WHERE action = 'api_token_created'");
    for (const [username, password, role] of [["ed", "editor-pass", "editor"], ["admin", "test1234", "admin"]]) {
      const res = await login(username, password);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ token: expect.stringMatching(TOKEN_RX), username, role });
      const uid = await userId(username);
      const row = (await tokens()).find((t) => t.user_id === uid);
      expect(row.name).toBe("SD Flasher on MATTS-PC");
      const [a] = await audits("api_token_created");
      expect(a).toMatchObject({ username, target_type: "api_token", target_id: String(row.id), details: '{"name": "SD Flasher on MATTS-PC", "source": "flasher", "hostname": "MATTS-PC"}' });
      const m = await me(bearer(body.token));
      expect(m.status).toBe(200);
      expect(await m.json()).toMatchObject({ username, role });
    }
    // the token itself never lands in the audit log
    expect((await query("SELECT details FROM audit_log")).some((x) => (x.details || "").includes("p5k_"))).toBe(false);
  });

  it("hostname is cleaned like the device-code flow; missing -> unknown PC", async () => {
    expect((await login("ed", "editor-pass", { hostname: " Zero​Width " })).status).toBe(200);
    expect((await login("ed", "editor-pass", { hostname: 7 })).status).toBe(200);
    const names = (await tokens()).map((t) => t.name);
    expect(names).toContain("SD Flasher on ZeroWidth");
    expect(names).toContain("SD Flasher on unknown PC");
  });

  it("viewer: 403 with plain words and no token row", async () => {
    const before = (await tokens()).length;
    expect(await detail(await login("vw", "viewer-pass"), 403)).toBe("This account can only view; ask an admin to make it an editor");
    expect((await tokens()).length).toBe(before);
  });

  it("wrong password or unknown user: 401, login_failed audit, throttled per ip+username after 5", async () => {
    await query("DELETE FROM audit_log WHERE action = 'login_failed'");
    const ip = { "cf-connecting-ip": "203.0.113.77" };
    const before = (await tokens()).length;
    expect(await detail(await login("ed", "nope", {}, ip), 401)).toBe("Invalid username or password");
    expect(await detail(await login("ghost", "nope", {}, ip), 401)).toBe("Invalid username or password");
    expect(await detail(await login("enroll", "nope", {}, ip), 401)).toBe("Invalid username or password"); // reserved name, no row
    expect(await detail(await post("/api/operator/login", "[1]"), 400)).toBe("body must be a JSON object");
    expect(await audits("login_failed")).toEqual([
      { username: null, target_type: "user", target_id: null, details: '{"username": "(no such user)", "source": "flasher"}', ip: "203.0.113.77" },
      { username: null, target_type: "user", target_id: String(await userId("ed")), details: '{"username": "ed", "source": "flasher"}', ip: "203.0.113.77" },
    ]);
    for (let i = 0; i < 4; i++) expect((await login("ed", "nope", {}, ip)).status).toBe(401);
    // the 6th attempt, even with the right password, waits
    const locked = await login("ed", "editor-pass", {}, ip);
    expect(await detail(locked, 429)).toMatch(/^Too many failed attempts; try again in \d+ s$/);
    expect(locked.headers.get("retry-after")).toMatch(/^\d+$/);
    expect((await tokens()).length).toBe(before);
    // another ip signs in fine, and that clears nothing for the locked one
    expect((await login("ed", "editor-pass")).status).toBe(200);
    expect((await login("ed", "editor-pass", {}, ip)).status).toBe(429);
    await auth.clearLoginFailures(env, "203.0.113.77", "ed");
    await auth.clearLoginFailures(env, "203.0.113.77", "ghost");
  });
});

describe("GET /api/operator/me", () => {
  it("shape; 401 on a bad token; 403 for a viewer's token", async () => {
    const gid = await group("Me group");
    const pid = await playlist("Me loop");
    const token = await signIn("ed", "editor-pass");
    const res = await me(bearer(token));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      username: "ed", role: "editor", console_url: BASE, timezone: "UTC", wyze_configured: false,
      groups: [{ id: gid, name: "Me group" }], playlists: [{ id: 1, name: "Default" }, { id: pid, name: "Me loop" }], // migration 0010 seeds Default
    });
    expect(await detail(await me(), 401)).toBe("Missing bearer token");
    expect(await detail(await me(bearer(auth.newApiToken())), 401)).toBe("Invalid API token");
    // a token whose user was demoted to viewer stops working with the sign-in's words
    const vwId = await userId("vw");
    const hash = await auth.apiTokenHash(token);
    await query("UPDATE api_tokens SET user_id = ? WHERE token_hash = ?", vwId, hash);
    expect(await detail(await me(bearer(token)), 403)).toBe("This account can only view; ask an admin to make it an editor");
    await query("DELETE FROM api_tokens WHERE token_hash = ?", hash);
    await query("DELETE FROM device_groups WHERE id = ?", gid);
    await query("DELETE FROM playlists WHERE id = ?", pid);
  });
});

describe("POST /api/operator/devices", () => {
  it("creates the projector for the signed-in account with the Settings defaults; 201, audited with the owner", async () => {
    await query("DELETE FROM audit_log WHERE action LIKE 'device_%registered'");
    const gid = await group("Reg group");
    const pid = await playlist("Reg loop");
    await env.DB.batch([
      env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('enroll_group_id', ?)").bind(String(gid)),
      env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('enroll_playlist_id', ?)").bind(String(pid)),
    ]);
    const token = await signIn("ed", "editor-pass");
    const res = await register(token, { device_id: " Lobby-1 ", name: "  Lobby  ", pi_model: " Raspberry Pi 4 " }, { "cf-connecting-ip": "10.2.2.2" });
    expect(res.status).toBe(201);
    const body = await res.json();
    const row = await dev("lobby-1");
    expect(body).toEqual({ device_id: "lobby-1", token: row.token, cms_url: BASE, owner: "ed", created: true });
    expect(row).toMatchObject({ name: "Lobby", owner_id: await userId("ed"), group_id: gid, playlist_id: pid, pi_model: "Raspberry Pi 4" });
    expect(row.token).toMatch(DEVICE_TOKEN_RX);
    expect((await sync("lobby-1", row.token)).status).toBe(200);
    const [a] = await audits("device_registered");
    expect(a).toEqual({ username: "ed", target_type: "device", target_id: String(row.id), details: `{"device_id": "lobby-1", "name": "Lobby", "owner": "ed", "group_id": ${gid}, "playlist_id": ${pid}}`, ip: "10.2.2.2" });
    expect((await query("SELECT details FROM audit_log")).some((x) => (x.details || "").includes(row.token))).toBe(false);
    await query("DELETE FROM settings WHERE key IN ('enroll_group_id', 'enroll_playlist_id')");
    // pi_model is optional and capped
    expect((await register(token, { device_id: "lobby-2", name: "Lobby 2" })).status).toBe(201);
    expect((await dev("lobby-2")).pi_model).toBeNull();
    expect((await register(token, { device_id: "lobby-3", name: "Lobby 3", pi_model: "m".repeat(80) })).status).toBe(201);
    expect((await dev("lobby-3")).pi_model).toBe("m".repeat(64));
    // validation as /api/enroll
    expect(await detail(await register(token, { device_id: "-bad", name: "x" }), 400)).toContain("device_id must be");
    expect(await detail(await register(token, { device_id: "ok-1", name: "" }), 400)).toContain("name must be 1-120 chars");
    expect(await detail(await register(token, "[1]"), 400)).toBe("body must be a JSON object");
    expect(await detail(await register("nope", { device_id: "ok-1", name: "x" }), 401)).toBe("Invalid API token");
    expect(await dev("ok-1")).toBeNull();
  });

  it("re-registering your own id: 200, a NEW token (the old card stops syncing), rename audited", async () => {
    await query("DELETE FROM audit_log WHERE action LIKE 'device_%registered'");
    const token = await signIn("ed", "editor-pass");
    const first = await (await register(token, { device_id: "hall-2", name: "Hall" })).json();
    const again = await register(token, { device_id: "HALL-2", name: "Hall (new card)", pi_model: "Raspberry Pi 5" });
    expect(again.status).toBe(200);
    const body = await again.json();
    expect(body).toEqual({ device_id: "hall-2", token: expect.stringMatching(DEVICE_TOKEN_RX), cms_url: BASE, owner: "ed", created: false });
    expect(body.token).not.toBe(first.token);
    expect(await dev("hall-2")).toMatchObject({ name: "Hall (new card)", token: body.token, pi_model: "Raspberry Pi 5", owner_id: await userId("ed") });
    expect((await sync("hall-2", first.token)).status).toBe(401);
    expect((await sync("hall-2", body.token)).status).toBe(200);
    expect((await query("SELECT COUNT(*) AS n FROM devices WHERE device_id = 'hall-2'"))[0].n).toBe(1);
    const [a] = await audits("device_reregistered");
    expect(a).toMatchObject({ username: "ed", target_type: "device", details: '{"device_id": "hall-2", "name": "Hall (new card)", "renamed_from": "Hall"}' });
    expect((await audits("device_registered")).length).toBe(1);
  });

  it("another account's id: 409 and nothing changes; an admin re-registers anyone's", async () => {
    const ed = await signIn("ed", "editor-pass");
    const admin = await signIn("admin", "test1234");
    const mine = await (await register(ed, { device_id: "mine-1", name: "Mine" })).json();
    await query("INSERT INTO users (username, password_hash, role) VALUES ('ed2', 'x', 'editor')");
    const ed2Id = await userId("ed2");
    await query("INSERT INTO api_tokens (user_id, name, token_hash) VALUES (?, 'ed2 pc', ?)", ed2Id, await auth.apiTokenHash("p5k_" + "e".repeat(32)));
    const other = "p5k_" + "e".repeat(32);
    expect(await detail(await register(other, { device_id: "mine-1", name: "Stolen" }), 409)).toBe("A projector with that ID belongs to another account; pick another name");
    expect(await dev("mine-1")).toMatchObject({ name: "Mine", token: mine.token, owner_id: await userId("ed") });
    // an admin may re-register it; the owner stays ed
    const res = await register(admin, { device_id: "mine-1", name: "Mine (admin card)" });
    expect(res.status).toBe(200);
    expect(await dev("mine-1")).toMatchObject({ name: "Mine (admin card)", owner_id: await userId("ed") });
    expect((await dev("mine-1")).token).not.toBe(mine.token);
  });

  it("an ownerless id (pre-migration, Add device form, /api/enroll): an admin takes it over, an editor gets 409", async () => {
    const legacy = await device("legacy-1", "Legacy", { owner_id: null });
    const ed = await signIn("ed", "editor-pass");
    const admin = await signIn("admin", "test1234");
    expect((await register(ed, { device_id: "legacy-1", name: "Legacy" })).status).toBe(409);
    expect(await dev("legacy-1")).toMatchObject({ owner_id: null, token: legacy.token });
    const res = await register(admin, { device_id: "legacy-1", name: "Legacy" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ owner: "admin", created: false });
    expect(await dev("legacy-1")).toMatchObject({ owner_id: await userId("admin") });
    expect((await dev("legacy-1")).token).not.toBe(legacy.token);
  });

  it("caps new ids fleet-wide per hour like /api/enroll (429 + Retry-After, audited as this user); re-registers still work", async () => {
    await query("DELETE FROM audit_log WHERE action = 'device_enroll_capped'");
    const token = await signIn("ed", "editor-pass");
    expect((await register(token, { device_id: "cap-own", name: "x" })).status).toBe(201);
    const before = (await query("SELECT COUNT(*) AS n FROM devices WHERE created_at > datetime('now', '-1 hour')"))[0].n;
    for (let i = 0; i < MAX_NEW_DEVICES_PER_HOUR - before; i++) {
      await query("INSERT INTO devices (device_id, name, token) VALUES (?, ?, ?)", `cap-${i}`, "x", `tok-cap-${i}`);
    }
    try {
      const capped = await register(token, { device_id: "cap-new", name: "x" });
      expect(await detail(capped, 429)).toBe("Too many new projectors enrolled in the last hour; try again later");
      expect(capped.headers.get("retry-after")).toBe("3600");
      expect(await dev("cap-new")).toBeNull();
      expect((await audits("device_enroll_capped"))[0]).toMatchObject({ username: "ed", target_type: "device", target_id: null, details: '{"device_id": "cap-new", "name": "x"}' });
      expect((await register(token, { device_id: "cap-own", name: "x" })).status).toBe(200);
    } finally {
      await query("DELETE FROM devices WHERE device_id LIKE 'cap-%'");
    }
  });
});
