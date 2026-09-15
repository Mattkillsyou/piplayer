// Port of web.dashboard + dashboard.html: the three cards and the device grid.
import * as auth from "../auth.js";
import * as db from "../db.js";
import { esc, localTime } from "../util.js";
import { decorateDevices } from "./devices.js";
import { layout } from "./layout.js";

function deviceCard(d, tz) {
  const thumb = d.last_screenshot_at
    ? `<img src="/devices/${d.id}/screenshot?t=${esc(encodeURIComponent(d.last_screenshot_at))}" class="device-thumb${d.screenshot_stale ? " device-thumb-stale" : ""}" alt="screenshot">
      <div class="muted small screenshot-age">
        screenshot ${esc(d.screenshot_age)} (${esc(localTime(d.last_screenshot_at, tz))})
        ${d.screenshot_stale ? '<span class="badge badge-stale" title="No new screenshot for more than 3 capture intervals: the player may be idle, black or down">stale</span>' : ""}
      </div>`
    : '<div class="device-thumb device-thumb-empty">no screenshot yet</div>';
  return `<div class="device-card">
    ${thumb}
    <div class="device-card-body">
      <div class="device-card-title">${esc(d.name)}</div>
      <div class="muted small"><code>${esc(d.device_id)}</code>${d.group_name ? ` · group: ${esc(d.group_name)}` : ""}</div>
      <div class="small">
        <strong>Active:</strong>
        ${d.active_playlist_name ? `${esc(d.active_playlist_name)} <span class="muted">(${esc(d.active_source)})</span>` : "—"}<br>
        <strong>Now playing:</strong>
        ${d.current_filename ? `#${(d.current_position || 0) + 1}: ${esc(d.current_filename)}` : "—"}
        <br>
        <strong>Status:</strong> ${esc(d.player_status || "—")} · last seen
        ${d.last_seen_at ? `${esc(d.seen_age)} (${esc(localTime(d.last_seen_at, tz))})` : "never"}
      </div>
      ${d.last_error ? `<div class="alert warn small" title="Reported by the player on its last sync">Sync problem: ${esc(d.last_error)}</div>` : ""}
    </div>
  </div>`;
}

async function dashboard(ctx) {
  auth.requireUser(ctx);
  const env = ctx.env;
  const settings = await ctx.settings();
  const media = await db.first(env, "SELECT COUNT(*) AS n, COALESCE(SUM(size_bytes), 0) AS bytes FROM media");
  const playlistCount = (await db.first(env, "SELECT COUNT(*) AS n FROM playlists")).n;
  const rows = await db.all(env,
    `SELECT d.id, d.device_id, d.name, d.last_seen_at, d.last_ip, d.playlist_id, d.group_id,
            d.current_position, d.current_filename, d.player_status,
            d.last_screenshot_at, d.last_error,
            p.name AS playlist_name, g.name AS group_name
       FROM devices d
       LEFT JOIN playlists p ON p.id = d.playlist_id
       LEFT JOIN device_groups g ON g.id = d.group_id
       ORDER BY d.name`);
  const devices = await decorateDevices(env, rows, settings);

  const content = `<h1>Dashboard</h1>

<div class="cards">
  <div class="card">
    <div class="card-label">Media</div>
    <div class="card-value">${media.n}</div>
    <div class="card-sub">${(media.bytes / 1024 / 1024).toFixed(1)} MB on disk</div>
  </div>
  <div class="card">
    <div class="card-label">Playlists</div>
    <div class="card-value">${playlistCount}</div>
  </div>
  <div class="card">
    <div class="card-label">Devices</div>
    <div class="card-value">${devices.length}</div>
  </div>
</div>

<h2>Devices</h2>
${!devices.length
    ? '<p class="muted">No devices yet. <a href="/devices">Register one</a> to get started.</p>'
    : `<div class="device-grid">
  ${devices.map((d) => deviceCard(d, settings.timezone)).join("\n  ")}
</div>`}`;
  return layout(ctx, { title: "Dashboard", content });
}

export function register(router) {
  router.get("/dashboard", dashboard);
}
