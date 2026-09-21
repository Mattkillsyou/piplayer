// Port of web.device_schedule_* + device_schedule.html. Rule evaluation (matches_now,
// describe) comes from src/schedules.js (P1); validation is contract 10.
import * as audit from "../audit.js";
import * as auth from "../auth.js";
import * as db from "../db.js";
import * as schedules from "../schedules.js";
import { esc, fail, idParam, intField, isoDateField, normalizeHhmm, redirect, str, wallClock } from "../util.js";
import { requireRow } from "./devices.js";
import { csrfInput, emptyState, layout } from "./layout.js";

const pad2 = (n) => String(n).padStart(2, "0");

async function schedulePage(ctx) {
  const user = auth.requireUser(ctx);
  const canEdit = user.role !== "viewer";
  const deviceId = idParam(ctx.params.device_id, "device_id");
  const device = await db.first(ctx.env, "SELECT id, device_id, name, playlist_id FROM devices WHERE id = ?", deviceId);
  if (!device) fail(404, "Not Found");
  const rules = await db.all(ctx.env,
    `SELECT s.id, s.playlist_id, s.name, s.priority, s.start_time, s.end_time,
            s.days_of_week, s.start_date, s.end_date,
            p.name AS playlist_name
       FROM device_schedules s
       LEFT JOIN playlists p ON p.id = s.playlist_id
      WHERE s.device_id = ?
      ORDER BY s.priority DESC, s.id`, deviceId);
  const playlists = await db.all(ctx.env, "SELECT id, name FROM playlists ORDER BY name");
  const tz = (await ctx.settings()).timezone;
  const now = wallClock(tz);
  // Several rules can match at once; only the one the player picks (manifest.pick_playlist) is
  // "active now", the rest say they are being overridden instead of claiming to play.
  const active = schedules.pick_active(rules, now);
  const nowText = `${now.year}-${pad2(now.month)}-${pad2(now.day)} ${pad2(now.hour)}:${pad2(now.minute)}:${pad2(now.second)} ${now.zone}`;
  for (const r of rules) {
    r.summary = schedules.describe(r);
    r.matches_now = schedules.schedule_matches(r, now);
    r.is_active = !!active && r.id === active.id;
  }

  const ruleRow = (r) => `<tr${r.is_active ? ' class="rule-active"' : ""}>
      <td class="position-cell">${r.priority}</td>
      <td class="name">${esc(r.name)}</td>
      <td>${esc(r.playlist_name || "—")}</td>
      <td class="muted">${esc(r.summary)}</td>
      <td>${r.is_active ? '<span class="badge badge-active">active now</span>' : r.matches_now ? '<span class="badge badge-muted">matches, but a higher-priority rule is playing</span>' : '<span class="badge badge-muted">waiting</span>'}</td>
      <td>
        ${canEdit ? `<form method="post" action="/devices/${device.id}/schedule/${r.id}/delete" class="inline" data-confirm="Delete rule ${esc(r.name)}?">
          ${csrfInput(ctx)}
          <button type="submit" class="danger small">Delete</button>
        </form>` : ""}
      </td>
    </tr>`;
  const dayBox = (name, i) => `<label class="inline-check"><input type="checkbox" name="days_of_week_chk" value="${i}">${name}</label>`;
  const zoneHelp = user.role === "admin"
    ? 'change the timezone on the <a href="/settings">Settings</a> page.'
    : "ask an administrator to change the site timezone on the Settings page.";

  const content = `<a href="/devices" class="back">← Devices</a>
<div class="page-head">
  <div>
    <span class="eyebrow">Schedule · ${esc(device.device_id)}</span>
    <h1>${esc(device.name)}</h1>
  </div>
  <span class="page-meta"><strong>site time ${esc(nowText)}</strong><br>rules use the site's wall-clock time (zone ${esc(now.zone)})</span>
</div>
<p class="zone-note">If this is not your venue's time, ${zoneHelp}</p>

<h2>Rules (${rules.length})</h2>
<p class="help small">When multiple rules match, the one with the highest priority wins. If no rule matches, the device's default playlist (set on the Devices page) plays. A window that crosses midnight (e.g. 22:00–02:00) belongs to the day it starts on, so "Fri 22:00–02:00" runs until Saturday 02:00.</p>
${!rules.length ? emptyState("NO RULES", "The device plays its default playlist always.") : `<div class="table-wrap">
<table class="data">
  <caption class="sr-only">Schedule rules</caption>
  <thead>
    <tr><th scope="col">Prio</th><th scope="col">Name</th><th scope="col">Playlist</th><th scope="col">When</th><th scope="col">State</th><th scope="col"><span class="sr-only">Actions</span></th></tr>
  </thead>
  <tbody>
    ${rules.map(ruleRow).join("\n    ")}
  </tbody>
</table>
</div>`}

${canEdit ? `<div class="panel">
  <h2>Add rule</h2>
  <form method="post" action="/devices/${device.id}/schedule">
    ${csrfInput(ctx)}
    <div class="form-grid">
      <label>Name
        <input type="text" name="name" placeholder="e.g., Morning Classes" required>
      </label>
      <label>Playlist
        <select name="playlist_id" required>
          <option value="">— pick —</option>
          ${playlists.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join("\n          ")}
        </select>
      </label>
      <label>Priority
        <input type="number" name="priority" value="10" min="0" max="1000">
      </label>
    </div>
    <div class="form-grid">
      <label>Start time
        <input type="time" name="start_time" placeholder="06:00">
      </label>
      <label>End time
        <input type="time" name="end_time" placeholder="09:00">
      </label>
      <label>Start date
        <input type="date" name="start_date">
      </label>
      <label>End date
        <input type="date" name="end_date" placeholder="never">
      </label>
    </div>
    <p class="help small">Leave both times empty for all day. An end time earlier than the start time wraps past midnight and counts as the start day.</p>

    <fieldset class="days-fieldset">
      <legend>Days (leave blank for all days)</legend>
      ${["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map(dayBox).join("\n      ")}
      <input type="hidden" name="days_of_week" id="days-hidden" value="">
    </fieldset>

    <div class="row">
      <button type="submit" class="primary">Add rule</button>
    </div>
  </form>
</div>` : ""}`;
  return layout(ctx, { title: `${device.name} schedule`, content });
}

async function scheduleCreate(ctx) {
  auth.requireRole(ctx, "editor");
  const deviceId = idParam(ctx.params.device_id, "device_id");
  const form = await ctx.form();
  const name = str(form, "name").trim() || "Rule";
  const pid = intField(str(form, "playlist_id"), "playlist_id");
  if (pid === null) fail(400, "playlist_id required");
  const prio = intField(str(form, "priority", "0"), "priority") ?? 0;
  if (prio < 0 || prio > 1000) fail(400, "priority must be between 0 and 1000");
  let startTime = str(form, "start_time").trim() || null;
  let endTime = str(form, "end_time").trim() || null;
  if (startTime !== null) {
    startTime = normalizeHhmm(startTime);
    if (startTime === null) fail(400, "start_time must be HH:MM (00:00-23:59)");
  }
  if (endTime !== null) {
    endTime = normalizeHhmm(endTime);
    if (endTime === null) fail(400, "end_time must be HH:MM (00:00-23:59)");
  }
  if (startTime !== null && endTime !== null && startTime === endTime) {
    fail(400, "start and end must differ; use no times for all-day");
  }
  const rawDays = str(form, "days_of_week").trim();
  if (rawDays && !/^[0-6]+$/.test(rawDays)) fail(400, "days_of_week must only contain digits 0-6 (0 = Monday)");
  const days = [...new Set(rawDays)].sort().join("") || null;
  const startDate = isoDateField(str(form, "start_date"), "start_date");
  const endDate = isoDateField(str(form, "end_date"), "end_date");
  if (startDate && endDate && startDate > endDate) fail(400, "start_date must be on or before end_date");
  await requireRow(ctx.env, "devices", deviceId, "Device");
  await requireRow(ctx.env, "playlists", pid, "Playlist");
  const id = (await db.run(ctx.env,
    `INSERT INTO device_schedules
        (device_id, playlist_id, name, priority, start_time, end_time, days_of_week, start_date, end_date)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    deviceId, pid, name, prio, startTime, endTime, days, startDate, endDate)).last_row_id;
  await audit.log(ctx, "device_schedule_create", "device_schedule", id, { device_id: deviceId, name, playlist_id: pid });
  return redirect(`/devices/${deviceId}/schedule`);
}

async function scheduleDelete(ctx) {
  auth.requireRole(ctx, "editor");
  const deviceId = idParam(ctx.params.device_id, "device_id");
  const scheduleId = idParam(ctx.params.schedule_id, "schedule_id");
  const r = await db.run(ctx.env, "DELETE FROM device_schedules WHERE id = ? AND device_id = ?", scheduleId, deviceId);
  if (!r.changes) fail(404, "Schedule rule not found");
  await audit.log(ctx, "device_schedule_delete", "device_schedule", scheduleId, { device_id: deviceId });
  return redirect(`/devices/${deviceId}/schedule`);
}

export function register(router) {
  router.get("/devices/:device_id/schedule", schedulePage);
  router.post("/devices/:device_id/schedule", scheduleCreate);
  router.post("/devices/:device_id/schedule/:schedule_id/delete", scheduleDelete);
}
