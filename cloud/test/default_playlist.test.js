// The site default playlist (migration 0010): the "Default" playlist every upload joins and
// every projector plays unless a schedule rule matches or the device / its group has a
// playlist of its own; the Settings select that moves it, the delete refusal and the wording
// on the Devices / Groups / Dashboard / Library pages.
import { beforeAll, describe, expect, it } from "vitest";
import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import * as db from "../src/db.js";
import * as manifest from "../src/manifest.js";
import { wallClock } from "../src/util.js";
import { BASE, query } from "./helpers.js";
import { audits, detail, device, group, ins, media, one, playlist, post, roles } from "./pages_common.js";

// The statements of migrations/0010_default_playlist.sql, verbatim (workerd cannot read the
// file): change them there and here together.
const MIGRATE_0010 = [
  "INSERT INTO playlists (name) SELECT 'Default' WHERE NOT EXISTS (SELECT 1 FROM playlists WHERE name = 'Default')",
  `INSERT INTO settings (key, value) SELECT 'default_playlist_id', CAST(id AS TEXT) FROM playlists
 WHERE name = 'Default' AND NOT EXISTS (SELECT 1 FROM settings WHERE key = 'default_playlist_id')`,
  `INSERT INTO playlist_items (playlist_id, media_id, position)
SELECT p.id, m.id,
       (SELECT COALESCE(MAX(position), -1) FROM playlist_items WHERE playlist_id = p.id) + ROW_NUMBER() OVER (ORDER BY m.uploaded_at, m.id)
  FROM media m, playlists p
 WHERE p.id = (SELECT CAST(value AS INTEGER) FROM settings WHERE key = 'default_playlist_id')
   AND NOT EXISTS (SELECT 1 FROM playlist_items pi WHERE pi.media_id = m.id)`,
];

const hex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
const digest = async (data) => hex(await crypto.subtle.digest("SHA-256", data));
const fakeFile = (size, seed) => Uint8Array.from({ length: size }, (_, i) => (i * seed + 7) & 0xff);
const bearer = (token) => ({ authorization: `Bearer ${token}` });
const defaultId = async () => Number((await one("SELECT value FROM settings WHERE key = 'default_playlist_id'")).value);
const items = (pid) => query("SELECT media_id, position FROM playlist_items WHERE playlist_id = ? ORDER BY position", pid);

let r, DEFAULT;

beforeAll(async () => {
  r = await roles();
  DEFAULT = await defaultId();
});

// Whole chunked upload of `data` as `name` by the editor; returns the new media id.
async function upload(name, data) {
  const init = await r.editor.postJson("/library/upload/init", { name, size: data.length, sha256: await digest(data), media_type: "image" }, { "X-CSRF-Token": r.editor.token });
  expect(init.status, await init.clone().text()).toBe(200);
  const { upload_id } = await init.json();
  const part = await r.editor.fetch(`/library/upload/${upload_id}/part/1`, { method: "PUT", body: data, headers: { "X-CSRF-Token": r.editor.token } });
  expect(part.status, await part.clone().text()).toBe(200);
  const done = await r.editor.postJson(`/library/upload/${upload_id}/complete`, {}, { "X-CSRF-Token": r.editor.token });
  expect(done.status, await done.clone().text()).toBe(200);
  return (await done.json()).media_id;
}

describe("migration 0010", () => {
  it("seeded the Default playlist and the setting; db.js is at schema 10 or later", async () => {
    expect(db.SCHEMA_VERSION).toBeGreaterThanOrEqual(10);
    expect(await one("SELECT value FROM meta WHERE key = 'schema_version'")).toEqual({ value: String(db.SCHEMA_VERSION) });
    expect(await one("SELECT name FROM playlists WHERE id = ?", DEFAULT)).toEqual({ name: "Default" });
    expect((await db.loadSettings(env)).default_playlist_id).toBe(DEFAULT);
    expect(db.SETTING_KEYS).toContain("default_playlist_id");
  });

  it("appends media that is in no playlist after the default's last item, keeps an existing Default and runs twice without harm", async () => {
    // a live database: one playlist already named Default with an item, one other playlist, two orphan files
    await query("DELETE FROM settings WHERE key = 'default_playlist_id'");
    const inDefault = await media("already.png");
    await ins("INSERT INTO playlist_items (playlist_id, media_id, position) VALUES (?, ?, 4)", DEFAULT, inDefault);
    const other = await playlist("Lobby");
    const inOther = await media("lobby.png");
    await ins("INSERT INTO playlist_items (playlist_id, media_id, position) VALUES (?, ?, 0)", other, inOther);
    const orphanLate = await media("late.png");
    await query("UPDATE media SET uploaded_at = '2026-02-01 00:00:00' WHERE id = ?", orphanLate);
    const orphanEarly = await media("early.png");
    await query("UPDATE media SET uploaded_at = '2026-01-01 00:00:00' WHERE id = ?", orphanEarly);

    for (const sql of MIGRATE_0010) await query(sql);
    expect(await query("SELECT id FROM playlists WHERE name = 'Default'")).toEqual([{ id: DEFAULT }]); // not a second one
    expect(await defaultId()).toBe(DEFAULT);
    expect(await items(DEFAULT)).toEqual([
      { media_id: inDefault, position: 4 }, { media_id: orphanEarly, position: 5 }, { media_id: orphanLate, position: 6 },
    ]);
    expect(await items(other)).toEqual([{ media_id: inOther, position: 0 }]); // a file in some playlist is left alone

    for (const sql of MIGRATE_0010) await query(sql); // idempotent
    expect((await items(DEFAULT)).length).toBe(3);
    await query("DELETE FROM playlist_items WHERE playlist_id = ?", DEFAULT);
    await query("DELETE FROM media");
    await query("DELETE FROM playlists WHERE id = ?", other);
  });

  it("loadSettings reads the id as null once the playlist row is gone", async () => {
    await query("INSERT OR REPLACE INTO settings (key, value) VALUES ('default_playlist_id', '999999')");
    expect((await db.loadSettings(env)).default_playlist_id).toBeNull();
    await query("INSERT OR REPLACE INTO settings (key, value) VALUES ('default_playlist_id', ?)", String(DEFAULT));
    expect((await db.loadSettings(env)).default_playlist_id).toBe(DEFAULT);
  });
});

describe("uploads join the default playlist", () => {
  it("each upload lands after the last item, bumps updated_at and is audited with the playlist", async () => {
    await query("UPDATE playlists SET updated_at = '2000-01-01 00:00:00' WHERE id = ?", DEFAULT);
    const first = await upload("one.png", fakeFile(600, 3));
    const second = await upload("two.png", fakeFile(600, 5));
    expect(await items(DEFAULT)).toEqual([{ media_id: first, position: 0 }, { media_id: second, position: 1 }]);
    expect((await one("SELECT updated_at FROM playlists WHERE id = ?", DEFAULT)).updated_at).not.toBe("2000-01-01 00:00:00");
    const [a] = await audits("upload_media");
    expect(a.target_id).toBe(String(second));
    expect(JSON.parse(a.details)).toEqual({ filename: "two.png", type: "image", playlist: DEFAULT });
    // the Library does not explain it (the owner wants no how-it-works prose on the pages)
    const lib = await (await r.editor.get("/library")).text();
    expect(lib).not.toContain("New files start playing");
    expect(lib).not.toContain("hashed before sending");
    expect(lib).not.toContain("Duration and resolution are read");
  });

  it("with no default playlist on file the upload still lands, in no playlist", async () => {
    await query("DELETE FROM settings WHERE key = 'default_playlist_id'");
    const id = await upload("loose.png", fakeFile(600, 9));
    expect(await query("SELECT playlist_id FROM playlist_items WHERE media_id = ?", id)).toEqual([]);
    expect(JSON.parse((await audits("upload_media"))[0].details)).toEqual({ filename: "loose.png", type: "image" });
    await query("INSERT INTO settings (key, value) VALUES ('default_playlist_id', ?)", String(DEFAULT));
    await query("DELETE FROM media WHERE id = ?", id);
  });
});

describe("resolution order", () => {
  const now = wallClock("UTC", new Date(Date.UTC(2026, 8, 14, 12, 0))); // Monday noon

  it("schedule > device > group > site default > nothing (pick_playlist and the per-device resolver agree)", async () => {
    const own = await playlist("Own");
    const gpl = await playlist("Group PL");
    const gid = await group("Grp");
    await query("UPDATE device_groups SET playlist_id = ? WHERE id = ?", gpl, gid);
    const bare = await device("bare", "Bare");
    const grouped = await device("grouped", "Grouped", { group_id: gid });
    const assigned = await device("assigned", "Assigned", { playlist_id: own, group_id: gid });
    const scheduled = await device("scheduled", "Scheduled", { playlist_id: own });
    await ins("INSERT INTO device_schedules (device_id, playlist_id, name, priority) VALUES (?, ?, 'always', 1)", scheduled.id, gpl);
    const row = (d) => query("SELECT id, playlist_id, group_id FROM devices WHERE id = ?", d.id).then((x) => x[0]);

    expect(await manifest.resolve_active_playlist_id(env, await row(bare), now)).toEqual([DEFAULT, "site-default"]);
    expect(await manifest.resolve_active_playlist_id(env, await row(grouped), now)).toEqual([gpl, "group-default"]);
    expect(await manifest.resolve_active_playlist_id(env, await row(assigned), now)).toEqual([own, "device-default"]);
    expect(await manifest.resolve_active_playlist_id(env, await row(scheduled), now)).toEqual([gpl, "schedule:always"]);
    expect(manifest.pick_playlist(await row(bare), [], null, now, DEFAULT)).toEqual([DEFAULT, "site-default"]);
    expect(manifest.pick_playlist(await row(bare), [], null, now, null)).toEqual([null, null]);
    expect(manifest.pick_playlist(await row(bare), [], null, now)).toEqual([null, null]);

    // the manifest and the Devices / Dashboard pages say where the playlist came from
    const settings = await db.loadSettings(env);
    const m = await manifest.manifest_for_device(env, { ...(await row(bare)), device_id: "bare", name: "Bare" }, "https://cms.example", settings);
    expect(m.playlist).toMatchObject({ id: DEFAULT, name: "Default", source: "site-default" });
    for (const path of ["/devices", "/dashboard"]) {
      const page = await (await r.editor.get(path)).text();
      expect(page, path).toContain("via default playlist");
      expect(page, path).toContain("via group: Grp");
      expect(page, path).toContain("via device default");
      expect(page, path).toContain("via schedule: always");
    }
    // the site default does not switch an auto-mode projector on: that follows schedules and assigned playlists
    expect(manifest.projector_want(await row(bare), [], null, now, settings)).toBe("off");
    expect(manifest.projector_want(await row(assigned), [], null, now, settings)).toBe("on");

    for (const d of [bare, grouped, assigned, scheduled]) await query("DELETE FROM devices WHERE id = ?", d.id);
    await query("DELETE FROM device_groups WHERE id = ?", gid);
    await query("DELETE FROM playlists WHERE id IN (?, ?)", own, gpl);
  });

  it("a device token fetches a file from the site default playlist", async () => {
    const dev = await device("fetcher", "Fetcher");
    const id = await upload("fetched.png", fakeFile(600, 11));
    const { filename } = await one("SELECT filename FROM media WHERE id = ?", id);
    expect((await SELF.fetch(`${BASE}/api/media/${filename}`, { headers: bearer(dev.token) })).status).toBe(200);
    await query("DELETE FROM settings WHERE key = 'default_playlist_id'");
    expect((await SELF.fetch(`${BASE}/api/media/${filename}`, { headers: bearer(dev.token) })).status).toBe(403);
    await query("INSERT INTO settings (key, value) VALUES ('default_playlist_id', ?)", String(DEFAULT));
    await query("DELETE FROM devices WHERE id = ?", dev.id);
    await query("DELETE FROM media WHERE id = ?", id);
  });

  it("the Devices row of a projector on an empty default points at the Library, on another empty playlist at that playlist", async () => {
    await query("DELETE FROM playlist_items WHERE playlist_id = ?", DEFAULT);
    const dev = await device("empty", "Empty");
    let page = await (await r.editor.get("/devices")).text();
    expect(page).toContain('<span class="now-file">nothing in it yet · <a href="/library">upload files in the Library</a></span>');
    const own = await playlist("Own empty");
    await query("UPDATE devices SET playlist_id = ? WHERE id = ?", own, dev.id);
    page = await (await r.editor.get("/devices")).text();
    expect(page).toContain(`<span class="now-file">nothing in it yet · <a href="/playlists/${own}">add files to it</a></span>`);
    await query("DELETE FROM devices WHERE id = ?", dev.id);
    await query("DELETE FROM playlists WHERE id = ?", own);
  });
});

describe("pages", () => {
  it("Devices and Groups selects call the empty choice Default", async () => {
    const dev = await device("labels", "Labels");
    const gid = await group("Labelled");
    expect(await (await r.editor.get("/devices")).text()).toContain('<option value="">Default (plays unless you pick one)</option>');
    const groups = await (await r.editor.get("/groups")).text();
    expect(groups).toContain('<option value="">Default</option>');
    expect(groups).not.toContain("Groups without one play the site default playlist.");
    expect(await (await r.editor.get("/dashboard")).text()).toContain("new uploads join the default playlist");
    await query("DELETE FROM devices WHERE id = ?", dev.id);
    await query("DELETE FROM device_groups WHERE id = ?", gid);
  });

  it("Playlists marks the default with a badge, hides its Delete button and refuses to delete it", async () => {
    const other = await playlist("Deletable");
    const page = await (await r.editor.get("/playlists")).text();
    expect(page).toContain(`<a href="/playlists/${DEFAULT}">Default</a> <span class="badge" title="Every upload joins this playlist; projectors with no playlist of their own play it">default</span>`);
    expect(page).not.toContain(`action="/playlists/${DEFAULT}/delete"`);
    expect(page).toContain(`action="/playlists/${other}/delete"`);
    expect(await detail(await post(r.editor, `/playlists/${DEFAULT}/delete`), 400)).toBe("This is the default playlist. Pick another default on Settings first.");
    expect(await one("SELECT id FROM playlists WHERE id = ?", DEFAULT)).toEqual({ id: DEFAULT });
    expect(await audits("playlist_delete")).toEqual([]);
    expect((await post(r.editor, `/playlists/${other}/delete`)).status).toBe(303);
  });

  it("Settings: the select shows the default, moves it to an existing playlist only, keeps it when omitted, audits", async () => {
    const other = await playlist("New default");
    const GOOD = { timezone: "UTC", screenshot_interval: "60", camera_interval: "10", default_image_duration: "10" };
    let page = await (await r.admin.get("/settings")).text();
    expect(page).toContain('<select name="default_playlist_id">');
    expect(page).toContain(`<option value="${DEFAULT}" selected>Default</option>`);
    expect(page).toContain(`<option value="${other}">New default</option>`);

    expect(await detail(await post(r.admin, "/settings", { ...GOOD, default_playlist_id: "999999" }), 400)).toBe("Default playlist: pick a playlist from the list");
    expect(await detail(await post(r.admin, "/settings", { ...GOOD, default_playlist_id: "abc" }), 400)).toBe("Default playlist must be a whole number");
    expect(await defaultId()).toBe(DEFAULT);

    expect((await post(r.admin, "/settings", { ...GOOD, default_playlist_id: String(other) })).status).toBe(303);
    expect(await defaultId()).toBe(other);
    expect(JSON.parse((await audits("settings_update"))[0].details)).toMatchObject({ default_playlist_id: other });
    page = await (await r.admin.get("/settings")).text();
    expect(page).toContain(`<option value="${other}" selected>New default</option>`);
    // the old default may go now, uploads land in the new one, the badge moved
    expect((await post(r.editor, `/playlists/${DEFAULT}/delete`)).status).toBe(303);
    const id = await upload("moved.png", fakeFile(600, 13));
    expect(await items(other)).toEqual([{ media_id: id, position: 0 }]);
    expect(await (await r.editor.get("/playlists")).text()).toContain(`<a href="/playlists/${other}">New default</a> <span class="badge"`);
    // an older form without the field keeps the current default
    expect((await post(r.admin, "/settings", GOOD)).status).toBe(303);
    expect(await defaultId()).toBe(other);
  });
});
