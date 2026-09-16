// /alerts (any role, read-only): the open alerts (alerts.evaluate, the */5 cron) and the most
// recently closed ones, with the device, kind, when it opened / closed and the last notification.
import * as alerts from "../alerts.js";
import * as auth from "../auth.js";
import * as db from "../db.js";
import { ageSeconds, ageText, esc, localTime } from "../util.js";
import { emptyState, layout } from "./layout.js";

const RECENT_LIMIT = 100;

function table(rows, tz, closed) {
  return `<div class="table-wrap">
  <table class="data">
    <thead><tr><th>Device</th><th>Alert</th><th>Opened</th><th>${closed ? "Closed" : "Open for"}</th><th>Last notified</th></tr></thead>
    <tbody>
    ${rows.map((a) => `<tr>
      <td class="name">${esc(a.name)} <code class="muted small">${esc(a.device_id)}</code></td>
      <td>${alerts.kindBadge(a.kind)}</td>
      <td class="muted nowrap">${esc(localTime(a.opened_at, tz))}</td>
      <td class="muted nowrap">${closed ? esc(localTime(a.closed_at, tz)) : esc(ageText(ageSeconds(a.opened_at)).replace(/ ago$/, ""))}</td>
      <td class="muted nowrap">${a.notified_at ? esc(localTime(a.notified_at, tz)) : "never"}</td>
    </tr>`).join("\n    ")}
    </tbody>
  </table>
  </div>`;
}

async function alertsPage(ctx) {
  const user = auth.requireUser(ctx);
  const tz = (await ctx.settings()).timezone;
  const select = `SELECT a.id, a.kind, a.opened_at, a.closed_at, a.notified_at, d.name, d.device_id
       FROM alerts a JOIN devices d ON d.id = a.device_id`;
  const open = await db.all(ctx.env, `${select} WHERE a.closed_at IS NULL ORDER BY a.opened_at DESC, a.id DESC`);
  const recent = await db.all(ctx.env, `${select} WHERE a.closed_at IS NOT NULL ORDER BY a.closed_at DESC, a.id DESC LIMIT ?`, RECENT_LIMIT);
  const content = `<div class="page-head">
  <h1>Alerts</h1>
  <span class="page-meta"><strong>${open.length} open</strong><br>checked every 5 minutes${user.role === "admin" ? ' · channels on the <a href="/settings">Settings</a> page' : ""}</span>
</div>

<div class="panel">
  <h2>Open · ${open.length}</h2>
  ${open.length ? table(open, tz, false) : emptyState("ALL CLEAR", "No open alerts. A device that goes offline, loses its player, stops sending screenshots or reports an error shows up here within 5 minutes.")}
</div>

<div class="panel">
  <h2>Recently recovered · ${recent.length}</h2>
  ${recent.length ? table(recent, tz, true) : '<p class="muted small">Nothing recovered yet.</p>'}
</div>`;
  return layout(ctx, { title: "Alerts", content });
}

export function register(router) {
  router.get("/alerts", alertsPage);
}
