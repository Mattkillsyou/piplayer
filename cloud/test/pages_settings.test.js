// /settings (admin only): timezone validated via Intl, screenshot interval >= 15, camera
// interval >= 5, default image duration, saved to the settings table, audit settings_update, effects on other pages.
import { beforeAll, describe, expect, it } from "vitest";
import { SELF } from "cloudflare:test";
import { query } from "./helpers.js";
import { audits, detail, device, group, playlist, post, roleMatrix, roles } from "./pages_common.js";

let r;
const GOOD = { timezone: "America/Los_Angeles", screenshot_interval: "120", camera_interval: "20", default_image_duration: "7.5" };
// The enrollment key is generated on first read, so it is always present; keep it out of the diffs.
const settings = () => query("SELECT key, value FROM settings WHERE key != 'enrollment_key' ORDER BY key");
const enrollmentKey = () => query("SELECT value FROM settings WHERE key = 'enrollment_key'").then((r) => r[0]?.value);

beforeAll(async () => {
  r = await roles();
});

describe("settings", () => {
  it("admin only", async () => {
    await roleMatrix(r, "GET", "/settings", { minRole: "admin" });
    await roleMatrix(r, "POST", "/settings", { minRole: "admin", fields: GOOD });
    expect(await settings()).toEqual([
      { key: "camera_interval", value: "20" },
      { key: "default_image_duration", value: "7.5" },
      { key: "screenshot_interval", value: "120" },
      { key: "timezone", value: "America/Los_Angeles" },
    ]);
    await query("DELETE FROM settings");
  });

  it("page shows the current values (env defaults) and the tz datalist", async () => {
    const page = await (await r.admin.get("/settings")).text();
    expect(page).toContain('name="timezone" value="UTC"');
    expect(page).toContain('name="screenshot_interval" value="60"');
    expect(page).toContain('name="camera_interval" value="10"');
    expect(page).toContain('name="default_image_duration" value="10"');
    expect(page).toContain('<option value="Europe/London">');
    expect(page).toContain('href="/settings" class="active"');
    expect(page).not.toContain("Settings saved.");
  });

  it("validation: 400 for a bad zone, interval < 15 or non-int, bad duration; nothing saved", async () => {
    const cases = [
      [{ ...GOOD, timezone: "Mars/Olympus" }, "timezone must be a valid IANA name"],
      [{ ...GOOD, timezone: "" }, "timezone must be a valid IANA name"],
      [{ ...GOOD, screenshot_interval: "14" }, "screenshot_interval must be at least 15 seconds"],
      [{ ...GOOD, screenshot_interval: "abc" }, "screenshot_interval must be an integer"],
      [{ ...GOOD, screenshot_interval: "1.5" }, "screenshot_interval must be an integer"],
      [{ ...GOOD, screenshot_interval: "" }, "screenshot_interval required"],
      [{ ...GOOD, camera_interval: "4" }, "camera_interval must be at least 5 seconds"],
      [{ ...GOOD, camera_interval: "x" }, "camera_interval must be an integer"],
      [{ ...GOOD, camera_interval: "" }, "camera_interval required"],
      [{ ...GOOD, default_image_duration: "0" }, "default_image_duration must be a positive number"],
      [{ ...GOOD, default_image_duration: "-3" }, "default_image_duration must be a positive number"],
      [{ ...GOOD, default_image_duration: "inf" }, "default_image_duration must be a positive number"],
      [{ ...GOOD, default_image_duration: "86401" }, "default_image_duration must be a positive number"],
      [{ ...GOOD, default_image_duration: "" }, "default_image_duration required"],
    ];
    await query("DELETE FROM audit_log WHERE action = 'settings_update'");
    for (const [fields, msg] of cases) {
      expect(await detail(await post(r.admin, "/settings", fields), 400), JSON.stringify(fields)).toContain(msg);
    }
    expect(await settings()).toEqual([]);
    expect(await audits("settings_update")).toEqual([]);
  });

  it("saves, audits, redirects with the saved banner, and the zone drives other pages + manifest", async () => {
    const res = await post(r.admin, "/settings", { ...GOOD, timezone: " Europe/Berlin " });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/settings?saved=1");
    expect(await settings()).toEqual([
      { key: "camera_interval", value: "20" },
      { key: "default_image_duration", value: "7.5" },
      { key: "screenshot_interval", value: "120" },
      { key: "timezone", value: "Europe/Berlin" },
    ]);
    const [a] = await audits("settings_update");
    expect(a.username).toBe("admin");
    expect(JSON.parse(a.details)).toEqual({ timezone: "Europe/Berlin", screenshot_interval: 120, camera_interval: 20, default_image_duration: 7.5,
      enroll_group_id: null, enroll_playlist_id: null });
    const page = await (await r.admin.get("/settings?saved=1")).text();
    expect(page).toContain("Settings saved.");
    expect(page).toContain('name="timezone" value="Europe/Berlin"');
    expect(page).toContain('name="screenshot_interval" value="120"');
    expect(page).toContain('name="camera_interval" value="20"');
    expect(page).toContain('name="default_image_duration" value="7.5"');

    // other pages: zone name, image duration hint, stale threshold (3 x 120 s), manifest interval
    const dev = await device("set-dev", "Set dev", { last_screenshot_at: "2020-06-01 12:00:00", last_seen_at: "2020-06-01 12:00:00" });
    const audit = await (await r.admin.get("/audit")).text();
    expect(audit).toMatch(/times in (CET|CEST|GMT\+[12])/);
    const dash = await (await r.admin.get("/dashboard")).text();
    expect(dash).toMatch(/2020-06-01 14:00 (CEST|GMT\+2)/);
    const sync = await SELF.fetch(`http://piplayer.test/api/sync/${dev.device_id}`, { headers: { authorization: `Bearer ${dev.token}` } });
    if (sync.status === 200) {
      const body = await sync.json();
      expect(body.screenshot_interval_seconds).toBe(120);
      expect(body.camera_interval_seconds).toBe(20);
      expect(body.server_time).toMatch(/\+0[12]:00$/);
    }
    // a fresh screenshot within 3 x 120 s is not stale
    await query("UPDATE devices SET last_screenshot_at = datetime('now', '-200 seconds') WHERE id = ?", dev.id);
    expect(await (await r.admin.get("/devices")).text()).not.toContain(">stale<");
    await query("UPDATE devices SET last_screenshot_at = datetime('now', '-400 seconds') WHERE id = ?", dev.id);
    expect(await (await r.admin.get("/devices")).text()).toContain(">stale<");
    await query("DELETE FROM settings");
  });

  it("enrollment defaults: selects list groups/playlists, unknown ids are 400, none deletes the row, deleted rows show as none", async () => {
    await query("DELETE FROM settings");
    const gid = await group("Lobby screens");
    const pid = await playlist("Welcome loop");
    let page = await (await r.admin.get("/settings")).text();
    expect(page).toContain('<select name="enroll_group_id">');
    expect(page).toContain('<select name="enroll_playlist_id">');
    expect(page).toContain(`<option value="${gid}">Lobby screens</option>`);
    expect(page).toContain(`<option value="${pid}">Welcome loop</option>`);

    for (const [fields, msg] of [
      [{ ...GOOD, enroll_group_id: "999999" }, "enroll_group_id: unknown group"],
      [{ ...GOOD, enroll_group_id: "abc" }, "enroll_group_id must be an integer"],
      [{ ...GOOD, enroll_playlist_id: "999999" }, "enroll_playlist_id: unknown playlist"],
      [{ ...GOOD, enroll_playlist_id: "1.5" }, "enroll_playlist_id must be an integer"],
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
    await query("DELETE FROM device_groups WHERE id = ?", gid);
    await query("DELETE FROM settings");
  });

  it("enrollment key: generated on first read, shown to admins, rotated with audit", async () => {
    await query("DELETE FROM settings");
    await query("DELETE FROM audit_log WHERE action = 'enrollment_key_rotated'");
    const page = await (await r.admin.get("/settings")).text();
    const key = await enrollmentKey();
    expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(page).toContain(`<input type="password" id="enrollment-key" value="${key}" readonly`);
    expect(page).toContain('data-reveal="enrollment-key">Show</button>');
    expect(page).toContain('action="/settings/enrollment/rotate"');
    expect(page).toContain("data-confirm=");
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
    const after = await (await r.admin.get("/settings?rotated=1")).text();
    expect(after).toContain("Enrollment key rotated.");
    expect(after).toContain(`value="${rotated}" readonly`);
    expect(after).not.toContain(key);
    // rotating never touches the other settings
    expect(await settings()).toEqual([]);
  });
});
