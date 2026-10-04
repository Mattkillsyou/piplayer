// Migration 0016 (accounts) on real data and on an empty database, run with the real migration
// files (TEST_MIGRATIONS) against the empty MIGRATION_DB / FRESH_DB bindings (vitest.config.js):
// the rows of a live single-account console seeded at schema 9, then 0010-0015, then 0016. Proves
// everything shared becomes the site admin's (the lowest-id admin), the settings and secrets move
// to that account (the enrollment key stays site-wide), every other account gets its own Default
// playlist, a projector of another account loses only what now belongs to someone else (audited),
// nothing else is deleted (the old settings and secrets rows stay for the worker from before the
// migration, which keeps serving until the new one is deployed), the site admin is recorded rather
// than recomputed, and the code reads the result as intended. The fresh-install path is /setup's
// accounts.adoptOrphans.
import { beforeAll, describe, expect, it } from "vitest";
import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import * as accounts from "../src/accounts.js";
import * as db from "../src/db.js";
import * as manifest from "../src/manifest.js";
import * as secrets from "../src/secrets.js";
import { wallClock } from "../src/util.js";

const before = (name) => env.TEST_MIGRATIONS.filter((m) => m.name < name);
const SHA = (c) => c.repeat(64);

describe("migration 0016 on a live database", () => {
  const m = env.MIGRATION_DB;
  const envM = { ...env, DB: m };
  const ins = async (sql, ...p) => (await m.prepare(sql).bind(...p).run()).meta.last_row_id;
  const all = async (sql, ...p) => (await m.prepare(sql).bind(...p).all()).results;
  const one = async (sql, ...p) => (await all(sql, ...p))[0] ?? null;
  const id = {};
  const counts = {};
  const countAll = async () => Object.fromEntries(await Promise.all(
    ["media", "playlist_items", "playlists", "device_groups", "devices", "device_schedules", "uploads", "audit_log", "users"]
      .map(async (t) => [t, (await one(`SELECT COUNT(*) AS n FROM ${t}`)).n])));

  beforeAll(async () => {
    // A console as it was at schema 9: one shared library, projectors per account.
    await applyD1Migrations(m, before("0010"));
    id.ed = await ins("INSERT INTO users (username, password_hash, role) VALUES ('ed', 'x', 'editor')"); // lowest id, not an admin
    id.boss = await ins("INSERT INTO users (username, password_hash, role) VALUES ('boss', 'x', 'admin')"); // the site admin
    id.admin2 = await ins("INSERT INTO users (username, password_hash, role) VALUES ('admin2', 'x', 'admin')");
    id.vw = await ins("INSERT INTO users (username, password_hash, role) VALUES ('vw', 'x', 'viewer')");
    const media = (file, sha, at) => ins(
      "INSERT INTO media (filename, original_name, media_type, size_bytes, sha256, uploaded_at) VALUES (?, ?, 'image', 10, ?, ?)", file, file, sha, at);
    id.m1 = await media("a.png", SHA("a"), "2026-01-01 00:00:00");
    id.m2 = await media("b.png", SHA("b"), "2026-01-02 00:00:00");
    id.m3 = await media("orphan.png", SHA("c"), "2026-01-03 00:00:00"); // in no playlist: 0010 appends it to Default
    id.lobby = await ins("INSERT INTO playlists (name) VALUES ('Lobby')");
    id.night = await ins("INSERT INTO playlists (name) VALUES ('Night')");
    await ins("INSERT INTO playlist_items (playlist_id, media_id, position) VALUES (?, ?, 0)", id.lobby, id.m1);
    await ins("INSERT INTO playlist_items (playlist_id, media_id, position) VALUES (?, ?, 1)", id.lobby, id.m2);
    await ins("INSERT INTO playlist_items (playlist_id, media_id, position) VALUES (?, ?, 0)", id.night, id.m2);
    id.hall = await ins("INSERT INTO device_groups (name, playlist_id) VALUES ('Hall', ?)", id.lobby);
    const device = (deviceId, owner, playlist, group) => ins(
      "INSERT INTO devices (device_id, name, token, owner_id, playlist_id, group_id) VALUES (?, ?, ?, ?, ?, ?)", deviceId, deviceId, `tok-${deviceId}`, owner, playlist, group);
    id.dBoss = await device("d-boss", id.boss, id.lobby, id.hall);
    id.dNone = await device("d-none", null, id.night, null);
    id.dEd = await device("d-ed", id.ed, id.lobby, id.hall);
    id.dAdmin2 = await device("d-admin2", id.admin2, id.night, null);
    id.ruleBoss = await ins("INSERT INTO device_schedules (device_id, playlist_id, name, priority, start_time, end_time) VALUES (?, ?, 'evening', 1, '18:00', '23:00')", id.dBoss, id.night);
    id.ruleEd = await ins("INSERT INTO device_schedules (device_id, playlist_id, name, priority) VALUES (?, ?, 'it''s \"late\"', 1)", id.dEd, id.night);
    for (const [k, v] of [["timezone", "Europe/London"], ["enrollment_key", "ek-123"], ["alert_email", "ops@example.net"], ["camera_config_version", "3"]]) {
      await ins("INSERT INTO settings (key, value) VALUES (?, ?)", k, v);
    }
    // the Wyze login as the old site-wide table held it: v1, bound to the name
    for (const [name, value] of [["wyze_email", "cam@example.net"], ["wyze_password", "pw"]]) {
      await ins("INSERT INTO secrets (name, value) VALUES (?, ?)", name, await secrets.encrypt(env, name, value));
    }
    await ins("INSERT INTO uploads (id, user_id, key, upload_id, name, size, sha256, media_type) VALUES ('u-ed', ?, 'k1', 'r2-1', 'x.png', 1, ?, 'image')", id.ed, SHA("d"));
    await ins("INSERT INTO uploads (id, user_id, key, upload_id, name, size, sha256, media_type) VALUES ('u-gone', NULL, 'k2', 'r2-2', 'y.png', 1, ?, 'image')", SHA("e"));
    id.auditEd = await ins("INSERT INTO audit_log (user_id, username, action) VALUES (?, 'ed', 'device_rename')", id.ed);
    id.auditSync = await ins("INSERT INTO audit_log (user_id, username, action) VALUES (NULL, NULL, 'device_sync')");

    await applyD1Migrations(m, before("0016"));
    counts.before = await countAll();
    await applyD1Migrations(m, env.TEST_MIGRATIONS);
    counts.after = await countAll();
  });

  it("0010 still seeds the shared Default with the file that was in no playlist", async () => {
    id.siteDefault = (await one("SELECT id FROM playlists WHERE legacy_name = 'Default'")).id;
    expect(await all("SELECT media_id FROM playlist_items WHERE playlist_id = ?", id.siteDefault)).toEqual([{ media_id: id.m3 }]);
  });

  it("reaches schema 16 and deletes nothing but the cross-account schedule rule", async () => {
    expect((await one("SELECT value FROM meta WHERE key = 'schema_version'")).value).toBe(String(db.SCHEMA_VERSION));
    expect(db.SCHEMA_VERSION).toBe(16);
    expect(counts.after).toEqual({
      ...counts.before,
      playlists: counts.before.playlists + 3, // a Default each for ed, admin2 and vw
      device_schedules: counts.before.device_schedules - 1,
      audit_log: counts.before.audit_log + 4, // what step 6 changed, one row each
    });
  });

  it("the worker from before 0016 keeps working until the new one is deployed", async () => {
    // Between `migrations apply` and `wrangler deploy` the old worker still serves every request.
    // Its own statements (db.loadSettings, manifest.manifest_for_device and secrets.get as they were
    // before this migration) must still find the Default playlist and the Wyze login: a projector
    // on the Default that got `playlist: null` would drop its cached media (player/sync.py), and
    // the camera config would turn off.
    const old = Object.fromEntries((await all(
      "SELECT key, value FROM settings WHERE key != 'default_playlist_id' OR value IN (SELECT CAST(id AS TEXT) FROM playlists)")).map((r) => [r.key, r.value]));
    expect(old).toMatchObject({ default_playlist_id: String(id.siteDefault), timezone: "Europe/London", alert_email: "ops@example.net", enrollment_key: "ek-123" });
    const device = await one("SELECT id, device_id, name, playlist_id, group_id FROM devices WHERE id = ?", id.dEd); // nothing of its own any more
    const rules = await all(
      `SELECT s.id, s.playlist_id, s.name, s.priority, s.start_time, s.end_time, s.days_of_week, s.start_date, s.end_date, p.name AS playlist_name
         FROM device_schedules s LEFT JOIN playlists p ON p.id = s.playlist_id WHERE s.device_id = ?`, device.id);
    const [pid, source] = manifest.pick_playlist(device, rules, null, wallClock(old.timezone), Number(old.default_playlist_id));
    expect([pid, source]).toEqual([id.siteDefault, "site-default"]);
    expect(await one("SELECT id, name FROM playlists WHERE id = ?", pid)).toEqual({ id: id.siteDefault, name: "Default" });
    const items = await all(
      `SELECT m.filename FROM playlist_items pi JOIN media m ON m.id = pi.media_id WHERE pi.playlist_id = ? ORDER BY pi.position ASC, pi.id ASC`, pid);
    expect(items).toEqual([{ filename: "orphan.png" }]);
    const wyze = await one("SELECT value FROM secrets WHERE name = 'wyze_email'");
    expect(await secrets.decrypt(env, "wyze_email", wyze.value)).toBe("cam@example.net");
  });

  it("everything shared is the site admin's (the lowest-id admin, recorded); names stay, the old column keeps them", async () => {
    expect(await one("SELECT value FROM settings WHERE key = 'site_admin_id'")).toEqual({ value: String(id.boss) });
    expect(await all("SELECT DISTINCT owner_id FROM media")).toEqual([{ owner_id: id.boss }]);
    expect(await all("SELECT DISTINCT owner_id FROM device_groups")).toEqual([{ owner_id: id.boss }]);
    expect(await all("SELECT name, legacy_name, owner_id FROM playlists WHERE id IN (?, ?, ?) ORDER BY id", id.lobby, id.night, id.siteDefault)).toEqual([
      { name: "Lobby", legacy_name: "Lobby", owner_id: id.boss },
      { name: "Night", legacy_name: "Night", owner_id: id.boss },
      { name: "Default", legacy_name: "Default", owner_id: id.boss },
    ]);
    expect(await one("SELECT name, legacy_name FROM device_groups WHERE id = ?", id.hall)).toEqual({ name: "Hall", legacy_name: "Hall" });
    // an upload in flight stays its uploader's; one whose uploader is gone is the site admin's
    expect(await all("SELECT id, user_id FROM uploads ORDER BY id")).toEqual([{ id: "u-ed", user_id: id.ed }, { id: "u-gone", user_id: id.boss }]);
    // the playlist contents are untouched
    expect(await all("SELECT playlist_id, media_id, position FROM playlist_items WHERE playlist_id IN (?, ?) ORDER BY playlist_id, position", id.lobby, id.night))
      .toEqual([{ playlist_id: id.lobby, media_id: id.m1, position: 0 }, { playlist_id: id.lobby, media_id: id.m2, position: 1 }, { playlist_id: id.night, media_id: id.m2, position: 0 }]);
  });

  it("settings and secrets are copied to the site admin (the old rows stay); the enrollment key stays site-wide", async () => {
    expect(await all("SELECT key, value FROM settings ORDER BY key")).toEqual([
      { key: "alert_email", value: "ops@example.net" }, { key: "camera_config_version", value: "3" },
      { key: "default_playlist_id", value: String(id.siteDefault) }, { key: "enrollment_key", value: "ek-123" },
      { key: "site_admin_id", value: String(id.boss) }, { key: "timezone", value: "Europe/London" },
    ]);
    expect(await all("SELECT user_id, key, value FROM account_settings WHERE user_id = ? ORDER BY key", id.boss)).toEqual([
      { user_id: id.boss, key: "alert_email", value: "ops@example.net" },
      { user_id: id.boss, key: "camera_config_version", value: "3" },
      { user_id: id.boss, key: "default_playlist_id", value: String(id.siteDefault) },
      { user_id: id.boss, key: "timezone", value: "Europe/London" },
    ]);
    expect(await all("SELECT name FROM secrets ORDER BY name")).toEqual([{ name: "wyze_email" }, { name: "wyze_password" }]);
    expect((await all("SELECT user_id, name FROM account_secrets ORDER BY name"))).toEqual([{ user_id: id.boss, name: "wyze_email" }, { user_id: id.boss, name: "wyze_password" }]);
    // the code reads them: the old ciphertext still opens for its new account only, and the
    // nightly housekeeping binds it to the account
    expect(await secrets.get(envM, id.boss, "wyze_email")).toBe("cam@example.net");
    expect(await secrets.wyzeConfigured(envM, id.boss)).toBe(true);
    expect(await secrets.get(envM, id.ed, "wyze_email")).toBeNull();
    expect(await secrets.housekeeping(envM)).toBe(2);
    expect((await one("SELECT value FROM account_secrets WHERE name = 'wyze_email'")).value).toMatch(/^v2:/);
    expect((await one("SELECT value FROM secrets WHERE name = 'wyze_email'")).value).toMatch(/^v1:/); // the old worker's copy, untouched
    expect(await secrets.get(envM, id.boss, "wyze_email")).toBe("cam@example.net");
    const s = await db.loadSettings(envM, id.boss);
    expect([s.timezone, s.alert_email, s.camera_config_version, s.default_playlist_id]).toEqual(["Europe/London", "ops@example.net", 3, id.siteDefault]);
    expect((await db.loadSettings(envM, id.ed)).timezone).toBe("UTC");
    expect(await db.enrollmentKey(envM)).toBe("ek-123");
  });

  it("every other account has its own empty Default playlist", async () => {
    for (const user of [id.ed, id.admin2, id.vw]) {
      const pid = Number((await one("SELECT value FROM account_settings WHERE user_id = ? AND key = 'default_playlist_id'", user)).value);
      expect(await one("SELECT name, owner_id FROM playlists WHERE id = ?", pid)).toEqual({ name: "Default", owner_id: user });
      expect(await all("SELECT id FROM playlist_items WHERE playlist_id = ?", pid)).toEqual([]);
      expect(pid).not.toBe(id.siteDefault);
      id[`default_${user}`] = pid;
    }
  });

  it("the audit rows by a person are about their account; device and cron rows about nobody", async () => {
    expect(await one("SELECT owner_id FROM audit_log WHERE id = ?", id.auditEd)).toEqual({ owner_id: id.ed });
    expect(await one("SELECT owner_id FROM audit_log WHERE id = ?", id.auditSync)).toEqual({ owner_id: null });
  });

  it("a projector keeps only its own account's content: another account's playlist, group and rule go, audited", async () => {
    const dev = (i) => one("SELECT playlist_id, group_id FROM devices WHERE id = ?", i);
    expect(await dev(id.dBoss)).toEqual({ playlist_id: id.lobby, group_id: id.hall }); // the site admin's own
    expect(await dev(id.dNone)).toEqual({ playlist_id: id.night, group_id: null }); // ownerless: the site admin's content
    expect(await dev(id.dEd)).toEqual({ playlist_id: null, group_id: null });
    expect(await dev(id.dAdmin2)).toEqual({ playlist_id: null, group_id: null }); // another admin is another account
    expect(await all("SELECT id FROM device_schedules ORDER BY id")).toEqual([{ id: id.ruleBoss }]);
    const rows = await all("SELECT user_id, action, target_type, target_id, details, owner_id FROM audit_log WHERE details LIKE '%migration 0016%' ORDER BY id");
    expect(rows.map((r) => ({ ...r, details: JSON.parse(r.details) }))).toEqual([
      { user_id: null, action: "device_assign_playlist", target_type: "device", target_id: String(id.dEd), owner_id: id.ed,
        details: { playlist_id: null, was: id.lobby, reason: "migration 0016: that playlist belongs to another account" } },
      { user_id: null, action: "device_assign_playlist", target_type: "device", target_id: String(id.dAdmin2), owner_id: id.admin2,
        details: { playlist_id: null, was: id.night, reason: "migration 0016: that playlist belongs to another account" } },
      { user_id: null, action: "device_set_group", target_type: "device", target_id: String(id.dEd), owner_id: id.ed,
        details: { group_id: null, was: id.hall, reason: "migration 0016: that group belongs to another account" } },
      { user_id: null, action: "device_schedule_delete", target_type: "device_schedule", target_id: String(id.ruleEd), owner_id: id.ed,
        details: { device_id: id.dEd, name: "it's \"late\"", playlist_id: id.night, reason: "migration 0016: that playlist belongs to another account" } },
    ]);
  });

  it("the projectors play what the code resolves from the migrated rows", async () => {
    const row = (i) => one("SELECT * FROM devices WHERE id = ?", i);
    const noon = wallClock("UTC", new Date(Date.UTC(2026, 9, 5, 12, 0)));
    const evening = wallClock("UTC", new Date(Date.UTC(2026, 9, 5, 19, 0)));
    expect(await manifest.resolve_active_playlist_id(envM, await row(id.dBoss), noon)).toEqual([id.lobby, "device-default"]);
    expect(await manifest.resolve_active_playlist_id(envM, await row(id.dBoss), evening)).toEqual([id.night, "schedule:evening"]);
    expect(await manifest.resolve_active_playlist_id(envM, await row(id.dNone), noon)).toEqual([id.night, "device-default"]);
    expect(await manifest.resolve_active_playlist_id(envM, await row(id.dEd), noon)).toEqual([id[`default_${id.ed}`], "site-default"]);
    expect(await manifest.resolve_active_playlist_id(envM, await row(id.dAdmin2), noon)).toEqual([id[`default_${id.admin2}`], "site-default"]);
  });

  it("the site admin is recorded, not recomputed: promoting a lower-id user moves nothing", async () => {
    await m.prepare("UPDATE users SET role = 'admin' WHERE id = ?").bind(id.ed).run(); // now the lowest-id admin
    expect(await accounts.siteAdminId(envM)).toBe(id.boss);
    const none = await one("SELECT * FROM devices WHERE id = ?", id.dNone);
    expect(await accounts.contentOwnerOf(envM, none)).toBe(id.boss);
    expect(await manifest.resolve_active_playlist_id(envM, none, wallClock("UTC", new Date(Date.UTC(2026, 9, 5, 12, 0))))).toEqual([id.night, "device-default"]);
    await m.prepare("UPDATE users SET role = 'editor' WHERE id = ?").bind(id.ed).run();
  });

  it("uniqueness is per account from here on", async () => {
    // the same file in another account's library, and the same names, are fine
    await ins("INSERT INTO media (filename, original_name, media_type, size_bytes, sha256, owner_id) VALUES ('a-ed.png', 'a.png', 'image', 10, ?, ?)", SHA("a"), id.ed);
    await ins("INSERT INTO playlists (owner_id, name, legacy_name) VALUES (?, 'Lobby', 'k-1')", id.ed);
    await ins("INSERT INTO device_groups (owner_id, name, legacy_name) VALUES (?, 'Hall', 'k-2')", id.ed);
    // twice in one account is not
    await expect(m.prepare("INSERT INTO media (filename, original_name, media_type, size_bytes, sha256, owner_id) VALUES ('a-2.png', 'a.png', 'image', 10, ?, ?)").bind(SHA("a"), id.boss).run())
      .rejects.toThrow(/UNIQUE constraint failed: media.owner_id, media.sha256/);
    await expect(m.prepare("INSERT INTO playlists (owner_id, name, legacy_name) VALUES (?, 'Lobby', 'k-3')").bind(id.ed).run())
      .rejects.toThrow(/UNIQUE constraint failed: playlists.owner_id, playlists.name/);
    await expect(m.prepare("INSERT INTO device_groups (owner_id, name, legacy_name) VALUES (?, 'Hall', 'k-4')").bind(id.boss).run())
      .rejects.toThrow(/UNIQUE constraint failed: device_groups.owner_id, device_groups.name/);
  });

  it("deleting an account deletes its library, playlists, groups and settings; its projectors stay, ownerless", async () => {
    await m.prepare("DELETE FROM users WHERE id = ?").bind(id.ed).run();
    for (const t of ["media", "playlists", "device_groups"]) expect(await all(`SELECT id FROM ${t} WHERE owner_id = ?`, id.ed), t).toEqual([]);
    expect(await all("SELECT key FROM account_settings WHERE user_id = ?", id.ed)).toEqual([]);
    expect(await one("SELECT owner_id FROM devices WHERE id = ?", id.dEd)).toEqual({ owner_id: null });
    expect(await one("SELECT owner_id FROM audit_log WHERE id = ?", id.auditEd)).toEqual({ owner_id: null });
    expect((await one("SELECT COUNT(*) AS n FROM media WHERE owner_id = ?", id.boss)).n).toBe(3); // the others' untouched
  });
});

describe("migration 0016 on an empty database (fresh install)", () => {
  const f = env.FRESH_DB;
  const envF = { ...env, DB: f };
  const all = async (sql, ...p) => (await f.prepare(sql).bind(...p).all()).results;

  it("applies cleanly; what the migrations seed keeps no owner until /setup adopts it", async () => {
    await applyD1Migrations(f, env.TEST_MIGRATIONS);
    expect(await all("SELECT value FROM meta WHERE key = 'schema_version'")).toEqual([{ value: "16" }]);
    expect(await all("SELECT id, name, owner_id FROM playlists")).toEqual([{ id: 1, name: "Default", owner_id: null }]);
    expect(await all("SELECT key, value FROM settings")).toEqual([{ key: "default_playlist_id", value: "1" }]); // no site admin recorded yet
    expect(await all("SELECT * FROM account_settings")).toEqual([]);
    const admin = (await f.prepare("INSERT INTO users (username, password_hash, role) VALUES ('first', 'x', 'admin')").run()).meta.last_row_id;
    expect(await accounts.adoptOrphans(envF, admin)).toBe(1);
    expect(await all("SELECT id, owner_id FROM playlists")).toEqual([{ id: 1, owner_id: admin }]);
    expect(await all("SELECT user_id, key, value FROM account_settings")).toEqual([{ user_id: admin, key: "default_playlist_id", value: "1" }]);
    expect(await all("SELECT key, value FROM settings")).toEqual([{ key: "site_admin_id", value: String(admin) }]); // /setup records it
    expect(await accounts.siteAdminId(envF)).toBe(admin);
    // the next account gets a Default of its own
    const next = (await f.prepare("INSERT INTO users (username, password_hash, role) VALUES ('next', 'x', 'editor')").run()).meta.last_row_id;
    const pid = await accounts.ensureDefaultPlaylist(envF, next);
    expect(pid).not.toBe(1);
    expect(await accounts.ensureDefaultPlaylist(envF, next)).toBe(pid); // idempotent
    expect(await all("SELECT name, owner_id FROM playlists WHERE id = ?", pid)).toEqual([{ name: "Default", owner_id: next }]);
  });
});
