// Port of web.audit_page + audit.html: newest first (created_at DESC, id DESC), ?limit= 1..1000,
// plus ?action= (one action name) and ?before= (an id cursor for the "older" link) so a human
// row stays reachable once the machine rows (device_update_reported, login_failed) outnumber
// the tail.
import * as auth from "../auth.js";
import * as db from "../db.js";
import { esc, fail, localTime, zoneName } from "../util.js";
import { layout } from "./layout.js";

const DEFAULT_LIMIT = 200;

// FastAPI's Query(200, ge=1, le=1000) -> 422 there; a 400 {detail} here (contract 10).
function limitParam(url) {
  const raw = url.searchParams.get("limit");
  if (raw === null || raw === "") return DEFAULT_LIMIT;
  if (!/^\d+$/.test(raw.trim())) fail(400, "limit must be an integer");
  const n = parseInt(raw, 10);
  if (n < 1 || n > 1000) fail(400, "limit must be between 1 and 1000");
  return n;
}

// Optional filter and cursor. `id < ?` is a valid cursor because audit.log never sets created_at
// itself, so ids and created_at rise together.
function filterParams(url) {
  const before = url.searchParams.get("before") || "";
  if (before && !/^\d+$/.test(before)) fail(400, "before must be an integer");
  const action = url.searchParams.get("action") || "";
  if (action && !/^[a-z_]{1,64}$/.test(action)) fail(400, "unknown action");
  return { before, action };
}

async function auditPage(ctx) {
  auth.requireUser(ctx);
  const limit = limitParam(ctx.url);
  const { before, action } = filterParams(ctx.url);
  const tz = (await ctx.settings()).timezone;
  const where = [], params = [];
  if (before) { where.push("id < ?"); params.push(parseInt(before, 10)); }
  if (action) { where.push("action = ?"); params.push(action); }
  const entries = await db.all(ctx.env,
    `SELECT id, user_id, username, action, target_type, target_id, details, ip, created_at
       FROM audit_log ${where.length ? "WHERE " + where.join(" AND ") : ""}
       ORDER BY created_at DESC, id DESC LIMIT ?`, ...params, limit);
  const actions = await db.all(ctx.env, "SELECT DISTINCT action FROM audit_log ORDER BY action");
  const query = `limit=${limit}${action ? "&action=" + encodeURIComponent(action) : ""}`;
  const older = entries.length === limit
    ? ` · <a href="/audit?${query}&before=${entries[entries.length - 1].id}">older</a>` : "";
  const row = (e) => `<tr>
      <td class="nowrap log-t"><code>${esc(localTime(e.created_at, tz))}</code></td>
      <td class="log-u">${esc(e.username || "—")}</td>
      <td class="log-a"><code>${esc(e.action)}</code></td>
      <td class="nowrap">${e.target_type ? `<span class="muted small">${esc(e.target_type)}</span> ${esc(e.target_id ?? "")}` : "—"}</td>
      <td class="log-d"><span class="muted small mono">${esc(e.details || "")}</span></td>
      <td class="muted nowrap">${esc(e.ip || "—")}</td>
    </tr>`;
  const content = `<div class="page-head">
  <h1>Audit log</h1>
  <span class="page-meta">last ${entries.length} entr${entries.length === 1 ? "y" : "ies"} · times in ${esc(zoneName(tz))} (database stores UTC)</span>
</div>

<div class="terminal">
  <div class="terminal-head">
    <h2>tail -n ${limit} audit.log${action ? ` | grep ${esc(action)}` : ""}</h2>
    <form method="get" action="/audit" class="row tight">
      <input type="hidden" name="limit" value="${limit}">
      <select name="action" data-autosubmit aria-label="Show only one kind of action">
        <option value="">all actions</option>
        ${actions.map((a) => `<option value="${esc(a.action)}"${a.action === action ? " selected" : ""}>${esc(a.action)}</option>`).join("\n        ")}
      </select>
      <button type="submit" class="small">Filter</button>
    </form>
    <span class="meta">newest first${before ? ` · <a href="/audit?${query}">newest</a>` : ""}${older}</span>
  </div>
  ${!entries.length ? '<div class="terminal-foot">no entries yet <span class="cursor-blink" aria-hidden="true"></span></div>' : `<div class="table-wrap">
  <table class="data">
    <thead>
      <tr><th>When</th><th>User</th><th>Action</th><th>Target</th><th>Details</th><th>IP</th></tr>
    </thead>
    <tbody>
      ${entries.map(row).join("\n      ")}
    </tbody>
  </table>
  </div>
  <div class="terminal-foot">end of tail <span class="cursor-blink" aria-hidden="true"></span></div>`}
</div>`;
  return layout(ctx, { title: "Audit log", content });
}

export function register(router) {
  router.get("/audit", auditPage);
}
