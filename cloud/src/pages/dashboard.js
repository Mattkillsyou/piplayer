// Port of web.dashboard + dashboard.html: stat tiles, the monitor wall and the audit tail.
import * as auth from "../auth.js";
import * as db from "../db.js";
import { esc, localTime, nowUtc, zoneName } from "../util.js";
import { cameraScreen, decorateDevices, deviceScreen, isFault, statusLamp, updateStatus } from "./devices.js";
import { csrfInput, emptyState, layout } from "./layout.js";

const DASHBOARD_AUDIT_TAIL = 8;

function deviceCard(ctx, d, tz, canEdit) {
  return `<div class="device-card${isFault(d) ? " is-fault" : ""}">
    ${deviceScreen(d, { now: true, tz, staleTitle: "No new screenshot for more than 3 capture intervals: the player may be idle, black or down" })}
    ${cameraScreen(d, { tz, staleTitle: "No new camera snapshot for more than 3 camera intervals: the camera or the Pi may be down" })}
    <div class="device-card-body">
      <div class="device-card-head">
        <div>
          <div class="device-card-title">${esc(d.name)}</div>
          <div class="device-card-id"><code>${esc(d.device_id)}</code>${d.group_name ? ` · ${esc(d.group_name)}` : ""}</div>
        </div>
        ${statusLamp(d)}
      </div>
      <div class="now-block${d.active_playlist_name ? "" : " none"}">
        ${d.active_playlist_name
    ? `<span class="now-playlist">${esc(d.active_playlist_name)}</span>
          <span class="now-via">via ${esc(d.active_source)}</span>`
    : '<span class="now-playlist">no playlist</span>'}
      </div>
      <span class="device-meta">last seen ${d.last_seen_at ? `${esc(d.seen_age)} · ${esc(localTime(d.last_seen_at, tz))}` : "never"}</span>
      ${d.last_error ? `<div class="alert error small" title="Reported by the player on its last sync">Sync problem: ${esc(d.last_error)}</div>` : ""}
      ${updateStatus(d, tz)}
      ${canEdit ? `<div class="tile-actions">
        <form method="post" action="/devices/${d.id}/command" class="inline">
          ${csrfInput(ctx)}
          <input type="hidden" name="command" value="force-sync">
          <button type="submit" class="small">Resync</button>
        </form>
        <form method="post" action="/devices/${d.id}/command" class="inline" data-confirm="Reboot ${esc(d.name)}?">
          ${csrfInput(ctx)}
          <input type="hidden" name="command" value="reboot">
          <button type="submit" class="small danger">Reboot</button>
        </form>
      </div>` : ""}
    </div>
  </div>`;
}

function auditLine(e, tz) {
  return `<li><span class="log-t">${esc(localTime(e.created_at, tz).slice(0, 16))}</span> <span class="log-u">${esc(e.username || "system")}</span> <span class="log-a">${esc(e.action)}</span>${e.target_type ? ` <span class="log-tg">${esc(e.target_type)} ${esc(e.target_id ?? "")}</span>` : ""} <span class="log-ip">${esc(e.ip || "")}</span></li>`;
}

async function dashboard(ctx) {
  const user = auth.requireUser(ctx);
  const canEdit = user.role !== "viewer";
  const env = ctx.env;
  const settings = await ctx.settings();
  const tz = settings.timezone;
  const media = await db.first(env, "SELECT COUNT(*) AS n, COALESCE(SUM(size_bytes), 0) AS bytes FROM media");
  const playlistCount = (await db.first(env, "SELECT COUNT(*) AS n FROM playlists")).n;
  const rows = await db.all(env,
    `SELECT d.id, d.device_id, d.name, d.last_seen_at, d.last_ip, d.playlist_id, d.group_id,
            d.current_position, d.current_filename, d.player_status,
            d.last_screenshot_at, d.last_error, d.last_camera_at, d.camera_error,
            d.last_update_at, d.last_update_ok, d.last_update_message, d.last_update_ref,
            p.name AS playlist_name, g.name AS group_name
       FROM devices d
       LEFT JOIN playlists p ON p.id = d.playlist_id
       LEFT JOIN device_groups g ON g.id = d.group_id
       ORDER BY d.name`);
  const devices = await decorateDevices(env, rows, settings);
  const auditTail = await db.all(env,
    `SELECT username, action, target_type, target_id, ip, created_at
       FROM audit_log ORDER BY created_at DESC, id DESC LIMIT ?`, DASHBOARD_AUDIT_TAIL);
  const faultCount = devices.filter(isFault).length;
  const playingCount = devices.filter((d) => d.lamp === "playing").length;
  const n = devices.length;

  const content = `<div class="page-head">
  <h1>Dashboard</h1>
  <span class="page-meta">server ${esc(localTime(nowUtc(), tz))} · ${esc(zoneName(tz))}</span>
</div>

<div class="cards">
  <div class="card">
    <span class="card-label">media on disk</span>
    <span class="card-value">${media.n}</span>
    <span class="card-sub">${(media.bytes / 1024 / 1024).toFixed(1)} MB on disk</span>
  </div>
  <div class="card">
    <span class="card-label">playlists</span>
    <span class="card-value">${playlistCount}</span>
    <span class="card-sub">assign on the Devices page</span>
  </div>
  <div class="card">
    <span class="card-label">devices</span>
    <span class="card-value">${n}</span>
    <span class="card-sub">${playingCount} playing · ${faultCount} fault${faultCount === 1 ? "" : "s"}</span>
  </div>
</div>

<div class="section-head">
  <h2>Monitor wall · ${n} device${n === 1 ? "" : "s"}</h2>
  ${n ? `<div class="filters" id="wall-filters">
    <button type="button" class="small" data-filter="all" aria-pressed="true">All</button>
    <button type="button" class="small" data-filter="faults" aria-pressed="false">Faults (${faultCount})</button>
  </div>` : ""}
</div>
${!n
    ? emptyState("NO SIGNAL", "No devices yet. Register one to start the wall.", '<a href="/devices" class="button small">Register a device</a>')
    : `<div class="device-grid" id="monitor-wall">
  ${devices.map((d) => deviceCard(ctx, d, tz, canEdit)).join("\n  ")}
</div>`}

<div class="audit-tail">
  <div class="audit-tail-head">
    <h2>Audit tail · <a href="/audit">full log</a></h2>
    <span class="cursor-blink" aria-hidden="true"></span>
  </div>
  <ul class="log-lines">
    ${auditTail.length ? auditTail.map((e) => auditLine(e, tz)).join("\n    ") : '<li class="empty-line">no activity yet</li>'}
  </ul>
</div>`;
  return layout(ctx, { title: "Dashboard", content });
}

export function register(router) {
  router.get("/dashboard", dashboard);
}
