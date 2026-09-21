// The daily cron's housekeeping that nothing else asserts: auth.housekeeping (expired sessions,
// stale login_failures rows), audit.housekeeping (PIPLAYER_AUDIT_RETENTION_DAYS, 0 = keep
// forever) and index.js carrying on with the next module when one housekeeping throws.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createExecutionContext, createScheduledController } from "cloudflare:test";
import { env } from "cloudflare:workers";
import * as audit from "../src/audit.js";
import * as auth from "../src/auth.js";
import worker from "../src/index.js";
import * as uploads from "../src/uploads.js";
import { query, setupAdmin } from "./helpers.js";

const DAILY = "0 3 * * *";
const unix = () => Math.floor(Date.now() / 1000);
const sessionIds = () => query("SELECT id FROM sessions ORDER BY id").then((r) => r.map((s) => s.id));
const failureIps = () => query("SELECT ip FROM login_failures ORDER BY ip").then((r) => r.map((f) => f.ip));
const auditIds = () => query("SELECT id FROM audit_log WHERE action = 'hk-probe' ORDER BY id").then((r) => r.map((a) => a.id));

// One expired and one live session for the admin, one stale and one fresh throttle row.
async function seedAuth() {
  await query("DELETE FROM sessions");
  await query("DELETE FROM login_failures");
  const uid = (await query("SELECT id FROM users WHERE username = 'admin'"))[0].id;
  await query("INSERT INTO sessions (id, user_id, csrf, expires_at) VALUES ('hk-expired', ?, 'c', datetime('now', '-1 minute'))", uid);
  await query("INSERT INTO sessions (id, user_id, csrf, expires_at) VALUES ('hk-live', ?, 'c', datetime('now', '+1 hour'))", uid);
  // MAX_LOCK_SECONDS is the longest window (600 s, LOGIN_USER_WINDOW_SECONDS): one row past it, one inside it
  await query("INSERT INTO login_failures (ip, username, at) VALUES ('10.0.0.1', 'admin', ?)", unix() - auth.LOGIN_USER_WINDOW_SECONDS - 5);
  await query("INSERT INTO login_failures (ip, username, at) VALUES ('10.0.0.2', 'admin', ?)", unix() - 5);
}

beforeAll(async () => {
  await setupAdmin("admin", "test1234");
});

describe("daily housekeeping", () => {
  afterEach(() => vi.restoreAllMocks());

  it("auth: deletes expired sessions and throttle rows older than the longest lock window, keeps the rest", async () => {
    await seedAuth();
    await auth.housekeeping(env);
    expect(await sessionIds()).toEqual(["hk-live"]);
    expect(await failureIps()).toEqual(["10.0.0.2"]);
  });

  it("audit: retention 0 keeps everything; 365 prunes only rows older than a year", async () => {
    await query("INSERT INTO audit_log (action, created_at) VALUES ('hk-probe', datetime('now', '-400 days'))");
    await query("INSERT INTO audit_log (action, created_at) VALUES ('hk-probe', datetime('now', '-10 days'))");
    const [old, recent] = await auditIds();
    await audit.housekeeping({ DB: env.DB, PIPLAYER_AUDIT_RETENTION_DAYS: "0" });
    expect(await auditIds()).toEqual([old, recent]);
    await audit.housekeeping({ DB: env.DB, PIPLAYER_AUDIT_RETENTION_DAYS: "365" });
    expect(await auditIds()).toEqual([recent]);
    await query("DELETE FROM audit_log WHERE action = 'hk-probe'");
  });

  it("the cron runs every module's housekeeping even when one of them throws", async () => {
    await seedAuth();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(uploads, "housekeeping").mockRejectedValue(new Error("boom"));
    await worker.scheduled(createScheduledController({ cron: DAILY }), env, createExecutionContext());
    expect(uploads.housekeeping).toHaveBeenCalledTimes(1);
    expect(errors.mock.calls.some((c) => String(c[0]).includes("housekeeping failed"))).toBe(true);
    // uploads runs before auth in index.js MODULES, so auth still did its work
    expect(await sessionIds()).toEqual(["hk-live"]);
    expect(await failureIps()).toEqual(["10.0.0.2"]);
  });
});
