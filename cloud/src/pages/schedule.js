// Port of web.device_schedule_* + device_schedule.html. Rule evaluation (matches_now,
// describe) comes from src/schedules.js (P1); validation is contract 10. A projector's rules
// play its own account's playlists in its account's zone: the page shows the rules of a
// projector the user sees (an admin sees every projector, read-only unless it is their own
// account's), and only its own account adds, edits or deletes rules, with its own playlists.
// Also add to puts the same rule on more of the account's projectors at once: each gets its own
// copy, edited and deleted on its own page (a rule belongs to one projector).
import * as accounts from "../accounts.js";
import * as audit from "../audit.js";
import * as auth from "../auth.js";
import * as db from "../db.js";
import * as schedules from "../schedules.js";
import { esc, fail, idParam, intField, isoDateField, normalizeHhmm, redirect, str, wallClock } from "../util.js";
import { requireContentOwner, requireDevice, requireRow } from "./devices.js";
import { csrfInput, emptyState, layout } from "./layout.js";

const pad2 = (n) => String(n).padStart(2, "0");

async function schedulePage(ctx) {
  const user = auth.requireUser(ctx);
  const deviceId = idParam(ctx.params.device_id, "device_id");
  const device = await requireDevice(ctx, deviceId, "d.id, d.device_id, d.name, d.playlist_id");
  const ownContent = device.content_owner === user.id;
  const canEdit = user.role !== "viewer" && ownContent;
  // Only the rules for the projector's own account's playlists count (manifest.device_content).
  const rules = await db.all(ctx.env,
    `SELECT s.id, s.playlist_id, s.name, s.priority, s.start_time, s.end_time,
            s.days_of_week, s.start_date, s.end_date,
            p.name AS playlist_name
       FROM device_schedules s
       JOIN playlists p ON p.id = s.playlist_id AND p.owner_id IS ?
      WHERE s.device_id = ?
      ORDER BY s.priority DESC, s.id`, device.content_owner, deviceId);
  const playlists = canEdit ? await db.all(ctx.env, "SELECT id, name FROM playlists WHERE owner_id = ? ORDER BY name", user.id) : [];
  // ?edit=<rule id> (the rows' Edit links): the form is that rule's, filled in. Only this
  // projector's rules; any other id gets the Add form.
  const edit = canEdit ? rules.find((r) => String(r.id) === ctx.url.searchParams.get("edit")) : undefined;
  // The account's other projectors, for Also add to: on the Add form only, as Save rule changes
  // this projector's rule alone (a copy elsewhere is its own row, edited on its own page).
  const others = canEdit && !edit ? await db.all(ctx.env,
    `SELECT d.id, d.name FROM devices d WHERE ${accounts.contentOwnerSql("d")} = ? AND d.id != ? ORDER BY d.name COLLATE NOCASE, d.id`,
    user.id, deviceId) : [];
  // The rules run in the projector's account's zone (the viewer's own for their own projector).
  const tz = ownContent ? (await ctx.settings()).timezone : (await db.loadSettings(ctx.env, device.content_owner)).timezone;
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
  const v = edit || { priority: 10 };
  const value = (x) => (x ? ` value="${esc(x)}"` : "");
  const base = `/devices/${device.id}/schedule`;

  const ruleRow = (r) => `<tr${r.is_active ? ' class="rule-active"' : ""}>
      <td data-label="Priority" class="position-cell">${r.priority}</td>
      <td class="name">${esc(r.name)}</td>
      <td data-label="Playlist">${esc(r.playlist_name || "—")}</td>
      <td data-label="When" class="muted">${esc(r.summary)}</td>
      <td data-label="State">${r.is_active ? '<span class="badge badge-active">active now</span>' : r.matches_now ? '<span class="badge badge-muted">matches, but a higher-priority rule is playing</span>' : '<span class="badge badge-muted">waiting</span>'}</td>
      <td>
        ${canEdit ? `<div class="action-buttons">
          <a href="${base}?edit=${r.id}#rule-form" class="button small">Edit</a>
          <form method="post" action="${base}/${r.id}/delete" class="inline" data-confirm="Delete rule ${esc(r.name)}?">
            ${csrfInput(ctx)}
            <button type="submit" class="danger small">Delete</button>
          </form>
        </div>` : ""}
      </td>
    </tr>`;
  const dayBox = (name, i) => `<label class="inline-check"><input type="checkbox" name="days_of_week_chk" value="${i}"${(v.days_of_week || "").includes(String(i)) ? " checked" : ""}>${name}</label>`;
  const alsoBox = (d) => `<label class="inline-check"><input type="checkbox" name="also" value="${d.id}">${esc(d.name)}</label>`;
  // Each account sets its own zone on its own Settings page (a viewer cannot open it).
  const zoneHelp = !ownContent
    ? "its own account changes the timezone on its Settings page."
    : user.role === "viewer"
      ? "this account can only view: an admin can make it an editor, which can change the timezone on the Settings page."
      : 'change the timezone on the <a href="/settings">Settings</a> page.';

  const content = `<a href="/devices" class="back">← Devices</a>
<div class="page-head">
  <div>
    <span class="eyebrow">Schedule · ${esc(device.device_id)}</span>
    <h1>${esc(device.name)}</h1>
  </div>
  <span class="page-meta"><strong>local time ${esc(nowText)}</strong><br>rules use the account's wall-clock time (zone ${esc(now.zone)})</span>
</div>
<p class="zone-note">If this is not your venue's time, ${zoneHelp}</p>

<h2>Rules (${rules.length})</h2>
${!rules.length ? emptyState("NO RULES", "The device plays its default playlist always.") : `<div class="table-wrap">
<table class="data stack">
  <caption class="sr-only">Schedule rules</caption>
  <thead>
    <tr><th scope="col">Prio</th><th scope="col">Name</th><th scope="col">Playlist</th><th scope="col">When</th><th scope="col">State</th><th scope="col"><span class="sr-only">Actions</span></th></tr>
  </thead>
  <tbody>
    ${rules.map(ruleRow).join("\n    ")}
  </tbody>
</table>
</div>`}

${canEdit ? `<div class="panel" id="rule-form">
  <h2>${edit ? "Edit rule" : "Add rule"}</h2>
  <form method="post" action="${base}${edit ? `/${edit.id}` : ""}">
    ${csrfInput(ctx)}
    <div class="form-grid">
      <label>Name
        <input type="text" name="name"${value(v.name)} placeholder="e.g., Morning Classes" required>
      </label>
      <label>Playlist
        <select name="playlist_id" required>
          <option value="">— pick —</option>
          ${playlists.map((p) => `<option value="${p.id}"${p.id === v.playlist_id ? " selected" : ""}>${esc(p.name)}</option>`).join("\n          ")}
        </select>
      </label>
      <label>Priority
        <input type="number" name="priority" value="${v.priority}" min="0" max="1000">
      </label>
    </div>
    <div class="form-grid">
      <label>Start time
        <input type="time" name="start_time"${value(v.start_time)} placeholder="06:00">
      </label>
      <label>End time
        <input type="time" name="end_time"${value(v.end_time)} placeholder="09:00">
      </label>
      <label>Start date
        <input type="date" name="start_date"${value(v.start_date)}>
      </label>
      <label>End date
        <input type="date" name="end_date"${value(v.end_date)} placeholder="never">
      </label>
    </div>

    <fieldset class="days-fieldset">
      <legend>Days (leave blank for all days)</legend>
      ${["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map(dayBox).join("\n      ")}
    </fieldset>
    ${others.length ? `<fieldset class="days-fieldset">
      <legend>Also add to</legend>
      ${others.map(alsoBox).join("\n      ")}
    </fieldset>` : ""}

    <div class="row">
      <button type="submit" class="primary">${edit ? "Save rule" : "Add rule"}</button>
      ${edit ? `<a href="${base}" class="button">Cancel</a>` : ""}
    </div>
  </form>
</div>` : ""}`;
  return layout(ctx, { title: `${device.name} schedule`, content });
}

// The rule a form describes (contract 10), checked before anything is read or written. The days
// are the ticked boxes when the browser sends them (no script needed), else days_of_week, a
// "0123456" subset with 0 = Monday (an API client, the e2e suite).
function parseRule(form) {
  const name = str(form, "name").trim() || "Rule";
  const pid = intField(str(form, "playlist_id"), "Playlist");
  if (pid === null) fail(400, "Pick a playlist");
  const prio = intField(str(form, "priority", "0"), "Priority") ?? 0;
  if (prio < 0 || prio > 1000) fail(400, "Priority must be between 0 and 1000");
  const time = (field, which) => {
    const raw = str(form, field).trim();
    if (!raw) return null;
    const t = normalizeHhmm(raw);
    if (t === null) fail(400, `The ${which} time must be in HH:MM form (00:00 to 23:59)`);
    return t;
  };
  const startTime = time("start_time", "start");
  const endTime = time("end_time", "end");
  if (startTime !== null && startTime === endTime) fail(400, "Start and end must differ; leave both empty for all day");
  const rawDays = (form.getAll("days_of_week_chk").join("") || str(form, "days_of_week")).trim();
  if (rawDays && !/^[0-6]+$/.test(rawDays)) fail(400, "Pick the days by ticking them");
  const days = [...new Set(rawDays)].sort().join("") || null;
  const startDate = isoDateField(str(form, "start_date"), "Start date");
  const endDate = isoDateField(str(form, "end_date"), "End date");
  if (startDate && endDate && startDate > endDate) fail(400, "The start date must be on or before the end date");
  return { name, pid, prio, startTime, endTime, days, startDate, endDate };
}

// The projectors ticked under Also add to ({id, owner_id}), each one another of the user's own
// account's: one read for all of them, and one that is not (handed away since the page loaded,
// a made-up id) fails the whole request before anything is written.
async function alsoAddTo(ctx, form, deviceId) {
  const ids = [...new Set(form.getAll("also").map((v) => idParam(String(v), "also")))];
  if (!ids.length) return [];
  const rows = await db.all(ctx.env,
    `SELECT d.id, d.owner_id FROM devices d
      WHERE d.id IN (SELECT value FROM json_each(?)) AND d.id != ? AND ${accounts.contentOwnerSql("d")} = ?`,
    JSON.stringify(ids), deviceId, ctx.user.id);
  if (rows.length !== ids.length) fail(404, "Device not found");
  return rows;
}

// POST /devices/:id/schedule adds a rule, and a copy to every projector ticked under Also add to,
// all in one batch. POST /devices/:id/schedule/:rule saves that rule only: a copy ticked again
// from an Edit form would be a second rule beside the old one, which kept playing the old times.
async function saveRule(ctx) {
  const user = auth.requireRole(ctx, "editor");
  const deviceId = idParam(ctx.params.device_id, "device_id");
  const ruleId = ctx.params.schedule_id === undefined ? null : idParam(ctx.params.schedule_id, "schedule_id");
  const form = await ctx.form();
  const rule = parseRule(form);
  const device = await requireDevice(ctx, deviceId);
  requireContentOwner(ctx, device);
  await requireRow(ctx.env, "playlists", rule.pid, user.id, "Playlist");
  const copies = ruleId === null ? await alsoAddTo(ctx, form, deviceId) : [];
  const fields = [rule.pid, rule.name, rule.prio, rule.startTime, rule.endTime, rule.days, rule.startDate, rule.endDate];
  if (ruleId !== null) {
    const { changes } = await db.run(ctx.env,
      `UPDATE device_schedules SET playlist_id = ?, name = ?, priority = ?, start_time = ?, end_time = ?,
              days_of_week = ?, start_date = ?, end_date = ?
        WHERE id = ? AND device_id = ?`, ...fields, ruleId, deviceId);
    if (!changes) fail(404, "Schedule rule not found");
  }
  const added = ruleId === null ? [{ id: deviceId, owner_id: device.owner_id }, ...copies] : copies;
  const results = added.length ? await db.batch(ctx.env, added.map((d) => [
    `INSERT INTO device_schedules
        (device_id, playlist_id, name, priority, start_time, end_time, days_of_week, start_date, end_date)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, d.id, ...fields])) : [];
  // One audit row per rule written, about its projector's account, in one batch (audit.log's
  // rule: a failed audit write never fails the request).
  try {
    const details = (id) => ({ device_id: id, name: rule.name, playlist_id: rule.pid });
    await db.batch(ctx.env, [
      ...(ruleId === null ? [] : [audit.statement(ctx, "device_schedule_update", "device_schedule", ruleId, details(deviceId), undefined, device.owner_id)]),
      ...added.map((d, i) => audit.statement(ctx, "device_schedule_create", "device_schedule", results[i].meta.last_row_id, details(d.id), undefined, d.owner_id)),
    ]);
  } catch (e) {
    console.error(`audit log write failed for a schedule rule: ${e}`);
  }
  const back = `/devices/${deviceId}/schedule`;
  if (!copies.length) return redirect(back);
  return auth.flashRedirect(ctx, back, `Rule added to ${copies.length + 1} projectors.`);
}

async function scheduleDelete(ctx) {
  auth.requireRole(ctx, "editor");
  const deviceId = idParam(ctx.params.device_id, "device_id");
  const scheduleId = idParam(ctx.params.schedule_id, "schedule_id");
  const device = await requireDevice(ctx, deviceId);
  requireContentOwner(ctx, device);
  const r = await db.run(ctx.env, "DELETE FROM device_schedules WHERE id = ? AND device_id = ?", scheduleId, deviceId);
  if (!r.changes) fail(404, "Schedule rule not found");
  await audit.log(ctx, "device_schedule_delete", "device_schedule", scheduleId, { device_id: deviceId }, undefined, device.owner_id);
  return redirect(`/devices/${deviceId}/schedule`);
}

export function register(router) {
  router.get("/devices/:device_id/schedule", schedulePage);
  router.post("/devices/:device_id/schedule", saveRule);
  router.post("/devices/:device_id/schedule/:schedule_id", saveRule);
  router.post("/devices/:device_id/schedule/:schedule_id/delete", scheduleDelete);
}
