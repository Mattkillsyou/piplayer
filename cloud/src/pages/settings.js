// /settings (admin only, cloud-only page): site timezone, screenshot interval and default
// image duration, stored in the settings table (db.loadSettings / saveSetting).
import * as audit from "../audit.js";
import * as auth from "../auth.js";
import * as db from "../db.js";
import { esc, fail, floatField, intField, isValidTimeZone, localTime, nowUtc, redirect, str, zoneName } from "../util.js";
import { alertBox, csrfInput, layout } from "./layout.js";

export const MIN_SCREENSHOT_INTERVAL = 15;

function timeZoneOptions() {
  try {
    return Intl.supportedValuesOf("timeZone");
  } catch {
    return [];
  }
}

async function settingsPage(ctx) {
  auth.requireRole(ctx, "admin");
  const s = await ctx.settings();
  const saved = ctx.url.searchParams.get("saved") === "1";
  const content = `<div class="page-head">
  <h1>Settings</h1>
  <span class="page-meta"><strong>site time ${esc(localTime(nowUtc(), s.timezone))}</strong><br>schedules, the audit log and every timestamp on these pages use this zone</span>
</div>
${saved ? alertBox("Settings saved.", "ok") : ""}

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
      <label>Default image duration (seconds)
        <input type="number" name="default_image_duration" value="${esc(s.default_image_duration)}" min="0.5" max="86400" step="0.5" required>
      </label>
    </div>
    <p class="help small">Zone ${esc(zoneName(s.timezone))}. The screenshot interval is sent to every player on its next sync; a device is flagged stale after 3 intervals without a screenshot. The image duration applies to images without a per-item override.</p>
    <div class="row">
      <button type="submit" class="primary">Save settings</button>
    </div>
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
  const duration = floatField(str(form, "default_image_duration"), "default_image_duration",
    "default_image_duration must be a positive number");
  if (duration === null) fail(400, "default_image_duration required");
  if (duration <= 0 || duration > 86400) fail(400, "default_image_duration must be a positive number of seconds (at most 86400)");
  const values = { timezone, screenshot_interval: interval, default_image_duration: duration };
  await db.batch(ctx.env, Object.entries(values).map(([k, v]) =>
    ["INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", k, String(v)]));
  await audit.log(ctx, "settings_update", "settings", null, values);
  return redirect("/settings?saved=1");
}

export function register(router) {
  router.get("/settings", settingsPage);
  router.post("/settings", settingsSave);
}
