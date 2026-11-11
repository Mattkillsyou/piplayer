// Upload links (migration 0017): a secret web address, /u/<token>, that lets someone without an
// account put files on the projectors of the account that made the link (Settings page "Upload
// links": make one, copy its address once, revoke it). The page lists that account's projectors
// and drives the Library's chunk protocol (../uploads.js, public/upload.js) through
// /api/link/<token>/upload/...: the token in the path stands in for the session, so there is no
// cookie, no CSRF token and nothing to sign in to. What arrives belongs to the link's account:
// the files go to its library, and POST /api/link/<token>/play puts them on the chosen
// projectors in place of what each was playing. Nothing of the account's own is changed for
// that: each projector gets a playlist of its own, "Upload link · <device id>", holding just what
// a link last sent there, and is pointed at it (devices.playlist_id; the Playlist select on the
// Devices page moves it to another playlist, and deleting all the sent files on the Library page,
// pages/library.js, takes it off its upload playlist, back to its group's playlist or the Default,
// not to one it had before). Like any playlist of its own, it keeps a projector in auto power mode
// switched on (manifest.projector_want). A link sees the names of the projectors it can send to
// and whether each is online, and, in the play answer, whether a schedule rule is running on the
// ones it sent to; it cannot list the library, playlists or settings (init only tells it whether
// a file it sends is already in the library). Whoever holds the
// address can fill the library (up to PIPLAYER_MAX_UPLOAD_BYTES per file), so a link is for
// people trusted with the projectors; revoking it stops the address at once.
import * as accounts from "../accounts.js";
import * as audit from "../audit.js";
import * as auth from "../auth.js";
import * as db from "../db.js";
import * as schedules from "../schedules.js";
import * as uploads from "../uploads.js";
import { ageSeconds, esc, fail, json, jsonObject, randomToken, sha256Hex, wallClock } from "../util.js";
import { installBaseUrl, OFFLINE_AFTER_SECONDS } from "./devices.js";
import { authBrand, authPage } from "./login.js";

export const MAX_LINK_FILES = 50;
export const LINK_GONE = "This upload link no longer works. Ask for a new one.";
// randomToken(24): 32 urlsafe characters. Anything else never reaches the database.
const TOKEN_RE = /^[A-Za-z0-9_-]{32}$/;
const SHA_RE = /^[0-9a-fA-F]{64}$/;

// The playlist a link fills for one projector. Named after the device id (fixed, and one name
// site-wide) rather than the display name, so renaming a projector keeps its playlist and two
// projectors of one name never share one. pages/library.js knows these playlists by the prefix.
export const PLAYLIST_PREFIX = "Upload link · ";
export const playlistNameFor = (device) => PLAYLIST_PREFIX + device.device_id;

// ---------------------------------------------------------------------------
// The account's side (Settings page)
// ---------------------------------------------------------------------------

export const linksOf = (env, userId) => db.all(env,
  "SELECT id, name, created_at, last_used_at FROM upload_links WHERE user_id = ? ORDER BY created_at DESC, id DESC", userId);

// Make a link for `userId` and audit it (the name, never the token). Only the token's SHA-256
// is stored; the caller shows the address once.
export async function issueLink(ctx, userId, name) {
  const token = randomToken(24);
  const id = (await db.run(ctx.env, "INSERT INTO upload_links (user_id, name, token_hash) VALUES (?, ?, ?)",
    userId, name, await sha256Hex(token))).last_row_id;
  await audit.log(ctx, "upload_link_created", "upload_link", id, { name });
  return { id, token };
}

// The address to hand out: on PIPLAYER_PUBLIC_BASE_URL when set, else the origin in use.
export const linkUrl = (ctx, token) => `${installBaseUrl(ctx.env, ctx.url).base}/u/${token}`;

// ---------------------------------------------------------------------------
// The holder's side (/u/<token>, /api/link/<token>/...)
// ---------------------------------------------------------------------------

// The link behind the token in the path ({id, name, user_id}), or null: an unknown or revoked
// token, or one whose account may no longer upload (demoted to viewer).
async function findLink(ctx) {
  const token = ctx.params.token;
  if (!TOKEN_RE.test(token)) return null;
  const row = await db.first(ctx.env,
    "SELECT l.id, l.name, l.user_id, u.role FROM upload_links l JOIN users u ON u.id = l.user_id WHERE l.token_hash = ?",
    await sha256Hex(token));
  return row && auth.roleRank(row.role) >= auth.roleRank("editor") ? row : null;
}

async function requireLink(ctx) {
  const link = await findLink(ctx);
  if (!link) fail(404, LINK_GONE);
  return link;
}

// The projectors a link can send to: the ones playing its account's content (its own, plus the
// ownerless ones for the site admin: accounts.contentOwnerSql), as that account's Dashboard has them.
const projectorsOf = (env, userId) => db.all(env,
  `SELECT d.id, d.device_id, d.name, d.last_seen_at FROM devices d WHERE ${accounts.contentOwnerSql("d")} = ? ORDER BY d.name COLLATE NOCASE, d.id`, userId);

// Checked in within the Devices page's offline limit. The page says "online" / "offline", not on /
// off: a projector that is busy fetching a large file does not check in either.
function isOn(device, now = new Date()) {
  const age = ageSeconds(device.last_seen_at, now);
  return age !== null && age <= OFFLINE_AFTER_SECONDS;
}

const card = (body) => `<div class="auth-card">
    ${authBrand()}
    ${body}
  </div>`;

async function linkPage(ctx) {
  const link = await findLink(ctx);
  if (!link) return authPage(ctx, { title: "Upload", status: 404, card: card(`<div class="alert error" role="alert">${esc(LINK_GONE)}</div>`) });
  const devices = await projectorsOf(ctx.env, link.user_id);
  if (!devices.length) return authPage(ctx, { title: "Upload", card: card('<div class="alert warn" role="alert">No projectors here yet.</div>') });
  const api = `/api/link/${ctx.params.token}`; // TOKEN_RE: urlsafe characters only
  const only = devices.length === 1; // nothing to pick: the one projector is ticked
  const boxes = devices.map((d) => `<label class="inline-check"><input type="checkbox" name="device" value="${d.id}"${only ? " checked" : ""}>${esc(d.name)}
          <span class="status status-${isOn(d) ? "playing" : "offline"}"><span class="lamp"></span>${isOn(d) ? "online" : "offline"}</span></label>`).join("\n        ");
  // No method or action: upload.js drives the data- routes, and without it (the script failed to
  // load) a submit just loads this page again instead of leaving for a JSON error.
  const body = `<form id="upload-form" class="link-form" data-init="${api}/upload/init" data-base="${api}/upload" data-play="${api}/play" data-max-files="${MAX_LINK_FILES}">
      <fieldset class="days-fieldset link-projectors">
        <legend>Projectors</legend>
        ${boxes}
      </fieldset>
      <input type="file" name="file" id="file-input" accept="video/*,image/*" multiple required aria-label="Choose files">
      <button type="submit" class="primary">Upload</button>
    </form>
    <ul id="upload-queue" class="upload-queue"></ul>
    <div id="upload-status" role="status"></div>`;
  return authPage(ctx, { title: "Upload", card: card(body), scripts: ["/static/sha256.js", "/static/upload.js"] });
}

// The token in the path is the sign-in for the Library's upload handlers (uploads.uploader).
const withLink = (handler) => async (ctx) => {
  ctx.link = await requireLink(ctx);
  return handler(ctx);
};

// "a", "a and b", "a, b and c".
const listText = (names) => (names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : names.join(""));

// What the page says once the files are on the projectors ({name, on, scheduled} each): one that
// is online fetches them on its next check-in, unless a schedule rule is running there (the
// rule's playlist stays up until it ends); one that is offline plays them when it is back, and
// once the rule has ended if one is running there.
export function sentMessage(devices) {
  const names = (pick) => devices.filter(pick).map((d) => d.name);
  const free = names((d) => d.on && !d.scheduled);
  const held = names((d) => d.on && d.scheduled);
  const off = names((d) => !d.on && !d.scheduled);
  const offHeld = names((d) => !d.on && d.scheduled);
  const parts = [free.length ? `Sent to ${listText(free)}. It starts once the projector has downloaded it.` : "Sent."];
  if (held.length) parts.push(`${listText(held)} ${held.length > 1 ? "have" : "has"} a schedule running and will play it when that ends.`);
  if (off.length) parts.push(`${listText(off)} ${off.length > 1 ? "are" : "is"} offline and will play it when back online.`);
  if (offHeld.length) parts.push(`${listText(offHeld)} ${offHeld.length > 1 ? "are" : "is"} offline with a schedule running and will play it once back online and that has ended.`);
  return parts.join(" ");
}

// Body {media: [sha256, ...], devices: [device row id, ...]}: the files (already in the link's
// account's library, in the order to play) become the whole playlist of each chosen projector.
// A schedule rule running on a projector still wins until it ends (manifest.pick_playlist): that
// is the owner's rule, the upload plays after it, and the answer says so.
async function linkPlay(ctx) {
  const link = await requireLink(ctx);
  const body = await jsonObject(ctx.request);
  const ids = body.devices;
  if (!Array.isArray(body.media) || !body.media.length || !body.media.every((s) => typeof s === "string" && SHA_RE.test(s))) {
    fail(400, "media must be a list of sha256 values");
  }
  if (body.media.length > MAX_LINK_FILES) fail(400, `Send at most ${MAX_LINK_FILES} files at a time`);
  const shas = body.media.map((s) => s.toLowerCase()); // as uploads.js stores them
  if (!Array.isArray(ids) || !ids.length || !ids.every((n) => Number.isInteger(n) && n > 0)) fail(400, "Pick at least one projector");
  const owner = link.user_id;
  // The ids go in as one JSON parameter each (an IN (?, ...) list would hit D1's bound-parameter limit).
  const media = await db.all(ctx.env,
    "SELECT sha256, original_name FROM media WHERE owner_id = ? AND sha256 IN (SELECT value FROM json_each(?))", owner, JSON.stringify(shas));
  if (media.length !== new Set(shas).size) fail(404, "A file is no longer in the library. Upload it again.");
  // Another account's projector answers like a missing one.
  const wanted = new Set(ids);
  const devices = (await projectorsOf(ctx.env, owner)).filter((d) => wanted.has(d.id));
  if (devices.length !== wanted.size) fail(404, "Projector not found");
  // Which of them a schedule rule holds right now: the account's own rules only, on its own clock,
  // as the manifest judges them (manifest.device_content). Two statements for any number, read
  // before the send is written, so a failed read cannot answer "not sent" for a send that
  // happened. A rule that plays one of the playlists this send fills holds nothing back.
  const rules = await db.all(ctx.env,
    `SELECT s.id, s.device_id, s.name, s.priority, s.start_time, s.end_time, s.days_of_week, s.start_date, s.end_date,
            p.name AS playlist_name
       FROM device_schedules s JOIN playlists p ON p.id = s.playlist_id AND p.owner_id = ?1
      WHERE s.device_id IN (SELECT value FROM json_each(?2))`, owner, JSON.stringify(devices.map((d) => d.id)));
  const now = wallClock((await db.loadSettings(ctx.env, owner)).timezone);
  const filled = new Set(devices.map(playlistNameFor));
  const sent = devices.map((d) => {
    const active = schedules.pick_active(rules.filter((s) => s.device_id === d.id), now);
    return { id: d.id, name: d.name, on: isOn(d), scheduled: !!active && !filled.has(active.playlist_name) };
  });

  // ponytail: one batch of five statements per projector; a house has a handful. Chunk the
  // batch if a link is ever pointed at hundreds of projectors.
  const PID = "(SELECT id FROM playlists WHERE owner_id = ?1 AND name = ?2)";
  const list = JSON.stringify(shas);
  const stmts = [];
  for (const d of devices) {
    const name = playlistNameFor(d);
    stmts.push(
      [`INSERT INTO playlists (owner_id, name, legacy_name)
        SELECT ?1, ?2, ?3 WHERE NOT EXISTS (SELECT 1 FROM playlists WHERE owner_id = ?1 AND name = ?2)`, owner, name, accounts.uniqueKey()],
      [`DELETE FROM playlist_items WHERE playlist_id = ${PID}`, owner, name],
      // json_each's key is the place in the array: the order the files were picked in.
      [`INSERT INTO playlist_items (playlist_id, media_id, position)
        SELECT ${PID}, m.id, j.key FROM json_each(?3) j JOIN media m ON m.sha256 = j.value AND m.owner_id = ?1 ORDER BY j.key`, owner, name, list],
      [`UPDATE playlists SET updated_at = datetime('now') WHERE owner_id = ?1 AND name = ?2`, owner, name],
      [`UPDATE devices SET playlist_id = ${PID} WHERE id = ?3`, owner, name, d.id],
    );
  }
  stmts.push(["UPDATE upload_links SET last_used_at = datetime('now') WHERE id = ?", link.id]);
  await db.batch(ctx.env, stmts);

  const names = new Map(media.map((m) => [m.sha256, m.original_name]));
  // No user: the link did it. The row is about the link's account.
  await audit.log(ctx, "upload_link_play", "upload_link", link.id,
    { link: link.name, devices: devices.map((d) => d.device_id), files: shas.map((s) => names.get(s)) }, null, owner);
  return json({ devices: sent, message: sentMessage(sent) });
}

export function register(router) {
  router.get("/u/:token", linkPage);
  router.post("/api/link/:token/upload/init", withLink(uploads.uploadInit));
  router.put("/api/link/:token/upload/:id/part/:n", withLink(uploads.uploadPart));
  router.get("/api/link/:token/upload/:id", withLink(uploads.uploadStatus));
  router.post("/api/link/:token/upload/:id/complete", withLink(uploads.uploadComplete));
  router.post("/api/link/:token/play", linkPlay);
}
