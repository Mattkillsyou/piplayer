// Port of web.playlists_* + playlists.html / playlist_edit.html.
import * as audit from "../audit.js";
import * as auth from "../auth.js";
import * as db from "../db.js";
import { esc, fail, idParam, intField, json, jsonObject, localTime, redirect, str } from "../util.js";
import { csrfInput, emptyState, layout } from "./layout.js";

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const round1 = (n) => Number(n).toFixed(1);

// Rewrite positions 0..n-1 in (position, id) order: one statement, run after a removal.
const RENUMBER_SQL = `UPDATE playlist_items
   SET position = (SELECT rn FROM (SELECT id, ROW_NUMBER() OVER (ORDER BY position, id) - 1 AS rn
                                     FROM playlist_items WHERE playlist_id = ?1) x
                    WHERE x.id = playlist_items.id)
 WHERE playlist_id = ?1`;
const TOUCH_SQL = "UPDATE playlists SET updated_at = datetime('now') WHERE id = ?";

async function playlistsPage(ctx) {
  const user = auth.requireUser(ctx);
  const canEdit = user.role !== "viewer";
  const tz = (await ctx.settings()).timezone;
  const rows = await db.all(ctx.env,
    `SELECT p.id, p.name, p.updated_at,
            (SELECT COUNT(*) FROM playlist_items pi WHERE pi.playlist_id = p.id) AS item_count,
            (SELECT COUNT(*) FROM devices d WHERE d.playlist_id = p.id) AS device_count,
            (SELECT COUNT(*) FROM device_groups g WHERE g.playlist_id = p.id) AS group_count,
            (SELECT COUNT(*) FROM device_schedules s WHERE s.playlist_id = p.id) AS schedule_count
       FROM playlists p ORDER BY p.name`);
  const rowHtml = (p) => {
    const parts = [];
    if (p.schedule_count) parts.push(`${p.schedule_count} schedule rule(s) will be deleted`);
    if (p.device_count) parts.push(`${p.device_count} device(s) will lose it as their default playlist`);
    if (p.group_count) parts.push(`${p.group_count} group(s) will lose it as their default playlist`);
    const confirm = `Delete playlist ${p.name}?` + (parts.length ? ` ${parts.join("; ")}.` : "");
    return `<tr>
      <td class="name"><a href="/playlists/${p.id}">${esc(p.name)}</a></td>
      <td>${p.item_count}</td>
      <td class="muted">
        <span title="devices with this as their default playlist">${plural(p.device_count, "device")}</span>
        ${p.group_count ? ` · ${plural(p.group_count, "group")}` : ""}
        ${p.schedule_count ? ` · ${plural(p.schedule_count, "schedule rule")}` : ""}
      </td>
      <td class="muted nowrap">${esc(localTime(p.updated_at, tz))}</td>
      <td>
        <div class="action-buttons">
          <a href="/playlists/${p.id}" class="button small">${canEdit ? "Edit" : "View"}</a>
          ${canEdit ? `<form method="post" action="/playlists/${p.id}/delete" class="inline" data-confirm="${esc(confirm)}">
            ${csrfInput(ctx)}
            <button type="submit" class="danger small">Delete</button>
          </form>` : ""}
        </div>
      </td>
    </tr>`;
  };
  const content = `<div class="page-head">
  <h1>Playlists</h1>
  ${canEdit ? `<form method="post" action="/playlists" class="head-actions">
    ${csrfInput(ctx)}
    <label>new playlist
      <input type="text" name="name" placeholder="e.g., Lobby Loop" required>
    </label>
    <button type="submit" class="primary">Create</button>
  </form>` : ""}
</div>

${!rows.length ? emptyState("NO PLAYLISTS", `No playlists yet.${canEdit ? " Create one above." : ""}`) : `<div class="table-wrap">
<table class="data">
  <caption class="sr-only">Playlists</caption>
  <thead>
    <tr><th scope="col">Name</th><th scope="col">Items</th><th scope="col">Used by</th><th scope="col">Updated</th><th scope="col"><span class="sr-only">Actions</span></th></tr>
  </thead>
  <tbody>
    ${rows.map(rowHtml).join("\n    ")}
  </tbody>
</table>
</div>`}`;
  return layout(ctx, { title: "Playlists", content });
}

async function playlistsCreate(ctx) {
  auth.requireRole(ctx, "editor");
  const name = str(await ctx.form(), "name").trim();
  if (!name) fail(400, "Name required");
  let pid;
  try {
    pid = (await db.run(ctx.env, "INSERT INTO playlists (name) VALUES (?)", name)).last_row_id;
  } catch (e) {
    if (db.isConstraintError(e)) fail(409, "A playlist with that name already exists");
    throw e;
  }
  await audit.log(ctx, "create_playlist", "playlist", pid, { name });
  return redirect(`/playlists/${pid}`);
}

async function playlistsEdit(ctx) {
  const user = auth.requireUser(ctx);
  const canEdit = user.role !== "viewer";
  const playlistId = idParam(ctx.params.playlist_id, "playlist_id");
  const playlist = await db.first(ctx.env, "SELECT id, name FROM playlists WHERE id = ?", playlistId);
  if (!playlist) fail(404, "Not Found");
  const items = await db.all(ctx.env,
    `SELECT pi.id, pi.position, pi.duration_override_seconds,
            m.id AS media_id, m.original_name, m.media_type,
            m.duration_seconds, m.filename
       FROM playlist_items pi
       JOIN media m ON m.id = pi.media_id
      WHERE pi.playlist_id = ?
      ORDER BY pi.position, pi.id`, playlistId);
  const available = await db.all(ctx.env,
    `SELECT m.id, m.original_name, m.media_type, m.duration_seconds
       FROM media m
      WHERE m.id NOT IN (SELECT media_id FROM playlist_items WHERE playlist_id = ?)
      ORDER BY m.original_name`, playlistId);
  // Python renders config.DEFAULT_IMAGE_DURATION (a float) with repr, so 10 shows as "10.0".
  const dur = (await ctx.settings()).default_image_duration;
  const defaultImageDuration = Number.isInteger(dur) ? dur.toFixed(1) : String(dur);

  const itemRow = (it, i) => `<tr data-item-id="${it.id}">
      <td class="drag-handle" title="Drag to reorder, or focus and press the up/down arrow keys">${canEdit ? `<span role="button" tabindex="0" aria-label="Move ${esc(it.original_name)}">⣿</span>` : ""}</td>
      <td class="position-cell">${i + 1}</td>
      <td>
        ${it.media_type === "video" ? '<span class="badge badge-video">VIDEO</span>' : '<span class="badge badge-image">IMAGE</span>'}
      </td>
      <td class="name">${esc(it.original_name)}</td>
      <td class="muted nowrap">${it.duration_seconds ? `${round1(it.duration_seconds)} s` : "—"}</td>
      <td>
        ${canEdit ? `<form method="post" action="/playlists/${playlist.id}/items/${it.id}/duration" class="inline duration-form">
          ${csrfInput(ctx)}
          <input type="number" name="duration" min="0.5" max="86400" step="0.5"
                 value="${esc(it.duration_override_seconds || "")}"
                 placeholder="${it.media_type === "image" ? esc(defaultImageDuration) : "auto"}"
                 aria-label="Duration override in seconds">
          <span class="unit">sec</span>
          <button type="submit" class="small">Set</button>
        </form>` : esc(it.duration_override_seconds || "—")}
      </td>
      <td>
        ${canEdit ? `<form method="post" action="/playlists/${playlist.id}/items/${it.id}/delete" class="inline" data-confirm="Remove ${esc(it.original_name)} from ${esc(playlist.name)}? Projectors playing it skip it from their next sync.">
          ${csrfInput(ctx)}
          <button type="submit" class="danger small">Remove</button>
        </form>` : ""}
      </td>
    </tr>`;
  const option = (m) => `<option value="${m.id}">
        [${esc(m.media_type.toUpperCase())}] ${esc(m.original_name)}${m.duration_seconds ? ` (${round1(m.duration_seconds)}s)` : ""}
      </option>`;

  const content = `<a href="/playlists" class="back">← All playlists</a>
<div class="page-head playlist-head">
  ${canEdit ? `<form method="post" action="/playlists/${playlist.id}/rename" class="row">
    ${csrfInput(ctx)}
    <label>playlist name
      <input type="text" name="name" value="${esc(playlist.name)}" required>
    </label>
    <button type="submit">Rename</button>
  </form>` : `<h1>${esc(playlist.name)}</h1>`}
  <span class="page-meta">${items.length} item${items.length === 1 ? "" : "s"}${canEdit ? " · drag rows to reorder" : ""}</span>
</div>

<h2>Playlist order (${items.length})</h2>
<p class="help small">Empty duration = play natural length for videos, ${esc(defaultImageDuration)}s default for images.</p>
${!items.length ? emptyState("EMPTY REEL", `Nothing queued.${canEdit ? " Add media below." : ""}`) : `<div class="table-wrap">
<table class="data sortable-table" id="playlist-items">
  <caption class="sr-only">Playlist items</caption>
  <thead>
    <tr><th scope="col"><span class="sr-only">Drag handle</span></th><th scope="col">#</th><th scope="col">Type</th><th scope="col">Name</th><th scope="col">Natural</th><th scope="col">Override</th><th scope="col"><span class="sr-only">Actions</span></th></tr>
  </thead>
  <tbody id="sortable-body" data-playlist-id="${playlist.id}"${canEdit ? "" : ' data-readonly="1"'}>
    ${items.map(itemRow).join("\n    ")}
  </tbody>
</table>
</div>`}

${canEdit ? `<h2>Add media</h2>
${!available.length
    ? `<p class="help small">All uploaded media is already in this playlist, or you haven't uploaded anything. <a href="/library">Go to Library</a>.</p>`
    : `<div class="table-foot">
  <form method="post" action="/playlists/${playlist.id}/items">
    ${csrfInput(ctx)}
    <select name="media_id" required aria-label="Media to add">
      <option value="">— pick media —</option>
      ${available.map(option).join("\n      ")}
    </select>
    <button type="submit" class="primary">Add</button>
  </form>
</div>`}
${items.length ? '<div class="drop-hint"><span>⣿</span><span class="sans">Drag a row by its handle and drop it where it should play. The new order is saved at once; devices pick it up on their next poll.</span></div>' : ""}` : ""}`;
  return layout(ctx, { title: playlist.name, content, scripts: ["/static/sortable.min.js"] });
}

async function playlistAddItem(ctx) {
  auth.requireRole(ctx, "editor");
  const playlistId = idParam(ctx.params.playlist_id, "playlist_id");
  const mid = intField(str(await ctx.form(), "media_id"), "media_id");
  if (mid === null) fail(400, "media_id required");
  const env = ctx.env;
  if (!(await db.first(env, "SELECT id FROM playlists WHERE id = ?", playlistId))) fail(404, "Playlist not found");
  if (!(await db.first(env, "SELECT id FROM media WHERE id = ?", mid))) fail(404, "Media not found");
  if (await db.first(env, "SELECT id FROM playlist_items WHERE playlist_id = ? AND media_id = ?", playlistId, mid)) {
    fail(409, "Already in playlist");
  }
  // No BEGIN IMMEDIATE on D1: the next position is computed inside the same batch as the
  // insert, and the HAVING re-checks the duplicate so two overlapping adds cannot both land.
  const results = await db.batch(env, [
    [`INSERT INTO playlist_items (playlist_id, media_id, position)
      SELECT ?1, ?2, COALESCE(MAX(position), -1) + 1 FROM playlist_items WHERE playlist_id = ?1
      HAVING NOT EXISTS (SELECT 1 FROM playlist_items WHERE playlist_id = ?1 AND media_id = ?2)`, playlistId, mid],
    [TOUCH_SQL, playlistId],
  ]);
  if (!results[0].meta.changes) fail(409, "Already in playlist");
  await audit.log(ctx, "playlist_add_item", "playlist", playlistId, { media_id: mid });
  return redirect(`/playlists/${playlistId}`);
}

async function playlistSetDuration(ctx) {
  auth.requireRole(ctx, "editor");
  const playlistId = idParam(ctx.params.playlist_id, "playlist_id");
  const itemId = idParam(ctx.params.item_id, "item_id");
  const raw = str(await ctx.form(), "duration").trim();
  let dur = null;
  if (raw) {
    // Python float() accepts 'inf'/'nan' and then the range check rejects them; here the
    // number regex rejects them up front, same 400 either way.
    if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(raw)) fail(400, "duration must be a positive number");
    dur = Number(raw);
    if (!Number.isFinite(dur) || dur <= 0 || dur > 86400) fail(400, "duration must be a positive number of seconds (at most 86400)");
  }
  const r = await db.run(ctx.env,
    "UPDATE playlist_items SET duration_override_seconds = ? WHERE id = ? AND playlist_id = ?", dur, itemId, playlistId);
  if (!r.changes) fail(404, "Playlist item not found");
  await db.run(ctx.env, TOUCH_SQL, playlistId);
  await audit.log(ctx, "playlist_set_duration", "playlist_item", itemId, { duration: dur });
  return redirect(`/playlists/${playlistId}`);
}

async function playlistReorder(ctx) {
  auth.requireRole(ctx, "editor");
  const playlistId = idParam(ctx.params.playlist_id, "playlist_id");
  const body = await jsonObject(ctx.request);
  const order = body.order;
  if (!Array.isArray(order)) fail(400, "body must be {order: [item_id, ...]}");
  // JSON integers only, like the Python CMS: strings such as "1" are rejected.
  const ids = order.map((x) => (Number.isInteger(x) ? x : NaN));
  if (ids.some((x) => Number.isNaN(x))) fail(400, "order must be a list of integers");
  const env = ctx.env;
  if (!(await db.first(env, "SELECT id FROM playlists WHERE id = ?", playlistId))) fail(404, "Playlist not found");
  const existing = new Set((await db.all(env, "SELECT id FROM playlist_items WHERE playlist_id = ?", playlistId)).map((r) => r.id));
  const given = new Set(ids);
  if (given.size !== existing.size || ids.length !== existing.size || [...given].some((x) => !existing.has(x))) {
    fail(400, "order must contain exactly the current items of this playlist");
  }
  await db.batch(env, [
    ...ids.map((itemId) => ["UPDATE playlist_items SET position = position + 10000 WHERE id = ? AND playlist_id = ?", itemId, playlistId]),
    ...ids.map((itemId, pos) => ["UPDATE playlist_items SET position = ? WHERE id = ? AND playlist_id = ?", pos, itemId, playlistId]),
    [TOUCH_SQL, playlistId],
  ]);
  await audit.log(ctx, "playlist_reorder", "playlist", playlistId, { order: ids });
  return json({ ok: true });
}

async function playlistRemoveItem(ctx) {
  auth.requireRole(ctx, "editor");
  const playlistId = idParam(ctx.params.playlist_id, "playlist_id");
  const itemId = idParam(ctx.params.item_id, "item_id");
  const env = ctx.env;
  if (!(await db.first(env, "SELECT id FROM playlist_items WHERE id = ? AND playlist_id = ?", itemId, playlistId))) {
    fail(404, "Playlist item not found");
  }
  await db.batch(env, [
    ["DELETE FROM playlist_items WHERE id = ? AND playlist_id = ?", itemId, playlistId],
    [RENUMBER_SQL, playlistId],
    [TOUCH_SQL, playlistId],
  ]);
  await audit.log(ctx, "playlist_remove_item", "playlist_item", itemId);
  return redirect(`/playlists/${playlistId}`);
}

async function playlistRename(ctx) {
  auth.requireRole(ctx, "editor");
  const playlistId = idParam(ctx.params.playlist_id, "playlist_id");
  const name = str(await ctx.form(), "name").trim();
  if (!name) fail(400, "Name required");
  let r;
  try {
    r = await db.run(ctx.env, "UPDATE playlists SET name = ?, updated_at = datetime('now') WHERE id = ?", name, playlistId);
  } catch (e) {
    if (db.isConstraintError(e)) fail(409, "A playlist with that name already exists");
    throw e;
  }
  if (!r.changes) fail(404, "Playlist not found");
  await audit.log(ctx, "playlist_rename", "playlist", playlistId, { name });
  return redirect(`/playlists/${playlistId}`);
}

async function playlistDelete(ctx) {
  auth.requireRole(ctx, "editor");
  const playlistId = idParam(ctx.params.playlist_id, "playlist_id");
  const env = ctx.env;
  const row = await db.first(env, "SELECT name FROM playlists WHERE id = ?", playlistId);
  if (!row) fail(404, "Playlist not found");
  // Record what the cascade is about to remove so the audit trail explains it.
  const rules = await db.all(env, "SELECT id, device_id, name FROM device_schedules WHERE playlist_id = ?", playlistId);
  const devices = (await db.all(env, "SELECT id FROM devices WHERE playlist_id = ?", playlistId)).map((r) => r.id);
  const groups = (await db.all(env, "SELECT id FROM device_groups WHERE playlist_id = ?", playlistId)).map((r) => r.id);
  await db.run(env, "DELETE FROM playlists WHERE id = ?", playlistId);
  for (const rule of rules) {
    await audit.log(ctx, "device_schedule_delete", "device_schedule", rule.id,
      { device_id: rule.device_id, name: rule.name, cascade_from_playlist: playlistId });
  }
  await audit.log(ctx, "playlist_delete", "playlist", playlistId,
    { name: row.name, schedules_deleted: rules.length, devices_cleared: devices, groups_cleared: groups });
  return redirect("/playlists");
}

export function register(router) {
  router.get("/playlists", playlistsPage);
  router.post("/playlists", playlistsCreate);
  router.get("/playlists/:playlist_id", playlistsEdit);
  router.post("/playlists/:playlist_id/items", playlistAddItem);
  router.post("/playlists/:playlist_id/items/reorder", playlistReorder);
  router.post("/playlists/:playlist_id/items/:item_id/duration", playlistSetDuration);
  router.post("/playlists/:playlist_id/items/:item_id/delete", playlistRemoveItem);
  router.post("/playlists/:playlist_id/rename", playlistRename);
  router.post("/playlists/:playlist_id/delete", playlistDelete);
}
