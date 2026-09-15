// Playlist hash golden values (computed with the Python CMS formula), Python float
// formatting, and the resolution order schedule -> device default -> group default.
import { beforeAll, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import * as manifest from "../src/manifest.js";
import { wallClock } from "../src/util.js";
import { query } from "./helpers.js";

const SHA = (c) => c.repeat(64);

describe("manifest_json", () => {
  it("renders the float fields like Python's json.dumps, everything else untouched", () => {
    const body = {
      device: { id: "d", name: 'q"uote' },
      playlist: { id: 1, name: '"natural_duration_seconds":10', items: [
        { position: 0, filename: "a.mp4", natural_duration_seconds: 12, effective_duration_seconds: null, size_bytes: 10 },
        { position: 1, filename: "b.png", natural_duration_seconds: null, effective_duration_seconds: 10 },
        { position: 2, filename: "c.mp4", natural_duration_seconds: 7.25, effective_duration_seconds: 7.5 },
      ] },
      commands: [], screenshot_interval_seconds: 60,
    };
    const s = manifest.manifest_json(body);
    expect(s).toBe('{"device":{"id":"d","name":"q\\"uote"},"playlist":{"id":1,"name":"\\"natural_duration_seconds\\":10","items":['
      + '{"position":0,"filename":"a.mp4","natural_duration_seconds":12.0,"effective_duration_seconds":null,"size_bytes":10},'
      + '{"position":1,"filename":"b.png","natural_duration_seconds":null,"effective_duration_seconds":10.0},'
      + '{"position":2,"filename":"c.mp4","natural_duration_seconds":7.25,"effective_duration_seconds":7.5}]},'
      + '"commands":[],"screenshot_interval_seconds":60}');
    expect(JSON.parse(s)).toEqual(body);
  });
});

describe("pyFloatStr", () => {
  it("prints floats the way Python's str() does", () => {
    expect(manifest.pyFloatStr(null)).toBe("None");
    expect(manifest.pyFloatStr(undefined)).toBe("None");
    expect(manifest.pyFloatStr(7.5)).toBe("7.5");
    expect(manifest.pyFloatStr(10)).toBe("10.0");
    expect(manifest.pyFloatStr(3)).toBe("3.0");
    expect(manifest.pyFloatStr(0.1)).toBe("0.1");
    expect(manifest.pyFloatStr(86400)).toBe("86400.0");
    expect(manifest.pyFloatStr(1234.5678)).toBe("1234.5678");
    expect(manifest.pyFloatStr(123456789012345)).toBe("123456789012345.0");
    expect(manifest.pyFloatStr(1e16)).toBe("1e+16");
    expect(manifest.pyFloatStr(1e-5)).toBe("1e-05");
    expect(manifest.pyFloatStr(2.5e-7)).toBe("2.5e-07");
  });
});

describe("playlist_hash", () => {
  it("matches the sha256 the Python CMS produces for a known manifest", async () => {
    // cms/.venv python: hashlib.sha256 over "playlist:7\n" + "0:a.mp4:aaa..:None\n" +
    // "1:b.png:bbb..:10.0\n" + "2:c.mp4:ccc..:7.5\n" + "3:d.png:ddd..:3.0\n"
    const items = [
      { position: 0, filename: "a.mp4", sha256: SHA("a"), effective_duration_seconds: null },
      { position: 1, filename: "b.png", sha256: SHA("b"), effective_duration_seconds: 10 },
      { position: 2, filename: "c.mp4", sha256: SHA("c"), effective_duration_seconds: 7.5 },
      { position: 3, filename: "d.png", sha256: SHA("d"), effective_duration_seconds: 3 },
    ];
    expect(await manifest.playlist_hash(7, items))
      .toBe("sha256:3176ca70a7a6228741dc8b789a5394e9a28dec90ec21274d290c72fe4a5c15d3");
    expect(await manifest.playlist_hash(1, []))
      .toBe("sha256:2db8072ed651fa33fdd6e272bdb6e78c447ba3efc567a5c6ba97e983a361fe0b");
  });
});

describe("resolve_active_playlist_id / manifest_for_device", () => {
  const ids = {};
  const settings = { timezone: "UTC", screenshot_interval: 60, default_image_duration: 10 };

  beforeAll(async () => {
    const ins = async (sql, ...p) => (await env.DB.prepare(sql).bind(...p).run()).meta.last_row_id;
    ids.plA = await ins("INSERT INTO playlists (name) VALUES ('A')");
    ids.plB = await ins("INSERT INTO playlists (name) VALUES ('B')");
    ids.plC = await ins("INSERT INTO playlists (name) VALUES ('C')");
    ids.plD = await ins("INSERT INTO playlists (name) VALUES ('D')");
    ids.grp = await ins("INSERT INTO device_groups (name, playlist_id) VALUES ('g', ?)", ids.plC);
    ids.mVid = await ins(`INSERT INTO media (filename, original_name, media_type, size_bytes, duration_seconds, sha256)
                          VALUES ('v.mp4', 'v.mp4', 'video', 100, 2.0, ?)`, SHA("1"));
    ids.mImg = await ins(`INSERT INTO media (filename, original_name, media_type, size_bytes, sha256)
                          VALUES ('i.png', 'i.png', 'image', 50, ?)`, SHA("2"));
    await ins("INSERT INTO playlist_items (playlist_id, media_id, position) VALUES (?, ?, 0)", ids.plA, ids.mVid);
    await ins("INSERT INTO playlist_items (playlist_id, media_id, position, duration_override_seconds) VALUES (?, ?, 1, 7.5)", ids.plA, ids.mImg);
    await ins("INSERT INTO playlist_items (playlist_id, media_id, position) VALUES (?, ?, 2)", ids.plA, ids.mImg);
    ids.dev = await ins("INSERT INTO devices (device_id, name, token, playlist_id, group_id) VALUES ('d1', 'Dev 1', 't1', ?, ?)", ids.plA, ids.grp);
    ids.devGroupOnly = await ins("INSERT INTO devices (device_id, name, token, group_id) VALUES ('d2', 'Dev 2', 't2', ?)", ids.grp);
    ids.devNone = await ins("INSERT INTO devices (device_id, name, token) VALUES ('d3', 'Dev 3', 't3')");
  });

  const device = () => query("SELECT id, device_id, name, playlist_id, group_id FROM devices WHERE id = ?", ids.dev).then((r) => r[0]);
  const now = () => wallClock("UTC", new Date(Date.UTC(2026, 8, 14, 12, 0))); // Monday noon

  it("device default, then group default, then null", async () => {
    expect(await manifest.resolve_active_playlist_id(env, await device(), now())).toEqual([ids.plA, "device-default"]);
    const d2 = (await query("SELECT * FROM devices WHERE id = ?", ids.devGroupOnly))[0];
    expect(await manifest.resolve_active_playlist_id(env, d2, now())).toEqual([ids.plC, "group-default"]);
    const d3 = (await query("SELECT * FROM devices WHERE id = ?", ids.devNone))[0];
    expect(await manifest.resolve_active_playlist_id(env, d3, now())).toEqual([null, null]);
  });

  it("a matching schedule wins (highest priority, then highest id); a bad row is ignored", async () => {
    await query("INSERT INTO device_schedules (device_id, playlist_id, name, priority, start_time, end_time) VALUES (?, ?, 'lunch', 5, '11:00', '13:00')", ids.dev, ids.plB);
    const s2 = (await env.DB.prepare("INSERT INTO device_schedules (device_id, playlist_id, name, priority, days_of_week) VALUES (?, ?, 'mon', 5, '0')").bind(ids.dev, ids.plD).run()).meta.last_row_id;
    await query("INSERT INTO device_schedules (device_id, playlist_id, name, priority, start_time) VALUES (?, ?, 'broken', 99, 'junk')", ids.dev, ids.plC);
    expect(await manifest.resolve_active_playlist_id(env, await device(), now())).toEqual([ids.plD, "schedule:mon"]);
    // Tuesday: 'mon' no longer matches, 'lunch' does
    const tue = wallClock("UTC", new Date(Date.UTC(2026, 8, 15, 12, 0)));
    expect(await manifest.resolve_active_playlist_id(env, await device(), tue)).toEqual([ids.plB, "schedule:lunch"]);
    // Tuesday evening: back to the device default
    const eve = wallClock("UTC", new Date(Date.UTC(2026, 8, 15, 20, 0)));
    expect(await manifest.resolve_active_playlist_id(env, await device(), eve)).toEqual([ids.plA, "device-default"]);
    await query("DELETE FROM device_schedules WHERE id = ?", s2);
    await query("DELETE FROM device_schedules WHERE name IN ('lunch', 'broken')");
  });

  it("builds the manifest with Python-compatible durations, urls and hash", async () => {
    const m = await manifest.manifest_for_device(env, await device(), "https://cms.example", settings, new Date(Date.UTC(2026, 8, 14, 12, 0, 7)));
    expect(m.device).toEqual({ id: "d1", name: "Dev 1" });
    expect(m.commands).toEqual([]);
    expect(m.screenshot_interval_seconds).toBe(60);
    expect(m.server_time).toBe("2026-09-14T12:00:07+00:00");
    const p = m.playlist;
    expect(p.id).toBe(ids.plA);
    expect(p.name).toBe("A");
    expect(p.source).toBe("device-default");
    expect(p.updated_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(p.items.map((i) => [i.position, i.filename, i.effective_duration_seconds, i.natural_duration_seconds, i.media_type, i.size_bytes]))
      .toEqual([[0, "v.mp4", null, 2, "video", 100], [1, "i.png", 7.5, null, "image", 50], [2, "i.png", 10, null, "image", 50]]);
    expect(p.items[0].url).toBe("https://cms.example/api/media/v.mp4");
    expect(p.items[1].sha256).toBe(SHA("2"));
    // "playlist:{id}\n0:v.mp4:111..:None\n1:i.png:222..:7.5\n2:i.png:222..:10.0\n"
    expect(p.hash).toBe(await manifest.playlist_hash(ids.plA, p.items));
    expect(p.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("uses the site default image duration and timezone from settings", async () => {
    const m = await manifest.manifest_for_device(env, await device(), "https://cms.example",
      { timezone: "America/Los_Angeles", screenshot_interval: 30, default_image_duration: 4 },
      new Date(Date.UTC(2026, 8, 14, 12, 0, 7)));
    expect(m.server_time).toBe("2026-09-14T05:00:07-07:00");
    expect(m.screenshot_interval_seconds).toBe(30);
    expect(m.playlist.items[2].effective_duration_seconds).toBe(4);
  });
});
