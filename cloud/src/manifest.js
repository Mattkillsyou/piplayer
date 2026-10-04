// Port of api.resolve_active_playlist_id / _manifest_for_device / the playlist hash.
// Library module, no routes: api.js (sync), media.js (device scoping) and the dashboard /
// devices pages all resolve the active playlist through the same function so they agree.
// A projector plays only its content account's content (accounts.js: its owner, or the site
// admin for an ownerless one): schedule rules, the device's playlist and its group's count only
// when they belong to that account, and the fallback is that account's Default playlist. The
// pages keep references consistent when they write; this check is here too so that no row,
// whatever its history, can put another account's file on a projector.
import * as accounts from "./accounts.js";
import * as db from "./db.js";
import * as schedules from "./schedules.js";
import { serverTimeIso, sha256Hex, wallClock, zoneOffsetMinutes } from "./util.js";

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

// _resolve_duration: override wins, images get the account's default, videos play naturally.
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

// What the playlist decision reads for one device, restricted to account `ownerId`: its schedule
// rules whose playlist is that account's (with the playlist name, for next_rule), the device's own
// playlist when it is that account's (else null), and its group's playlist when the group and the
// playlist both are. Two statements.
export async function device_content(env, device, ownerId) {
  const rows = await db.all(env,
    `SELECT s.id, s.playlist_id, s.name, s.priority, s.start_time, s.end_time,
            s.days_of_week, s.start_date, s.end_date, p.name AS playlist_name
       FROM device_schedules s JOIN playlists p ON p.id = s.playlist_id AND p.owner_id = ?
      WHERE s.device_id = ?`, ownerId, device.id);
  const refs = await db.first(env,
    `SELECT (SELECT id FROM playlists WHERE id = ?1 AND owner_id = ?3) AS playlist_id,
            (SELECT g.playlist_id FROM device_groups g JOIN playlists p ON p.id = g.playlist_id AND p.owner_id = ?3
              WHERE g.id = ?2 AND g.owner_id = ?3) AS group_playlist_id`,
    device.playlist_id ?? null, device.group_id ?? null, ownerId);
  return { rows, playlistId: refs.playlist_id, groupPlaylistId: refs.group_playlist_id };
}

// [playlist_id, source]: matching schedule (highest priority, then highest id) ->
// device default -> group default -> the account's Default playlist -> [null, null], all from the
// device's content account. `device` needs id, playlist_id, group_id and owner_id (or
// content_owner); `now` is a util.wallClock() in that account's timezone; `defaultPlaylistId` is
// its settings.default_playlist_id (loaded here when the caller has no settings in hand).
export async function resolve_active_playlist_id(env, device, now, defaultPlaylistId = undefined) {
  const owner = await accounts.contentOwnerOf(env, device);
  if (defaultPlaylistId === undefined) defaultPlaylistId = (await db.loadSettings(env, owner)).default_playlist_id;
  const c = await device_content(env, device, owner);
  return pick_playlist({ ...device, playlist_id: c.playlistId }, c.rows, c.groupPlaylistId, now, defaultPlaylistId);
}

// The decision half of resolve_active_playlist_id, on rows the caller already has (already
// restricted to the device's content account): the device's schedules, its group's default
// playlist_id (null when it has no group) and the account's Default playlist
// (settings.default_playlist_id, migration 0016: the last fallback, so a projector with nothing
// of its own still plays). The /devices and /dashboard pages fetch those for the whole fleet in a
// few statements and call this per device instead of issuing per-device queries.
export function pick_playlist(device, scheduleRows, groupPlaylistId, now, defaultPlaylistId = null) {
  const active = schedules.pick_active(scheduleRows, now);
  if (active) return [active.playlist_id, `schedule:${active.name}`];
  if (device.playlist_id) return [device.playlist_id, "device-default"];
  if (groupPlaylistId) return [groupPlaylistId, "group-default"];
  if (defaultPlaylistId) return [defaultPlaylistId, "site-default"];
  return [null, null];
}

// Projector power (Devices page "Projector" block; player/player/projector.py).
export const PROJECTOR_CONTROLS = ["none", "broadlink", "cec"];
export const PROJECTOR_MODES = ["manual", "auto"];
export const PROJECTOR_STATES = ["on", "off", "unknown"];
// The Broadlink packets a device can learn (ir-learn:<name> command -> projector_ir_codes JSON).
export const IR_CODE_NAMES = ["power_on", "power_off", "input_hdmi1"];

// The stored projector_ir_codes JSON as {name: base64} with only the known names, {} for
// NULL / junk (a hand-edited row must never break a sync or the Devices page).
export function ir_codes(raw) {
  let parsed;
  try {
    parsed = raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
  const out = {};
  if (parsed && typeof parsed === "object") {
    for (const n of IR_CODE_NAMES) if (typeof parsed[n] === "string" && parsed[n]) out[n] = parsed[n];
  }
  return out;
}

// "on" | "off" for a device's projector in auto mode, from the same rows pick_playlist uses:
// on while a playlist is active, from projector_lead_minutes before the next schedule rule
// starts, and until nothing has been active for projector_idle_minutes; off otherwise. The
// account's Default playlist does not count: it is always there, so it would keep every auto-mode
// projector on around the clock; auto mode follows schedules and assigned playlists only.
export function projector_want(device, scheduleRows, groupPlaylistId, now, settings) {
  const lead = settings.projector_lead_minutes ?? db.PROJECTOR_LEAD_MINUTES;
  const idle = settings.projector_idle_minutes ?? db.PROJECTOR_IDLE_MINUTES;
  const activeAt = (w) => pick_playlist(device, scheduleRows, groupPlaylistId, w)[0] !== null;
  if (activeAt(now)) return "on";
  const upcoming = schedules.next_start(scheduleRows, now);
  if (upcoming && (schedules.wallMs(upcoming[1]) - schedules.wallMs(now)) / 60000 <= lead) return "on";
  // ponytail: one pick_playlist per idle minute (default 10) rather than a "last end" solver
  for (let m = 1; m <= idle; m++) if (activeAt(schedules.wallFromMs(schedules.wallMs(now) - m * 60000))) return "on";
  return "off";
}

// The manifest `projector` block, or null when the device has no projector control (absence =
// feature off for the player). `want` is what auto mode follows; manual mode only acts on the
// projector-on / projector-off commands.
export function projector_block(device, want) {
  const control = device.projector_control;
  if (!control || control === "none") return null;
  return {
    control,
    mode: PROJECTOR_MODES.includes(device.projector_power_mode) ? device.projector_power_mode : "manual",
    want,
    codes: ir_codes(device.projector_ir_codes),
    broadlink_host: device.broadlink_host || null,
  };
}

// Commands not yet completed, each handed out at most MAX_COMMAND_DELIVERIES times.
// A command the player never reports on (lost result POST, crash) is closed as
// undeliverable instead of being re-sent forever (a lost 'reboot' result must not
// reboot the Pi on every boot). The delivery_count increment is a claim: two syncs in
// flight for one device (a retried sync, two cards sharing an id) both read the row but
// only the UPDATE that still sees the old count hands the command out.
export async function pending_commands(env, deviceRowId) {
  const rows = await db.all(env,
    `SELECT id, command, issued_at, delivery_count FROM device_commands
      WHERE device_id = ? AND completed_at IS NULL
      ORDER BY id ASC`, deviceRowId);
  const updates = [];
  const claims = []; // [index into updates, command]
  for (const r of rows) {
    if (r.delivery_count >= MAX_COMMAND_DELIVERIES) {
      updates.push([
        `UPDATE device_commands SET completed_at = datetime('now'), undeliverable = 1, result = ?
          WHERE id = ? AND completed_at IS NULL`,
        `undeliverable: no result after ${MAX_COMMAND_DELIVERIES} deliveries`, r.id]);
      console.warn(`command ${r.id} (${r.command}) for device ${deviceRowId} closed as undeliverable`);
      continue;
    }
    claims.push([updates.length, { id: r.id, command: r.command, issued_at: r.issued_at }]);
    updates.push([
      `UPDATE device_commands
          SET delivered_at = COALESCE(delivered_at, datetime('now')),
              delivery_count = delivery_count + 1
        WHERE id = ? AND delivery_count = ? AND completed_at IS NULL`, r.id, r.delivery_count]);
  }
  if (!updates.length) return [];
  const results = await db.batch(env, updates);
  return claims.filter(([i]) => results[i].meta.changes === 1).map(([, c]) => c);
}

const pad2 = (n) => String(n).padStart(2, "0");

// A site wall-clock minute {year, month, day, hour, minute} as ISO 8601 with the zone's
// numeric offset at that moment, e.g. 2026-09-15T22:00-07:00 (Python:
// datetime.astimezone().isoformat(timespec="minutes")).
function wallIsoMinutes(timeZone, w) {
  const naive = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute);
  let off = zoneOffsetMinutes(timeZone, new Date(naive));
  off = zoneOffsetMinutes(timeZone, new Date(naive - off * 60000)); // settle across a DST edge
  const a = Math.abs(off);
  return `${w.year}-${pad2(w.month)}-${pad2(w.day)}T${pad2(w.hour)}:${pad2(w.minute)}` +
    `${off < 0 ? "-" : "+"}${pad2(Math.floor(a / 60))}:${pad2(a % 60)}`;
}

// The /api/sync body. `device` is the devices row (id, device_id, name, playlist_id, group_id,
// owner_id / content_owner, the projector and mpv columns); `settings` its content account's;
// `baseUrl` is the request origin (https://host) the media URLs are built on. The shape is the
// Python CMS's, byte for byte, plus the cloud-only keys.
export async function manifest_for_device(env, device, baseUrl, settings, now = new Date()) {
  const owner = await accounts.contentOwnerOf(env, device);
  const wall = wallClock(settings.timezone, now);
  const content = await device_content(env, device, owner);
  const rows = content.rows;
  const groupPlaylistId = content.groupPlaylistId;
  const own = { ...device, playlist_id: content.playlistId }; // another account's playlist reads as none
  const [activePlaylistId, source] = pick_playlist(own, rows, groupPlaylistId, wall, settings.default_playlist_id);

  let playlistBlock = null;
  if (activePlaylistId) {
    const playlistRow = await db.first(env, "SELECT id, name, updated_at FROM playlists WHERE id = ? AND owner_id = ?", activePlaylistId, owner);
    // Only the account's own files: an item can never point anywhere else (playlistAddItem), and
    // this join makes sure no row ever could.
    const items = await db.all(env,
      `SELECT pi.position, pi.duration_override_seconds,
              m.filename, m.sha256, m.size_bytes, m.duration_seconds, m.media_type
         FROM playlist_items pi
         JOIN media m ON m.id = pi.media_id AND m.owner_id = ?
        WHERE pi.playlist_id = ?
        ORDER BY pi.position ASC, pi.id ASC`, owner, activePlaylistId);
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

  // Nothing to play right now: tell the player when the next schedule rule starts so its
  // standby screen can say so.
  let nextRule = null;
  if (playlistBlock === null || !playlistBlock.items.length) {
    const upcoming = schedules.next_start(rows, wall);
    if (upcoming) {
      const [rule, startsAt] = upcoming;
      nextRule = { name: rule.name, playlist: rule.playlist_name ?? null, starts_at: wallIsoMinutes(settings.timezone, startsAt) };
    }
  }

  return {
    device: { id: device.device_id, name: device.name },
    playlist: playlistBlock,
    next_rule: nextRule,
    commands,
    screenshot_interval_seconds: settings.screenshot_interval,
    camera_interval_seconds: settings.camera_interval,
    // Site wall-clock with UTC offset, e.g. 2026-09-14T15:03:07-07:00 (schedules use this clock).
    server_time: serverTimeIso(settings.timezone, now),
    // Remote updates (Settings): the git ref update-player checks out, whether the daemon
    // updates itself nightly and the site-local window it may do so in.
    update: {
      release: settings.player_release || "main",
      auto: settings.auto_update || "off",
      window: settings.auto_update_window || "03:00-05:00",
    },
    // Camera zero-config: bumped on any Wyze / camera-source change; the player refetches
    // GET /api/camera-config/<device_id> when it differs from the one it last applied.
    camera_config_version: settings.camera_config_version || 0,
    // Projector power: null when the device has no projector control; otherwise {control, mode,
    // want, codes, broadlink_host} (auto mode follows `want`, see projector_want).
    projector: projector_block(device, projector_want(own, rows, groupPlaylistId, wall, settings)),
    // Playback options set per device (migration 0014): only present when one is set, so an older
    // player and a device on the defaults see the manifest they always did.
    ...(device.mpv_hwdec || device.mpv_profile ? {
      mpv: {
        ...(device.mpv_hwdec ? { hwdec: device.mpv_hwdec } : {}),
        ...(device.mpv_profile ? { profile: device.mpv_profile } : {}),
      },
    } : {}),
  };
}

// camelCase aliases.
export const deviceContent = device_content;
export const resolveActivePlaylistId = resolve_active_playlist_id;
export const manifestForDevice = manifest_for_device;
export const playlistHash = playlist_hash;
export const pendingCommands = pending_commands;
export const projectorWant = projector_want;
export const manifestJson = manifest_json;

export function register(router) {
  void router; // library module: nothing to register
}
