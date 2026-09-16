// Port of web.devices_* + devices.html: register / assign / group / regen-token / delete /
// command / screenshot / camera snapshot + live URL, plus decorateDevices() which the
// dashboard shares.
import * as audit from "../audit.js";
import * as auth from "../auth.js";
import * as db from "../db.js";
import * as manifest from "../manifest.js";
import * as media from "../media.js";
import {
  ageSeconds, ageText, esc, fail, HttpError, idParam, intField, localTime, randomToken, redirect, str, wallClock,
} from "../util.js";
import { alertBox, csrfInput, emptyState, layout } from "./layout.js";

export const COMMANDS = ["reboot", "force-sync", "restart-mpv", "update-player", "update-os", "update-all"];
// The fleet "Update all players" button queues one of these for every device (POST /devices/update-all).
export const FLEET_COMMANDS = ["update-player", "update-os", "update-all"];
const DEVICE_ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
// A player that has not synced for this long is shown as offline (it polls every 30 s and
// backs off to at most 300 s when the CMS is unreachable, in which case it cannot reach us anyway).
export const OFFLINE_AFTER_SECONDS = 180;
const LAMP_STATES = ["playing", "paused", "idle", "mpv-down"];
// A failed remote update (last_update_ok = 0, api.storeUpdateStatus) is a fault until the next report.
export const isFault = (d) => d.lamp === "mpv-down" || d.lamp === "offline" || d.last_update_ok === 0;

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
    const camAge = ageSeconds(dd.last_camera_at, now);
    dd.camera_age = camAge === null ? null : ageText(camAge);
    dd.camera_stale = camAge !== null && camAge > 3 * settings.camera_interval;
    const seen = ageSeconds(dd.last_seen_at, now);
    dd.seen_age = seen === null ? null : ageText(seen);
    dd.offline = seen === null || seen > OFFLINE_AFTER_SECONDS;
    // what the status lamp shows: offline beats whatever the player last reported;
    // the value becomes a CSS class, so anything unknown from the device reads as idle
    const reported = dd.player_status || "idle";
    dd.lamp = dd.offline ? "offline" : (LAMP_STATES.includes(reported) ? reported : "idle");
  }
  return rows;
}

// 404 when an optional foreign-key target does not exist (null is allowed) (web._require_row).
export async function requireRow(env, table, rowId, label) {
  if (rowId === null || rowId === undefined) return;
  if (!(await db.first(env, `SELECT id FROM ${table} WHERE id = ?`, rowId))) fail(404, `${label} not found`);
}

const screenshotHref = (d) => `/devices/${d.id}/screenshot?t=${esc(encodeURIComponent(d.last_screenshot_at))}`;

// The `.device-screen` block shared by the Devices rows and the dashboard wall: thumb (or
// NO SIGNAL), age chip + live/stale chip; `link` wraps the thumb in a new-tab link, `now`
// adds the now-playing overlay, `tz` puts the local capture time on the age chip (dashboard),
// `staleTitle` is the stale chip tooltip.
export function deviceScreen(d, { link = false, now = false, tz = null, staleTitle = "" } = {}) {
  let inner;
  if (d.last_screenshot_at) {
    const img = `<img src="${screenshotHref(d)}" class="device-thumb${d.screenshot_stale ? " device-thumb-stale" : ""}" alt="Latest screenshot from ${esc(d.name)}">`;
    inner = `${link ? `<a href="${screenshotHref(d)}" target="_blank" title="Open the latest screenshot">${img}</a>` : img}
      <span class="screenshot-age">
        <span class="screen-chip tl"${tz ? ` title="${esc(localTime(d.last_screenshot_at, tz))}"` : ""}>${esc(d.screenshot_age)}</span>
        ${d.screenshot_stale
    ? `<span class="screen-chip tr is-stale badge-stale" title="${staleTitle}">stale</span>`
    : '<span class="screen-chip tr">live</span>'}
      </span>`;
  } else {
    inner = `<div class="device-thumb device-thumb-empty">
        <span class="empty-title">NO SIGNAL</span>
        <span class="empty-sub">no screenshot yet</span>
      </div>`;
  }
  return `<div class="device-screen${d.screenshot_stale ? " is-stale" : ""}">
      ${inner}
      ${now && d.current_filename ? `<span class="screen-now">#${(d.current_position || 0) + 1} ${esc(d.current_filename)}</span>` : ""}
    </div>`;
}

// Room camera snapshot (only rendered when the device has ever sent one): the same
// `.device-screen` block as the projector screenshot with a CAM chip, age + live/stale chip,
// and the player's camera_error in the warn style underneath.
const cameraHref = (d) => `/devices/${d.id}/camera?t=${esc(encodeURIComponent(d.last_camera_at))}`;

export function cameraScreen(d, { link = false, tz = null, staleTitle = "" } = {}) {
  const error = d.camera_error
    ? `<div class="alert warn small" title="Reported by the player on its last sync">Camera: ${esc(d.camera_error)}</div>`
    : "";
  if (!d.last_camera_at) return error;
  const img = `<img src="${cameraHref(d)}" class="device-thumb${d.camera_stale ? " device-thumb-stale" : ""}" alt="Latest camera snapshot from ${esc(d.name)}">`;
  return `<div class="device-screen device-camera${d.camera_stale ? " is-stale" : ""}">
      ${link ? `<a href="${cameraHref(d)}" target="_blank" title="Open the latest camera snapshot">${img}</a>` : img}
      <span class="screenshot-age">
        <span class="screen-chip tl"${tz ? ` title="${esc(localTime(d.last_camera_at, tz))}"` : ""}>cam · ${esc(d.camera_age)}</span>
        ${d.camera_stale
    ? `<span class="screen-chip tr is-stale badge-stale" title="${staleTitle}">stale</span>`
    : '<span class="screen-chip tr">live</span>'}
      </span>
    </div>
    ${error}`;
}

// The operator-pasted live URL: absolute https only, no credentials, at most 2048 chars.
// liveUrl() returns the normalised URL or null (used again at render time, so the iframe
// only ever gets a URL that passes); validateLiveUrl() is the form rule (empty clears, 400 otherwise).
export function liveUrl(value) {
  const v = (value || "").trim();
  if (!v || v.length > 2048) return null;
  let u;
  try {
    u = new URL(v);
  } catch {
    return null;
  }
  return u.protocol === "https:" && u.hostname && !u.username && !u.password ? u.href : null;
}

export function validateLiveUrl(value) {
  if (!(value || "").trim()) return null;
  const url = liveUrl(value);
  if (!url) fail(400, "camera_live_url must be an absolute https:// URL");
  return url;
}

export const statusLamp = (d) => `<span class="status status-${esc(d.lamp)}"><span class="lamp"></span>${esc(d.lamp)}</span>`;

function optionList(rows, selected) {
  return rows.map((r) =>
    `<option value="${r.id}"${r.id === selected ? " selected" : ""}>${esc(r.name)}</option>`).join("\n              ");
}

function commandLine(c, tz) {
  let state;
  if (c.completed_at) {
    if (c.result && c.result.startsWith("undeliverable")) state = `<span class="badge badge-stale">${esc(c.result)}</span>`;
    else state = `done${c.result ? ` · ${esc(c.result)}` : ""}`;
  } else if (c.delivered_at) {
    state = `delivered ×${c.delivery_count}, no result yet`;
  } else {
    state = "queued";
  }
  return `<li>
            <span class="muted">${esc(localTime(c.issued_at, tz))}</span>
            <code>${esc(c.command)}</code> →
            ${state}
          </li>`;
}

// CMS_URL for the install snippet: the optional PIPLAYER_PUBLIC_BASE_URL var wins (as in the
// Python CMS), else the origin the browser is using; the note about editing it is only shown
// in the second case, where the guess may be wrong (LAN vs Tailscale address).
export function installBaseUrl(env, url) {
  const configured = (env.PIPLAYER_PUBLIC_BASE_URL || "").replace(/\/+$/, "");
  return { base: configured || url.origin, configured: Boolean(configured) };
}

// What the player reported after its last update-player / update-os run (api.storeUpdateStatus):
// a failure is an error box so it stands out, success a muted line; nothing until the first report.
export function updateStatus(d, tz) {
  if (!d.last_update_at) return "";
  const when = `${esc(ageText(ageSeconds(d.last_update_at)))} · ${esc(localTime(d.last_update_at, tz))}`;
  const ref = d.last_update_ref ? ` <code>${esc(d.last_update_ref)}</code>` : "";
  const msg = d.last_update_message ? `: ${esc(d.last_update_message)}` : "";
  return d.last_update_ok
    ? `<p class="update-status muted small" title="Reported by the player after its last update">Update ok${ref} · ${when}${msg}</p>`
    : `<div class="alert error update-status" title="Reported by the player after its last update">Update failed${ref} · ${when}${msg}</div>`;
}

function commandForm(ctx, d, command, label, cls, title = "", extra = "") {
  return `<form method="post" action="/devices/${d.id}/command" class="inline"${extra}>
          ${csrfInput(ctx)}
          <input type="hidden" name="command" value="${command}">
          <button type="submit" class="${cls}"${title ? ` title="${title}"` : ""}>${label}</button>
        </form>`;
}

function deviceRow(ctx, d, playlists, groups, canEdit, tz, install) {
  const dis = canEdit ? "" : " disabled";
  const live = liveUrl(d.camera_live_url);
  return `<div class="device-row${isFault(d) ? " is-fault" : ""}">
    <div class="device-ident">
      ${deviceScreen(d, { link: true, staleTitle: "No new screenshot for more than 3 capture intervals" })}
      ${cameraScreen(d, { link: true, staleTitle: "No new camera snapshot for more than 3 camera intervals" })}
      <span class="device-name">${esc(d.name)}</span>
      <span class="device-id"><code>${esc(d.device_id)}</code>${d.group_name ? ` · ${esc(d.group_name)}` : ""}</span>
      ${statusLamp(d)}
    </div>

    <div class="device-detail">
      <div class="assign">
        <form method="post" action="/devices/${d.id}/group">
          ${csrfInput(ctx)}
          <label>group
            <select name="group_id" data-autosubmit${dis}>
              <option value="">— none —</option>
              ${optionList(groups, d.group_id)}
            </select>
          </label>
        </form>
        <form method="post" action="/devices/${d.id}/assign">
          ${csrfInput(ctx)}
          <label>default playlist
            <select name="playlist_id" data-autosubmit${dis}>
              <option value="">— none —</option>
              ${optionList(playlists, d.playlist_id)}
            </select>
          </label>
        </form>
        <a href="/devices/${d.id}/schedule" class="button">Schedule (${d.schedule_count})</a>
      </div>

      <div class="now-block${d.active_playlist_name ? "" : " none"}">
        <span class="now-label">active now${d.active_playlist_name ? ` · via ${esc(d.active_source)}` : ""}</span>
        <span class="now-playlist">${d.active_playlist_name ? esc(d.active_playlist_name) : "no playlist"}</span>
        ${d.current_filename
    ? `<span class="now-file">#${(d.current_position || 0) + 1} ${esc(d.current_filename)}${d.player_status ? ` · ${esc(d.player_status)}` : ""}</span>`
    : ""}
      </div>

      <div class="facts">
        <div><span class="label">last seen</span><span class="value">${d.last_seen_at ? `${esc(d.seen_age)}<br>${esc(localTime(d.last_seen_at, tz))}` : "never"}</span></div>
        <div><span class="label">ip</span><span class="value">${d.last_ip ? esc(d.last_ip) : "—"}</span></div>
        <div><span class="label">agent</span><span class="value">${d.player_version ? `v${esc(d.player_version)}` : "—"}</span></div>
      </div>

      ${d.last_error ? `<div class="alert error" title="Reported by the player on its last sync">Sync problem: ${esc(d.last_error)}</div>` : ""}
      ${updateStatus(d, tz)}

      <details class="camera-block">
        <summary>Camera${live ? " · live URL set" : ""}</summary>
        <div class="token-block">
          <form method="post" action="/devices/${d.id}/camera-url" class="row">
            ${csrfInput(ctx)}
            <label>Camera live URL
              <input type="url" name="camera_live_url" value="${esc(live || "")}" placeholder="https://cam-lobby.example.com/" pattern="https://.*" maxlength="2048"${dis}>
            </label>
            <button type="submit" class="small"${dis}>Save</button>
          </form>
          <p class="help small">Page the console embeds for the live view (e.g. a Cloudflare Tunnel hostname to the Wyze bridge player). Snapshots come from the Pi on their own; see docs/camera.md.</p>
          ${live ? `<div class="action-buttons">
            <a href="${esc(live)}" target="_blank" rel="noopener noreferrer" class="button small">Live</a>
            <button type="button" class="small" data-live-frame="live-frame-${d.id}">Show live</button>
          </div>
          <iframe id="live-frame-${d.id}" class="live-frame" data-src="${esc(live)}" title="Live camera: ${esc(d.name)}" sandbox="allow-same-origin allow-scripts" referrerpolicy="no-referrer" hidden></iframe>` : ""}
        </div>
      </details>

      ${d.recent_commands.length ? `<details>
        <summary>Recent commands (${d.recent_commands.length})</summary>
        <ul class="command-list">
          ${d.recent_commands.map((c) => commandLine(c, tz)).join("\n          ")}
        </ul>
      </details>` : ""}
    </div>

    <div class="device-actions">
      <span class="label">Actions</span>
      ${canEdit ? `<div class="action-buttons">
        ${commandForm(ctx, d, "force-sync", "Resync", "small primary", "Tell the Pi to re-sync from the CMS now")}
        ${commandForm(ctx, d, "restart-mpv", "Restart mpv", "small", "Restart the mpv playback process")}
        ${commandForm(ctx, d, "reboot", "Reboot Pi", "small danger", "", ` data-confirm="Reboot ${esc(d.name)}?"`)}
      </div>
      <div class="action-buttons">
        ${commandForm(ctx, d, "update-player", "Update player", "small", "Check out the Settings release on the Pi and reinstall the player", ` data-confirm="Update the player software on ${esc(d.name)}? Playback restarts."`)}
        ${commandForm(ctx, d, "update-os", "Update OS", "small", "apt-get upgrade on the Pi; reboots if the OS asks for it", ` data-confirm="Update OS packages on ${esc(d.name)}? The Pi may reboot."`)}
        ${commandForm(ctx, d, "update-all", "Update all", "small", "Player software, then OS packages", ` data-confirm="Update player and OS on ${esc(d.name)}? The Pi may reboot."`)}
      </div>
      <details>
        <summary>Token / install</summary>
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
      </details>` : '<span class="help small">Viewer access: read-only.</span>'}
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
            d.last_camera_at, d.camera_error, d.camera_live_url,
            d.last_update_at, d.last_update_ok, d.last_update_message, d.last_update_ref,
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
  const queued = ctx.url.searchParams.get("queued");

  const content = `<div class="page-head">
  <h1>Devices</h1>
  ${canEdit ? `<form method="post" action="/devices" class="head-actions">
    ${csrfInput(ctx)}
    <label>device_id
      <input type="text" name="device_id" placeholder="lobby-projector" pattern="[a-z0-9][a-z0-9-]{0,62}" required>
    </label>
    <label>name
      <input type="text" name="name" placeholder="Lobby Projector" required>
    </label>
    <button type="submit" class="primary">Register</button>
  </form>
  ${devices.length ? `<form method="post" action="/devices/update-all" class="head-actions" data-confirm="Queue a player software update (release ${esc(settings.player_release)}) on every device? Playback restarts on each Pi.">
    ${csrfInput(ctx)}
    <input type="hidden" name="command" value="update-player">
    <button type="submit" title="Queue update-player on every device that is not already waiting for one">Update all players</button>
  </form>` : ""}` : ""}
</div>
${canEdit ? '<p class="help small">After registering, open "Token / install" on the new device and run that command on the Pi.</p>' : ""}
${/^\d+$/.test(queued || "") ? alertBox(`Update queued for ${queued} device${queued === "1" ? "" : "s"}.`, "ok") : ""}

${!devices.length
    ? emptyState("NO SIGNAL", `No devices yet.${canEdit ? " Register one above." : ""}`)
    : `<div class="device-rows">
  ${devices.map((d) => deviceRow(ctx, d, playlists, groups, canEdit, tz, install)).join("\n  ")}
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
  await media.deleteCamera(ctx.env, row.device_id);
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

// Fleet action: queue one update command for every device that is not already waiting for
// the same one (a second click while the first is still queued must not double-update).
async function devicesUpdateAll(ctx) {
  const user = auth.requireRole(ctx, "editor");
  const command = str(await ctx.form(), "command") || "update-player";
  if (!FLEET_COMMANDS.includes(command)) fail(400, "unknown command");
  const { changes } = await db.run(ctx.env,
    `INSERT INTO device_commands (device_id, command, issued_by)
     SELECT d.id, ?, ? FROM devices d
      WHERE NOT EXISTS (SELECT 1 FROM device_commands c
                         WHERE c.device_id = d.id AND c.command = ? AND c.completed_at IS NULL)`,
    command, user.id, command);
  await audit.log(ctx, "device_update_all", "device", null, { command, queued: changes });
  return redirect(`/devices?queued=${changes}`);
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

// Latest camera snapshot, same rules as the screenshot.
async function devicesCamera(ctx) {
  auth.requireUser(ctx);
  const deviceId = idParam(ctx.params.device_id, "device_id");
  const row = await db.first(ctx.env, "SELECT device_id FROM devices WHERE id = ?", deviceId);
  if (!row) fail(404, "Not Found");
  try {
    return await media.serveCamera(ctx.request, ctx.env, row.device_id);
  } catch (e) {
    if (e instanceof HttpError && e.status === 404) fail(404, "no camera snapshot yet");
    throw e;
  }
}

async function devicesSetCameraUrl(ctx) {
  auth.requireRole(ctx, "editor");
  const deviceId = idParam(ctx.params.device_id, "device_id");
  const url = validateLiveUrl(str(await ctx.form(), "camera_live_url"));
  await requireRow(ctx.env, "devices", deviceId, "Device");
  await db.run(ctx.env, "UPDATE devices SET camera_live_url = ? WHERE id = ?", url, deviceId);
  await audit.log(ctx, "device_set_camera_url", "device", deviceId, { camera_live_url: url });
  return redirect("/devices");
}

export function register(router) {
  router.get("/devices", devicesPage);
  router.post("/devices", devicesCreate);
  router.post("/devices/:device_id/assign", devicesAssign);
  router.post("/devices/:device_id/group", devicesSetGroup);
  router.post("/devices/:device_id/regen-token", devicesRegenToken);
  router.post("/devices/:device_id/delete", devicesDelete);
  router.post("/devices/:device_id/command", devicesSendCommand);
  router.post("/devices/update-all", devicesUpdateAll);
  router.get("/devices/:device_id/screenshot", devicesScreenshot);
  router.get("/devices/:device_id/camera", devicesCamera);
  router.post("/devices/:device_id/camera-url", devicesSetCameraUrl);
}
