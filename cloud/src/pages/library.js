// Port of web.library_page / library_delete + templates/library.html. The upload panel is
// driven by /static/upload.js (chunked protocol in ../uploads.js) instead of a multipart form.
// Each account has its own library (media.owner_id, migration 0016): the page lists the user's
// own files and a delete of another account's file id answers like a missing one.
// The files are shown as a grid of previews (thumbCell(), also used by the playlist editor):
// each has a small picture, opens large in a viewer (/static/media.js) and carries its own
// Delete; ticking several deletes them in one go (POST /library/delete).
// A preview is a JPEG beside the file in R2 (media.thumbKey). The Worker cannot decode a video,
// so the browser of an editor makes it the first time a page shows a file that has none
// (media.js, PUT /library/<id>/thumb); until then GET /library/<id>/thumb sends the picture
// itself for an image and 404 for a video (the tile then says so).
// A delete moves the files to Recently deleted (media_trash, migration 0019), below the grid:
// Restore puts them back with their ids, playlist places and times; Empty, or the daily purge
// after TRASH_DAYS, removes them and their R2 objects for good.
import * as audit from "../audit.js";
import * as auth from "../auth.js";
import * as db from "../db.js";
import * as media from "../media.js";
import { IMAGE_EXTENSIONS, extOf } from "../uploads.js";
import { esc, envInt, fail, fileSize, HttpError, idParam, json, localTime, runTime, str } from "../util.js";
import { csrfInput, emptyState, layout } from "./layout.js";
import { PLAYLIST_PREFIX } from "./links.js";

// Jinja's `| round(1)`: one decimal, always shown ('5.0').
const round1 = (n) => (Math.round(n * 10) / 10).toFixed(1);

export const MAX_THUMB_BYTES = 400 * 1024;
// A week, not for ever: a preview can be made again (media.js stores a better frame over a dark one).
const THUMB_CACHE = "private, max-age=604800";
// Most files one POST /library/delete takes (a page holds no more than a library does; the cap
// keeps one request's statements and R2 calls bounded).
export const MAX_DELETE = 500;
// Recently deleted keeps a file this many days; one Empty or one daily purge removes at most
// PURGE_MAX of them (two R2 keys each, 1000 keys a call).
export const TRASH_DAYS = 30;
export const PURGE_MAX = 1000;

// Rewrite the positions of the playlists in ?1 (a JSON array of ids) to 0..n-1 in (position, id)
// order (web._renumber_playlist), after a removal. It reads a ROW_NUMBER() snapshot through
// UPDATE ... FROM: a correlated subquery in SET is run again for each row and sees the positions
// this same statement already rewrote, which shuffled a playlist that had been reordered and put
// two items on one position. Shared with the playlist editor's Remove.
export const RENUMBER_SQL = `UPDATE playlist_items SET position = x.rn
  FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY playlist_id ORDER BY position, id) - 1 AS rn
          FROM playlist_items WHERE playlist_id IN (SELECT value FROM json_each(?1))) AS x
 WHERE x.id = playlist_items.id AND playlist_items.position != x.rn`;

// What a browser can show in an <img> (an animated GIF is a "video" to the projector, but still
// a picture here); everything else is played in a <video>.
const isPicture = (filename) => IMAGE_EXTENSIONS.has(extOf(filename));

// The preview of one file ({id, filename, original_name, media_type, duration_seconds} of a media
// row): a link to the file itself that media.js opens in the viewer (without the script it is
// just the file in a new tab), holding the small picture and, on it, the type and running time.
// `meta` is the line the viewer shows under the file. Shared with the playlist editor.
export function thumbCell(m, meta = "") {
  const length = m.media_type === "video" ? runTime(m.duration_seconds) : "";
  return `<a class="media-thumb" href="/api/media/${esc(m.filename)}" target="_blank" rel="noopener" data-view data-kind="${isPicture(m.filename) ? "img" : "video"}" data-name="${esc(m.original_name)}" data-meta="${esc(meta)}" aria-label="Open ${esc(m.original_name)}">
        <img src="/library/${m.id}/thumb" alt="" loading="lazy" decoding="async" data-thumb="${m.id}">
        ${m.media_type === "video" ? '<span class="badge badge-video">VIDEO</span>' : '<span class="badge badge-image">IMAGE</span>'}
        ${length ? `<span class="media-length">${esc(length)}</span>` : ""}
      </a>`;
}

function uploadGrid(maxBytes, ctx) {
  return `<div class="library-grid">
  <div class="dropzone brackets">
    <span class="dropzone-title">DROP MEDIA</span>
    <p>Max ${round1(maxBytes / 1024 / 1024 / 1024)} GB per file. Videos: mp4 · mov · m4v · mkv · webm (1080p H.264 recommended). Images: jpg · png · gif · webp · bmp.</p>
    <form id="upload-form" method="post" action="/library/upload/init" data-init="/library/upload/init">
      ${csrfInput(ctx)}
      <input type="file" name="file" id="file-input" accept="video/*,image/*" multiple required aria-label="Choose files">
      <button type="submit" class="primary">Upload</button>
    </form>
  </div>
  <div class="upload-panel">
    <div class="upload-panel-head">
      <h2>Upload queue</h2>
    </div>
    <div class="upload-panel-body">
      <ul id="upload-queue" class="upload-queue"></ul>
      <div id="upload-status" class="muted" role="status"></div>
    </div>
  </div>
</div>`;
}

// "Default, Lobby loop and 2 more": the first few playlists a file is in.
function usedIn(names) {
  if (!names || !names.length) return '<span class="media-used none">Not in any playlist</span>';
  const shown = names.slice(0, 2).map(esc).join(", ");
  return `<span class="media-used" title="${esc(names.join(", "))}">In ${shown}${names.length > 2 ? ` and ${names.length - 2} more` : ""}</span>`;
}

function card(v, tz, editor, playlists) {
  const when = localTime(v.uploaded_at, tz);
  const facts = [fileSize(v.size_bytes), v.width ? `${v.width}×${v.height}` : "", v.codec || ""].filter(Boolean);
  // The viewer's line: everything the table used to show for the file.
  const meta = [...facts, v.media_type === "video" ? runTime(v.duration_seconds) : "", `uploaded ${when}`].filter(Boolean).join(" · ");
  const actions = editor ? `
      <div class="media-actions">
        <label class="inline-check"><input type="checkbox" name="media_id" value="${v.id}" aria-label="Select ${esc(v.original_name)}">Select</label>
        <button type="submit" name="one" value="${v.id}" class="danger small" data-confirm="Delete ${esc(v.original_name)}? It is removed from every playlist that uses it.">Delete</button>
      </div>` : "";
  return `    <li class="media-card">
      ${thumbCell(v, meta)}
      <div class="media-info">
        <span class="media-name" title="${esc(v.original_name)}">${esc(v.original_name)}</span>
        <span class="media-meta">${esc(facts.join(" · "))}</span>
        <span class="media-meta">${esc(when)}</span>
        ${usedIn(playlists)}
      </div>${actions}
    </li>`;
}

async function libraryPage(ctx) {
  const user = auth.requireUser(ctx);
  const editor = user.role !== "viewer";
  const tz = (await ctx.settings()).timezone;
  const items = await db.all(ctx.env,
    `SELECT id, original_name, filename, media_type, size_bytes, duration_seconds, width, height, codec, uploaded_at
     FROM media WHERE owner_id = ? ORDER BY uploaded_at DESC, id DESC`, user.id);
  // Which playlists each file is in (the account's own, by name): what a delete would touch.
  const usedBy = new Map();
  for (const r of await db.all(ctx.env,
    `SELECT pi.media_id, p.name FROM playlist_items pi JOIN playlists p ON p.id = pi.playlist_id
      WHERE p.owner_id = ? ORDER BY p.name COLLATE NOCASE, p.id`, user.id)) {
    if (!usedBy.has(r.media_id)) usedBy.set(r.media_id, []);
    usedBy.get(r.media_id).push(r.name);
  }
  const maxBytes = envInt(ctx.env, "PIPLAYER_MAX_UPLOAD_BYTES", 5 * 1024 * 1024 * 1024);
  const totalBytes = items.reduce((n, v) => n + (v.size_bytes || 0), 0);
  const cards = items.map((v) => card(v, tz, editor, usedBy.get(v.id))).join("\n");
  // Editors get one form round the whole grid: each file's Delete button and the ticked boxes
  // post to the same route (a form cannot sit inside another, and every card needs the token).
  // autocomplete="off": on Back a browser would restore the ticks by position, onto other files
  // once the list has changed; data-max: Select all ticks no more than one delete takes.
  const grid = !items.length ? emptyState("NO MEDIA", `No media yet.${editor ? " Drop a file above." : ""}`)
    : editor ? `<form id="library-form" method="post" action="/library/delete" autocomplete="off" data-max="${MAX_DELETE}">
  ${csrfInput(ctx)}
  <div class="media-bar">
    <h2>Media (${items.length})</h2>
    <div class="action-buttons">
      <button type="button" class="small" data-select-all>Select all</button>
      <button type="submit" class="danger small" data-delete-selected data-confirm="Delete the selected files? They are removed from every playlist that uses them.">Delete selected</button>
    </div>
  </div>
  <ul class="media-grid" data-thumb-put>
${cards}
  </ul>
</form>` : `<h2>Media (${items.length})</h2>
<ul class="media-grid">
${cards}
</ul>`;
  const trash = await trashSection(ctx, user);
  const content = `<div class="page-head">
  <h1>Library</h1>
  <span class="page-meta">${items.length} file${items.length === 1 ? "" : "s"} · ${fileSize(totalBytes)} in total</span>
</div>

${editor ? uploadGrid(maxBytes, ctx) : ""}

${items.length ? "" : `<h2>Media (0)</h2>\n`}${grid}
${trash}`;
  return layout(ctx, { title: "Library", content, scripts: ["/static/media.js", ...(editor ? ["/static/sha256.js", "/static/upload.js"] : [])] });
}

// The first statement of a delete's batch: a media_trash row for each media row in ?1, with its
// places in the playlists of ?2 (the ones that hold any of the files): its index in each one's
// (position, id) order, which is what Restore puts back, and its time there.
const TRASH_SQL = `WITH placed AS (
    SELECT media_id, playlist_id, duration_override_seconds AS override,
           ROW_NUMBER() OVER (PARTITION BY playlist_id ORDER BY position, id) - 1 AS position
      FROM playlist_items WHERE playlist_id IN (SELECT value FROM json_each(?2)))
  INSERT INTO media_trash (owner_id, media_id, filename, original_name, media_type, size_bytes, duration_seconds,
      width, height, codec, sha256, uploaded_at, places)
  SELECT m.owner_id, m.id, m.filename, m.original_name, m.media_type, m.size_bytes, m.duration_seconds,
         m.width, m.height, m.codec, m.sha256, m.uploaded_at,
         (SELECT json_group_array(json_object('playlist_id', playlist_id, 'position', position, 'override', override))
            FROM placed WHERE media_id = m.id)
    FROM media m WHERE m.id IN (SELECT value FROM json_each(?1)) ORDER BY m.id`;

// Move the caller's own files `ids` to Recently deleted in one transaction whatever their number:
// each row is copied to media_trash with its playlist places and deleted (cascading its
// playlist_items), the position gaps close in every playlist that held one
// (web._renumber_playlist), those playlists' updated_at moves, and a projector pointed at an
// upload link's playlist (links.js) that this just emptied goes back to its group's playlist or
// the Default instead of the standby screen: deleting what was sent is how the owner takes it
// off the wall. The R2 objects stay for Restore (purgeTrash removes them). An id that is not the
// caller's (another account's, already deleted) is skipped. Returns the rows deleted ({id, original_name}).
async function deleteMedia(ctx, user, ids) {
  const env = ctx.env;
  // The ids go in as one JSON parameter (an IN (?, ...) list would hit D1's bound-parameter limit).
  const rows = await db.all(env,
    "SELECT id, original_name FROM media WHERE owner_id = ?1 AND id IN (SELECT value FROM json_each(?2)) ORDER BY id", user.id, JSON.stringify(ids));
  if (!rows.length) return rows;
  const own = JSON.stringify(rows.map((r) => r.id));
  const uses = await db.all(env,
    "SELECT DISTINCT media_id, playlist_id FROM playlist_items WHERE media_id IN (SELECT value FROM json_each(?)) ORDER BY playlist_id", own);
  const playlistsOf = new Map(rows.map((r) => [r.id, []]));
  for (const u of uses) playlistsOf.get(u.media_id).push(u.playlist_id);
  const affected = JSON.stringify([...new Set(uses.map((u) => u.playlist_id))]);
  // The upload links' playlists this delete empties. GLOB: the prefix in its exact case (LIKE
  // would also take an owner's own "upload link · x").
  const emptied = `SELECT p.id FROM playlists p WHERE p.id IN (SELECT value FROM json_each(?1)) AND p.name GLOB ?2
      AND NOT EXISTS (SELECT 1 FROM playlist_items WHERE playlist_id = p.id)`;
  // Handed to waitUntil so a browser that goes away mid-request cannot stop the work between the
  // commit and the audit rows.
  const done = (async () => {
    const results = await db.batch(env, [
      [TRASH_SQL, own, affected],
      ["DELETE FROM media WHERE id IN (SELECT value FROM json_each(?))", own],
      [RENUMBER_SQL, affected],
      ["UPDATE playlists SET updated_at = datetime('now') WHERE id IN (SELECT value FROM json_each(?))", affected],
      // which projectors go back, and from which playlist (for each file's own audit row)...
      [`SELECT id, playlist_id FROM devices WHERE playlist_id IN (${emptied}) ORDER BY id`, affected, PLAYLIST_PREFIX + "*"],
      [`UPDATE devices SET playlist_id = NULL WHERE playlist_id IN (${emptied})`, affected, PLAYLIST_PREFIX + "*"],
    ]);
    const cleared = results[4].results || [];
    // One audit row per file, all in one statement batch (audit.log's rule: a failed write never
    // fails the request). A file's row names only the projectors that left one of its own playlists.
    try {
      await db.batch(env, rows.map((r) => {
        const playlists = playlistsOf.get(r.id);
        const devices = cleared.filter((d) => playlists.includes(d.playlist_id)).map((d) => d.id);
        return audit.statement(ctx, "delete_media", "media", r.id,
          { filename: r.original_name, playlists, devices_cleared: devices.length ? devices : undefined });
      }));
    } catch (e) {
      console.error(`audit log write failed for delete_media: ${e}`);
    }
  })();
  ctx.exec.waitUntil(done);
  await done;
  return rows;
}

// Recently deleted, below the grid (C4): the account's newest MAX_DELETE rows with a tick box
// each, Restore selected and Empty. "" for a viewer and when there is nothing.
async function trashSection(ctx, user) {
  if (user.role === "viewer") return "";
  const rows = await db.all(ctx.env,
    `SELECT id, original_name, deleted_at, COUNT(*) OVER () AS total FROM media_trash WHERE owner_id = ?
      ORDER BY deleted_at DESC, id DESC LIMIT ?`, user.id, MAX_DELETE);
  if (!rows.length) return "";
  const tz = (await ctx.settings()).timezone;
  const total = rows[0].total;
  const emptying = Math.min(total, PURGE_MAX);
  // Restore selected first: Enter on a tick box presses the form's first button.
  return `<details class="trash">
  <summary>Recently deleted (${total})</summary>
  <form method="post" action="/library/trash/restore" autocomplete="off">
    ${csrfInput(ctx)}
    <ul class="trash-list">
${rows.map((t) => `      <li><label class="inline-check"><input type="checkbox" name="trash_id" value="${t.id}">${esc(t.original_name)}</label><span class="media-meta">${esc(localTime(t.deleted_at, tz))}</span></li>`).join("\n")}
    </ul>
    <div class="action-buttons">
      <button type="submit" class="small">Restore selected</button>
      <button type="submit" class="danger small" formaction="/library/trash/empty" data-confirm="Delete ${emptying} file${emptying === 1 ? "" : "s"} for good?">Empty</button>
    </div>
  </form>
</details>`;
}

// Where restored files go back in one playlist. `items`: its items as they are now, in order
// ({id, position}); `places`: what comes back ({media_id, position, override, deleted_at}, the
// position being the file's index when it was deleted). Each place goes back to that index,
// the newest delete first and one delete's places in playlist order: that undoes the deletes in
// reverse, so the order comes back exact when nothing else changed since, and close otherwise.
// Returns {moves: [[item id, position]] for the items that shift, adds: [[media_id, position,
// override]]}.
export function mergePlaces(items, places) {
  const list = items.slice();
  const order = places.slice().sort((a, b) => (a.deleted_at === b.deleted_at ? a.position - b.position : a.deleted_at < b.deleted_at ? 1 : -1));
  for (const p of order) list.splice(Math.min(p.position, list.length), 0, p);
  const moves = [], adds = [];
  list.forEach((x, i) => {
    if (x.media_id !== undefined) adds.push([x.media_id, i, x.override ?? null]);
    else if (x.position !== i) moves.push([x.id, i]);
  });
  return { moves, adds };
}

// Restore the ticked trash rows of the caller's own account: each file comes back under its old
// id with its times, into every playlist place it held that still exists (mergePlaces). One whose
// bytes, name or id are in the library again (uploaded anew) cannot come back and stays here.
async function trashRestore(ctx) {
  const user = auth.requireRole(ctx, "editor");
  const picked = (await ctx.form()).getAll("trash_id").filter((v) => typeof v === "string");
  if (!picked.length) return auth.flashRedirect(ctx, "/library", "Nothing was ticked.", "warn");
  if (picked.length > MAX_DELETE) fail(400, `Restore at most ${MAX_DELETE} files at a time`);
  const env = ctx.env;
  const ids = JSON.stringify([...new Set(picked.map((v) => idParam(v, "trash_id")))]);
  const rows = await db.all(env,
    `SELECT t.id, t.media_id, t.original_name, t.places, t.deleted_at,
            EXISTS (SELECT 1 FROM media WHERE id = t.media_id) OR EXISTS (SELECT 1 FROM media WHERE filename = t.filename)
              OR EXISTS (SELECT 1 FROM media WHERE owner_id = t.owner_id AND sha256 = t.sha256) AS back
       FROM media_trash t WHERE t.owner_id = ?1 AND t.id IN (SELECT value FROM json_each(?2)) ORDER BY t.id`, user.id, ids);
  if (!rows.length) return auth.flashRedirect(ctx, "/library", "Those files are no longer in Recently deleted.", "warn");
  const back = rows.filter((r) => r.back);
  const restore = rows.filter((r) => !r.back);
  if (!restore.length) {
    return auth.flashRedirect(ctx, "/library", back.length === 1 ? `${back[0].original_name} is already back in the library.` : "Those files are already back in the library.", "warn");
  }
  const places = restore.flatMap((r) => JSON.parse(r.places).map((p) => ({ ...p, media_id: r.media_id, deleted_at: r.deleted_at })));
  // The playlists to go back into: the caller's own that still exist, each read once.
  const lists = new Map();
  if (places.length) {
    for (const it of await db.all(env,
      `SELECT p.id AS playlist_id, pi.id, pi.position FROM playlists p LEFT JOIN playlist_items pi ON pi.playlist_id = p.id
        WHERE p.owner_id = ?1 AND p.id IN (SELECT value FROM json_each(?2)) ORDER BY p.id, pi.position, pi.id`,
      user.id, JSON.stringify([...new Set(places.map((p) => p.playlist_id))]))) {
      if (!lists.has(it.playlist_id)) lists.set(it.playlist_id, []);
      if (it.id !== null) lists.get(it.playlist_id).push({ id: it.id, position: it.position });
    }
  }
  const moves = [], adds = [];
  for (const [pid, items] of lists) {
    const merged = mergePlaces(items, places.filter((p) => p.playlist_id === pid));
    moves.push(...merged.moves);
    adds.push(...merged.adds.map((a) => [pid, ...a]));
  }
  const touched = JSON.stringify([...lists.keys()]);
  const restoreIds = JSON.stringify(restore.map((r) => r.id));
  // One transaction: the media rows first (the items point at them), the places a playlist
  // deleted meanwhile cannot take are dropped, RENUMBER closes what an edit since the read moved.
  await db.batch(env, [
    [`INSERT INTO media (id, filename, original_name, media_type, size_bytes, duration_seconds, width, height, codec, sha256, uploaded_at, owner_id)
      SELECT media_id, filename, original_name, media_type, size_bytes, duration_seconds, width, height, codec, sha256, uploaded_at, owner_id
        FROM media_trash WHERE owner_id = ?1 AND id IN (SELECT value FROM json_each(?2))`, user.id, restoreIds],
    ["DELETE FROM media_trash WHERE owner_id = ?1 AND id IN (SELECT value FROM json_each(?2))", user.id, restoreIds],
    [`UPDATE playlist_items SET position = json_extract(x.value, '$[1]')
        FROM json_each(?1) AS x WHERE playlist_items.id = json_extract(x.value, '$[0]')`, JSON.stringify(moves)],
    [`INSERT INTO playlist_items (playlist_id, media_id, position, duration_override_seconds)
      SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]'), json_extract(value, '$[3]')
        FROM json_each(?1) WHERE json_extract(value, '$[0]') IN (SELECT id FROM playlists WHERE owner_id = ?2)`, JSON.stringify(adds), user.id],
    [RENUMBER_SQL, touched],
    ["UPDATE playlists SET updated_at = datetime('now') WHERE id IN (SELECT value FROM json_each(?))", touched],
    ...restore.map((r) => audit.statement(ctx, "restore_media", "media", r.media_id, {
      filename: r.original_name,
      playlists: [...new Set(adds.filter((a) => a[1] === r.media_id).map((a) => a[0]))],
    })),
  ]);
  const done = restore.length === 1 ? `Restored ${restore[0].original_name}` : `Restored ${restore.length} files`;
  if (back.length) return auth.flashRedirect(ctx, "/library", `${done}; ${back.length} ${back.length === 1 ? "is" : "are"} already back in the library.`, "warn");
  return auth.flashRedirect(ctx, "/library", `${done}.`);
}

// Empty: the caller's whole Recently deleted (PURGE_MAX a press, oldest first) goes for good.
async function trashEmpty(ctx) {
  const user = auth.requireRole(ctx, "editor");
  const rows = await db.all(ctx.env, "SELECT id FROM media_trash WHERE owner_id = ? ORDER BY deleted_at, id LIMIT ?", user.id, PURGE_MAX);
  if (!rows.length) return auth.flashRedirect(ctx, "/library", "Recently deleted is empty.", "warn");
  const n = rows.length;
  const done = purgeTrash(ctx.env, rows.map((r) => r.id), [audit.statement(ctx, "empty_trash", null, null, { files: n })]);
  ctx.exec.waitUntil(done); // the R2 deletes finish even if the browser goes away
  await done;
  return auth.flashRedirect(ctx, "/library", `Deleted ${n} file${n === 1 ? "" : "s"} for good.`);
}

// Remove the trash rows `ids` for good (with `extra` statements, its audit row, in the same
// batch), then their files and previews from R2, 1000 keys a call: unless a media row or a trash
// row that stays holds the same filename (the same bytes uploaded again under the same name share
// the key). The rows are gone either way; an R2 error is logged.
async function purgeTrash(env, ids, extra = []) {
  const list = JSON.stringify(ids);
  const [doomed] = await db.batch(env, [
    [`SELECT DISTINCT t.filename FROM media_trash t WHERE t.id IN (SELECT value FROM json_each(?1))
        AND NOT EXISTS (SELECT 1 FROM media m WHERE m.filename = t.filename)
        AND t.filename NOT IN (SELECT filename FROM media_trash WHERE id NOT IN (SELECT value FROM json_each(?1)))`, list],
    ["DELETE FROM media_trash WHERE id IN (SELECT value FROM json_each(?))", list],
    ...extra,
  ]);
  const keys = doomed.results.flatMap((r) => [media.mediaKey(r.filename), media.thumbKey(r.filename)]);
  for (let i = 0; i < keys.length; i += 1000) {
    try { await env.MEDIA.delete(keys.slice(i, i + 1000)); }
    catch (e) { console.error(`R2 delete failed for ${keys.slice(i, i + 1000).length} object(s) from ${keys[i]}:`, e && e.stack || e); }
  }
}

// Daily cron (index.js): what was deleted more than TRASH_DAYS ago goes for good, PURGE_MAX a run.
// Returns how many rows went.
export async function housekeeping(env) {
  const old = await db.all(env, "SELECT id FROM media_trash WHERE deleted_at < datetime('now', ?) ORDER BY deleted_at, id LIMIT ?",
    `-${TRASH_DAYS} days`, PURGE_MAX);
  if (old.length) await purgeTrash(env, old.map((r) => r.id));
  return old.length;
}

async function libraryDelete(ctx) {
  const user = auth.requireRole(ctx, "editor");
  const mediaId = idParam(ctx.params.media_id, "media_id");
  const [row] = await deleteMedia(ctx, user, [mediaId]);
  if (!row) fail(404, "Not Found");
  return auth.flashRedirect(ctx, "/library", `Deleted ${row.original_name}.`);
}

// The grid's form: `one` is the file whose own Delete was pressed, else every ticked `media_id`.
async function libraryDeleteMany(ctx) {
  const user = auth.requireRole(ctx, "editor");
  const form = await ctx.form();
  const one = str(form, "one").trim();
  const picked = one ? [one] : form.getAll("media_id").filter((v) => typeof v === "string");
  if (!picked.length) return auth.flashRedirect(ctx, "/library", "Nothing was ticked. Tick the files to delete, then press Delete selected.", "warn");
  if (picked.length > MAX_DELETE) fail(400, `Delete at most ${MAX_DELETE} files at a time`);
  const rows = await deleteMedia(ctx, user, [...new Set(picked.map((v) => idParam(v, "media_id")))]);
  if (!rows.length) return auth.flashRedirect(ctx, "/library", "Nothing was deleted: those files are no longer in the library.", "warn");
  return auth.flashRedirect(ctx, "/library", rows.length === 1 ? `Deleted ${rows[0].original_name}.` : `Deleted ${rows.length} files.`);
}

// The caller's own media row (`cols`) behind :media_id, or the 404 a missing id gets.
async function ownMedia(ctx, user, cols) {
  const row = await db.first(ctx.env, `SELECT ${cols} FROM media WHERE id = ? AND owner_id = ?`, idParam(ctx.params.media_id, "media_id"), user.id);
  if (!row) fail(404, "Not Found");
  return row;
}

// The small picture of a file: the stored preview, else the file itself when a browser can
// show it as a picture (a redirect, so the copy the viewer needs is fetched once), else 404.
async function thumbGet(ctx) {
  const row = await ownMedia(ctx, auth.requireUser(ctx), "filename");
  try {
    return await media.serveObject(ctx.request, ctx.env.MEDIA, media.thumbKey(row.filename), { "cache-control": THUMB_CACHE });
  } catch (e) {
    if (!(e instanceof HttpError) || e.status !== 404) throw e;
  }
  if (!isPicture(row.filename)) fail(404, "No preview yet");
  return new Response(null, { status: 302, headers: { location: `/api/media/${row.filename}`, "cache-control": "no-store" } });
}

// Store the preview media.js made in the browser: a JPEG, small, for one of the caller's own files.
async function thumbPut(ctx) {
  const row = await ownMedia(ctx, auth.requireRole(ctx, "editor"), "filename");
  const tooLarge = () => fail(413, `A preview is at most ${MAX_THUMB_BYTES} bytes`);
  const declared = parseInt(ctx.request.headers.get("content-length") || "", 10);
  if (!Number.isFinite(declared)) fail(411, "Content-Length is required");
  if (declared > MAX_THUMB_BYTES) tooLarge();
  const bytes = new Uint8Array(await ctx.request.arrayBuffer());
  if (bytes.length > MAX_THUMB_BYTES) tooLarge();
  if (!media.isJpeg(bytes)) fail(400, "A preview must be a JPEG image");
  await ctx.env.MEDIA.put(media.thumbKey(row.filename), bytes, { httpMetadata: { contentType: "image/jpeg" } });
  return json({ ok: true });
}

export function register(router) {
  router.get("/library", libraryPage);
  router.post("/library/delete", libraryDeleteMany);
  router.post("/library/trash/restore", trashRestore);
  router.post("/library/trash/empty", trashEmpty);
  router.post("/library/:media_id/delete", libraryDelete);
  router.get("/library/:media_id/thumb", thumbGet);
  router.put("/library/:media_id/thumb", thumbPut);
}
