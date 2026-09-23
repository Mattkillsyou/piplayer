// Device API audit fixes: assertMigrated checks meta.schema_version (M14), a bad timezone row
// falls back to UTC instead of taking every page down (M13), two overlapping syncs never hand
// out the same command twice (L12), and a board that reports camera_supported=0 gets no tunnel
// token fetched per sync (L23).
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import * as db from "../src/db.js";
import * as manifest from "../src/manifest.js";
import { BASE, query, setupAdmin } from "./helpers.js";
import { device, ins, one } from "./pages_common.js";

const bearer = (token) => ({ authorization: `Bearer ${token}` });
const sync = (d, params = {}) => SELF.fetch(`${BASE}/api/sync/${d.device_id}?${new URLSearchParams(params)}`, { headers: bearer(d.token) });

// assertMigrated remembers a good answer for the life of the isolate, so the stale-schema check
// must be the first request this file makes.
describe("assertMigrated (M14)", () => {
  it("a database behind SCHEMA_VERSION answers a plain 500 on /api/health and every route until migrated", async () => {
    expect(Number((await one("SELECT value FROM meta WHERE key = 'schema_version'")).value)).toBe(db.SCHEMA_VERSION);
    await query("UPDATE meta SET value = ? WHERE key = 'schema_version'", String(db.SCHEMA_VERSION - 1));
    const msg = `The database is behind this release of Projection5000 (it is at version ${db.SCHEMA_VERSION - 1}, this release needs ${db.SCHEMA_VERSION}): run npm run migrate:remote and try again`;
    for (const path of ["/api/health", "/api/sync/nope", "/login"]) {
      const r = await SELF.fetch(BASE + path);
      expect(r.status, path).toBe(500);
      expect((await r.json()).detail).toBe(msg);
    }
    await query("UPDATE meta SET value = ? WHERE key = 'schema_version'", String(db.SCHEMA_VERSION));
    expect(await (await SELF.fetch(`${BASE}/api/health`)).json()).toEqual({ ok: true });
  });
});

describe("after setup", () => {
  let admin;
  let dev;

  beforeAll(async () => {
    admin = await setupAdmin("admin", "test1234");
    dev = await device("fix-1", "Fix 1");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    for (const k of ["CF_API_TOKEN", "CF_ACCOUNT_ID", "CF_ZONE_ID"]) delete env[k];
  });

  it("an invalid timezone row falls back to UTC: sync and the pages keep working (M13)", async () => {
    await query("INSERT OR REPLACE INTO settings (key, value) VALUES ('timezone', 'Mars/Olympus')");
    try {
      const s = await db.loadSettings(env);
      expect(s.timezone).toBe("UTC");
      expect(s.timezone_problem).toBe("Mars/Olympus"); // the Settings page warns with the stored value
      expect((await sync(dev)).status).toBe(200);
      for (const path of ["/dashboard", "/devices", "/settings"]) expect((await admin.get(path)).status, path).toBe(200);
      expect(await (await admin.get("/settings")).text()).toContain('value="UTC"');
    } finally {
      await query("DELETE FROM settings WHERE key = 'timezone'");
    }
    expect((await db.loadSettings(env)).timezone_problem).toBeUndefined(); // a good or missing row sets nothing
  });

  it("two overlapping syncs deliver a command once; delivery_count moves by one (L12)", async () => {
    const id = await ins("INSERT INTO device_commands (device_id, command) VALUES (?, 'reboot')", dev.id);
    const [a, b] = await Promise.all([manifest.pending_commands(env, dev.id), manifest.pending_commands(env, dev.id)]);
    expect([...a, ...b].map((c) => c.command)).toEqual(["reboot"]);
    expect(await one("SELECT delivery_count FROM device_commands WHERE id = ?", id)).toEqual({ delivery_count: 1 });
    // the next sync delivers it again (still open), so at-least-once is kept
    expect((await manifest.pending_commands(env, dev.id)).map((c) => c.id)).toEqual([id]);
    expect(await one("SELECT delivery_count FROM device_commands WHERE id = ?", id)).toEqual({ delivery_count: 2 });
  });

  it("a sync reporting camera_supported=0 gets tunnel null without an API call; 1 fetches the token (L23)", async () => {
    Object.assign(env, { CF_API_TOKEN: "cf-test-token", CF_ACCOUNT_ID: "acct1", CF_ZONE_ID: "zone1" });
    await query("UPDATE devices SET tunnel_id = 'tun-9', tunnel_hostname = 'fix-1-cam.photogen5000.com' WHERE id = ?", dev.id);
    const calls = [];
    vi.stubGlobal("fetch", async (url) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ success: true, errors: [], result: "eyJ-token" }), { headers: { "content-type": "application/json" } });
    });
    expect((await (await sync(dev, { camera_supported: "0" })).json()).tunnel).toBeNull();
    expect(calls.length).toBe(0);
    expect((await (await sync(dev, { camera_supported: "1" })).json()).tunnel).toEqual({ token: "eyJ-token", hostname: "fix-1-cam.photogen5000.com" });
    expect(calls.length).toBe(1);
  });
});
