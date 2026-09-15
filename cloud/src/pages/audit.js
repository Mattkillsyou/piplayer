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
      <td class="nowrap"><code>${esc(localTime(e.created_at, tz))}</code></td>
      <td>${esc(e.username || "—")}</td>
      <td><code>${esc(e.action)}</code></td>
      <td>${e.target_type ? `<span class="muted small">${esc(e.target_type)}</span> ${esc(e.target_id)}` : "—"}</td>
      <td><span class="muted small mono">${esc(e.details || "")}</span></td>
      <td><span class="muted small">${esc(e.ip || "—")}</span></td>
    </tr>`;
  const content = `<h1>Audit log</h1>
<p class="muted small">Last ${entries.length} entries. Times are shown in the site's zone (${esc(zoneName(tz))}); the database stores UTC.</p>

${!entries.length ? '<p class="muted">No entries yet.</p>' : `<table class="data">
  <thead>
    <tr><th>When</th><th>User</th><th>Action</th><th>Target</th><th>Details</th><th>IP</th></tr>
  </thead>
  <tbody>
    ${entries.map(row).join("\n    ")}
  </tbody>
</table>`}`;
  return layout(ctx, { title: "Audit log", content });
}

export function register(router) {
  router.get("/audit", auditPage);
}
