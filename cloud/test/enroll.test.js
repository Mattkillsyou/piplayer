// POST /api/enroll: key check (constant-time, throttled per ip), device_id/name validation,
// create vs re-enroll (a NEW token, the old one stops, name updated), the per-hour cap on new
// device ids, audit rows, no token in the audit log.
import { beforeAll, describe, expect, it } from "vitest";
import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import * as auth from "../src/auth.js";
import * as db from "../src/db.js";
import { BASE, query, setupAdmin } from "./helpers.js";
import { MAX_NEW_DEVICES_PER_HOUR } from "../src/api.js";
import { audits, detail, group, playlist } from "./pages_common.js";

let key;

const enroll = (body, headers = {}) => SELF.fetch(`${BASE}/api/enroll`, {
  method: "POST", body: typeof body === "string" ? body : JSON.stringify(body),
  headers: { "content-type": "application/json", ...headers },
});
const dev = (deviceId) => query("SELECT id, device_id, name, token, group_id, playlist_id FROM devices WHERE device_id = ?", deviceId).then((r) => r[0] ?? null);
const setDefaults = (gid, pid) => env.DB.batch([
  env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('enroll_group_id', ?)").bind(gid === null ? "" : String(gid)),
  env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('enroll_playlist_id', ?)").bind(pid === null ? "" : String(pid)),
]);
const clear = (ip = null) => auth.clearLoginFailures(env, ip, auth.ENROLL_KEY);

beforeAll(async () => {
  await setupAdmin("admin", "test1234");
  key = (await db.loadSettings(env)).enrollment_key; // generated on first read
});

describe("POST /api/enroll", () => {
  it("creates the device, returns a fresh token and the console origin, audits without the token", async () => {
    await query("DELETE FROM audit_log WHERE action LIKE 'device_%enrolled'");
    const r = await enroll({ key, device_id: " Lobby-1 ", name: "  Lobby  " }, { "cf-connecting-ip": "10.1.1.1" });
    expect(r.status).toBe(200);
    const body = await r.json();
    const row = await dev("lobby-1");
    expect(row).not.toBeNull();
    expect(body).toEqual({ device_id: "lobby-1", token: row.token, cms_url: BASE });
    expect(row.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(row.name).toBe("Lobby");
    const [a] = await audits("device_enrolled");
    expect(a).toEqual({ username: null, target_type: "device", target_id: String(row.id), details: '{"device_id": "lobby-1", "name": "Lobby"}', ip: "10.1.1.1" });
    expect(await audits("device_reenrolled")).toEqual([]);
    const all = await query("SELECT details FROM audit_log");
    expect(all.some((x) => (x.details || "").includes(row.token))).toBe(false);
    // the token works for the device API
    const sync = await SELF.fetch(`${BASE}/api/sync/lobby-1`, { headers: { authorization: `Bearer ${row.token}` } });
    expect(sync.status).toBe(200);
  });

  it("re-enrolling issues a new token (the old card stops syncing), updates the name, audits device_reenrolled with renamed_from", async () => {
    await query("DELETE FROM audit_log WHERE action LIKE 'device_%enrolled'");
    const first = await (await enroll({ key, device_id: "hall-2", name: "Hall" })).json();
    const again = await enroll({ key, device_id: "HALL-2", name: "Hall (new card)" });
    expect(again.status).toBe(200);
    const body = await again.json();
    expect(body).toMatchObject({ device_id: "hall-2", cms_url: BASE });
    expect(body.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(body.token).not.toBe(first.token);
    const row = await dev("hall-2");
    expect(row.name).toBe("Hall (new card)");
    expect(row.token).toBe(body.token);
    // the enrollment key alone never yields a live token: the old one is dead, only the new one syncs
    const bearer = (t) => SELF.fetch(`${BASE}/api/sync/hall-2`, { headers: { authorization: `Bearer ${t}` } });
    expect((await bearer(first.token)).status).toBe(401);
    expect((await bearer(body.token)).status).toBe(200);
    // a rename can change the derived Wyze camera name, so the Pi must refetch its camera config
    const ver = async () => parseInt((await query("SELECT value FROM settings WHERE key = 'camera_config_version'"))[0]?.value || "0", 10);
    const afterRename = await ver();
    expect(afterRename).toBeGreaterThan(0);
    expect((await query("SELECT COUNT(*) AS n FROM devices WHERE device_id = 'hall-2'"))[0].n).toBe(1);
    // same name again: still a re-enroll audit, name untouched
    expect((await enroll({ key, device_id: "hall-2", name: "Hall (new card)" })).status).toBe(200);
    expect((await dev("hall-2")).name).toBe("Hall (new card)");
    expect(await ver()).toBe(afterRename); // unchanged name: no bump
    expect((await audits("device_reenrolled")).map((a) => a.details)).toEqual([
      '{"device_id": "hall-2", "name": "Hall (new card)"}', '{"device_id": "hall-2", "name": "Hall (new card)", "renamed_from": "Hall"}',
    ]);
    expect((await audits("device_enrolled")).length).toBe(1);
  });

  it("wrong or missing key is 401 and creates nothing; body must be a JSON object", async () => {
    const bad = [
      { key: "nope", device_id: "k-1", name: "x" }, { device_id: "k-1", name: "x" }, { key: 7, device_id: "k-1", name: "x" },
      { key: key + "x", device_id: "k-1", name: "x" }, { key: key.slice(0, -1), device_id: "k-1", name: "x" }, { key: "", device_id: "k-1", name: "x" },
    ];
    for (const body of bad) {
      expect(await detail(await enroll(body), 401), JSON.stringify(body)).toBe("invalid enrollment key");
    }
    expect(await dev("k-1")).toBeNull();
    expect(await detail(await enroll("not json"), 400)).toBe("body must be a JSON object");
    expect(await detail(await enroll("[1]"), 400)).toBe("body must be a JSON object");
    await clear();
  });

  it("validates device_id and name after the key (400), nothing created", async () => {
    const cases = [
      [{ key, name: "x" }, "device_id must be"],
      [{ key, device_id: "", name: "x" }, "device_id must be"],
      [{ key, device_id: "-bad", name: "x" }, "device_id must be"],
      [{ key, device_id: "bad_id!", name: "x" }, "device_id must be"],
      [{ key, device_id: "a".repeat(64), name: "x" }, "device_id must be"],
      [{ key, device_id: 5, name: "x" }, "device_id must be"],
      [{ key, device_id: "ok-1" }, "name must be 1-120 chars"],
      [{ key, device_id: "ok-1", name: "   " }, "name must be 1-120 chars"],
      [{ key, device_id: "ok-1", name: "n".repeat(121) }, "name must be 1-120 chars"],
      [{ key, device_id: "ok-1", name: ["x"] }, "name must be 1-120 chars"],
    ];
    for (const [body, msg] of cases) {
      expect(await detail(await enroll(body), 400), JSON.stringify(body)).toContain(msg);
    }
    expect(await dev("ok-1")).toBeNull();
    expect((await enroll({ key, device_id: "a".repeat(63), name: "n".repeat(120) })).status).toBe(200);
    // a bad body with a bad key is a 401, never a 400 (the key is checked first)
    expect((await enroll({ key: "nope", device_id: "-bad", name: "" })).status).toBe(401);
    await clear();
  });

  it("no session or CSRF is involved; a garbage cookie changes nothing", async () => {
    const r = await enroll({ key: "nope", device_id: "s-1", name: "x" }, { cookie: "piplayer_session=garbage.sig" });
    expect(r.status).toBe(401);
    expect(r.headers.get("set-cookie")).toBeNull();
    await clear();
  });

  it("throttles per ip after 10 bad keys within 60 s; other ips and login are unaffected", async () => {
    const ip = { "cf-connecting-ip": "203.0.113.9" };
    const codes = [];
    for (let i = 0; i < 11; i++) codes.push((await enroll({ key: "nope", device_id: "t-1", name: "x" }, ip)).status);
    expect(codes.slice(0, 10)).toEqual(Array(10).fill(401));
    expect(codes[10]).toBe(429);
    // a correct key is refused while locked, and the lock reports the wait
    const locked = await enroll({ key, device_id: "t-1", name: "x" }, ip);
    expect(await detail(locked, 429)).toMatch(/^Too many failed attempts; try again in \d+ s$/);
    expect(locked.headers.get("retry-after")).toMatch(/^\d+$/);
    expect(await dev("t-1")).toBeNull();
    // another ip still works
    expect((await enroll({ key, device_id: "t-2", name: "x" }, { "cf-connecting-ip": "203.0.113.10" })).status).toBe(200);
    // the login throttle for this ip is separate (keyed by username)
    expect(await auth.loginLockedFor(env, "203.0.113.9", "admin")).toBe(0);
    expect(await auth.loginLockedFor(env, "203.0.113.9", auth.ENROLL_KEY, auth.ENROLL_MAX_FAILURES, auth.ENROLL_LOCK_SECONDS)).toBeGreaterThan(0);
    // ten failures older than 60 s do not lock
    await query("UPDATE login_failures SET at = at - 61 WHERE username = ?", auth.ENROLL_KEY);
    expect((await enroll({ key, device_id: "t-1", name: "x" }, ip)).status).toBe(200);
    await clear("203.0.113.9");
  });

  it("caps new device ids fleet-wide per hour (429 + Retry-After, audited); re-enrolls and rows older than an hour do not count", async () => {
    await query("DELETE FROM audit_log WHERE action = 'device_enroll_capped'");
    const before = (await query("SELECT COUNT(*) AS n FROM devices WHERE created_at > datetime('now', '-1 hour')"))[0].n;
    for (let i = 0; i < MAX_NEW_DEVICES_PER_HOUR - before; i++) {
      await query("INSERT INTO devices (device_id, name, token) VALUES (?, ?, ?)", `cap-${i}`, "x", `tok-cap-${i}`);
    }
    try {
      const capped = await enroll({ key, device_id: "cap-new", name: "x" }, { "cf-connecting-ip": "10.7.7.7" });
      expect(await detail(capped, 429)).toBe("Too many new projectors enrolled in the last hour; try again later");
      expect(capped.headers.get("retry-after")).toBe("3600");
      expect(await dev("cap-new")).toBeNull();
      expect((await audits("device_enroll_capped"))[0]).toMatchObject({ target_type: "device", target_id: null, details: '{"device_id": "cap-new", "name": "x"}', ip: "10.7.7.7" });
      // an existing id still re-enrolls (a re-flashed card)
      expect((await enroll({ key, device_id: "cap-0", name: "x" })).status).toBe(200);
      // a row aged past the hour frees a slot
      await query("UPDATE devices SET created_at = datetime('now', '-2 hours') WHERE device_id = 'cap-0'");
      expect((await enroll({ key, device_id: "cap-new", name: "x" })).status).toBe(200);
      expect(await dev("cap-new")).not.toBeNull();
    } finally {
      await query("DELETE FROM devices WHERE device_id LIKE 'cap-%'");
    }
  });

  it("applies the Settings group/playlist on first enrollment only; deleted rows count as none", async () => {
    await query("DELETE FROM audit_log WHERE action LIKE 'device_%enrolled'");
    const gid = await group("Enroll group");
    const pid = await playlist("Enroll playlist");
    try {
      // nothing configured (the default): no assignment
      expect((await enroll({ key, device_id: "auto-0", name: "x" })).status).toBe(200);
      expect(await dev("auto-0")).toMatchObject({ group_id: null, playlist_id: null });

      await setDefaults(gid, pid);
      expect((await enroll({ key, device_id: "auto-1", name: "Auto" })).status).toBe(200);
      const row = await dev("auto-1");
      expect(row).toMatchObject({ group_id: gid, playlist_id: pid });
      const [a] = await audits("device_enrolled");
      expect(a.details).toBe(`{"device_id": "auto-1", "name": "Auto", "group_id": ${gid}, "playlist_id": ${pid}}`);

      // re-enroll keeps whatever the device has now, even when the defaults changed
      await query("UPDATE devices SET group_id = NULL WHERE id = ?", row.id);
      await setDefaults(null, pid);
      expect((await enroll({ key, device_id: "auto-1", name: "Auto 2" })).status).toBe(200);
      expect(await dev("auto-1")).toMatchObject({ name: "Auto 2", group_id: null, playlist_id: pid });
      expect((await audits("device_reenrolled"))[0].details).toBe('{"device_id": "auto-1", "name": "Auto 2", "renamed_from": "Auto"}');
      // and the earlier device enrolled before any defaults is untouched by a re-enroll too
      expect((await enroll({ key, device_id: "auto-0", name: "x" })).status).toBe(200);
      expect(await dev("auto-0")).toMatchObject({ group_id: null, playlist_id: null });

      // only the playlist is set
      expect((await enroll({ key, device_id: "auto-2", name: "x" })).status).toBe(200);
      expect(await dev("auto-2")).toMatchObject({ group_id: null, playlist_id: pid });
      expect((await audits("device_enrolled"))[0].details).toBe(`{"device_id": "auto-2", "name": "x", "playlist_id": ${pid}}`);

      // dangling ids (rows deleted, settings not cleared) are ignored
      await setDefaults(gid, pid);
      await query("DELETE FROM device_groups WHERE id = ?", gid);
      await query("DELETE FROM playlists WHERE id = ?", pid);
      expect((await enroll({ key, device_id: "auto-3", name: "x" })).status).toBe(200);
      expect(await dev("auto-3")).toMatchObject({ group_id: null, playlist_id: null });
      expect((await audits("device_enrolled"))[0].details).toBe('{"device_id": "auto-3", "name": "x"}');
    } finally {
      await query("DELETE FROM settings WHERE key LIKE 'enroll_%_id'");
      await query("DELETE FROM device_groups WHERE id = ?", gid);
      await query("DELETE FROM playlists WHERE id = ?", pid);
    }
  });

  it("a rotated key invalidates the old one", async () => {
    const fresh = await db.generateEnrollmentKey(env);
    try {
      expect(fresh).not.toBe(key);
      expect((await enroll({ key, device_id: "r-1", name: "x" })).status).toBe(401);
      expect((await enroll({ key: fresh, device_id: "r-1", name: "x" })).status).toBe(200);
    } finally {
      await query("UPDATE settings SET value = ? WHERE key = 'enrollment_key'", key);
      await clear();
    }
  });
});
