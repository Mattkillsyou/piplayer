// Port of api.resolve_active_playlist_id / _manifest_for_device / the playlist hash.
// Library module, no routes: api.js (sync), media.js (device scoping) and the dashboard /
// devices pages all resolve the active playlist through the same function so they agree.
import * as db from "./db.js";
import * as schedules from "./schedules.js";
import { serverTimeIso, sha256Hex, wallClock } from "./util.js";

export const MAX_COMMAND_DELIVERIES = 5;

// Python's str() of the effective duration, as it enters the hash string:
// 7.5 -> '7.5', 10.0 -> '10.0', None -> 'None', 1e16 -> '1e+16', 1e-05 -> '1e-05'.
// D1 hands REAL columns back as JS numbers (7.0 -> 7), so integers get their '.0' back.
export function pyFloatStr(v) {
  if (v === null || v === undefined) return "None";
  const a = Math.abs(v);
  if (a !== 0 && (a >= 1e16 || a < 1e-4)) {
    const [mant, exp] = v.toExponential().split("e");
    return `${mant}e${exp[0]}${exp.slice(1).padStart(2, "0")}`;
  }
  if (Number.isInteger(v)) return `${v}.0`;
  return String(v);
}

// The /api/sync body rendered byte-identically to FastAPI's JSONResponse (compact
// separators, floats via float.__repr__). JSON.stringify prints the REAL columns as `10`
// where Python prints `10.0`, so the two float fields are re-rendered through pyFloatStr.
// Anchored on the key so a user string (playlist name) can never be rewritten.
const FLOAT_KEYS = /("(?:natural|effective)_duration_seconds":)"([^"]+)"/g;
export function manifest_json(body) {
  const s = JSON.stringify(body, (k, v) =>
    ((k === "natural_duration_seconds" || k === "effective_duration_seconds") && typeof v === "number" ? pyFloatStr(v) : v));
  return s.replace(FLOAT_KEYS, "$1$2");
}

// _resolve_duration: override wins, images get the site default, videos play naturally.
export function resolveDuration(item, defaultImageDuration) {
  if (item.duration_override_seconds) return Number(item.duration_override_seconds);
  if (item.media_type === "image") return defaultImageDuration;
  return null;
}

// "sha256:" + hex(sha256("playlist:{id}\n" + Σ "{position}:{filename}:{sha256}:{effective_duration}\n")),
// byte-identical to the Python CMS so a player sees the same hash from either manager.
export async function playlist_hash(playlistId, items) {
  let s = `playlist:${playlistId}\n`;
  for (const it of items) {
    s += `${it.position}:${it.filename}:${it.sha256}:${pyFloatStr(it.effective_duration_seconds)}\n`;
  }
  return "sha256:" + await sha256Hex(s);
}

// [playlist_id, source]: matching schedule (highest priority, then highest id) ->
// device default -> group default -> [null, null]. `device` needs id, playlist_id, group_id;
// `now` is a util.wallClock() in the site timezone.
export async function resolve_active_playlist_id(env, device, now) {
  const rows = await db.all(env,
    `SELECT id, playlist_id, name, priority, start_time, end_time,
            days_of_week, start_date, end_date
       FROM device_schedules WHERE device_id = ?`, device.id);
  let groupPlaylistId = null;
  if (device.group_id) {
    const grow = await db.first(env, "SELECT playlist_id FROM device_groups WHERE id = ?", device.group_id);
    groupPlaylistId = grow ? grow.playlist_id : null;
  }
  return pick_playlist(device, rows, groupPlaylistId, now);
}

// The decision half of resolve_active_playlist_id, on rows the caller already has: the
// device's schedules and its group's default playlist_id (null when it has no group). The
// /devices and /dashboard pages fetch those for the whole fleet in a few statements and
// call this per device instead of issuing per-device queries.
export function pick_playlist(device, scheduleRows, groupPlaylistId, now) {
  const active = schedules.pick_active(scheduleRows, now);
  if (active) return [active.playlist_id, `schedule:${active.name}`];
  if (device.playlist_id) return [device.playlist_id, "device-default"];
  if (groupPlaylistId) return [groupPlaylistId, "group-default"];
  return [null, null];
}

// Commands not yet completed, each handed out at most MAX_COMMAND_DELIVERIES times.
// A command the player never reports on (lost result POST, crash) is closed as
// undeliverable instead of being re-sent forever (a lost 'reboot' result must not
// reboot the Pi on every boot).
export async function pending_commands(env, deviceRowId) {
  const rows = await db.all(env,
    `SELECT id, command, issued_at, delivery_count FROM device_commands
      WHERE device_id = ? AND completed_at IS NULL
      ORDER BY id ASC`, deviceRowId);
  const cmds = [];
  const updates = [];
  for (const r of rows) {
    if (r.delivery_count >= MAX_COMMAND_DELIVERIES) {
      updates.push([
        `UPDATE device_commands SET completed_at = datetime('now'), result = ?
          WHERE id = ? AND completed_at IS NULL`,
        `undeliverable: no result after ${MAX_COMMAND_DELIVERIES} deliveries`, r.id]);
      console.warn(`command ${r.id} (${r.command}) for device ${deviceRowId} closed as undeliverable`);
      continue;
    }
    updates.push([
      `UPDATE device_commands
          SET delivered_at = COALESCE(delivered_at, datetime('now')),
              delivery_count = delivery_count + 1
        WHERE id = ?`, r.id]);
    cmds.push({ id: r.id, command: r.command, issued_at: r.issued_at });
  }
  if (updates.length) await db.batch(env, updates);
  return cmds;
}

// The /api/sync body. `device` is the devices row (id, device_id, name, playlist_id, group_id);
// `baseUrl` is the request origin (https://host) the media URLs are built on.
export async function manifest_for_device(env, device, baseUrl, settings, now = new Date()) {
  const wall = wallClock(settings.timezone, now);
  const [activePlaylistId, source] = await resolve_active_playlist_id(env, device, wall);

  let playlistBlock = null;
  if (activePlaylistId) {
    const playlistRow = await db.first(env, "SELECT id, name, updated_at FROM playlists WHERE id = ?", activePlaylistId);
    const items = await db.all(env,
      `SELECT pi.position, pi.duration_override_seconds,
              m.filename, m.sha256, m.size_bytes, m.duration_seconds, m.media_type
         FROM playlist_items pi
         JOIN media m ON m.id = pi.media_id
        WHERE pi.playlist_id = ?
        ORDER BY pi.position ASC, pi.id ASC`, activePlaylistId);
    if (playlistRow) {
      const itemList = items.map((it) => ({
        position: it.position,
        filename: it.filename,
        sha256: it.sha256,
        size_bytes: it.size_bytes,
        media_type: it.media_type,
        natural_duration_seconds: it.duration_seconds,
        effective_duration_seconds: resolveDuration(it, settings.default_image_duration),
        url: `${baseUrl}/api/media/${it.filename}`,
      }));
      playlistBlock = {
        id: playlistRow.id,
        name: playlistRow.name,
        updated_at: playlistRow.updated_at,
        source,
        hash: await playlist_hash(playlistRow.id, itemList),
        items: itemList,
      };
    }
  }

  const commands = await pending_commands(env, device.id);

  return {
    device: { id: device.device_id, name: device.name },
    playlist: playlistBlock,
    commands,
    screenshot_interval_seconds: settings.screenshot_interval,
    // Site wall-clock with UTC offset, e.g. 2026-09-14T15:03:07-07:00 (schedules use this clock).
    server_time: serverTimeIso(settings.timezone, now),
  };
}

// camelCase aliases.
export const resolveActivePlaylistId = resolve_active_playlist_id;
export const manifestForDevice = manifest_for_device;
export const playlistHash = playlist_hash;
export const pendingCommands = pending_commands;
export const manifestJson = manifest_json;

export function register(router) {
  void router; // library module: nothing to register
}
