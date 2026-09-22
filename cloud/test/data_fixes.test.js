// Data package audit fixes: migration 0006 heals duplicate media rows and duplicate open alerts
// itself before its unique indexes go on (instead of failing on a live database), 0008 indexes
// login_failures by username, and loadSettings reports a stored timezone it had to fall back from.
import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import * as db from "../src/db.js";
import { query } from "./helpers.js";
import { ins, one } from "./pages_common.js";

// The healing statements of migrations/0006_indexes.sql, verbatim (workerd cannot read the
// file): change them there and here together.
const HEAL_0006 = [
  `UPDATE playlist_items SET media_id = (SELECT MIN(id) FROM media m2 WHERE m2.sha256 = (SELECT sha256 FROM media WHERE id = playlist_items.media_id))
  WHERE media_id NOT IN (SELECT MIN(id) FROM media GROUP BY sha256)`,
  "DELETE FROM playlist_items WHERE id NOT IN (SELECT MIN(id) FROM playlist_items GROUP BY playlist_id, media_id)",
  "DELETE FROM media WHERE id NOT IN (SELECT MIN(id) FROM media GROUP BY sha256)",
  `UPDATE alerts SET closed_at = datetime('now')
  WHERE closed_at IS NULL AND id NOT IN (SELECT MAX(id) FROM alerts WHERE closed_at IS NULL GROUP BY device_id, kind)`,
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_media_sha256 ON media(sha256)",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_alerts_one_open ON alerts(device_id, kind) WHERE closed_at IS NULL",
];

describe("migration 0006 heals duplicates before indexing", () => {
  it("one media row per sha256 keeps the playlist item, one open alert per (device, kind) remains", async () => {
    // the test database is already at schema 8: take the unique indexes off to seed what a live one may hold
    await query("DROP INDEX idx_media_sha256");
    await query("DROP INDEX idx_alerts_one_open");
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

    for (const sql of HEAL_0006) await query(sql);

    expect(await query("SELECT id FROM media WHERE sha256 = ?", sha)).toEqual([{ id: oldest }]);
    expect(await query("SELECT id, media_id, position FROM playlist_items WHERE playlist_id = ? ORDER BY position", pl))
      .toEqual([{ id: keep, media_id: oldest, position: 0 }, { id: moved, media_id: other, position: 2 }]); // the gap stays
    expect(await query("SELECT id, media_id FROM playlist_items WHERE playlist_id = ?", pl2)).toEqual([{ id: repointed, media_id: oldest }]);
    expect(await query("SELECT id, notified_at FROM alerts WHERE device_id = ? AND closed_at IS NULL ORDER BY id", dev))
      .toEqual([{ id: a2, notified_at: null }, { id: a3, notified_at: null }]);
    expect((await one("SELECT notified_at, closed_at FROM alerts WHERE id = ?", a1))).toEqual({ notified_at: "2026-01-01 00:00:00", closed_at: expect.any(String) });
    // the indexes are back on
    await expect(env.DB.prepare("INSERT INTO media (filename, original_name, media_type, size_bytes, sha256) VALUES ('h4.mp4', 'h4', 'video', 1, ?)").bind(sha).run())
      .rejects.toThrow(/UNIQUE constraint failed: media.sha256/);
    await expect(env.DB.prepare("INSERT INTO alerts (device_id, kind) VALUES (?, 'offline')").bind(dev).run())
      .rejects.toThrow(/UNIQUE constraint failed: alerts.device_id, alerts.kind/);
  });
});

describe("migration 0008", () => {
  it("login_failures is indexed by username and schema_version is 8", async () => {
    expect(await query("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_login_failures_user'")).toEqual([{ name: "idx_login_failures_user" }]);
    expect(db.SCHEMA_VERSION).toBe(8);
    expect(await one("SELECT value FROM meta WHERE key = 'schema_version'")).toEqual({ value: "8" });
  });
});

describe("loadSettings", () => {
  it("a stored timezone that is no longer accepted falls back to UTC and is reported as timezone_problem", async () => {
    await query("INSERT OR REPLACE INTO settings (key, value) VALUES ('timezone', ?)", "Mars/" + "x".repeat(100));
    const s = await db.loadSettings(env);
    expect(s.timezone).toBe("UTC");
    expect(s.timezone_problem).toBe(("Mars/" + "x".repeat(100)).slice(0, 64));
    await query("INSERT OR REPLACE INTO settings (key, value) VALUES ('timezone', 'Europe/Paris')");
    const ok = await db.loadSettings(env);
    expect(ok.timezone).toBe("Europe/Paris");
    expect(ok).not.toHaveProperty("timezone_problem");
  });
});
