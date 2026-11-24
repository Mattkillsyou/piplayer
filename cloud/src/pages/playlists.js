// Port of web.playlists_* + playlists.html / playlist_edit.html. Each account has its own
// playlists (playlists.owner_id, migration 0016; names unique per account) holding its own files
// only: every route answers another account's playlist, item or file id exactly like a missing one.
import * as accounts from "../accounts.js";
import * as audit from "../audit.js";
import * as auth from "../auth.js";
import * as db from "../db.js";
import { playSeconds } from "../manifest.js";
import { esc, fail, fileSize, floatField, idParam, intField, json, jsonObject, localTime, redirect, runTime, str } from "../util.js";
import { csrfInput, emptyState, layout } from "./layout.js";
import { appendToPlaylist, MAX_DELETE, RENUMBER_SQL, thumbCell } from "./library.js";

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

const TOUCH_SQL = "UPDATE playlists SET updated_at = datetime('now') WHERE id = ?";

// The caller's own playlist row (`cols`) or the 404 a missing id gets.
async function ownPlaylist(ctx, playlistId, cols = "id") {
  const row = await accounts.ownRow(ctx.env, "playlists", playlistId, ctx.user.id, cols);
  if (!row) fail(404, "Playlist not found");
  return row;
}

// A duration box: '' is null (back to the default), else 0.5 to 86400 seconds or 400. Python's
// float() took 'inf' / 'nan' and the range check refused them; floatField refuses them up front.
function parseDuration(raw) {
  const msg = "Duration must be a number of seconds between 0.5 and 86400";
  const dur = floatField(raw, "Duration", msg);
  if (dur !== null && (dur < 0.5 || dur > 86400)) fail(400, msg);
  return dur;
}

// One pass of `items` as the player runs it: "1:05", "at least 1:05" when an item's length is
// unknown (a video the uploader's browser could not measure), "" when nothing is known.
function totalTime(items, defaultImageDuration) {
  let known = 0;
  let unknown = false;
  for (const it of items) {
    const s = playSeconds(it, defaultImageDuration);
    if (s === null) unknown = true; else known += s;
  }
  const t = runTime(known);
  return t && unknown ? `at least ${t}` : t;
}

async function playlistsPage(ctx) {
  const user = auth.requireUser(ctx);
  const canEdit = user.role !== "viewer";
  const { timezone: tz, default_playlist_id: defaultId, default_image_duration: dur } = await ctx.settings();
  // The account's own playlists; "used by" counts the projectors, groups and schedule rules that
  // play them, which are all the account's own (only its projectors may point at its playlists).
  // The Default also counts the projectors it is the fallback of: no playlist of their own and none
  // from their group, by the manifest's rules (manifest.pick_playlist; another account's reads as none).
  const co = accounts.contentOwnerSql("d");
  const rows = await db.all(ctx.env,
    `SELECT p.id, p.name, p.updated_at,
            (SELECT COUNT(*) FROM playlist_items pi WHERE pi.playlist_id = p.id) AS item_count,
            (SELECT COUNT(*) FROM devices d WHERE d.playlist_id = p.id AND ${co} = ?1) AS device_count,
            (SELECT COUNT(*) FROM device_groups g WHERE g.playlist_id = p.id AND g.owner_id = ?1) AS group_count,
            (SELECT COUNT(*) FROM device_schedules s JOIN devices d ON d.id = s.device_id WHERE s.playlist_id = p.id AND ${co} = ?1) AS schedule_count,
            CASE WHEN p.id = ?2 THEN (SELECT COUNT(*) FROM devices d WHERE ${co} = ?1
              AND NOT EXISTS (SELECT 1 FROM playlists x WHERE x.id = d.playlist_id AND x.owner_id = ?1)
              AND NOT EXISTS (SELECT 1 FROM device_groups g JOIN playlists x ON x.id = g.playlist_id AND x.owner_id = ?1
                               WHERE g.id = d.group_id AND g.owner_id = ?1)) ELSE 0 END AS fallback_count
       FROM playlists p WHERE p.owner_id = ?1 ORDER BY p.name`, user.id, defaultId ?? null);
  // Every item of those playlists, for each one's running time.
  const itemsOf = new Map();
  for (const it of await db.all(ctx.env,
    `SELECT pi.playlist_id, pi.duration_override_seconds, m.media_type, m.duration_seconds, m.filename
       FROM playlist_items pi JOIN media m ON m.id = pi.media_id JOIN playlists p ON p.id = pi.playlist_id
      WHERE p.owner_id = ?`, user.id)) {
    if (!itemsOf.has(it.playlist_id)) itemsOf.set(it.playlist_id, []);
    itemsOf.get(it.playlist_id).push(it);
  }
  const rowHtml = (p) => {
    const parts = [];
    if (p.schedule_count) parts.push(`${p.schedule_count} schedule rule(s) will be deleted`);
    if (p.device_count) parts.push(`${p.device_count} device(s) will lose it as their default playlist`);
    if (p.group_count) parts.push(`${p.group_count} group(s) will lose it as their default playlist`);
    const confirm = `Delete playlist ${p.name}?` + (parts.length ? ` ${parts.join("; ")}.` : "");
    return `<tr>
      <td class="name"><a href="/playlists/${p.id}">${esc(p.name)}</a>${p.id === defaultId ? ' <span class="badge" title="Library uploads join this playlist unless another is picked; projectors with no playlist of their own play it">default</span>' : ""}</td>
      <td data-label="Items">${p.item_count}</td>
      <td data-label="Duration" class="nowrap">${totalTime(itemsOf.get(p.id) || [], dur) || "—"}</td>
      <td data-label="Used by" class="muted">
        ${p.device_count || !p.fallback_count ? `<span title="devices with this as their default playlist">${plural(p.device_count, "device")}</span>` : ""}
        ${p.fallback_count ? `${p.device_count ? " · " : ""}<span title="devices with no playlist of their own or from their group">${plural(p.fallback_count, "device")} (fallback)</span>` : ""}
        ${p.group_count ? ` · ${plural(p.group_count, "group")}` : ""}
        ${p.schedule_count ? ` · ${plural(p.schedule_count, "schedule rule")}` : ""}
      </td>
      <td data-label="Updated" class="muted nowrap">${esc(localTime(p.updated_at, tz))}</td>
      <td>
        <div class="action-buttons">
          <a href="/playlists/${p.id}" class="button small">${canEdit ? "Edit" : "View"}</a>
          ${canEdit && p.id !== defaultId ? `<form method="post" action="/playlists/${p.id}/delete" class="inline" data-confirm="${esc(confirm)}">
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
<table class="data stack">
  <caption class="sr-only">Playlists</caption>
  <thead>
    <tr><th scope="col">Name</th><th scope="col">Items</th><th scope="col">Duration</th><th scope="col">Used by</th><th scope="col">Updated</th><th scope="col"><span class="sr-only">Actions</span></th></tr>
  </thead>
  <tbody>
    ${rows.map(rowHtml).join("\n    ")}
  </tbody>
</table>
</div>`}`;
  return layout(ctx, { title: "Playlists", content });
}

// Names are unique within the account (idx_playlists_owner_name): another account's playlist of
// the same name is no conflict, and the 409 can only ever be about one's own.
async function playlistsCreate(ctx) {
  const user = auth.requireRole(ctx, "editor");
  const name = str(await ctx.form(), "name").trim();
  if (!name) fail(400, "Enter a name");
  let pid;
  try {
    pid = (await db.run(ctx.env, "INSERT INTO playlists (owner_id, name, legacy_name) VALUES (?, ?, ?)", user.id, name, accounts.uniqueKey())).last_row_id;
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
  const playlist = await accounts.ownRow(ctx.env, "playlists", playlistId, user.id, "id, name");
  if (!playlist) fail(404, "Not Found");
  const items = await db.all(ctx.env,
    `SELECT pi.id, pi.position, pi.duration_override_seconds,
            m.id AS media_id, m.original_name, m.media_type,
            m.duration_seconds, m.filename, m.size_bytes, m.width, m.height
       FROM playlist_items pi
       JOIN media m ON m.id = pi.media_id
      WHERE pi.playlist_id = ?
      ORDER BY pi.position, pi.id`, playlistId);
  const available = await db.all(ctx.env,
    `SELECT m.id, m.original_name, m.media_type, m.duration_seconds
       FROM media m
      WHERE m.owner_id = ? AND m.id NOT IN (SELECT media_id FROM playlist_items WHERE playlist_id = ?)
      ORDER BY m.original_name`, user.id, playlistId);
  // Python renders config.DEFAULT_IMAGE_DURATION (a float) with repr, so 10 shows as "10.0".
  const dur = (await ctx.settings()).default_image_duration;
  const defaultImageDuration = Number.isInteger(dur) ? dur.toFixed(1) : String(dur);
  const time = totalTime(items, dur);

  // id="item-N": a row's Set comes back to that row (playlistSetDuration).
  const itemRow = (it, i) => `<tr id="item-${it.id}" data-item-id="${it.id}">
      <td class="drag-handle" title="Drag to reorder, or focus and press the up/down arrow keys">${canEdit ? `<span role="button" tabindex="0" aria-label="Move ${esc(it.original_name)}">⣿</span>` : ""}</td>
      <td class="position-cell">${i + 1}</td>
      <td class="thumb-cell">${thumbCell({ ...it, id: it.media_id },
        [fileSize(it.size_bytes), it.width ? `${it.width}×${it.height}` : "", it.media_type === "video" ? runTime(it.duration_seconds) : ""].filter(Boolean).join(" · "))}</td>
      <td class="name">${esc(it.original_name)}</td>
      <td class="muted nowrap">${runTime(playSeconds(it, dur)) || "—"}</td>
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
        ${canEdit ? `<div class="action-buttons">
          <label class="inline-check"><input type="checkbox" name="item_id" value="${it.id}" form="remove-items" aria-label="Select ${esc(it.original_name)}">Select</label>
          <form method="post" action="/playlists/${playlist.id}/items/${it.id}/delete" class="inline" data-confirm="Remove ${esc(it.original_name)} from ${esc(playlist.name)}? Projectors playing it skip it from their next sync.">
            ${csrfInput(ctx)}
            <button type="submit" class="danger small">Remove</button>
          </form>
        </div>` : ""}
      </td>
    </tr>`;
  const option = (m) => {
    const t = runTime(m.duration_seconds);
    return `<option value="${m.id}">
        [${esc(m.media_type.toUpperCase())}] ${esc(m.original_name)}${t ? ` (${t})` : ""}
      </option>`;
  };

  // Duplicate shares the name form (formaction) so it sits beside Rename; Enter still renames.
  // Remove selected is a form of its own under the table (a form cannot hold the rows' forms): the
  // rows' tick boxes join it with form="remove-items". Its hidden noop button comes first because
  // Enter on a tick box submits through the form's first submit button (as on the Library).
  const content = `<a href="/playlists" class="back">← All playlists</a>
<div class="page-head playlist-head">
  ${canEdit ? `<form method="post" action="/playlists/${playlist.id}/rename" class="row">
    ${csrfInput(ctx)}
    <label>playlist name
      <input type="text" name="name" value="${esc(playlist.name)}" required>
    </label>
    <button type="submit">Rename</button>
    <button type="submit" formaction="/playlists/${playlist.id}/duplicate" formnovalidate>Duplicate</button>
  </form>` : `<h1>${esc(playlist.name)}</h1>`}
  <span class="page-meta">${plural(items.length, "item")}${time ? ` · ${time}` : ""}</span>
</div>

<div class="section-head">
  <h2>Playlist order (${items.length})</h2>
  ${canEdit && items.some((it) => it.media_type === "image") ? `<form method="post" action="/playlists/${playlist.id}/pictures" class="inline duration-form">
    ${csrfInput(ctx)}
    <label>Every picture
      <input type="number" name="duration" min="0.5" max="86400" step="0.5" placeholder="${esc(defaultImageDuration)}">
    </label>
    <span class="unit">sec</span>
    <button type="submit" class="small">Set all</button>
  </form>` : ""}
</div>
${!items.length ? emptyState("EMPTY REEL", `Nothing queued.${canEdit ? " Add media below." : ""}`) : `<div class="table-wrap">
<table class="data sortable-table" id="playlist-items"${canEdit ? " data-thumb-put" : ""}>
  <caption class="sr-only">Playlist items</caption>
  <thead>
    <tr><th scope="col"><span class="sr-only">Drag handle</span></th><th scope="col">#</th><th scope="col">Preview</th><th scope="col">Name</th><th scope="col">Duration</th><th scope="col">Override</th><th scope="col"><span class="sr-only">Actions</span></th></tr>
  </thead>
  <tbody id="sortable-body" data-playlist-id="${playlist.id}"${canEdit ? "" : ' data-readonly="1"'}>
    ${items.map(itemRow).join("\n    ")}
  </tbody>
</table>
</div>${canEdit ? `
<form method="post" action="/playlists/${playlist.id}/items/delete" id="remove-items" class="action-buttons remove-items" autocomplete="off">
  ${csrfInput(ctx)}
  <button type="submit" name="noop" value="1" hidden></button>
  <button type="submit" class="danger small" data-confirm="Remove the selected files from ${esc(playlist.name)}? Projectors playing it skip them from their next sync.">Remove selected</button>
</form>` : ""}`}

${canEdit ? `<h2>Add media</h2>
${!available.length
    ? `<p class="help small">Nothing to add. <a href="/library?to=${playlist.id}">Library</a>.</p>`
    : `<div class="table-foot">
  <form method="post" action="/playlists/${playlist.id}/items">
    ${csrfInput(ctx)}
    <select name="media_id" required aria-label="Media to add">
      <option value="">— pick media —</option>
      ${available.map(option).join("\n      ")}
    </select>
    <button type="submit" class="primary">Add</button>
    <a class="button small" href="/library?to=${playlist.id}">Add from Library</a>
  </form>
</div>`}
${items.length ? '<div class="drop-hint"><span>⣿</span><span class="sans">Drag a row by its handle and drop it where it should play. The new order is saved at once; devices pick it up on their next poll.</span></div>' : ""}` : ""}`;
  return layout(ctx, { title: playlist.name, content, scripts: ["/static/sortable.min.js", "/static/media.js"] });
}

// The Add media select sends one file; a post with several media_id adds them all, in that order,
// at most MAX_DELETE a request (as the Library's Add to playlist).
async function playlistAddItem(ctx) {
  const user = auth.requireRole(ctx, "editor");
  const playlistId = idParam(ctx.params.playlist_id, "playlist_id");
  const ids = (await ctx.form()).getAll("media_id")
    .map((v) => intField(typeof v === "string" ? v : "", "Media to add")).filter((v) => v !== null);
  if (!ids.length) fail(400, "Pick a file to add");
  if (ids.length > MAX_DELETE) fail(400, `Add at most ${MAX_DELETE} files at a time`);
  await ownPlaylist(ctx, playlistId);
  // A playlist holds its own account's files only (the manifest serves nothing else either).
  const { added, already } = await appendToPlaylist(ctx.env, playlistId, ids, user.id);
  if (!added) fail(already ? 409 : 404, already ? "That file is already in this playlist" : "Media not found");
  await audit.log(ctx, "playlist_add_item", "playlist", playlistId, ids.length === 1 ? { media_id: ids[0] } : { media_ids: ids, added });
  return redirect(`/playlists/${playlistId}`);
}

async function playlistSetDuration(ctx) {
  auth.requireRole(ctx, "editor");
  const playlistId = idParam(ctx.params.playlist_id, "playlist_id");
  const itemId = idParam(ctx.params.item_id, "item_id");
  const dur = parseDuration(str(await ctx.form(), "duration"));
  const r = await db.run(ctx.env,
    `UPDATE playlist_items SET duration_override_seconds = ? WHERE id = ? AND playlist_id = ?
        AND playlist_id IN (SELECT id FROM playlists WHERE owner_id = ?)`, dur, itemId, playlistId, ctx.user.id);
  if (!r.changes) fail(404, "Playlist item not found");
  await db.run(ctx.env, TOUCH_SQL, playlistId);
  await audit.log(ctx, "playlist_set_duration", "playlist_item", itemId, { duration: dur });
  return redirect(`/playlists/${playlistId}#item-${itemId}`);
}

// "Every picture": one time for all the playlist's pictures, or back to the account's default
// when the box is empty. Its videos keep their own.
async function playlistSetPictures(ctx) {
  const user = auth.requireRole(ctx, "editor");
  const playlistId = idParam(ctx.params.playlist_id, "playlist_id");
  const dur = parseDuration(str(await ctx.form(), "duration"));
  await ownPlaylist(ctx, playlistId);
  const [r] = await db.batch(ctx.env, [
    [`UPDATE playlist_items SET duration_override_seconds = ?1
       WHERE playlist_id = ?2 AND media_id IN (SELECT id FROM media WHERE media_type = 'image' AND owner_id = ?3)`, dur, playlistId, user.id],
    [TOUCH_SQL, playlistId],
  ]);
  const n = r.meta.changes;
  if (!n) return auth.flashRedirect(ctx, `/playlists/${playlistId}`, "There are no pictures in this playlist.", "warn");
  await audit.log(ctx, "playlist_set_picture_duration", "playlist", playlistId, { duration: dur, items: n });
  return auth.flashRedirect(ctx, `/playlists/${playlistId}`,
    dur === null ? `${plural(n, "picture")} back to the default.` : `${plural(n, "picture")} set to ${runTime(dur)}.`);
}

// A copy with the same files, order and times, named "NAME copy" (then "NAME copy 2", ...). One
// batch, so never half a copy; it plays nowhere until it is given to a projector or schedule.
async function playlistDuplicate(ctx) {
  const user = auth.requireRole(ctx, "editor");
  const playlistId = idParam(ctx.params.playlist_id, "playlist_id");
  const own = await db.all(ctx.env, "SELECT id, name FROM playlists WHERE owner_id = ?", user.id);
  const from = own.find((p) => p.id === playlistId);
  if (!from) fail(404, "Playlist not found");
  const taken = new Set(own.map((p) => p.name));
  let name = `${from.name} copy`;
  for (let n = 2; taken.has(name); n++) name = `${from.name} copy ${n}`;
  let results;
  try {
    results = await db.batch(ctx.env, [
      ["INSERT INTO playlists (owner_id, name, legacy_name) VALUES (?, ?, ?)", user.id, name, accounts.uniqueKey()],
      [`INSERT INTO playlist_items (playlist_id, media_id, position, duration_override_seconds)
        SELECT (SELECT id FROM playlists WHERE owner_id = ?1 AND name = ?2), media_id, position, duration_override_seconds
          FROM playlist_items WHERE playlist_id = ?3 ORDER BY position, id`, user.id, name, playlistId],
    ]);
  } catch (e) {
    if (db.isConstraintError(e)) fail(409, "A playlist with that name already exists");
    throw e;
  }
  const pid = results[0].meta.last_row_id;
  await audit.log(ctx, "playlist_duplicate", "playlist", pid, { from: playlistId, name });
  return auth.flashRedirect(ctx, `/playlists/${pid}`, `Duplicated as ${name}.`);
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
  await ownPlaylist(ctx, playlistId);
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
  if (!(await db.first(env,
    "SELECT pi.id FROM playlist_items pi JOIN playlists p ON p.id = pi.playlist_id WHERE pi.id = ? AND pi.playlist_id = ? AND p.owner_id = ?",
    itemId, playlistId, ctx.user.id))) {
    fail(404, "Playlist item not found");
  }
  await db.batch(env, [
    ["DELETE FROM playlist_items WHERE id = ? AND playlist_id = ?", itemId, playlistId],
    [RENUMBER_SQL, JSON.stringify([playlistId])],
    [TOUCH_SQL, playlistId],
  ]);
  await audit.log(ctx, "playlist_remove_item", "playlist_item", itemId);
  return redirect(`/playlists/${playlistId}`);
}

// Remove selected: every ticked item of the playlist in one batch, at most MAX_DELETE. `noop` is
// Enter on a tick box (playlistsEdit): nothing is removed, and the 204 leaves the browser on the
// page with its ticks. An id that is not an item of this playlist is skipped.
async function playlistRemoveItems(ctx) {
  auth.requireRole(ctx, "editor");
  const playlistId = idParam(ctx.params.playlist_id, "playlist_id");
  const form = await ctx.form();
  if (form.has("noop")) return new Response(null, { status: 204 });
  const { name } = await ownPlaylist(ctx, playlistId, "name");
  const back = `/playlists/${playlistId}`;
  const picked = form.getAll("item_id").filter((v) => typeof v === "string");
  if (!picked.length) return auth.flashRedirect(ctx, back, "Nothing was ticked.", "warn");
  if (picked.length > MAX_DELETE) fail(400, `Remove at most ${MAX_DELETE} files at a time`);
  const ids = [...new Set(picked.map((v) => idParam(v, "item_id")))];
  const doomed = "FROM playlist_items WHERE playlist_id = ?1 AND id IN (SELECT value FROM json_each(?2))";
  const [, gone] = await db.batch(ctx.env, [
    // Before the delete, while the items are still there: updated_at moves only when one goes.
    [`UPDATE playlists SET updated_at = datetime('now') WHERE id = ?1 AND EXISTS (SELECT 1 ${doomed})`, playlistId, JSON.stringify(ids)],
    [`DELETE ${doomed}`, playlistId, JSON.stringify(ids)],
    [RENUMBER_SQL, JSON.stringify([playlistId])],
  ]);
  const n = gone.meta.changes;
  if (!n) return auth.flashRedirect(ctx, back, "Nothing was removed: those files are no longer in this playlist.", "warn");
  await audit.log(ctx, "playlist_remove_items", "playlist", playlistId, { item_ids: ids, removed: n });
  return auth.flashRedirect(ctx, back, `Removed ${plural(n, "file")} from ${name}.`);
}

async function playlistRename(ctx) {
  auth.requireRole(ctx, "editor");
  const playlistId = idParam(ctx.params.playlist_id, "playlist_id");
  const name = str(await ctx.form(), "name").trim();
  if (!name) fail(400, "Enter a name");
  let r;
  try {
    r = await db.run(ctx.env, "UPDATE playlists SET name = ?, updated_at = datetime('now') WHERE id = ? AND owner_id = ?", name, playlistId, ctx.user.id);
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
  const row = await ownPlaylist(ctx, playlistId, "name");
  if (playlistId === (await ctx.settings()).default_playlist_id) fail(400, "This is the default playlist. Pick another default on Settings first.");
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
  router.post("/playlists/:playlist_id/items/delete", playlistRemoveItems);
  router.post("/playlists/:playlist_id/items/:item_id/duration", playlistSetDuration);
  router.post("/playlists/:playlist_id/items/:item_id/delete", playlistRemoveItem);
  router.post("/playlists/:playlist_id/pictures", playlistSetPictures);
  router.post("/playlists/:playlist_id/duplicate", playlistDuplicate);
  router.post("/playlists/:playlist_id/rename", playlistRename);
  router.post("/playlists/:playlist_id/delete", playlistDelete);
}
