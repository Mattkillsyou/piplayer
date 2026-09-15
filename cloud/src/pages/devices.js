// Port of web.devices_* + devices.html: register / assign / group / regen-token / delete /
// command / screenshot, plus decorateDevices() which the dashboard shares.
import * as audit from "../audit.js";
import * as auth from "../auth.js";
import * as db from "../db.js";
import * as manifest from "../manifest.js";
import * as media from "../media.js";
import {
  ageSeconds, ageText, esc, fail, HttpError, idParam, intField, localTime, randomToken, redirect, str, wallClock,
} from "../util.js";
import { csrfInput, layout } from "./layout.js";

export const COMMANDS = ["reboot", "force-sync", "restart-mpv"];
const DEVICE_ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

// Fill in the served playlist (schedule/default/group), screenshot age + stale flag and
// last-seen age for a list of device rows (web._decorate_device), with the fleet's
// schedules, group defaults and playlist names fetched in three statements rather than
// a few per device (D1 statements count against the per-invocation subrequest budget).
export async function decorateDevices(env, rows, settings, now = new Date()) {
  if (!rows.length) return rows;
  const wall = wallClock(settings.timezone, now);
  // Both callers pass every device, so read all schedules in one unbound statement and
  // bucket in JS: an IN (...) list would hit D1's bound-parameter limit on a large fleet.
  const byDevice = new Map(rows.map((d) => [d.id, []]));
  for (const s of await db.all(env,
    `SELECT id, device_id, playlist_id, name, priority, start_time, end_time,
            days_of_week, start_date, end_date
       FROM device_schedules`)) {
    const bucket = byDevice.get(s.device_id);
    if (bucket) bucket.push(s);
  }
  const groupPl = new Map((await db.all(env, "SELECT id, playlist_id FROM device_groups")).map((g) => [g.id, g.playlist_id]));
  const plName = new Map((await db.all(env, "SELECT id, name FROM playlists")).map((p) => [p.id, p.name]));
  for (const dd of rows) {
    const [pid, source] = manifest.pick_playlist(dd, byDevice.get(dd.id), groupPl.get(dd.group_id) ?? null, wall);
    dd.active_playlist_id = pid;
    dd.active_playlist_name = null;
    dd.active_source = null;
    if (pid) {
      dd.active_playlist_name = plName.get(pid) ?? null;
      if (source.startsWith("schedule:")) dd.active_source = "schedule: " + source.slice("schedule:".length);
      else if (source === "group-default") dd.active_source = `group: ${dd.group_name || ""}`;
      else dd.active_source = "device default";
    }
    const shotAge = ageSeconds(dd.last_screenshot_at, now);
    dd.screenshot_age = shotAge === null ? null : ageText(shotAge);
    dd.screenshot_stale = shotAge !== null && shotAge > 3 * settings.screenshot_interval;
    const seen = ageSeconds(dd.last_seen_at, now);
    dd.seen_age = seen === null ? null : ageText(seen);
  }
  return rows;
}

// 404 when an optional foreign-key target does not exist (null is allowed) (web._require_row).
export async function requireRow(env, table, rowId, label) {
  if (rowId === null || rowId === undefined) return;
  if (!(await db.first(env, `SELECT id FROM ${table} WHERE id = ?`, rowId))) fail(404, `${label} not found`);
}

// Player state for the lamp: the reported status while the device has checked in, else offline.
export const lampState = (d) => (d.last_seen_at ? d.player_status || "idle" : "offline");

// The 16:9 "screen": screenshot (or NO SIGNAL) under scanlines, age tag, stale badge and the
// now-playing caption. Shared with the devices page (`link` wraps the image in a new-tab link).
export function screenHtml(d, tz, { link = false, staleTitle } = {}) {
  const href = `/devices/${d.id}/screenshot?t=${esc(encodeURIComponent(d.last_screenshot_at))}`;
  const img = `<img src="${href}" class="device-thumb${d.screenshot_stale ? " device-thumb-stale" : ""}" alt="screenshot">`;
  const shot = d.last_screenshot_at
    ? `${link ? `<a href="${href}" target="_blank" title="Open screenshot">${img}</a>` : img}
      <span class="screen-age screenshot-age" title="screenshot ${esc(d.screenshot_age)} (${esc(localTime(d.last_screenshot_at, tz))})">${esc(d.screenshot_age)}</span>
      ${d.screenshot_stale ? `<span class="badge badge-stale" title="${staleTitle}">stale</span>` : ""}`
    : '<div class="device-thumb device-thumb-empty">no screenshot yet</div>';
  return `<div class="screen">
      ${shot}
      ${d.current_filename ? `<span class="screen-now">#${(d.current_position || 0) + 1} ${esc(d.current_filename)}</span>` : ""}
    </div>`;
}

function optionList(rows, selected) {
  return rows.map((r) =>
    `<option value="${r.id}"${r.id === selected ? " selected" : ""}>${esc(r.name)}</option>`).join("\n            ");
}

function commandLine(c, tz) {
  let state;
  if (c.completed_at) {
    if (c.result && c.result.startsWith("undeliverable")) state = `<span class="badge badge-stale">${esc(c.result)}</span>`;
    else state = `done${c.result ? `: ${esc(c.result)}` : ""}`;
  } else if (c.delivered_at) {
    state = `delivered ×${c.delivery_count}, no result yet`;
  } else {
    state = "queued";
  }
  return `<li>
            <span class="muted">${esc(localTime(c.issued_at, tz))}</span>
            <code>${esc(c.command)}</code> → ${state}
          </li>`;
}

// CMS_URL for the install snippet: the optional PIPLAYER_PUBLIC_BASE_URL var wins (as in the
// Python CMS), else the origin the browser is using; the note about editing it is only shown
// in the second case, where the guess may be wrong (LAN vs Tailscale address).
export function installBaseUrl(env, url) {
  const configured = (env.PIPLAYER_PUBLIC_BASE_URL || "").replace(/\/+$/, "");
  return { base: configured || url.origin, configured: Boolean(configured) };
}

// One device-detail card: screen | fields + active-now + kv | actions (devices.html).
function deviceDetail(ctx, d, playlists, groups, canEdit, tz, install) {
  const dis = canEdit ? "" : " disabled";
  const state = lampState(d);
  const commandForm = (command, label, title, cls = "", extra = "") => `<form method="post" action="/devices/${d.id}/command" class="inline"${extra}>
          ${csrfInput(ctx)}
          <input type="hidden" name="command" value="${command}">
          <button type="submit"${cls ? ` class="${cls}"` : ""}${title ? ` title="${title}"` : ""}>${label}</button>
        </form>`;
  const now = d.current_filename ? `#${(d.current_position || 0) + 1} ${esc(d.current_filename)}` : "no output";
  return `<div class="device-detail">
    <div>
      ${screenHtml(d, tz, { link: true, staleTitle: "No new screenshot for more than 3 capture intervals" })}
      <span class="device-name">${esc(d.name)}</span>
      <code class="device-id">${esc(d.device_id)}</code>
      <span class="lamp lamp-${esc(state)}">${esc(state)}</span>
    </div>

    <div>
      <div class="fields">
        <form method="post" action="/devices/${d.id}/group" class="inline">
          ${csrfInput(ctx)}
          <label>group
            <select name="group_id" data-autosubmit${dis}>
              <option value="">— none —</option>
              ${optionList(groups, d.group_id)}
            </select>
          </label>
        </form>
        <form method="post" action="/devices/${d.id}/assign" class="inline">
          ${csrfInput(ctx)}
          <label>default playlist
            <select name="playlist_id" data-autosubmit${dis}>
              <option value="">— none —</option>
              ${optionList(playlists, d.playlist_id)}
            </select>
          </label>
        </form>
        <a href="/devices/${d.id}/schedule" class="button small">Schedule (${d.schedule_count})</a>
      </div>
      <div class="active-now">
        <span class="via">active now${d.active_source ? ` · via ${esc(d.active_source)}` : ""}</span>
        ${d.active_playlist_name
    ? `<span class="playlist">${esc(d.active_playlist_name)}</span>`
    : '<span class="playlist muted">no playlist</span>'}
        <span class="now">${now}</span>
      </div>
      <div class="kv">
        <div><span class="k">last seen</span><span class="v">${d.last_seen_at ? `${esc(d.seen_age)}<br><span class="muted">${esc(localTime(d.last_seen_at, tz))}</span>` : "never"}</span></div>
        <div><span class="k">ip</span><span class="v">${d.last_ip ? esc(d.last_ip) : "none"}</span></div>
        <div><span class="k">agent</span><span class="v">${d.player_version ? `v${esc(d.player_version)}` : "none"}</span></div>
      </div>
      ${d.last_error ? `<div class="alert warn small" title="Reported by the player on its last sync">Sync problem: ${esc(d.last_error)}</div>` : ""}
      ${d.recent_commands.length ? `<details>
        <summary class="small">Recent commands (${d.recent_commands.length})</summary>
        <ul class="command-list small">
          ${d.recent_commands.map((c) => commandLine(c, tz)).join("\n          ")}
        </ul>
      </details>` : ""}
    </div>

    <div>
      <span class="eyebrow eyebrow-quiet">Actions</span>
      <div class="action-buttons">
        ${canEdit ? `${commandForm("force-sync", "Resync", "Tell the Pi to re-sync from the CMS now", "primary")}
        ${commandForm("restart-mpv", "Restart mpv", "Restart the mpv playback process")}
        ${commandForm("reboot", "Reboot Pi", "", "danger", ` data-confirm="Reboot ${esc(d.name)}?"`)}
        <details>
          <summary class="small">Token / install</summary>
          <div class="token-block">
            <code class="token">${esc(d.token)}</code>
            <p class="muted small">On the Pi, from the directory you cloned the repo into:</p>
            <pre class="install-cmd">cd piplayer/player && \\
DEVICE_ID=${esc(d.device_id)} \\
DEVICE_TOKEN=${esc(d.token)} \\
CMS_URL=${esc(install.base)} \\
sudo -E bash deploy/install-player.sh</pre>
            ${install.configured ? "" : `<p class="muted small">CMS_URL is the address your browser is using; edit it if this Pi reaches the CMS another way (e.g. a LAN address instead of Tailscale).</p>`}
            <div class="action-buttons">
              <form method="post" action="/devices/${d.id}/regen-token" class="inline" data-confirm="Regenerate token? The Pi will need the new token.">
                ${csrfInput(ctx)}
                <button type="submit" class="small">New token</button>
              </form>
              <form method="post" action="/devices/${d.id}/delete" class="inline" data-confirm="Delete device ${esc(d.name)}?">
                ${csrfInput(ctx)}
                <button type="submit" class="danger small">Delete device</button>
              </form>
            </div>
          </div>
        </details>` : '<p class="muted small">Read-only: viewers cannot send commands.</p>'}
      </div>
    </div>
  </div>`;
}

async function devicesPage(ctx) {
  const user = auth.requireUser(ctx);
  const canEdit = auth.roleRank(user.role) >= auth.roleRank("editor");
  const settings = await ctx.settings();
  const tz = settings.timezone;
  const env = ctx.env;
  const rows = await db.all(env,
    `SELECT d.id, d.device_id, d.name, d.last_seen_at, d.last_ip,
            d.player_version, d.current_position, d.current_filename, d.player_status,
            d.last_screenshot_at, d.last_error,
            p.id AS playlist_id, p.name AS playlist_name,
            g.id AS group_id, g.name AS group_name
       FROM devices d
       LEFT JOIN playlists p ON p.id = d.playlist_id
       LEFT JOIN device_groups g ON g.id = d.group_id
       ORDER BY d.name`);
  const playlists = await db.all(env, "SELECT id, name FROM playlists ORDER BY name");
  const groups = await db.all(env, "SELECT id, name FROM device_groups ORDER BY name");
  const devices = await decorateDevices(env, rows, settings);
  // Schedule counts, tokens and the last 5 commands for the whole fleet in one statement
  // each (SQLite window function for the per-device LIMIT) rather than three per device.
  const counts = new Map((await db.all(env, "SELECT device_id, COUNT(*) AS n FROM device_schedules GROUP BY device_id"))
    .map((r) => [r.device_id, r.n]));
  // Tokens are only shown to people who may install a player (editor+).
  const tokens = canEdit ? new Map((await db.all(env, "SELECT id, token FROM devices")).map((r) => [r.id, r.token])) : null;
  const recent = await db.all(env,
    `SELECT id, device_id, command, issued_at, delivered_at, completed_at, result, delivery_count
       FROM (SELECT *, ROW_NUMBER() OVER (PARTITION BY device_id ORDER BY id DESC) AS rn FROM device_commands)
      WHERE rn <= 5 ORDER BY device_id, id DESC`);
  const byId = new Map(devices.map((d) => [d.id, d]));
  for (const dd of devices) {
    dd.schedule_count = counts.get(dd.id) || 0;
    if (tokens) dd.token = tokens.get(dd.id);
    dd.recent_commands = [];
  }
  for (const c of recent) byId.get(c.device_id)?.recent_commands.push(c);
  const install = installBaseUrl(env, ctx.url);

  const content = `<h1>Devices</h1>

${canEdit ? `<div class="panel">
  <h2>Register a new device</h2>
  <p class="muted small">
    After creating it, open "Token / install" on the new row and run that command on the Pi.
  </p>
  <form method="post" action="/devices" class="row">
    ${csrfInput(ctx)}
    <label>device_id
      <input type="text" name="device_id" placeholder="lobby-projector" pattern="[a-z0-9][a-z0-9-]{0,62}" required>
    </label>
    <label>name
      <input type="text" name="name" placeholder="Lobby Projector" required>
    </label>
    <button type="submit" class="primary">Register device</button>
  </form>
</div>` : ""}

${!devices.length ? '<p class="muted empty">No devices yet.</p>' : `<div class="device-list">
  ${devices.map((d) => deviceDetail(ctx, d, playlists, groups, canEdit, tz, install)).join("\n  ")}
</div>`}`;
  return layout(ctx, { title: "Devices", content });
}

async function devicesCreate(ctx) {
  auth.requireRole(ctx, "editor");
  const form = await ctx.form();
  const deviceId = str(form, "device_id").trim().toLowerCase();
  const name = str(form, "name").trim();
  if (!DEVICE_ID_RE.test(deviceId)) fail(400, "device_id must be lowercase alphanumeric + hyphens, 1-63 chars");
  if (!name) fail(400, "name required");
  const token = randomToken(32);
  let id;
  try {
    id = (await db.run(ctx.env, "INSERT INTO devices (device_id, name, token) VALUES (?, ?, ?)", deviceId, name, token)).last_row_id;
  } catch (e) {
    if (db.isConstraintError(e)) fail(409, "A device with that device_id already exists");
    throw e;
  }
  await audit.log(ctx, "register_device", "device", id, { device_id: deviceId, name });
  return redirect("/devices");
}

async function devicesAssign(ctx) {
  auth.requireRole(ctx, "editor");
  const deviceId = idParam(ctx.params.device_id, "device_id");
  const pid = intField(str(await ctx.form(), "playlist_id"), "playlist_id");
  await requireRow(ctx.env, "devices", deviceId, "Device");
  await requireRow(ctx.env, "playlists", pid, "Playlist");
  await db.run(ctx.env, "UPDATE devices SET playlist_id = ? WHERE id = ?", pid, deviceId);
  await audit.log(ctx, "device_assign_playlist", "device", deviceId, { playlist_id: pid });
  return redirect("/devices");
}

async function devicesSetGroup(ctx) {
  auth.requireRole(ctx, "editor");
  const deviceId = idParam(ctx.params.device_id, "device_id");
  const gid = intField(str(await ctx.form(), "group_id"), "group_id");
  await requireRow(ctx.env, "devices", deviceId, "Device");
  await requireRow(ctx.env, "device_groups", gid, "Group");
  await db.run(ctx.env, "UPDATE devices SET group_id = ? WHERE id = ?", gid, deviceId);
  await audit.log(ctx, "device_set_group", "device", deviceId, { group_id: gid });
  return redirect("/devices");
}

async function devicesRegenToken(ctx) {
  auth.requireRole(ctx, "editor");
  const deviceId = idParam(ctx.params.device_id, "device_id");
  await requireRow(ctx.env, "devices", deviceId, "Device");
  await db.run(ctx.env, "UPDATE devices SET token = ? WHERE id = ?", randomToken(32), deviceId);
  await audit.log(ctx, "device_regen_token", "device", deviceId);
  return redirect("/devices");
}

async function devicesDelete(ctx) {
  auth.requireRole(ctx, "editor");
  const deviceId = idParam(ctx.params.device_id, "device_id");
  const row = await db.first(ctx.env, "SELECT device_id, name FROM devices WHERE id = ?", deviceId);
  if (!row) fail(404, "Device not found");
  await db.run(ctx.env, "DELETE FROM devices WHERE id = ?", deviceId);
  await media.deleteScreenshot(ctx.env, row.device_id);
  await audit.log(ctx, "device_delete", "device", deviceId, { device_id: row.device_id, name: row.name });
  return redirect("/devices");
}

async function devicesSendCommand(ctx) {
  const user = auth.requireRole(ctx, "editor");
  const deviceId = idParam(ctx.params.device_id, "device_id");
  const command = str(await ctx.form(), "command");
  if (!COMMANDS.includes(command)) fail(400, "unknown command");
  await requireRow(ctx.env, "devices", deviceId, "Device");
  const id = (await db.run(ctx.env,
    "INSERT INTO device_commands (device_id, command, issued_by) VALUES (?, ?, ?)", deviceId, command, user.id)).last_row_id;
  await audit.log(ctx, "device_send_command", "device", deviceId, { command, command_id: id });
  return redirect("/devices");
}

// Latest screenshot, session users only (never cached: the URL carries ?t= but the
// browser must not keep an old frame).
async function devicesScreenshot(ctx) {
  auth.requireUser(ctx);
  const deviceId = idParam(ctx.params.device_id, "device_id");
  const row = await db.first(ctx.env, "SELECT device_id FROM devices WHERE id = ?", deviceId);
  if (!row) fail(404, "Not Found");
  try {
    return await media.serveScreenshot(ctx.request, ctx.env, row.device_id);
  } catch (e) {
    if (e instanceof HttpError && e.status === 404) fail(404, "no screenshot yet");
    throw e;
  }
}

export function register(router) {
  router.get("/devices", devicesPage);
  router.post("/devices", devicesCreate);
  router.post("/devices/:device_id/assign", devicesAssign);
  router.post("/devices/:device_id/group", devicesSetGroup);
  router.post("/devices/:device_id/regen-token", devicesRegenToken);
  router.post("/devices/:device_id/delete", devicesDelete);
  router.post("/devices/:device_id/command", devicesSendCommand);
  router.get("/devices/:device_id/screenshot", devicesScreenshot);
}
