// /settings (admin only, cloud-only page): site timezone, screenshot and camera intervals,
// default image duration and the group/playlist new devices get on first enrollment, stored in
// the settings table (db.loadSettings / saveSetting), plus the device enrollment key (shown
// masked, rotatable; POST /api/enroll checks it).
import * as audit from "../audit.js";
import * as auth from "../auth.js";
import * as db from "../db.js";
import { esc, fail, floatField, intField, isValidTimeZone, localTime, nowUtc, redirect, str, zoneName } from "../util.js";
import { alertBox, csrfInput, layout } from "./layout.js";

export const MIN_SCREENSHOT_INTERVAL = 15;
export const MIN_CAMERA_INTERVAL = 5;

function timeZoneOptions() {
  try {
    return Intl.supportedValuesOf("timeZone");
  } catch {
    return [];
  }
}

// <option>s for a nullable-id select; a stored id whose row was deleted matches nothing = none.
function optionList(rows, selected) {
  return rows.map((r) => `<option value="${r.id}"${r.id === selected ? " selected" : ""}>${esc(r.name)}</option>`).join("\n          ");
}

async function settingsPage(ctx) {
  auth.requireRole(ctx, "admin");
  const s = await ctx.settings();
  const groups = await db.all(ctx.env, "SELECT id, name FROM device_groups ORDER BY name");
  const playlists = await db.all(ctx.env, "SELECT id, name FROM playlists ORDER BY name");
  const saved = ctx.url.searchParams.get("saved") === "1";
  const rotated = ctx.url.searchParams.get("rotated") === "1";
  const content = `<div class="page-head">
  <h1>Settings</h1>
  <span class="page-meta"><strong>site time ${esc(localTime(nowUtc(), s.timezone))}</strong><br>schedules, the audit log and every timestamp on these pages use this zone</span>
</div>
${saved ? alertBox("Settings saved.", "ok") : ""}
${rotated ? alertBox("Enrollment key rotated. Cards flashed with the old key must be re-flashed.", "ok") : ""}

<div class="panel">
  <h2>Site settings</h2>
  <form method="post" action="/settings">
    ${csrfInput(ctx)}
    <div class="form-grid">
      <label>Site timezone (IANA name)
        <input type="text" name="timezone" value="${esc(s.timezone)}" list="tz-list" placeholder="America/Los_Angeles" required>
        <datalist id="tz-list">
          ${timeZoneOptions().map((tz) => `<option value="${esc(tz)}">`).join("\n          ")}
        </datalist>
      </label>
      <label>Screenshot interval (seconds, at least ${MIN_SCREENSHOT_INTERVAL})
        <input type="number" name="screenshot_interval" value="${esc(s.screenshot_interval)}" min="${MIN_SCREENSHOT_INTERVAL}" step="1" required>
      </label>
      <label>Camera snapshot interval (seconds, at least ${MIN_CAMERA_INTERVAL})
        <input type="number" name="camera_interval" value="${esc(s.camera_interval)}" min="${MIN_CAMERA_INTERVAL}" step="1" required>
      </label>
      <label>Default image duration (seconds)
        <input type="number" name="default_image_duration" value="${esc(s.default_image_duration)}" min="0.5" max="86400" step="0.5" required>
      </label>
      <label>New devices join group
        <select name="enroll_group_id">
          <option value="">— none —</option>
          ${optionList(groups, s.enroll_group_id)}
        </select>
      </label>
      <label>New devices get playlist
        <select name="enroll_playlist_id">
          <option value="">— none —</option>
          ${optionList(playlists, s.enroll_playlist_id)}
        </select>
      </label>
    </div>
    <p class="help small">Zone ${esc(zoneName(s.timezone))}. The screenshot interval is sent to every player on its next sync; a device is flagged stale after 3 intervals without a screenshot; the camera interval works the same way for room camera snapshots. The image duration applies to images without a per-item override. The group and playlist are applied when a device enrolls for the first time (<code>POST /api/enroll</code>); re-enrolling a known device keeps its current assignment.</p>
    <div class="row">
      <button type="submit" class="primary">Save settings</button>
    </div>
  </form>
</div>

<div class="panel">
  <h2>Device enrollment</h2>
  <p class="muted small">The flasher bakes this key into every card; a Pi presents it on first boot (<code>POST /api/enroll</code>) and receives its own device token. Rotate it if a card is lost: cards flashed with the old key that have not booted yet stop working.</p>
  <div class="enrollment-key">
    <label for="enrollment-key" class="small">Enrollment key</label>
    <input type="password" id="enrollment-key" value="${esc(s.enrollment_key)}" readonly spellcheck="false" autocomplete="off">
    <button type="button" class="small" data-reveal="enrollment-key">Show</button>
  </div>
  <form method="post" action="/settings/enrollment/rotate" class="inline" data-confirm="Rotate the enrollment key? Cards flashed with the old key that have not booted yet will fail to enroll.">
    ${csrfInput(ctx)}
    <button type="submit" class="danger">Rotate key</button>
  </form>
</div>`;
  return layout(ctx, { title: "Settings", content });
}

async function settingsSave(ctx) {
  auth.requireRole(ctx, "admin");
  const form = await ctx.form();
  const timezone = str(form, "timezone").trim();
  if (!isValidTimeZone(timezone)) fail(400, "timezone must be a valid IANA name (e.g. America/Los_Angeles)");
  const interval = intField(str(form, "screenshot_interval"), "screenshot_interval");
  if (interval === null) fail(400, "screenshot_interval required");
  if (interval < MIN_SCREENSHOT_INTERVAL) fail(400, `screenshot_interval must be at least ${MIN_SCREENSHOT_INTERVAL} seconds`);
  const camera = intField(str(form, "camera_interval"), "camera_interval");
  if (camera === null) fail(400, "camera_interval required");
  if (camera < MIN_CAMERA_INTERVAL) fail(400, `camera_interval must be at least ${MIN_CAMERA_INTERVAL} seconds`);
  const duration = floatField(str(form, "default_image_duration"), "default_image_duration",
    "default_image_duration must be a positive number");
  if (duration === null) fail(400, "default_image_duration required");
  if (duration <= 0 || duration > 86400) fail(400, "default_image_duration must be a positive number of seconds (at most 86400)");
  const enrollGroup = intField(str(form, "enroll_group_id"), "enroll_group_id");
  if (enrollGroup !== null && !(await db.first(ctx.env, "SELECT id FROM device_groups WHERE id = ?", enrollGroup))) fail(400, "enroll_group_id: unknown group");
  const enrollPlaylist = intField(str(form, "enroll_playlist_id"), "enroll_playlist_id");
  if (enrollPlaylist !== null && !(await db.first(ctx.env, "SELECT id FROM playlists WHERE id = ?", enrollPlaylist))) fail(400, "enroll_playlist_id: unknown playlist");
  const values = { timezone, screenshot_interval: interval, camera_interval: camera, default_image_duration: duration,
    enroll_group_id: enrollGroup, enroll_playlist_id: enrollPlaylist };
  // null (none) deletes the row so the settings table only holds what is set
  await db.batch(ctx.env, Object.entries(values).map(([k, v]) => (v === null
    ? ["DELETE FROM settings WHERE key = ?", k]
    : ["INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", k, String(v)])));
  await audit.log(ctx, "settings_update", "settings", null, values);
  return redirect("/settings?saved=1");
}

async function enrollmentRotate(ctx) {
  auth.requireRole(ctx, "admin");
  await db.generateEnrollmentKey(ctx.env);
  await audit.log(ctx, "enrollment_key_rotated", "settings", "enrollment_key");
  return redirect("/settings?rotated=1");
}

export function register(router) {
  router.get("/settings", settingsPage);
  router.post("/settings", settingsSave);
  router.post("/settings/enrollment/rotate", enrollmentRotate);
}
