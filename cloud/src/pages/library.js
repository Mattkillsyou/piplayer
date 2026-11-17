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
import * as accounts from "../accounts.js";
import * as audit from "../audit.js";
import * as auth from "../auth.js";
import * as db from "../db.js";
import * as media from "../media.js";
import { IMAGE_EXTENSIONS, extOf } from "../uploads.js";
import { esc, envInt, fail, fileSize, HttpError, idParam, intField, json, localTime, runTime, str } from "../util.js";
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
  const content = `<div class="page-head">
  <h1>Library</h1>
  <span class="page-meta">${items.length} file${items.length === 1 ? "" : "s"} · ${fileSize(totalBytes)} in total</span>
</div>

${editor ? uploadGrid(maxBytes, ctx) : ""}

${items.length ? "" : `<h2>Media (0)</h2>\n`}${grid}`;
  return layout(ctx, { title: "Library", content, scripts: ["/static/media.js", ...(editor ? ["/static/sha256.js", "/static/upload.js"] : [])] });
}

// Delete the caller's own files `ids` in one transaction whatever their number: the rows go
// (cascading their playlist_items), the position gaps close in every playlist that held one
// (web._renumber_playlist), those playlists' updated_at moves, and a projector pointed at an
// upload link's playlist (links.js) that this just emptied goes back to its group's playlist or
// the Default instead of the standby screen: deleting what was sent is how the owner takes it
// off the wall. An id that is not the caller's (another account's, already deleted) is skipped.
// Returns the rows deleted ({id, original_name}).
async function deleteMedia(ctx, user, ids) {
  const env = ctx.env;
  // The ids go in as one JSON parameter (an IN (?, ...) list would hit D1's bound-parameter limit).
  const rows = await db.all(env,
    "SELECT id, filename, original_name FROM media WHERE owner_id = ?1 AND id IN (SELECT value FROM json_each(?2)) ORDER BY id", user.id, JSON.stringify(ids));
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
  const results = await db.batch(env, [
    ["DELETE FROM media WHERE id IN (SELECT value FROM json_each(?))", own],
    [RENUMBER_SQL, affected],
    ["UPDATE playlists SET updated_at = datetime('now') WHERE id IN (SELECT value FROM json_each(?))", affected],
    // which projectors go back, and from which playlist (for each file's own audit row)...
    [`SELECT id, playlist_id FROM devices WHERE playlist_id IN (${emptied}) ORDER BY id`, affected, PLAYLIST_PREFIX + "*"],
    [`UPDATE devices SET playlist_id = NULL WHERE playlist_id IN (${emptied})`, affected, PLAYLIST_PREFIX + "*"],
  ]);
  const cleared = results[3].results || [];
  // The rows are gone either way; an R2 hiccup must not turn that into a 500 with no audit row.
  const keys = rows.flatMap((r) => [media.mediaKey(r.filename), media.thumbKey(r.filename)]);
  for (let i = 0; i < keys.length; i += 1000) { // R2 takes at most 1000 keys a call
    try { await env.MEDIA.delete(keys.slice(i, i + 1000)); }
    catch (e) { console.error(`R2 delete failed for ${keys.slice(i, i + 1000).length} object(s) from ${keys[i]}:`, e && e.stack || e); }
  }
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
  return rows;
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

// Put the account's own files `mediaIds` at the end of its own playlist `playlistId`, in the
// order given (a repeat counts once), skipping the ones already in it: a file has one place per
// playlist, as the editor's Add has always kept it. One batch whatever the count (the ids go in as
// one JSON parameter: an IN (?, ...) list would hit D1's bound-parameter limit). No BEGIN
// IMMEDIATE on D1: the positions are worked out by the statement that writes them, so two
// overlapping adds cannot put one file in twice or two files on one position. Returns {added,
// already}: the files put in, and the account's own files that were in it before (an id that is
// not one of its files, or no longer is, counts as neither).
export async function appendToPlaylist(env, playlistId, mediaIds, ownerId) {
  const own = `FROM json_each(?2) j JOIN media m ON m.id = j.value AND m.owner_id = ?3
    JOIN playlists p ON p.id = ?1 AND p.owner_id = ?3`;
  // NOT IN, not a correlated NOT EXISTS: the playlist's items are read once, not once per file.
  const fresh = `${own} WHERE m.id NOT IN (SELECT media_id FROM playlist_items WHERE playlist_id = ?1)`;
  const args = [playlistId, JSON.stringify(mediaIds), ownerId];
  const results = await db.batch(env, [
    [`SELECT COUNT(DISTINCT m.id) AS n ${own}`, ...args],
    // Before the insert, while the new files are still new: updated_at moves only when one lands.
    [`UPDATE playlists SET updated_at = datetime('now') WHERE id = ?1 AND EXISTS (SELECT 1 ${fresh})`, ...args],
    [`INSERT INTO playlist_items (playlist_id, media_id, position)
      SELECT ?1, m.id, (SELECT COALESCE(MAX(position), -1) FROM playlist_items WHERE playlist_id = ?1) + ROW_NUMBER() OVER (ORDER BY MIN(j.key))
      ${fresh} GROUP BY m.id`, ...args],
  ]);
  const added = results[2].meta.changes;
  return { added, already: results[0].results[0].n - added };
}

// The upload rule (uploads.validateInit): what a file may be called.
const MAX_NAME = 1024;

// The Library's "Add to playlist" (a formaction on the grid's form): every ticked file, in the
// order the page shows them, at the end of one of the caller's own playlists.
async function libraryAddToPlaylist(ctx) {
  const user = auth.requireRole(ctx, "editor");
  const form = await ctx.form();
  const playlistId = intField(str(form, "playlist_id"), "Playlist");
  if (playlistId === null) return auth.flashRedirect(ctx, "/library", "Pick a playlist.", "warn");
  const playlist = await accounts.ownRow(ctx.env, "playlists", playlistId, user.id, "id, name");
  if (!playlist) fail(404, "Playlist not found");
  const picked = form.getAll("media_id").filter((v) => typeof v === "string");
  if (!picked.length) return auth.flashRedirect(ctx, "/library", "Nothing was ticked.", "warn");
  if (picked.length > MAX_DELETE) fail(400, `Add at most ${MAX_DELETE} files at a time`);
  const ids = [...new Set(picked.map((v) => idParam(v, "media_id")))];
  const { added, already } = await appendToPlaylist(ctx.env, playlist.id, ids, user.id);
  if (!added && !already) fail(404, "Media not found");
  if (!added) return auth.flashRedirect(ctx, "/library", `${already === 1 ? "That file is" : "Those files are"} already in ${playlist.name}.`, "warn");
  await audit.log(ctx, "playlist_add_items", "playlist", playlist.id, { added, media_ids: ids });
  const skipped = already ? `; ${already} ${already === 1 ? "was" : "were"} already in it` : "";
  return auth.flashRedirect(ctx, "/library", `Added ${added} file${added === 1 ? "" : "s"} to ${playlist.name}${skipped}.`);
}

// A file's own page (the Library card's name links here): its name (a rename form for an
// editor), the preview, the facts, Download under its own name, every playlist it is in, and
// Delete. Any role, the caller's own file only (another account's id answers like a missing one).
async function filePage(ctx) {
  const user = auth.requireUser(ctx);
  const editor = user.role !== "viewer";
  const m = await ownMedia(ctx, user, "id, original_name, filename, media_type, size_bytes, duration_seconds, width, height, uploaded_at");
  const tz = (await ctx.settings()).timezone;
  const playlists = await db.all(ctx.env,
    `SELECT DISTINCT p.id, p.name FROM playlist_items pi JOIN playlists p ON p.id = pi.playlist_id AND p.owner_id = ?
      WHERE pi.media_id = ? ORDER BY p.name COLLATE NOCASE, p.id`, user.id, m.id);
  const video = m.media_type === "video";
  const meta = [video ? "Video" : "Image", video ? runTime(m.duration_seconds) : "", m.width ? `${m.width}×${m.height}` : "",
    fileSize(m.size_bytes), `uploaded ${localTime(m.uploaded_at, tz)}`].filter(Boolean).join(" · ");
  // Saved under its own name (the file is on this origin, so the browser honours download=),
  // with the stored file's extension when a rename left it off: the bytes are still that type.
  const ext = extOf(m.filename);
  const saveAs = extOf(m.original_name) === ext ? m.original_name : m.original_name + ext;
  const list = playlists.map((p) => `<li><a href="/playlists/${p.id}">${esc(p.name)}</a></li>`).join("\n  ");
  const content = `<a href="/library" class="back">← Library</a>
<div class="file-page"${editor ? " data-thumb-put" : ""}>
<div class="page-head">
  ${editor ? `<form method="post" action="/library/${m.id}/rename" class="row">
    ${csrfInput(ctx)}
    <label>file name
      <input type="text" name="name" value="${esc(m.original_name)}" maxlength="${MAX_NAME}" required>
    </label>
    <button type="submit">Rename</button>
  </form>` : `<h1>${esc(m.original_name)}</h1>`}
  <span class="page-meta">${esc(meta)}</span>
</div>
${thumbCell(m, meta)}
<div class="action-buttons">
  <a class="button small" href="/api/media/${esc(m.filename)}" download="${esc(saveAs)}">Download</a>
  ${editor ? `<form method="post" action="/library/${m.id}/delete" class="inline" data-confirm="Delete ${esc(m.original_name)}? It is removed from every playlist that uses it.">
    ${csrfInput(ctx)}
    <button type="submit" class="danger small">Delete</button>
  </form>` : ""}
</div>
<h2>Playlists (${playlists.length})</h2>
${list ? `<ul>\n  ${list}\n</ul>` : '<p class="muted">Not in any playlist</p>'}
</div>`;
  return layout(ctx, { title: m.original_name, content, scripts: ["/static/media.js"] });
}

// Rename a file: only what the pages show (original_name). The stored name, the R2 key and the
// sha256 stay, so no projector fetches it again and every playlist keeps it in its place.
async function libraryRename(ctx) {
  const user = auth.requireRole(ctx, "editor");
  const name = str(await ctx.form(), "name").trim();
  if (!name || name.length > MAX_NAME || /[\x00-\x1f\x7f]/.test(name)) fail(400, `File name must be 1-${MAX_NAME} printable characters`);
  const row = await ownMedia(ctx, user, "id, original_name");
  await db.run(ctx.env, "UPDATE media SET original_name = ? WHERE id = ? AND owner_id = ?", name, row.id, user.id);
  await audit.log(ctx, "media_rename", "media", row.id, { from: row.original_name, to: name });
  return auth.flashRedirect(ctx, `/library/${row.id}`, `Renamed to ${name}.`);
}

export function register(router) {
  router.get("/library", libraryPage);
  router.post("/library/delete", libraryDeleteMany);
  router.post("/library/add-to-playlist", libraryAddToPlaylist);
  // A file's page is one segment deep: the uploads (uploads.js, /library/upload/<id>...) and a
  // file's own routes below are deeper, so neither reaches the other.
  router.get("/library/:media_id", filePage);
  router.post("/library/:media_id/rename", libraryRename);
  router.post("/library/:media_id/delete", libraryDelete);
  router.get("/library/:media_id/thumb", thumbGet);
  router.put("/library/:media_id/thumb", thumbPut);
}
