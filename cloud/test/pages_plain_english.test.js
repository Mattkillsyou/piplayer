// Plain-English validation: a bad value typed into a form comes back on the HTML error page as
// a sentence that names the field by its on-page label, never by its form name. Plus the
// Settings warning for a stored timezone that is no longer accepted, and the daily cron that
// encrypts RTSP URLs stored in the clear before the encrypted column existed.
import { beforeAll, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import * as db from "../src/db.js";
import * as devices from "../src/pages/devices.js";
import { query } from "./helpers.js";
import { device, media, one, playlist, post, roles } from "./pages_common.js";

let r, dev, pid, mid;

beforeAll(async () => {
  r = await roles();
  dev = await device("hall-1", "Hall");
  pid = await playlist("Hall loop");
  mid = await media("poster.jpg");
});

// A browser form post: the error page instead of the JSON detail.
const html = (c, path, fields) => c.post(path, fields, { "X-CSRF-Token": c.token, accept: "text/html" }).then(async (res) => [res.status, await res.text()]);

const SETTINGS = { timezone: "UTC", screenshot_interval: "60", camera_interval: "10", default_image_duration: "10" };
const ALERTS = { alert_offline_minutes: "10", alert_repeat_minutes: "60" };

describe("validation messages read as sentences on the error page", () => {
  const cases = [
    ["/settings", { ...SETTINGS, screenshot_interval: "14" }, "Screenshot interval must be a whole number of at least 15 seconds"],
    ["/settings", { ...SETTINGS, camera_interval: "" }, "Camera snapshot interval must be a whole number of at least 5 seconds"],
    ["/settings", { ...SETTINGS, default_image_duration: "0.25" }, "Default image duration must be between 0.5 and 86400 seconds"],
    ["/settings", { ...SETTINGS, player_release: "v1;rm" }, "Player software version may only contain letters, digits, dots, slashes, hyphens and underscores (at most 100)"],
    ["/settings", { ...SETTINGS, auto_update_window: "3-5" }, "Auto-update window must be HH:MM-HH:MM"],
    ["/settings", { ...SETTINGS, projector_lead_minutes: "1441" }, "Switch on before a schedule starts must be a whole number of minutes, 0-1440"],
    ["/settings/alerts", { ...ALERTS, alert_offline_minutes: "0" }, "Offline after must be a whole number of minutes, 1-1440"],
    ["/settings/alerts", { ...ALERTS, alert_repeat_minutes: "10081" }, "Repeat while open must be a whole number of minutes, 0-10080"],
    ["/settings/alerts", { ...ALERTS, alert_email: "not-an-address" }, "Enter one or more email addresses, separated by commas"],
    ["/settings/alerts", { ...ALERTS, alert_webhook_url: "http://hooks.example.com/z" }, "The webhook must be an https:// address"],
    ["/settings/wyze", { wyze_camera_pattern: "x".repeat(101) }, "Camera name pattern must be 1-100 printable characters"],
    ["/settings/tokens", { name: " " }, "Token name must be 1-60 characters"],
    ["/users", { username: "u9", password: "short", role: "viewer" }, "Enter a username and a password of at least 6 characters"],
    ["/users", { username: "u".repeat(65), password: "pw123456", role: "viewer" }, "Username must be at most 64 characters"],
    ["/users", { username: "u9", password: "pw123456", role: "god" }, "Pick a role"],
    ["/devices", { device_id: "ok-9", name: " " }, "Name must be 1-120 characters"],
    ["DEV/camera-source", { camera_source: "rtsp", camera_rtsp_url: "http://x/" }, "Stream address must start with rtsp:// or rtsps://"],
    ["DEV/camera-source", { camera_source: "rtsp" }, "Enter the stream address for the rtsp source"],
    ["DEV/camera-source", { camera_source: "wyze", camera_wyze_name: "x".repeat(101) }, "Camera name may be at most 100 printable characters"],
    ["DEV/camera-url", { camera_live_url: "http://cam/" }, "The camera live URL must be an https:// address"],
    ["DEV/projector", { projector_control: "broadlink", broadlink_host: "http://rm4" }, "Broadlink address must be a hostname or IP address"],
    ["DEV/schedule", { playlist_id: "" }, "Pick a playlist"],
    ["DEV/schedule", { playlist_id: "PID", priority: "1001" }, "Priority must be between 0 and 1000"],
    ["DEV/schedule", { playlist_id: "PID", start_time: "25:00" }, "The start time must be in HH:MM form (00:00 to 23:59)"],
    ["DEV/schedule", { playlist_id: "PID", start_time: "09:00", end_time: "9:00" }, "Start and end must differ; leave both empty for all day"],
    ["DEV/schedule", { playlist_id: "PID", days_of_week: "7" }, "Pick the days by ticking them"],
    ["DEV/schedule", { playlist_id: "PID", start_date: "2026-09-20", end_date: "2026-09-19" }, "The start date must be on or before the end date"],
    ["/playlists", { name: " " }, "Enter a name"],
    ["/groups", { name: " " }, "Enter a name"],
    ["PL/items", { media_id: "" }, "Pick a file to add"],
    ["PL/items/1/duration", { duration: "0.4" }, "Duration must be a number of seconds between 0.5 and 86400"],
  ];

  it.each(cases)("%s %j", async (path, fields, sentence) => {
    const p = path.replace("DEV", `/devices/${dev.id}`).replace("PL", `/playlists/${pid}`);
    const f = Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, v === "PID" ? String(pid) : v]));
    const [status, page] = await html(r.admin, p, f);
    expect(status, sentence).toBe(400);
    expect(page).toContain("Something went wrong");
    expect(page).toContain(sentence);
  });

  it("adding the same file twice says so in a sentence", async () => {
    expect((await post(r.admin, `/playlists/${pid}/items`, { media_id: String(mid) })).status).toBe(303);
    const [status, page] = await html(r.admin, `/playlists/${pid}/items`, { media_id: String(mid) });
    expect(status).toBe(409);
    expect(page).toContain("That file is already in this playlist");
  });

  it("no message on a page an owner reaches names a form field", async () => {
    for (const [path, fields] of cases) {
      const p = path.replace("DEV", `/devices/${dev.id}`).replace("PL", `/playlists/${pid}`);
      const f = Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, v === "PID" ? String(pid) : v]));
      const [, page] = await html(r.admin, p, f);
      const m = /<div class="alert error" role="alert">([^<]*)<\/div>/.exec(page);
      expect(m, p).not.toBeNull();
      expect(m[1], p).not.toMatch(/\b[a-z]+_[a-z_]+\b/);
    }
  });
});

describe("Settings warns when the stored timezone is no longer accepted", () => {
  it("shows the offending value with UTC in use, gone after a real zone is saved", async () => {
    await query("INSERT INTO settings (key, value) VALUES ('timezone', 'EST') ON CONFLICT(key) DO UPDATE SET value = excluded.value");
    let page = await (await r.admin.get("/settings")).text();
    expect(page).toContain('The saved timezone &quot;EST&quot; is no longer accepted, so times are shown in UTC. Pick a timezone from the list and save.');
    expect((await post(r.admin, "/settings", { ...SETTINGS, timezone: "Europe/London" })).status).toBe(303);
    page = await (await r.admin.get("/settings")).text();
    expect(page).not.toContain("is no longer accepted");
    expect(page).toContain('name="timezone" value="Europe/London"');
  });
});

describe("devices.housekeeping encrypts RTSP URLs stored in the clear", () => {
  it("rewrites a plaintext row under the device key; cameraConfig still returns the URL; encrypted rows are left alone", async () => {
    const url = "rtsp://old:pw@10.0.0.6:554/s";
    const d = await device("cam-legacy", "Legacy", { camera_source: "rtsp", camera_rtsp_url: url });
    expect(await devices.housekeeping(env)).toBe(1);
    const row = await one("SELECT * FROM devices WHERE id = ?", d.id);
    expect(row.camera_rtsp_url).toMatch(/^v1:/);
    expect(row.camera_rtsp_url).not.toContain("pw@");
    expect(await devices.cameraConfig(env, row, await db.loadSettings(env))).toMatchObject({ source: "rtsp", rtsp_url: url });
    expect(await devices.housekeeping(env)).toBe(0);
    expect((await one("SELECT camera_rtsp_url AS u FROM devices WHERE id = ?", d.id)).u).toBe(row.camera_rtsp_url);
  });
});
