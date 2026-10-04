// Each account's Default playlist (migration 0016; before it one site-wide playlist, migration
// 0010): the playlist every upload of the account joins and every projector of the account plays
// unless a schedule rule matches or the device / its group has a playlist of its own; the Settings
// select that moves it, the delete refusal and the wording on the Devices / Groups / Dashboard /
// Library pages. Migrations 0010 and 0016 themselves are exercised on a real database by
// test/migration_accounts.test.js.
import { beforeAll, describe, expect, it } from "vitest";
import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import * as db from "../src/db.js";
import * as manifest from "../src/manifest.js";
import { wallClock } from "../src/util.js";
import { BASE, query } from "./helpers.js";
import { audits, defaultPlaylistOf, detail, device, group, ins, media, one, playlist, post, roles } from "./pages_common.js";

const hex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
const digest = async (data) => hex(await crypto.subtle.digest("SHA-256", data));
const fakeFile = (size, seed) => Uint8Array.from({ length: size }, (_, i) => (i * seed + 7) & 0xff);
const bearer = (token) => ({ authorization: `Bearer ${token}` });
const items = (pid) => query("SELECT media_id, position FROM playlist_items WHERE playlist_id = ? ORDER BY position", pid);

let r, DEFAULT, ADMIN_DEFAULT;

beforeAll(async () => {
  r = await roles();
  DEFAULT = await defaultPlaylistOf(r.ids.editor); // the editor's: the fixtures below are the editor's
  ADMIN_DEFAULT = await defaultPlaylistOf(r.ids.admin);
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

describe("one Default playlist per account", () => {
  it("every account has its own, named Default; the first admin's is the one migration 0010 made (adopted at /setup)", async () => {
    expect(db.SCHEMA_VERSION).toBeGreaterThanOrEqual(16);
    expect(await one("SELECT value FROM meta WHERE key = 'schema_version'")).toEqual({ value: String(db.SCHEMA_VERSION) });
    const defaults = await query(
      `SELECT u.username, p.name, p.owner_id = u.id AS own FROM users u
         JOIN account_settings s ON s.user_id = u.id AND s.key = 'default_playlist_id'
         JOIN playlists p ON p.id = CAST(s.value AS INTEGER) ORDER BY u.id`);
    expect(defaults).toEqual([
      { username: "admin", name: "Default", own: 1 }, { username: "ed", name: "Default", own: 1 }, { username: "vw", name: "Default", own: 1 },
    ]);
    expect(new Set([DEFAULT, ADMIN_DEFAULT]).size).toBe(2);
    // 0010's playlist was created before any user existed; /setup gave it to the first admin
    expect(ADMIN_DEFAULT).toBe((await one("SELECT MIN(id) AS id FROM playlists")).id);
    expect((await db.loadSettings(env, r.ids.editor)).default_playlist_id).toBe(DEFAULT);
    expect(db.SETTING_KEYS).toContain("default_playlist_id");
    expect(await query("SELECT key FROM settings WHERE key != 'enrollment_key'")).toEqual([]); // nothing per-account left in the site table
  });

  it("loadSettings reads the id as null once the playlist row is gone, or when it is another account's", async () => {
    await query("UPDATE account_settings SET value = '999999' WHERE user_id = ? AND key = 'default_playlist_id'", r.ids.editor);
    expect((await db.loadSettings(env, r.ids.editor)).default_playlist_id).toBeNull();
    await query("UPDATE account_settings SET value = ? WHERE user_id = ? AND key = 'default_playlist_id'", String(ADMIN_DEFAULT), r.ids.editor);
    expect((await db.loadSettings(env, r.ids.editor)).default_playlist_id).toBeNull();
    await query("UPDATE account_settings SET value = ? WHERE user_id = ? AND key = 'default_playlist_id'", String(DEFAULT), r.ids.editor);
    expect((await db.loadSettings(env, r.ids.editor)).default_playlist_id).toBe(DEFAULT);
    // the batch loader agrees, per account
    const both = await db.loadSettingsFor(env, [r.ids.editor, r.ids.admin, null]);
    expect([both.get(r.ids.editor).default_playlist_id, both.get(r.ids.admin).default_playlist_id, both.size]).toEqual([DEFAULT, ADMIN_DEFAULT, 2]);
  });
});

describe("uploads join the uploader's Default playlist", () => {
  it("each upload lands after the last item of the editor's own Default, bumps updated_at and is audited with the playlist", async () => {
    await query("UPDATE playlists SET updated_at = '2000-01-01 00:00:00' WHERE id = ?", DEFAULT);
    const first = await upload("one.png", fakeFile(600, 3));
    const second = await upload("two.png", fakeFile(600, 5));
    expect(await items(DEFAULT)).toEqual([{ media_id: first, position: 0 }, { media_id: second, position: 1 }]);
    expect(await items(ADMIN_DEFAULT)).toEqual([]); // nothing reaches another account's playlist
    expect((await one("SELECT updated_at FROM playlists WHERE id = ?", DEFAULT)).updated_at).not.toBe("2000-01-01 00:00:00");
    expect(await one("SELECT owner_id FROM media WHERE id = ?", second)).toEqual({ owner_id: r.ids.editor });
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
    await query("DELETE FROM account_settings WHERE user_id = ? AND key = 'default_playlist_id'", r.ids.editor);
    const id = await upload("loose.png", fakeFile(600, 9));
    expect(await query("SELECT playlist_id FROM playlist_items WHERE media_id = ?", id)).toEqual([]);
    expect(JSON.parse((await audits("upload_media"))[0].details)).toEqual({ filename: "loose.png", type: "image" });
    await ins("INSERT INTO account_settings (user_id, key, value) VALUES (?, 'default_playlist_id', ?)", r.ids.editor, String(DEFAULT));
    await query("DELETE FROM media WHERE id = ?", id);
  });
});

describe("resolution order", () => {
  const now = wallClock("UTC", new Date(Date.UTC(2026, 8, 14, 12, 0))); // Monday noon

  it("schedule > device > group > the account's Default > nothing (pick_playlist and the per-device resolver agree)", async () => {
    const own = await playlist("Own");
    const gpl = await playlist("Group PL");
    const gid = await group("Grp");
    await query("UPDATE device_groups SET playlist_id = ? WHERE id = ?", gpl, gid);
    const bare = await device("bare", "Bare");
    const grouped = await device("grouped", "Grouped", { group_id: gid });
    const assigned = await device("assigned", "Assigned", { playlist_id: own, group_id: gid });
    const scheduled = await device("scheduled", "Scheduled", { playlist_id: own });
    await ins("INSERT INTO device_schedules (device_id, playlist_id, name, priority) VALUES (?, ?, 'always', 1)", scheduled.id, gpl);
    const row = (d) => query("SELECT id, playlist_id, group_id, owner_id FROM devices WHERE id = ?", d.id).then((x) => x[0]);

    expect(await manifest.resolve_active_playlist_id(env, await row(bare), now)).toEqual([DEFAULT, "site-default"]);
    expect(await manifest.resolve_active_playlist_id(env, await row(grouped), now)).toEqual([gpl, "group-default"]);
    expect(await manifest.resolve_active_playlist_id(env, await row(assigned), now)).toEqual([own, "device-default"]);
    expect(await manifest.resolve_active_playlist_id(env, await row(scheduled), now)).toEqual([gpl, "schedule:always"]);
    expect(manifest.pick_playlist(await row(bare), [], null, now, DEFAULT)).toEqual([DEFAULT, "site-default"]);
    expect(manifest.pick_playlist(await row(bare), [], null, now, null)).toEqual([null, null]);
    expect(manifest.pick_playlist(await row(bare), [], null, now)).toEqual([null, null]);

    // the manifest and the Devices / Dashboard pages say where the playlist came from
    const settings = await db.loadSettings(env, r.ids.editor);
    const m = await manifest.manifest_for_device(env, { ...(await row(bare)), device_id: "bare", name: "Bare" }, "https://cms.example", settings);
    expect(m.playlist).toMatchObject({ id: DEFAULT, name: "Default", source: "site-default" });
    for (const path of ["/devices", "/dashboard"]) {
      const page = await (await r.editor.get(path)).text();
      expect(page, path).toContain("via default playlist");
      expect(page, path).toContain("via group: Grp");
      expect(page, path).toContain("via device default");
      expect(page, path).toContain("via schedule: always");
    }
    // the Default does not switch an auto-mode projector on: that follows schedules and assigned playlists
    expect(manifest.projector_want(await row(bare), [], null, now, settings)).toBe("off");
    expect(manifest.projector_want(await row(assigned), [], null, now, settings)).toBe("on");

    for (const d of [bare, grouped, assigned, scheduled]) await query("DELETE FROM devices WHERE id = ?", d.id);
    await query("DELETE FROM device_groups WHERE id = ?", gid);
    await query("DELETE FROM playlists WHERE id IN (?, ?)", own, gpl);
  });

  it("a device token fetches a file from its account's Default playlist, not from another account's", async () => {
    const dev = await device("fetcher", "Fetcher");
    const id = await upload("fetched.png", fakeFile(600, 11));
    const { filename } = await one("SELECT filename FROM media WHERE id = ?", id);
    expect((await SELF.fetch(`${BASE}/api/media/${filename}`, { headers: bearer(dev.token) })).status).toBe(200);
    // the same projector handed to the admin plays the admin's Default, which does not hold the file
    await query("UPDATE devices SET owner_id = ? WHERE id = ?", r.ids.admin, dev.id);
    expect((await SELF.fetch(`${BASE}/api/media/${filename}`, { headers: bearer(dev.token) })).status).toBe(403);
    await query("UPDATE devices SET owner_id = ? WHERE id = ?", r.ids.editor, dev.id);
    await query("DELETE FROM account_settings WHERE user_id = ? AND key = 'default_playlist_id'", r.ids.editor);
    expect((await SELF.fetch(`${BASE}/api/media/${filename}`, { headers: bearer(dev.token) })).status).toBe(403);
    await ins("INSERT INTO account_settings (user_id, key, value) VALUES (?, 'default_playlist_id', ?)", r.ids.editor, String(DEFAULT));
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
    expect(page).not.toContain(`/playlists/${ADMIN_DEFAULT}"`); // the admin's Default is not on the editor's page
    expect(await detail(await post(r.editor, `/playlists/${DEFAULT}/delete`), 400)).toBe("This is the default playlist. Pick another default on Settings first.");
    expect(await one("SELECT id FROM playlists WHERE id = ?", DEFAULT)).toEqual({ id: DEFAULT });
    expect(await audits("playlist_delete")).toEqual([]);
    expect((await post(r.editor, `/playlists/${other}/delete`)).status).toBe(303);
  });

  it("Settings: the editor's select shows its own default, moves it to its own playlist only, keeps it when omitted, audits", async () => {
    const other = await playlist("New default");
    const GOOD = { timezone: "UTC", screenshot_interval: "60", camera_interval: "10", default_image_duration: "10" };
    let page = await (await r.editor.get("/settings")).text();
    expect(page).toContain('<select name="default_playlist_id">');
    expect(page).toContain(`<option value="${DEFAULT}" selected>Default</option>`);
    expect(page).toContain(`<option value="${other}">New default</option>`);
    expect(page).not.toContain(`<option value="${ADMIN_DEFAULT}"`);

    expect(await detail(await post(r.editor, "/settings", { ...GOOD, default_playlist_id: "999999" }), 400)).toBe("Default playlist: pick a playlist from the list");
    expect(await detail(await post(r.editor, "/settings", { ...GOOD, default_playlist_id: String(ADMIN_DEFAULT) }), 400)).toBe("Default playlist: pick a playlist from the list");
    expect(await detail(await post(r.editor, "/settings", { ...GOOD, default_playlist_id: "abc" }), 400)).toBe("Default playlist must be a whole number");
    expect(await defaultPlaylistOf(r.ids.editor)).toBe(DEFAULT);

    expect((await post(r.editor, "/settings", { ...GOOD, default_playlist_id: String(other) })).status).toBe(303);
    expect(await defaultPlaylistOf(r.ids.editor)).toBe(other);
    expect(await defaultPlaylistOf(r.ids.admin)).toBe(ADMIN_DEFAULT); // the admin's own is untouched
    expect(JSON.parse((await audits("settings_update"))[0].details)).toMatchObject({ default_playlist_id: other });
    page = await (await r.editor.get("/settings")).text();
    expect(page).toContain(`<option value="${other}" selected>New default</option>`);
    // the old default may go now, uploads land in the new one, the badge moved
    expect((await post(r.editor, `/playlists/${DEFAULT}/delete`)).status).toBe(303);
    const id = await upload("moved.png", fakeFile(600, 13));
    expect(await items(other)).toEqual([{ media_id: id, position: 0 }]);
    expect(await (await r.editor.get("/playlists")).text()).toContain(`<a href="/playlists/${other}">New default</a> <span class="badge"`);
    // an older form without the field keeps the current default
    expect((await post(r.editor, "/settings", GOOD)).status).toBe(303);
    expect(await defaultPlaylistOf(r.ids.editor)).toBe(other);
  });
});
