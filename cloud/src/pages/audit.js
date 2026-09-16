// Port of web.audit_page + audit.html: newest first (created_at DESC, id DESC), ?limit= 1..1000.
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

async function auditPage(ctx) {
  auth.requireUser(ctx);
  const limit = limitParam(ctx.url);
  const tz = (await ctx.settings()).timezone;
  const entries = await db.all(ctx.env,
    `SELECT id, user_id, username, action, target_type, target_id, details, ip, created_at
       FROM audit_log ORDER BY created_at DESC, id DESC LIMIT ?`, limit);
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
    <h2>tail -n ${limit} audit.log</h2>
    <span class="meta">newest first · <a href="/audit?limit=1000">show 1000</a></span>
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
