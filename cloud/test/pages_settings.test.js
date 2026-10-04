// /settings (editors and admins, each their own account's, migration 0016): timezone validated
// via Intl, screenshot interval >= 15, camera interval >= 5, default image duration, player
// update policy (git ref, off|nightly, HH:MM-HH:MM window), saved to account_settings, audit
// settings_update, effects on the account's own pages + its projectors' manifests; the site-wide
// enrollment key for admins only.
import { beforeAll, describe, expect, it } from "vitest";
import { SELF } from "cloudflare:test";
import { query } from "./helpers.js";
import { audits, detail, device, group, playlist, post, roleMatrix, roles } from "./pages_common.js";

let r;
const GOOD = { timezone: "America/Los_Angeles", screenshot_interval: "120", camera_interval: "20", default_image_duration: "7.5" };
// Every save stores the update policy too (omitted fields keep their current value = the defaults here).
const UPDATE_ROWS = [{ key: "auto_update", value: "off" }, { key: "auto_update_window", value: "03:00-05:00" }, { key: "player_release", value: "main" }];
const withUpdate = (rows) => [...rows, ...UPDATE_ROWS].sort((a, b) => (a.key < b.key ? -1 : 1));
const UPDATE_AUDIT = { player_release: "main", auto_update: "off", auto_update_window: "03:00-05:00" };
// An account's own rows, without its Default playlist (test/default_playlist.test.js covers it).
const settings = (owner = r.ids.admin) => query("SELECT key, value FROM account_settings WHERE user_id = ? AND key != 'default_playlist_id' ORDER BY key", owner);
const reset = (owner = r.ids.admin) => query("DELETE FROM account_settings WHERE user_id = ? AND key != 'default_playlist_id'", owner);
const setRow = (key, value, owner = r.ids.admin) => query("UPDATE account_settings SET value = ? WHERE user_id = ? AND key = ?", value, owner, key);
const enrollmentKey = () => query("SELECT value FROM settings WHERE key = 'enrollment_key'").then((x) => x[0]?.value);
const sync = (d) => SELF.fetch(`http://piplayer.test/api/sync/${d.device_id}`, { headers: { authorization: `Bearer ${d.token}` } });

beforeAll(async () => {
  r = await roles();
});

describe("settings", () => {
  it("editors and admins, each saving their own account only", async () => {
    await roleMatrix(r, "GET", "/settings", { minRole: "editor" });
    await roleMatrix(r, "POST", "/settings", { minRole: "editor", fields: GOOD }); // the editor saves
    expect(await settings(r.ids.editor)).toEqual(withUpdate([
      { key: "camera_interval", value: "20" },
      { key: "default_image_duration", value: "7.5" },
      { key: "screenshot_interval", value: "120" },
      { key: "timezone", value: "America/Los_Angeles" },
    ]));
    expect(await settings(r.ids.admin)).toEqual([]); // the admin's are untouched
    expect(await (await r.admin.get("/settings")).text()).toContain('<option value="UTC" selected>UTC</option>');
    await reset(r.ids.editor);
  });

  it("page shows the current values (env defaults) and a real timezone dropdown", async () => {
    await r.editor.get("/settings"); // consumes the one-shot notice left by the save above
    const page = await (await r.admin.get("/settings")).text();
    // a <select> grouped by region, not a text box whose suggestions only match what is typed
    expect(page).toContain('<select name="timezone" required>');
    expect(page).toContain('<option value="UTC" selected>UTC</option>');
    expect(page).toContain('<optgroup label="America">');
    expect(page).toContain('<option value="America/New_York">America/New York</option>');
    expect(page).not.toContain("datalist");
    expect(page).toContain('name="screenshot_interval" value="60"');
    expect(page).toContain('name="camera_interval" value="10"');
    expect(page).toContain('name="default_image_duration" value="10"');
    expect(page).toContain('name="player_release" value="main"');
    expect(page).toContain('<option value="off" selected>off</option>');
    expect(page).toContain('<option value="nightly">nightly</option>');
    expect(page).toContain('name="auto_update_window" value="03:00-05:00"');
    // A \d inside the template literal would be emitted as a bare d and make the browser reject every submit.
    expect(page).toContain('pattern="([01][0-9]|2[0-3]):[0-5][0-9]-([01][0-9]|2[0-3]):[0-5][0-9]"');
    expect(page).toContain('<option value="Europe/London">');
    expect(page).toContain('href="/settings" class="active"');
    expect(page).toContain("<h2>Account settings</h2>");
    expect(page).not.toContain("Settings saved.");
  });

  it("validation: 400 for a bad zone, interval < 15 or non-int, bad duration; nothing saved", async () => {
    const cases = [
      [{ ...GOOD, timezone: "Mars/Olympus" }, "Pick a timezone from the list"],
      [{ ...GOOD, timezone: "" }, "Pick a timezone from the list"],
      // ICU accepts EST/MST but maps them to fixed-offset zones (America/Panama, America/Phoenix): no DST
      [{ ...GOOD, timezone: "EST" }, "short names like EST are not accepted"],
      [{ ...GOOD, timezone: "MST" }, "short names like EST are not accepted"],
      [{ ...GOOD, timezone: "PST" }, "short names like EST are not accepted"],
      [{ ...GOOD, screenshot_interval: "14" }, "Screenshot interval must be a whole number of at least 15 seconds"],
      [{ ...GOOD, screenshot_interval: "abc" }, "Screenshot interval must be a whole number"],
      [{ ...GOOD, screenshot_interval: "1.5" }, "Screenshot interval must be a whole number"],
      [{ ...GOOD, screenshot_interval: "" }, "Screenshot interval must be a whole number of at least 15 seconds"],
      [{ ...GOOD, camera_interval: "4" }, "Camera snapshot interval must be a whole number of at least 5 seconds"],
      [{ ...GOOD, camera_interval: "x" }, "Camera snapshot interval must be a whole number"],
      [{ ...GOOD, camera_interval: "" }, "Camera snapshot interval must be a whole number of at least 5 seconds"],
      [{ ...GOOD, default_image_duration: "0" }, "Default image duration must be between 0.5 and 86400 seconds"],
      [{ ...GOOD, default_image_duration: "-3" }, "Default image duration must be between 0.5 and 86400 seconds"],
      [{ ...GOOD, default_image_duration: "inf" }, "Default image duration must be between 0.5 and 86400 seconds"],
      [{ ...GOOD, default_image_duration: "86401" }, "Default image duration must be between 0.5 and 86400 seconds"],
      [{ ...GOOD, default_image_duration: "0.4" }, "Default image duration must be between 0.5 and 86400 seconds"],
      [{ ...GOOD, default_image_duration: "" }, "Default image duration must be between 0.5 and 86400 seconds"],
      [{ ...GOOD, player_release: "-rf" }, "Player software version may only contain letters, digits, dots, slashes, hyphens and underscores (at most 100)"],
      [{ ...GOOD, player_release: "a..b" }, "Player software version may only contain letters, digits, dots, slashes, hyphens and underscores (at most 100)"],
      [{ ...GOOD, player_release: "v1;rm" }, "Player software version may only contain letters, digits, dots, slashes, hyphens and underscores (at most 100)"],
      [{ ...GOOD, player_release: "a".repeat(101) }, "Player software version may only contain letters, digits, dots, slashes, hyphens and underscores (at most 100)"],
      [{ ...GOOD, auto_update: "weekly" }, "Auto-update must be off or nightly"],
      [{ ...GOOD, auto_update_window: "3:00-5:00" }, "Auto-update window must be HH:MM-HH:MM"],
      [{ ...GOOD, auto_update_window: "03:00" }, "Auto-update window must be HH:MM-HH:MM"],
      [{ ...GOOD, auto_update_window: "24:00-05:00" }, "Auto-update window must be HH:MM-HH:MM"],
    ];
    await query("DELETE FROM audit_log WHERE action = 'settings_update'");
    for (const [fields, msg] of cases) {
      expect(await detail(await post(r.admin, "/settings", fields), 400), JSON.stringify(fields)).toContain(msg);
    }
    expect(await settings()).toEqual([]);
    expect(await audits("settings_update")).toEqual([]);
  });

  it("saves, audits, redirects with the saved banner, and the zone drives the account's pages + its projectors' manifests", async () => {
    const res = await post(r.admin, "/settings", { ...GOOD, timezone: " Europe/Berlin " });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/settings");
    expect(res.headers.get("set-cookie")).toMatch(/^piplayer_flash=/);
    expect(await settings()).toEqual(withUpdate([
      { key: "camera_interval", value: "20" },
      { key: "default_image_duration", value: "7.5" },
      { key: "screenshot_interval", value: "120" },
      { key: "timezone", value: "Europe/Berlin" },
    ]));
    const [a] = await audits("settings_update");
    expect(a.username).toBe("admin");
    const adminDefault = Number((await query("SELECT value FROM account_settings WHERE user_id = ? AND key = 'default_playlist_id'", r.ids.admin))[0].value);
    expect(JSON.parse(a.details)).toEqual({ timezone: "Europe/Berlin", screenshot_interval: 120, camera_interval: 20, default_image_duration: 7.5,
      enroll_group_id: null, enroll_playlist_id: null, default_playlist_id: adminDefault, ...UPDATE_AUDIT });
    const page = await (await r.admin.get("/settings")).text();
    expect(page).toContain('<div class="alert ok" role="alert">Settings saved.</div>');
    // one-shot: the next load, and a forged query string, show nothing
    expect(await (await r.admin.get("/settings?saved=1&rotated=1&revoked=1&tested=email&test_error=x")).text()).not.toMatch(/Settings saved|rotated|revoked|alert sent|alert failed/);
    expect(page).toContain('<option value="Europe/Berlin" selected>Europe/Berlin</option>');
    expect(page).toContain('name="screenshot_interval" value="120"');
    expect(page).toContain('name="camera_interval" value="20"');
    expect(page).toContain('name="default_image_duration" value="7.5"');

    // the admin's pages and projector: zone name, stale threshold (3 x 120 s), manifest intervals
    const dev = await device("set-dev", "Set dev", { owner_id: r.ids.admin, last_screenshot_at: "2020-06-01 12:00:00", last_seen_at: "2020-06-01 12:00:00" });
    const audit = await (await r.admin.get("/audit")).text();
    expect(audit).toMatch(/times in (CET|CEST|GMT\+[12])/);
    const dash = await (await r.admin.get("/dashboard")).text();
    expect(dash).toMatch(/2020-06-01 14:00 (CEST|GMT\+2)/);
    const body = await (await sync(dev)).json();
    expect(body.screenshot_interval_seconds).toBe(120);
    expect(body.camera_interval_seconds).toBe(20);
    expect(body.server_time).toMatch(/\+0[12]:00$/);
    // another account's pages and projectors keep their own (the defaults)
    expect(await (await r.editor.get("/audit")).text()).toMatch(/times in UTC/);
    const edDev = await device("set-ed", "Set ed");
    const edBody = await (await sync(edDev)).json();
    expect([edBody.screenshot_interval_seconds, edBody.camera_interval_seconds]).toEqual([60, 10]);
    expect(edBody.server_time).toMatch(/\+00:00$/);
    // a fresh screenshot within 3 x 120 s is not stale
    await query("UPDATE devices SET last_screenshot_at = datetime('now', '-200 seconds') WHERE id = ?", dev.id);
    expect(await (await r.admin.get("/devices")).text()).not.toContain(">stale<");
    await query("UPDATE devices SET last_screenshot_at = datetime('now', '-400 seconds') WHERE id = ?", dev.id);
    expect(await (await r.admin.get("/devices")).text()).toContain(">stale<");
    await query("DELETE FROM devices WHERE id IN (?, ?)", dev.id, edDev.id);
    await reset();
  });

  it("enrollment defaults: the selects list the account's own groups/playlists, any other id is 400, none deletes the row, deleted rows show as none", async () => {
    await reset();
    const gid = await group("Lobby screens", r.ids.admin);
    const pid = await playlist("Welcome loop", r.ids.admin);
    const edGroup = await group("Editor screens"); // the editor's: not the admin's to pick
    const edPlaylist = await playlist("Editor loop");
    let page = await (await r.admin.get("/settings")).text();
    expect(page).toContain('<select name="enroll_group_id">');
    expect(page).toContain('<select name="enroll_playlist_id">');
    expect(page).toContain(`<option value="${gid}">Lobby screens</option>`);
    expect(page).toContain(`<option value="${pid}">Welcome loop</option>`);
    expect(page).not.toContain("Editor screens");
    expect(page).not.toContain("Editor loop");

    for (const [fields, msg] of [
      [{ ...GOOD, enroll_group_id: "999999" }, "Pick a group from the list"],
      [{ ...GOOD, enroll_group_id: String(edGroup) }, "Pick a group from the list"],
      [{ ...GOOD, enroll_group_id: "abc" }, "New devices join group must be a whole number"],
      [{ ...GOOD, enroll_playlist_id: "999999" }, "Pick a playlist from the list"],
      [{ ...GOOD, enroll_playlist_id: String(edPlaylist) }, "Pick a playlist from the list"],
      [{ ...GOOD, enroll_playlist_id: "1.5" }, "New devices get playlist must be a whole number"],
    ]) {
      expect(await detail(await post(r.admin, "/settings", fields), 400), JSON.stringify(fields)).toContain(msg);
    }
    expect(await settings()).toEqual([]);

    expect((await post(r.admin, "/settings", { ...GOOD, enroll_group_id: String(gid), enroll_playlist_id: String(pid) })).status).toBe(303);
    expect((await settings()).filter((x) => x.key.startsWith("enroll_"))).toEqual([
      { key: "enroll_group_id", value: String(gid) }, { key: "enroll_playlist_id", value: String(pid) },
    ]);
    const [a] = await audits("settings_update");
    expect(JSON.parse(a.details)).toMatchObject({ enroll_group_id: gid, enroll_playlist_id: pid });
    page = await (await r.admin.get("/settings")).text();
    expect(page).toContain(`<option value="${gid}" selected>Lobby screens</option>`);
    expect(page).toContain(`<option value="${pid}" selected>Welcome loop</option>`);

    // the playlist is deleted: its setting row stays but nothing is selected (= none)
    await query("DELETE FROM playlists WHERE id = ?", pid);
    page = await (await r.admin.get("/settings")).text();
    expect(page).toContain(`<option value="${gid}" selected>`);
    expect(page).not.toContain("Welcome loop");
    // saving with none removes the rows
    expect((await post(r.admin, "/settings", { ...GOOD, enroll_group_id: "", enroll_playlist_id: "" })).status).toBe(303);
    expect((await settings()).filter((x) => x.key.startsWith("enroll_"))).toEqual([]);
    await query("DELETE FROM device_groups WHERE id IN (?, ?)", gid, edGroup);
    await query("DELETE FROM playlists WHERE id = ?", edPlaylist);
    await reset();
  });

  it("player updates: git ref / mode / window saved, shown selected, carried by the account's manifests; omitted fields keep their value", async () => {
    await reset();
    let res = await post(r.admin, "/settings", { ...GOOD, player_release: " v2.1.0 ", auto_update: "nightly", auto_update_window: "22:30-01:15" });
    expect(res.status).toBe(303);
    expect((await settings()).filter((x) => x.key in UPDATE_AUDIT)).toEqual([
      { key: "auto_update", value: "nightly" }, { key: "auto_update_window", value: "22:30-01:15" }, { key: "player_release", value: "v2.1.0" },
    ]);
    expect(JSON.parse((await audits("settings_update"))[0].details)).toMatchObject({ player_release: "v2.1.0", auto_update: "nightly", auto_update_window: "22:30-01:15" });
    const page = await (await r.admin.get("/settings")).text();
    expect(page).toContain('name="player_release" value="v2.1.0"');
    expect(page).toContain('<option value="nightly" selected>nightly</option>');
    expect(page).toContain('name="auto_update_window" value="22:30-01:15"');
    // the admin's player sees the policy on its next sync; the editor's keeps the defaults
    const dev = await device("upd-dev", "Upd dev", { owner_id: r.ids.admin });
    const s = await sync(dev);
    expect(s.status).toBe(200);
    expect((await s.json()).update).toEqual({ release: "v2.1.0", auto: "nightly", window: "22:30-01:15" });
    const edDev = await device("upd-ed", "Upd ed");
    expect((await (await sync(edDev)).json()).update).toEqual({ release: "main", auto: "off", window: "03:00-05:00" });
    // an ownerless projector follows the site admin (here the admin)
    const loose = await device("upd-loose", "Upd loose", { owner_id: null });
    expect((await (await sync(loose)).json()).update).toEqual({ release: "v2.1.0", auto: "nightly", window: "22:30-01:15" });
    // a save without the update fields (older form) keeps them
    res = await post(r.admin, "/settings", GOOD);
    expect(res.status).toBe(303);
    expect((await settings()).filter((x) => x.key in UPDATE_AUDIT).map((x) => x.value)).toEqual(["nightly", "22:30-01:15", "v2.1.0"]);
    // a branch with a slash and a sha are refs too
    for (const ref of ["release/2026-09", "eecd133", "feature_x-1"]) {
      expect((await post(r.admin, "/settings", { ...GOOD, player_release: ref })).status, ref).toBe(303);
    }
    // a junk stored value falls back to the default rather than reaching the player
    await setRow("player_release", "-rf");
    await setRow("auto_update_window", "x");
    const m = await (await sync(dev)).json();
    expect(m.update).toEqual({ release: "main", auto: "nightly", window: "03:00-05:00" });
    await query("DELETE FROM devices WHERE id IN (?, ?, ?)", dev.id, edDev.id, loose.id);
    await reset();
  });

  it("enrollment key: site-wide, generated on first read, shown to admins only, rotated with audit", async () => {
    await reset();
    await query("DELETE FROM audit_log WHERE action = 'enrollment_key_rotated'");
    const page = await (await r.admin.get("/settings")).text();
    const key = await enrollmentKey();
    expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(page).toContain(`<input type="password" id="enrollment-key" value="${key}" readonly`);
    expect(page).toContain('data-reveal="enrollment-key">Show</button>');
    expect(page).toContain('action="/settings/enrollment/rotate"');
    expect(page).toContain("data-confirm=");
    // an editor's own Settings has no enrollment key: it can enroll any device id
    const ed = await (await r.editor.get("/settings")).text();
    expect(ed).not.toContain(key);
    expect(ed).not.toContain("enrollment-key");
    expect(ed).not.toContain("/settings/enrollment/rotate");
    // stable across reads
    await (await r.admin.get("/dashboard")).text();
    expect(await enrollmentKey()).toBe(key);

    await roleMatrix(r, "POST", "/settings/enrollment/rotate", { minRole: "admin" });
    const rotated = await enrollmentKey();
    expect(rotated).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(rotated).not.toBe(key);
    const [a] = await audits("enrollment_key_rotated");
    expect(a.username).toBe("admin");
    expect(a.target_id).toBe("enrollment_key");
    expect(a.details).toBeNull();
    const after = await (await r.admin.get("/settings")).text();
    expect(after).toContain("Enrollment key rotated.");
    expect(after).toContain(`value="${rotated}" readonly`);
    expect(after).not.toContain(key);
    // rotating never touches the other settings
    expect(await settings()).toEqual([]);
  });
});

// E: projector lead / idle minutes (manifest projector.want for auto-mode devices).
describe("projector power settings", () => {
  it("shows the 3 / 10 defaults, validates, saves and audits only when posted, drives the manifest want", async () => {
    await reset();
    let page = await (await r.admin.get("/settings")).text();
    expect(page).toContain('name="projector_lead_minutes" value="3"');
    expect(page).toContain('name="projector_idle_minutes" value="10"');
    expect(await detail(await post(r.admin, "/settings", { ...GOOD, projector_lead_minutes: "x" }), 400)).toBe("Switch on before a schedule starts must be a whole number");
    expect(await detail(await post(r.admin, "/settings", { ...GOOD, projector_lead_minutes: "-1" }), 400)).toBe("Switch on before a schedule starts must be a whole number of minutes, 0-1440");
    expect(await detail(await post(r.admin, "/settings", { ...GOOD, projector_idle_minutes: "1441" }), 400)).toBe("Switch off after playback ends must be a whole number of minutes, 0-1440");
    expect((await settings()).filter((x) => x.key.startsWith("projector_"))).toEqual([]);
    let res = await post(r.admin, "/settings", { ...GOOD, projector_lead_minutes: "15", projector_idle_minutes: "0" });
    expect(res.status).toBe(303);
    expect((await settings()).filter((x) => x.key.startsWith("projector_"))).toEqual([
      { key: "projector_idle_minutes", value: "0" }, { key: "projector_lead_minutes", value: "15" }]);
    expect(JSON.parse((await audits("settings_update"))[0].details)).toMatchObject({ projector_lead_minutes: 15, projector_idle_minutes: 0 });
    page = await (await r.admin.get("/settings")).text();
    expect(page).toContain('name="projector_lead_minutes" value="15"');
    expect(page).toContain('name="projector_idle_minutes" value="0"');
    // a save without the fields (older form) keeps them; the audit row does not mention them
    res = await post(r.admin, "/settings", GOOD);
    expect(res.status).toBe(303);
    expect((await settings()).filter((x) => x.key.startsWith("projector_")).map((x) => x.value)).toEqual(["0", "15"]);
    expect(JSON.parse((await audits("settings_update"))[0].details)).not.toHaveProperty("projector_lead_minutes");
    // an auto-mode projector of the admin's with a rule starting in 10 min wants on with a 15 min lead (zone: LA)
    const dev = await device("proj-set", "Proj set", { owner_id: r.ids.admin, projector_control: "cec", projector_power_mode: "auto" });
    const start = new Date(Date.now() + 10 * 60000);
    const fmt = new Intl.DateTimeFormat("en-GB", { timeZone: "America/Los_Angeles", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    const hhmm = fmt.format(start);
    const end = fmt.format(new Date(start.getTime() + 20 * 60000));
    if (hhmm < end) { // not across midnight, where a wrap window would need a different assertion
      await query("INSERT INTO device_schedules (device_id, playlist_id, name, priority, start_time, end_time) VALUES (?, ?, 'soon', 1, ?, ?)", dev.id, await playlist("Soon PL", r.ids.admin), hhmm, end);
      const want = () => sync(dev).then((x) => x.json());
      expect((await want()).projector).toEqual({ control: "cec", mode: "auto", want: "on", codes: {}, broadlink_host: null });
      await setRow("projector_lead_minutes", "5");
      expect((await want()).projector.want).toBe("off");
      // a junk stored value falls back to the default (3)
      await setRow("projector_lead_minutes", "soon");
      expect((await want()).projector.want).toBe("off");
      expect(await (await r.admin.get("/settings")).text()).toContain('name="projector_lead_minutes" value="3"');
      await query("DELETE FROM device_schedules WHERE device_id = ?", dev.id);
    }
    await reset();
  });
});
