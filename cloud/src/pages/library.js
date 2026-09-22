// Port of web.library_page / library_delete + templates/library.html. The upload panel is
// driven by /static/upload.js (chunked protocol in ../uploads.js) instead of a multipart form.
import * as audit from "../audit.js";
import * as auth from "../auth.js";
import * as db from "../db.js";
import { esc, envInt, fail, idParam, localTime, redirect } from "../util.js";
import { csrfInput, emptyState, layout } from "./layout.js";

// Jinja's `| round(1)`: one decimal, always shown ('5.0').
const round1 = (n) => (Math.round(n * 10) / 10).toFixed(1);

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
      <div id="upload-status" class="muted"></div>
    </div>
  </div>
</div>`;
}

function row(v, tz, editor, ctx) {
  const badge = v.media_type === "video"
    ? '<span class="badge badge-video">VIDEO</span>'
    : '<span class="badge badge-image">IMAGE</span>';
  const duration = v.media_type === "video" && v.duration_seconds ? `${round1(v.duration_seconds)} s` : "—";
  const res = v.width ? `${esc(v.width)}×${esc(v.height)}` : "—";
  const del = editor ? `
        <form method="post" action="/library/${esc(v.id)}/delete" class="inline" data-confirm="Delete ${esc(v.original_name)}? It is removed from every playlist that uses it.">
          ${csrfInput(ctx)}
          <button type="submit" class="danger small">Delete</button>
        </form>` : "";
  return `    <tr>
      <td>${badge}</td>
      <td class="name">${esc(v.original_name)}</td>
      <td class="nowrap">${round1(v.size_bytes / 1024 / 1024)} MB</td>
      <td class="nowrap">${duration}</td>
      <td class="nowrap">${res}</td>
      <td class="muted">${esc(v.codec || "—")}</td>
      <td class="muted nowrap">${esc(localTime(v.uploaded_at, tz))}</td>
      <td>${del}
      </td>
    </tr>`;
}

async function libraryPage(ctx) {
  const user = auth.requireUser(ctx);
  const editor = user.role !== "viewer";
  const tz = (await ctx.settings()).timezone;
  const items = await db.all(ctx.env,
    `SELECT id, original_name, filename, media_type, size_bytes, duration_seconds, width, height, codec, uploaded_at
     FROM media ORDER BY uploaded_at DESC, id DESC`);
  const maxBytes = envInt(ctx.env, "PIPLAYER_MAX_UPLOAD_BYTES", 5 * 1024 * 1024 * 1024);
  const totalBytes = items.reduce((n, v) => n + (v.size_bytes || 0), 0);
  const table = items.length ? `<div class="table-wrap">
<table class="data">
  <caption class="sr-only">Media</caption>
  <thead>
    <tr><th scope="col">Type</th><th scope="col">Name</th><th scope="col">Size</th><th scope="col">Duration</th><th scope="col">Resolution</th><th scope="col">Codec</th><th scope="col">Uploaded</th><th scope="col"><span class="sr-only">Actions</span></th></tr>
  </thead>
  <tbody>
${items.map((v) => row(v, tz, editor, ctx)).join("\n")}
  </tbody>
</table>
</div>` : emptyState("NO MEDIA", `No media yet.${editor ? " Drop a file above." : ""}`);
  const content = `<div class="page-head">
  <h1>Library</h1>
  <span class="page-meta">${items.length} file${items.length === 1 ? "" : "s"} · ${round1(totalBytes / 1024 / 1024 / 1024)} GB in total</span>
</div>

${editor ? uploadGrid(maxBytes, ctx) : ""}

<h2>Media (${items.length})</h2>
${table}`;
  return layout(ctx, { title: "Library", content, scripts: editor ? ["/static/sha256.js", "/static/upload.js"] : [] });
}

async function libraryDelete(ctx) {
  auth.requireRole(ctx, "editor");
  const mediaId = idParam(ctx.params.media_id, "media_id");
  const row = await db.first(ctx.env, "SELECT filename, original_name FROM media WHERE id = ?", mediaId);
  if (!row) fail(404, "Not Found");
  const affected = (await db.all(ctx.env,
    "SELECT DISTINCT playlist_id FROM playlist_items WHERE media_id = ?", mediaId)).map((r) => r.playlist_id);
  // One transaction: delete (cascades playlist_items), close the position gaps in every
  // affected playlist (web._renumber_playlist) and bump their updated_at.
  const stmts = [["DELETE FROM media WHERE id = ?", mediaId]];
  for (const pid of affected) {
    stmts.push([
      `UPDATE playlist_items SET position = (
         SELECT COUNT(*) FROM playlist_items AS p2
         WHERE p2.playlist_id = playlist_items.playlist_id
           AND (p2.position < playlist_items.position OR (p2.position = playlist_items.position AND p2.id < playlist_items.id)))
       WHERE playlist_id = ?`, pid]);
    stmts.push(["UPDATE playlists SET updated_at = datetime('now') WHERE id = ?", pid]);
  }
  await db.batch(ctx.env, stmts);
  // The row is gone either way; an R2 hiccup must not turn that into a 500 with no audit row.
  try { await ctx.env.MEDIA.delete("media/" + row.filename); }
  catch (e) { console.error(`R2 delete failed for media/${row.filename}:`, e && e.stack || e); }
  await audit.log(ctx, "delete_media", "media", mediaId, { filename: row.original_name, playlists: affected });
  return redirect("/library");
}

export function register(router) {
  router.get("/library", libraryPage);
  router.post("/library/:media_id/delete", libraryDelete);
}
