// Port of web.library_page / library_delete + templates/library.html. The upload panel is
// driven by /static/upload.js (chunked protocol in ../uploads.js) instead of a multipart form.
// Each account has its own library (media.owner_id, migration 0016): the page lists the user's
// own files and a delete of another account's file id answers like a missing one.
// The files are shown as a grid of previews (thumbCell(), also used by the playlist editor):
// each has a small picture, opens large in a viewer (/static/media.js) and carries its own
// Delete; ticking several deletes them in one go (POST /library/delete) or adds them to a
// playlist (POST /library/add-to-playlist). Find / Show / Sort narrow and order the grid in the
// browser (media.js).
// A preview is a JPEG beside the file in R2 (media.thumbKey). The Worker cannot decode a video,
// so the browser of an editor makes it the first time a page shows a file that has none
// (media.js, PUT /library/<id>/thumb); until then GET /library/<id>/thumb sends the picture
// itself for an image and 404 for a video (the tile then says so).
// A delete moves the files to Recently deleted (media_trash, migration 0019), below the grid:
// Restore puts them back with their ids, playlist places and times; Empty, or the daily purge
// after TRASH_DAYS, removes them and their R2 objects for good.
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
// A week: nothing replaces a stored preview, so this only bounds how long a browser keeps one
// (thumbCell's ?v= keeps that copy from anyone who guesses at ids on a shared browser).
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
// `meta` is the line the viewer shows under the file, data-page the file's own page (the
// viewer's Details). The picture's ?v= is the stored name's sha256 prefix: the route ignores it,
// but a cached preview cannot be asked for by its id alone, by whoever uses the browser next.
// Shared with the playlist editor.
export function thumbCell(m, meta = "") {
  const length = m.media_type === "video" ? runTime(m.duration_seconds) : "";
  // The label is the link's whole accessible name: the badge and the running time on the
  // picture are not read out unless it says them too.
  const label = [`Open ${m.original_name}`, m.media_type === "video" ? "video" : "image", length].filter(Boolean).join(", ");
  return `<a class="media-thumb" href="/api/media/${esc(m.filename)}" target="_blank" rel="noopener" data-view data-kind="${isPicture(m.filename) ? "img" : "video"}" data-name="${esc(m.original_name)}" data-meta="${esc(meta)}" data-page="/library/${m.id}" aria-label="${esc(label)}">
        <img src="/library/${m.id}/thumb?v=${esc(m.filename.slice(0, 16))}" alt="" loading="lazy" decoding="async" data-thumb="${m.id}">
        ${m.media_type === "video" ? '<span class="badge badge-video">VIDEO</span>' : '<span class="badge badge-image">IMAGE</span>'}
        ${length ? `<span class="media-length">${esc(length)}</span>` : ""}
      </a>`;
}

// The upload box. "Add to" is where the files go (uploads.js uploadComplete): "" the account's
// Default playlist as before, an id one of its other playlists, "none" no playlist. `picked` is
// the playlist /library?to= came from, when it is one of the others.
function uploadGrid(ctx, maxBytes, playlists, dflt, picked) {
  const to = [
    dflt ? `<option value="">${esc(dflt.name)}</option>` : "",
    ...playlists.filter((p) => p !== dflt).map((p) => `<option value="${p.id}"${p === picked ? " selected" : ""}>${esc(p.name)}</option>`),
    `<option value="none"${dflt || picked ? "" : " selected"}>No playlist</option>`,
  ].join("");
  return `<div class="library-grid">
  <div class="dropzone brackets">
    <span class="dropzone-title">DROP MEDIA</span>
    <p>Max ${round1(maxBytes / 1024 / 1024 / 1024)} GB per file. Videos: mp4 · mov · m4v · mkv · webm · animated gif (1080p H.264 recommended). Images: jpg · png · gif · webp · bmp.</p>
    <form id="upload-form" method="post" action="/library/upload/init" data-init="/library/upload/init">
      ${csrfInput(ctx)}
      <input type="file" name="file" id="file-input" accept="video/*,image/*" multiple required aria-label="Choose files">
      <label>Add to <select name="playlist" id="upload-to">${to}</select></label>
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

// One file. The data-* are what the Library's Find / Show / Sort read (public/media.js): the
// name, the type, the size, the running time and where the file is used ("default" only in the
// account's Default playlist, "playlist" in any other, upload links' included, "none" in none).
// `playlists` are the playlists it is in ({id, name}), by name.
function card(v, tz, editor, playlists, defaultId) {
  const when = localTime(v.uploaded_at, tz);
  const facts = [fileSize(v.size_bytes), v.width ? `${v.width}×${v.height}` : "", v.codec || ""].filter(Boolean);
  // The viewer's line: everything the table used to show for the file.
  const meta = [...facts, v.media_type === "video" ? runTime(v.duration_seconds) : "", `uploaded ${when}`].filter(Boolean).join(" · ");
  const use = !playlists ? "none" : playlists.every((p) => p.id === defaultId) ? "default" : "playlist";
  const actions = editor ? `
      <div class="media-actions">
        <label class="inline-check"><input type="checkbox" name="media_id" value="${v.id}" aria-label="Select ${esc(v.original_name)}">Select</label>
        <button type="submit" name="one" value="${v.id}" class="danger small" data-confirm="Delete ${esc(v.original_name)}? It is removed from every playlist that uses it.">Delete</button>
      </div>` : "";
  return `    <li class="media-card" data-name="${esc(v.original_name)}" data-kind="${esc(v.media_type)}" data-size="${Number(v.size_bytes) || 0}" data-length="${Number(v.duration_seconds) || 0}" data-use="${use}">
      ${thumbCell(v, meta)}
      <div class="media-info">
        <a class="media-name" href="/library/${v.id}">${esc(v.original_name)}</a>
        <span class="media-meta">${esc(facts.join(" · "))}</span>
        <span class="media-meta">${esc(when)}</span>
        ${usedIn(playlists && playlists.map((p) => p.name))}
      </div>${actions}
    </li>`;
}

async function libraryPage(ctx) {
  const user = auth.requireUser(ctx);
  const editor = user.role !== "viewer";
  const { timezone: tz, default_playlist_id: defaultId } = await ctx.settings();
  const [items, uses, playlists] = (await db.batch(ctx.env, [
    [`SELECT id, original_name, filename, media_type, size_bytes, duration_seconds, width, height, codec, uploaded_at
       FROM media WHERE owner_id = ? ORDER BY uploaded_at DESC, id DESC`, user.id],
    // Which playlists each file is in (the account's own, by name): what a delete would touch.
    [`SELECT pi.media_id, p.id, p.name FROM playlist_items pi JOIN playlists p ON p.id = pi.playlist_id
       WHERE p.owner_id = ? ORDER BY p.name COLLATE NOCASE, p.id`, user.id],
    // The account's playlists, for "Add to" and Add to playlist.
    ["SELECT id, name FROM playlists WHERE owner_id = ? ORDER BY name COLLATE NOCASE, id", user.id],
  ])).map((r) => r.results);
  const usedBy = new Map();
  for (const u of uses) {
    if (!usedBy.has(u.media_id)) usedBy.set(u.media_id, []);
    usedBy.get(u.media_id).push(u);
  }
  const dflt = playlists.find((p) => p.id === defaultId);
  // /library?to=<playlist id> (the playlist editor's Add from Library) picks that playlist in
  // Add to playlist and in the upload box's Add to.
  const to = Number(ctx.url.searchParams.get("to"));
  const picked = playlists.find((p) => p.id === to && p !== dflt);
  const maxBytes = envInt(ctx.env, "PIPLAYER_MAX_UPLOAD_BYTES", 5 * 1024 * 1024 * 1024);
  const totalBytes = items.reduce((n, v) => n + (v.size_bytes || 0), 0);
  const cards = items.map((v) => card(v, tz, editor, usedBy.get(v.id), defaultId)).join("\n");
  // Find / Show / Sort: public/media.js shows the bar and does the work in the browser (without
  // the script the bar stays hidden). Outside the grid's form, so Enter in it submits nothing.
  // ponytail: every card is on the page; past about 1,000 files add a server ?q= with paging.
  const head = `<div class="media-head">
  <h2 id="media-count">Media (${items.length})</h2>
  <div class="media-find" id="media-find" hidden>
    <label>Find <input type="search" id="find-q" autocomplete="off"></label>
    <label>Show <select id="find-show"><option value="">All</option><option value="video">Videos</option><option value="image">Images</option>${dflt ? `<option value="default">Only in ${esc(dflt.name)}</option>` : ""}<option value="none">In no playlist</option></select></label>
    <label>Sort <select id="find-sort"><option value="">Newest</option><option value="oldest">Oldest</option><option value="name">Name</option><option value="size">Largest</option><option value="length">Longest</option></select></label>
  </div>
</div>`;
  // Editors get one form round the whole grid: each file's Delete button, the ticked boxes and
  // Add to playlist (formaction) post from it (a form cannot sit inside another, and every card
  // needs the token). autocomplete="off": on Back a browser would restore the ticks by position,
  // onto other files once the list has changed; data-max: Select all ticks no more than one
  // request takes. The hidden noop button comes first because Enter on a tick box submits through
  // the form's first submit button: with scripts off that was Delete selected, unasked.
  const grid = !items.length ? `<h2>Media (0)</h2>\n${emptyState("NO MEDIA", `No media yet.${editor ? " Drop a file above." : ""}`)}`
    : editor ? `${head}
<form id="library-form" method="post" action="/library/delete" autocomplete="off" data-max="${MAX_DELETE}">
  ${csrfInput(ctx)}
  <button type="submit" name="noop" value="1" hidden></button>
  <div class="media-bar">
    <div class="action-buttons">
      <button type="button" class="small" data-select-all>Select all</button>
      <button type="submit" class="danger small" data-delete-selected data-confirm="Delete the selected files? They are removed from every playlist that uses them.">Delete selected</button>
    </div>
    <div class="action-buttons media-add">
      <select name="playlist_id" id="add-to" aria-label="Playlist"><option value="">Pick a playlist</option>${playlists.map((p) => `<option value="${p.id}"${p.id === to ? " selected" : ""}>${esc(p.name)}</option>`).join("")}</select>
      <button type="submit" class="small" formaction="/library/add-to-playlist" data-add-selected>Add to playlist</button>
    </div>
    <span class="sr-only" role="status" data-picked></span>
  </div>
  <ul class="media-grid" data-thumb-put>
${cards}
  </ul>
</form>` : `${head}
<ul class="media-grid">
${cards}
</ul>`;
  const trash = await trashSection(ctx, user);
  const content = `<div class="page-head">
  <h1>Library</h1>
  <span class="page-meta">${items.length} file${items.length === 1 ? "" : "s"} · ${fileSize(totalBytes)} in total</span>
</div>

${editor ? uploadGrid(ctx, maxBytes, playlists, dflt, picked) : ""}

${grid}
${trash}`;
  return layout(ctx, { title: "Library", content, scripts: ["/static/media.js", ...(editor ? ["/static/sha256.js", "/static/upload.js"] : [])] });
}

// The first statement of a delete's batch: a media_trash row for each media row in ?1, with its
// places in the playlists of ?2 (the ones that hold any of the files): its index in each one's
// (position, id) order, which is what Restore puts back, and its time there. deleted_at is to the
// millisecond and one value for the whole statement: it is what tells one delete from the next
// (two quick deletes in one second are two deletes), whatever default the table has.
const TRASH_SQL = `WITH placed AS (
    SELECT media_id, playlist_id, duration_override_seconds AS override,
           ROW_NUMBER() OVER (PARTITION BY playlist_id ORDER BY position, id) - 1 AS position
      FROM playlist_items WHERE playlist_id IN (SELECT value FROM json_each(?2)))
  INSERT INTO media_trash (owner_id, media_id, filename, original_name, media_type, size_bytes, duration_seconds,
      width, height, codec, sha256, uploaded_at, places, deleted_at)
  SELECT m.owner_id, m.id, m.filename, m.original_name, m.media_type, m.size_bytes, m.duration_seconds,
         m.width, m.height, m.codec, m.sha256, m.uploaded_at,
         (SELECT json_group_array(json_object('playlist_id', playlist_id, 'position', position, 'override', override))
            FROM placed WHERE media_id = m.id),
         strftime('%Y-%m-%d %H:%M:%f', 'now')
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
      ["DELETE FROM media WHERE id IN (SELECT value FROM json_each(?)) RETURNING id", own],
      [RENUMBER_SQL, affected],
      ["UPDATE playlists SET updated_at = datetime('now') WHERE id IN (SELECT value FROM json_each(?))", affected],
      // which projectors go back, and from which playlist (for each file's own audit row)...
      [`SELECT id, playlist_id FROM devices WHERE playlist_id IN (${emptied}) ORDER BY id`, affected, PLAYLIST_PREFIX + "*"],
      [`UPDATE devices SET playlist_id = NULL WHERE playlist_id IN (${emptied})`, affected, PLAYLIST_PREFIX + "*"],
    ]);
    const cleared = results[4].results || [];
    // Only the files this batch moved: the same delete posted twice at once (a double click) finds
    // them gone the second time and audits nothing.
    const moved = new Set(results[1].results.map((m) => m.id));
    if (!moved.size) return;
    // One audit row per file, all in one statement batch (audit.log's rule: a failed write never
    // fails the request). A file's row names only the projectors that left one of its own playlists.
    try {
      await db.batch(env, rows.filter((r) => moved.has(r.id)).map((r) => {
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
// each, Select all (public/media.js), Restore selected and Empty. "" for a viewer and when there
// is nothing.
async function trashSection(ctx, user) {
  if (user.role === "viewer") return "";
  const rows = await db.all(ctx.env,
    "SELECT id, original_name, deleted_at FROM media_trash WHERE owner_id = ? ORDER BY deleted_at DESC, id DESC LIMIT ?", user.id, MAX_DELETE);
  if (!rows.length) return "";
  const tz = (await ctx.settings()).timezone;
  // Counted apart, and only when the list is full (a COUNT(*) OVER () read every row four times).
  const total = rows.length < MAX_DELETE ? rows.length
    : (await db.first(ctx.env, "SELECT COUNT(*) AS n FROM media_trash WHERE owner_id = ?", user.id)).n;
  const emptying = Math.min(total, PURGE_MAX);
  // One delete gives all its rows one time: each time is formatted once, not once per row.
  const times = new Map();
  const when = (at) => { if (!times.has(at)) times.set(at, esc(localTime(at, tz))); return times.get(at); };
  // Restore selected is the first submit button (Select all is not one): Enter on a tick box presses it.
  return `<details class="trash">
  <summary>Recently deleted (${total})</summary>
  <form method="post" action="/library/trash/restore" autocomplete="off">
    ${csrfInput(ctx)}
    <ul class="trash-list">
${rows.map((t) => `      <li><label class="inline-check"><input type="checkbox" name="trash_id" value="${t.id}">${esc(t.original_name)}</label><span class="media-meta">${when(t.deleted_at)}</span></li>`).join("\n")}
    </ul>
    <div class="action-buttons">
      <button type="button" class="small" data-select-trash>Select all</button>
      <button type="submit" class="small">Restore selected</button>
      <button type="submit" class="danger small" formaction="/library/trash/empty" data-confirm="Delete ${emptying} file${emptying === 1 ? "" : "s"} for good?">Empty</button>
    </div>
  </form>
</details>`;
}

// Where restored files go back in one playlist. `items`: its items as they are now, in order
// ({id, position}); `places`: the places in it of the files in Recently deleted ({position,
// override, deleted_at}, the position being the file's index when it was deleted), with media_id
// for a file that comes back and trash_id (its row) for one that stays. Every place goes back to
// its index, the newest delete first and one delete's places in playlist order: that undoes the
// deletes in reverse, so the order is exact when nothing else changed since, and close otherwise.
// Then the files that stay leave again, oldest delete first, each one's index just before its own
// delete being its new stored position, so restoring them later is exact too.
// Returns {moves: [[item id, position]] for the items that shift, adds: [[media_id, position,
// override]], waits: [[place, position]] for the places that stay at a new index}.
// ponytail: quadratic in the places that stay in one playlist; a sorted count past thousands.
export function mergePlaces(items, places) {
  const list = items.slice();
  const order = places.slice().sort((a, b) => (a.deleted_at === b.deleted_at ? a.position - b.position : a.deleted_at < b.deleted_at ? 1 : -1));
  for (const p of order) list.splice(Math.min(p.position, list.length), 0, p);
  const moves = [], adds = [], waits = [], gone = [];
  list.forEach((x, k) => {
    if (x.trash_id !== undefined) {
      // the ones that stay from older deletes have left again by the time of its own
      const at = k - gone.filter((t) => t < x.deleted_at).length;
      if (at !== x.position) waits.push([x, at]);
      gone.push(x.deleted_at);
      return;
    }
    const i = k - gone.length;
    if (x.media_id !== undefined) adds.push([x.media_id, i, x.override ?? null]);
    else if (x.position !== i) moves.push([x.id, i]);
  });
  return { moves, adds, waits };
}

// Restore the ticked trash rows of the caller's own account: each file comes back under its old
// id with its times, into every playlist place it held that still exists (mergePlaces), and the
// files that stay in Recently deleted keep their places in step. One whose bytes, name or id are
// in the library again (uploaded anew), or that an older ticked row brings back, stays here.
async function trashRestore(ctx) {
  const user = auth.requireRole(ctx, "editor");
  const picked = (await ctx.form()).getAll("trash_id").filter((v) => typeof v === "string");
  if (!picked.length) return auth.flashRedirect(ctx, "/library", "Nothing was ticked.", "warn");
  if (picked.length > MAX_DELETE) fail(400, `Restore at most ${MAX_DELETE} files at a time`);
  const env = ctx.env;
  const ids = JSON.stringify([...new Set(picked.map((v) => idParam(v, "trash_id")))]);
  const rows = await db.all(env,
    `SELECT t.id, t.media_id, t.original_name, t.places, t.deleted_at, t.filename, t.sha256,
            EXISTS (SELECT 1 FROM media WHERE id = t.media_id) OR EXISTS (SELECT 1 FROM media WHERE filename = t.filename)
              OR EXISTS (SELECT 1 FROM media WHERE owner_id = t.owner_id AND sha256 = t.sha256) AS back
       FROM media_trash t WHERE t.owner_id = ?1 AND t.id IN (SELECT value FROM json_each(?2)) ORDER BY t.id`, user.id, ids);
  if (!rows.length) return auth.flashRedirect(ctx, "/library", "Those files are no longer in Recently deleted.", "warn");
  // Two ticked copies of one file (deleted, uploaded again, deleted again): the library holds a
  // file once, so the older comes back and the other stays.
  const seen = new Set();
  for (const r of rows) if (!r.back) { if (seen.has(r.sha256) || seen.has(r.filename)) r.back = 1; else seen.add(r.sha256).add(r.filename); }
  const back = rows.filter((r) => r.back);
  const restore = rows.filter((r) => !r.back);
  if (!restore.length) {
    return auth.flashRedirect(ctx, "/library", back.length === 1 ? `${back[0].original_name} is already back in the library.` : "Those files are already back in the library.", "warn");
  }
  const restoreIds = JSON.stringify(restore.map((r) => r.id));
  const placesOf = (r, mark) => JSON.parse(r.places).map((p) => ({ ...p, deleted_at: r.deleted_at, ...mark }));
  const places = restore.flatMap((r) => placesOf(r, { media_id: r.media_id }));
  // The playlists to go back into (the caller's own that still exist, each read once) and the
  // rows that stay in Recently deleted with a place in one of them.
  const lists = new Map(), stay = new Map();
  if (places.length) {
    const pids = JSON.stringify([...new Set(places.map((p) => p.playlist_id))]);
    const [items, others] = await Promise.all([
      db.all(env, `SELECT p.id AS playlist_id, pi.id, pi.position FROM playlists p LEFT JOIN playlist_items pi ON pi.playlist_id = p.id
        WHERE p.owner_id = ?1 AND p.id IN (SELECT value FROM json_each(?2)) ORDER BY p.id, pi.position, pi.id`, user.id, pids),
      db.all(env, `SELECT id, places, deleted_at FROM media_trash t WHERE owner_id = ?1 AND id NOT IN (SELECT value FROM json_each(?3))
        AND EXISTS (SELECT 1 FROM json_each(t.places) WHERE json_extract(value, '$.playlist_id') IN (SELECT value FROM json_each(?2)))`, user.id, pids, restoreIds),
    ]);
    for (const it of items) {
      if (!lists.has(it.playlist_id)) lists.set(it.playlist_id, []);
      if (it.id !== null) lists.get(it.playlist_id).push({ id: it.id, position: it.position });
    }
    for (const t of others) stay.set(t.id, placesOf(t, { trash_id: t.id }));
  }
  const moves = [], adds = [], kept = new Set();
  const waiting = [...stay.values()].flat();
  for (const [pid, items] of lists) {
    const here = (p) => p.playlist_id === pid;
    const merged = mergePlaces(items, [...places.filter(here), ...waiting.filter(here)]);
    moves.push(...merged.moves);
    adds.push(...merged.adds.map((a) => [pid, ...a]));
    for (const [p, at] of merged.waits) { p.position = at; kept.add(p.trash_id); }
  }
  const touched = JSON.stringify([...lists.keys()]);
  const rewrites = JSON.stringify([...kept].map((id) => [id, JSON.stringify(stay.get(id).map(({ playlist_id, position, override }) => ({ playlist_id, position, override })))]));
  // Every write but the media INSERT runs only while this request still holds its rows: the same
  // form posted twice at once (a double click), or an Empty or the purge in between, took them,
  // and then nothing moves. The rows go last, so the guards see them.
  const held = "EXISTS (SELECT 1 FROM media_trash WHERE owner_id = ?2 AND id IN (SELECT value FROM json_each(?3)))";
  const work = (async () => {
    // One transaction: the media rows first (the items point at them), the places a playlist
    // deleted meanwhile cannot take are dropped, RENUMBER closes what an edit since the read moved.
    const [ins] = await db.batch(env, [
      [`INSERT INTO media (id, filename, original_name, media_type, size_bytes, duration_seconds, width, height, codec, sha256, uploaded_at, owner_id)
        SELECT media_id, filename, original_name, media_type, size_bytes, duration_seconds, width, height, codec, sha256, uploaded_at, owner_id
          FROM media_trash WHERE owner_id = ?1 AND id IN (SELECT value FROM json_each(?2)) RETURNING id`, user.id, restoreIds],
      [`UPDATE playlist_items SET position = json_extract(x.value, '$[1]')
          FROM json_each(?1) AS x WHERE playlist_items.id = json_extract(x.value, '$[0]') AND ${held}`, JSON.stringify(moves), user.id, restoreIds],
      [`INSERT INTO playlist_items (playlist_id, media_id, position, duration_override_seconds)
        SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]'), json_extract(value, '$[3]')
          FROM json_each(?1) WHERE json_extract(value, '$[0]') IN (SELECT id FROM playlists WHERE owner_id = ?2)
           AND json_extract(value, '$[1]') IN (SELECT media_id FROM media_trash WHERE owner_id = ?2 AND id IN (SELECT value FROM json_each(?3)))`,
      JSON.stringify(adds), user.id, restoreIds],
      [`UPDATE media_trash SET places = json_extract(x.value, '$[1]') FROM json_each(?1) AS x
          WHERE media_trash.id = json_extract(x.value, '$[0]') AND media_trash.owner_id = ?2 AND ${held}`, rewrites, user.id, restoreIds],
      [RENUMBER_SQL, touched],
      [`UPDATE playlists SET updated_at = datetime('now') WHERE id IN (SELECT value FROM json_each(?1)) AND ${held}`, touched, user.id, restoreIds],
      ["DELETE FROM media_trash WHERE owner_id = ?1 AND id IN (SELECT value FROM json_each(?2))", user.id, restoreIds],
    ]);
    const came = new Set(ins.results.map((m) => m.id));
    const restored = restore.filter((r) => came.has(r.media_id));
    // One audit row per file this request brought back, in one batch (audit.log's rule: a failed
    // write never fails the request).
    if (restored.length) {
      try {
        await db.batch(env, restored.map((r) => audit.statement(ctx, "restore_media", "media", r.media_id, {
          filename: r.original_name,
          playlists: [...new Set(adds.filter((a) => a[1] === r.media_id).map((a) => a[0]))],
        })));
      } catch (e) {
        console.error(`audit log write failed for restore_media: ${e}`);
      }
    }
    return restored;
  })();
  ctx.exec.waitUntil(work); // as deleteMedia: a browser that goes away cannot stop it between the batches
  const restored = await work;
  if (!restored.length) return auth.flashRedirect(ctx, "/library", "Those files are no longer in Recently deleted.", "warn");
  const done = restored.length === 1 ? `Restored ${restored[0].original_name}` : `Restored ${restored.length} files`;
  const left = [[back.length, "already back in the library"], [restore.length - restored.length, "no longer in Recently deleted"]]
    .filter(([n]) => n).map(([n, what]) => `; ${n} ${n === 1 ? "is" : "are"} ${what}`).join("");
  return auth.flashRedirect(ctx, "/library", `${done}${left}.`, left ? "warn" : "ok");
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
// `noop` is Enter on a tick box with scripts off (libraryPage): the ticks come along, nothing is
// deleted, and the 204 leaves the browser on the page with its ticks.
async function libraryDeleteMany(ctx) {
  const user = auth.requireRole(ctx, "editor");
  const form = await ctx.form();
  if (form.has("noop")) return new Response(null, { status: 204 });
  const one = str(form, "one").trim();
  const picked = one ? [one] : form.getAll("media_id").filter((v) => typeof v === "string");
  if (!picked.length) return auth.flashRedirect(ctx, "/library", "Nothing was ticked.", "warn");
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
  if (!/^\d+$/.test(ctx.params.media_id)) fail(404, "Not Found"); // /library/delete and the like
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
  router.post("/library/trash/restore", trashRestore);
  router.post("/library/trash/empty", trashEmpty);
  // A file's page is one segment deep: the uploads (uploads.js, /library/upload/<id>...) and a
  // file's own routes below are deeper, so neither reaches the other.
  router.get("/library/:media_id", filePage);
  router.post("/library/:media_id/rename", libraryRename);
  router.post("/library/:media_id/delete", libraryDelete);
  router.get("/library/:media_id/thumb", thumbGet);
  router.put("/library/:media_id/thumb", thumbPut);
}
