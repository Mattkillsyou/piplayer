// Port of web.dashboard + dashboard.html: the three cards and the device grid.
import * as auth from "../auth.js";
import * as db from "../db.js";
import { esc, localTime } from "../util.js";
import { decorateDevices, lampState, screenHtml } from "./devices.js";
import { layout } from "./layout.js";

function deviceCard(d, tz) {
  const state = lampState(d);
  return `<div class="device-card">
    ${screenHtml(d, tz, { staleTitle: "No new screenshot for more than 3 capture intervals: the player may be idle, black or down" })}
    <div class="device-card-body">
      <div class="device-card-head">
        <div>
          <div class="device-card-title">${esc(d.name)}</div>
          <div class="muted small"><code>${esc(d.device_id)}</code>${d.group_name ? ` · ${esc(d.group_name)}` : ""}</div>
        </div>
        <span class="lamp lamp-${esc(state)}">${esc(state)}</span>
      </div>
      <div class="active-strip${d.active_playlist_name ? "" : " empty-strip"}">
        ${d.active_playlist_name ? `${esc(d.active_playlist_name)} <span class="source">via ${esc(d.active_source)}</span>` : "no playlist"}
      </div>
      ${d.last_error ? `<div class="alert warn small" title="Reported by the player on its last sync">Sync problem: ${esc(d.last_error)}</div>` : ""}
    </div>
    <div class="device-card-foot">
      <code>${esc(d.device_id)}</code>
      <span${d.last_seen_at ? ` title="${esc(localTime(d.last_seen_at, tz))}"` : ""}>last seen ${d.last_seen_at ? esc(d.seen_age) : "never"}</span>
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

<h2>Monitor wall · ${devices.length} device${devices.length === 1 ? "" : "s"}</h2>
${!devices.length
    ? '<p class="muted empty">No devices yet. <a href="/devices">Register one</a> to get started.</p>'
    : `<div class="device-grid">
  ${devices.map((d) => deviceCard(d, settings.timezone)).join("\n  ")}
</div>`}`;
  return layout(ctx, { title: "Dashboard", content });
}

export function register(router) {
  router.get("/dashboard", dashboard);
}
