// Data package audit fixes: migration 0006 heals duplicate media rows and duplicate open alerts
// itself before its unique indexes go on (instead of failing on a live database), 0008 indexes
// login_failures by username, and loadSettings reports a stored timezone it had to fall back from.
import { describe, expect, it } from "vitest";
import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import * as db from "../src/db.js";
import { query } from "./helpers.js";
import { ins as insDB, one } from "./pages_common.js";

describe("migration 0006 heals duplicates before indexing", () => {
  it("one media row per sha256 keeps the playlist item, one open alert per (device, kind) remains", async () => {
    // An empty database at schema 5 holding what a live one may have held, then the real 0006.
    const m = env.MIGRATION_DB;
    const upTo = (name) => env.TEST_MIGRATIONS.filter((x) => x.name < name);
    await applyD1Migrations(m, upTo("0006"));
    const ins = async (sql, ...p) => (await m.prepare(sql).bind(...p).run()).meta.last_row_id;
    const mq = async (sql, ...p) => (await m.prepare(sql).bind(...p).all()).results;
    const sha = "d".repeat(64);
    const oldest = await ins("INSERT INTO media (filename, original_name, media_type, size_bytes, sha256) VALUES ('h1.mp4', 'h1', 'video', 1, ?)", sha);
    const dup = await ins("INSERT INTO media (filename, original_name, media_type, size_bytes, sha256) VALUES ('h2.mp4', 'h2', 'video', 1, ?)", sha);
    const other = await ins("INSERT INTO media (filename, original_name, media_type, size_bytes, sha256) VALUES ('h3.mp4', 'h3', 'video', 1, ?)", "e".repeat(64));
    const pl = await ins("INSERT INTO playlists (name) VALUES ('heal')");
    const keep = await ins("INSERT INTO playlist_items (playlist_id, media_id, position) VALUES (?, ?, 0)", pl, oldest);
    await ins("INSERT INTO playlist_items (playlist_id, media_id, position) VALUES (?, ?, 1)", pl, dup); // repeats `oldest` after re-pointing: dropped
    const moved = await ins("INSERT INTO playlist_items (playlist_id, media_id, position) VALUES (?, ?, 2)", pl, other);
    const pl2 = await ins("INSERT INTO playlists (name) VALUES ('heal2')");
    const repointed = await ins("INSERT INTO playlist_items (playlist_id, media_id, position) VALUES (?, ?, 0)", pl2, dup); // only use in its playlist: re-pointed
    const dev = await ins("INSERT INTO devices (device_id, name, token) VALUES ('d-heal', 'D', 'tok-heal')");
    const a1 = await ins("INSERT INTO alerts (device_id, kind, notified_at) VALUES (?, 'offline', '2026-01-01 00:00:00')", dev);
    const a2 = await ins("INSERT INTO alerts (device_id, kind) VALUES (?, 'offline')", dev);
    const a3 = await ins("INSERT INTO alerts (device_id, kind) VALUES (?, 'mpv-down')", dev);

    await applyD1Migrations(m, env.TEST_MIGRATIONS.filter((x) => x.name.startsWith("0006")));

    expect(await mq("SELECT id FROM media WHERE sha256 = ?", sha)).toEqual([{ id: oldest }]);
    expect(await mq("SELECT id, media_id, position FROM playlist_items WHERE playlist_id = ? ORDER BY position", pl))
      .toEqual([{ id: keep, media_id: oldest, position: 0 }, { id: moved, media_id: other, position: 2 }]); // the gap stays
    expect(await mq("SELECT id, media_id FROM playlist_items WHERE playlist_id = ?", pl2)).toEqual([{ id: repointed, media_id: oldest }]);
    expect(await mq("SELECT id, notified_at FROM alerts WHERE device_id = ? AND closed_at IS NULL ORDER BY id", dev))
      .toEqual([{ id: a2, notified_at: null }, { id: a3, notified_at: null }]);
    expect((await mq("SELECT notified_at, closed_at FROM alerts WHERE id = ?", a1))[0]).toEqual({ notified_at: "2026-01-01 00:00:00", closed_at: expect.any(String) });
    // the indexes are on
    await expect(m.prepare("INSERT INTO media (filename, original_name, media_type, size_bytes, sha256) VALUES ('h4.mp4', 'h4', 'video', 1, ?)").bind(sha).run())
      .rejects.toThrow(/UNIQUE constraint failed: media.sha256/);
    await expect(m.prepare("INSERT INTO alerts (device_id, kind) VALUES (?, 'offline')").bind(dev).run())
      .rejects.toThrow(/UNIQUE constraint failed: alerts.device_id, alerts.kind/);
    // and the rest of the migrations apply on top (0016 replaces the index with one per account)
    await applyD1Migrations(m, env.TEST_MIGRATIONS);
    expect((await mq("SELECT value FROM meta WHERE key = 'schema_version'"))[0].value).toBe(String(db.SCHEMA_VERSION));
  });
});

describe("migration 0008", () => {
  it("login_failures is indexed by username and schema_version matches db.js", async () => {
    expect(await query("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_login_failures_user'")).toEqual([{ name: "idx_login_failures_user" }]);
    expect(db.SCHEMA_VERSION).toBeGreaterThanOrEqual(8);
    expect(await one("SELECT value FROM meta WHERE key = 'schema_version'")).toEqual({ value: String(db.SCHEMA_VERSION) });
  });
});

describe("migration 0011", () => {
  it("adds users.email (unique, case-insensitive) and the password_resets table", async () => {
    expect((await query("PRAGMA table_info(users)")).map((c) => c.name)).toContain("email");
    expect((await query("PRAGMA table_info(password_resets)")).map((c) => c.name))
      .toEqual(["id", "user_id", "token_hash", "created_at", "expires_at", "used_at", "ip"]);
    expect(await query("SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('users_email_lower', 'idx_password_resets_user') ORDER BY name"))
      .toEqual([{ name: "idx_password_resets_user" }, { name: "users_email_lower" }]);
    await query("DELETE FROM users WHERE username LIKE 'm11-%'");
    await insDB("INSERT INTO users (username, password_hash, role, email) VALUES ('m11-a', 'x', 'viewer', 'Same@Example.com')");
    await expect(env.DB.prepare("INSERT INTO users (username, password_hash, role, email) VALUES ('m11-b', 'x', 'viewer', 'same@example.com')").run())
      .rejects.toThrow(/UNIQUE constraint failed/);
    // several accounts without an address are fine
    await insDB("INSERT INTO users (username, password_hash, role) VALUES ('m11-c', 'x', 'viewer')");
    await insDB("INSERT INTO users (username, password_hash, role) VALUES ('m11-d', 'x', 'viewer')");
    await query("DELETE FROM users WHERE username LIKE 'm11-%'");
  });
});

describe("loadSettings", () => {
  it("a stored timezone that is no longer accepted falls back to UTC and is reported as timezone_problem", async () => {
    const uid = await insDB("INSERT INTO users (username, password_hash, role) VALUES ('tz-user', 'x', 'editor')");
    const other = await insDB("INSERT INTO users (username, password_hash, role) VALUES ('tz-other', 'x', 'editor')");
    await query("INSERT OR REPLACE INTO account_settings (user_id, key, value) VALUES (?, 'timezone', ?)", uid, "Mars/" + "x".repeat(100));
    const s = await db.loadSettings(env, uid);
    expect(s.timezone).toBe("UTC");
    expect(s.timezone_problem).toBe(("Mars/" + "x".repeat(100)).slice(0, 64));
    expect(await db.loadSettings(env, other)).not.toHaveProperty("timezone_problem"); // another account's row
    await query("INSERT OR REPLACE INTO account_settings (user_id, key, value) VALUES (?, 'timezone', 'Europe/Paris')", uid);
    const ok = await db.loadSettings(env, uid);
    expect(ok.timezone).toBe("Europe/Paris");
    expect(ok).not.toHaveProperty("timezone_problem");
    expect((await db.loadSettings(env, other)).timezone).toBe("UTC");
    await query("DELETE FROM users WHERE id IN (?, ?)", uid, other);
  });
});
