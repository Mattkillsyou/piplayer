// Accounts (migration 0016): every account is its own private space. A user's projectors
// (devices.owner_id), media library, playlists (with its own Default playlist), groups, settings
// (account_settings), secrets (account_secrets) and the audit rows about it (audit_log.owner_id) are
// its own; nobody else lists, changes or even learns the name of any of them, and a lookup of
// another account's row answers exactly like a missing one. Roles only say what a user may do
// inside their own account (viewer reads, editor and admin change everything there); an admin also
// sees every projector (and may hand one to another account), the Users page and the site-wide
// device enrollment key, but their library, playlists, groups, schedules and settings are their
// own like anyone's. This module holds the rules the pages, the device API and the alert cron share.
import * as audit from "./audit.js";
import * as db from "./db.js";
import { randomToken } from "./util.js";

// The site admin: the account recorded as settings.site_admin_id (migration 0016 records the
// lowest-id admin of that moment, /setup the first admin: adoptOrphans). Everything that existed
// before accounts (one shared library) became theirs, and an ownerless projector (enrolled with
// the site key, or one an admin left without an owner) plays their content and follows their
// settings, as it did before. Recorded, never recomputed from the roles: promoting, demoting or
// deleting other users must not hand those projectors, that library and that Wyze login to
// someone else, and the Users page refuses to delete or demote the site admin (SITE_ADMIN_KEPT).
export const SITE_ADMIN_SQL = "(SELECT CAST(value AS INTEGER) FROM settings WHERE key = 'site_admin_id')";
export const SITE_ADMIN_KEPT = "That is the site admin account: projectors without an owner play its content, so it cannot be deleted or given another role";

export async function siteAdminId(env) {
  return (await db.first(env, `SELECT ${SITE_ADMIN_SQL} AS id`)).id;
}

// A projector's content account: the account whose playlists, groups, schedules and settings it
// plays by. Its owner, or the site admin for an ownerless one. `alias` is the devices table alias.
export const contentOwnerSql = (alias = "d") => `COALESCE(${alias}.owner_id, ${SITE_ADMIN_SQL})`;

// The content account of a devices row: `content_owner` when the query already selected it
// (auth.deviceFromHeader, pages/devices.requireDevice), else from owner_id, else from D1 by id
// (a caller holding only a partial row).
export async function contentOwnerOf(env, device) {
  if (device.content_owner !== undefined) return device.content_owner;
  if (device.owner_id !== undefined) return device.owner_id ?? await siteAdminId(env);
  const row = await db.first(env, `SELECT ${contentOwnerSql("d")} AS owner FROM devices d WHERE d.id = ?`, device.id);
  return row ? row.owner : null;
}

// playlists.legacy_name / device_groups.legacy_name: the old name column, renamed by migration 0016
// because its site-wide UNIQUE cannot be dropped in D1. Nobody sees it; a new row gets a random
// token so it never collides, and `name` (unique per account) is what every page shows.
export const uniqueKey = () => randomToken(16);

// Rows of one account, or null (the same answer as a missing row, so another account's id
// learns nothing). `table` is a trusted literal: media, playlists or device_groups.
export function ownRow(env, table, id, ownerId, cols = "id") {
  if (id === null || id === undefined || ownerId === null || ownerId === undefined) return Promise.resolve(null);
  return db.first(env, `SELECT ${cols} FROM ${table} WHERE id = ? AND owner_id = ?`, id, ownerId);
}

// The account's Default playlist id: its default_playlist_id when that names one of its own
// playlists, else its playlist called Default, created when it has none (sign-up, a user made on
// the Users page, /setup). Returns the id.
export async function ensureDefaultPlaylist(env, userId) {
  const current = await db.first(env,
    `SELECT p.id FROM account_settings s JOIN playlists p ON p.id = CAST(s.value AS INTEGER) AND p.owner_id = s.user_id
      WHERE s.user_id = ? AND s.key = 'default_playlist_id'`, userId);
  if (current) return current.id;
  await db.batch(env, [
    [`INSERT INTO playlists (owner_id, name, legacy_name)
      SELECT ?1, 'Default', ?2 WHERE NOT EXISTS (SELECT 1 FROM playlists WHERE owner_id = ?1 AND name = 'Default')`, userId, uniqueKey()],
    [`INSERT INTO account_settings (user_id, key, value)
      SELECT ?1, 'default_playlist_id', CAST(id AS TEXT) FROM playlists WHERE owner_id = ?1 AND name = 'Default'
      ON CONFLICT (user_id, key) DO UPDATE SET value = excluded.value`, userId],
  ]);
  return (await db.first(env, "SELECT id FROM playlists WHERE owner_id = ? AND name = 'Default'", userId)).id;
}

// /setup on a database that holds rows from before any user existed (migration 0016 on an empty
// database, the Default playlist of 0010, a key generated before setup): the first admin becomes
// the site admin and owns them. Only ever called while that admin is the only user, so no other
// account's row can be among them (and no worker from before 0016 is still reading the old rows).
export async function adoptOrphans(env, userId) {
  await db.batch(env, [
    ["UPDATE media SET owner_id = ? WHERE owner_id IS NULL", userId],
    ["UPDATE playlists SET owner_id = ? WHERE owner_id IS NULL", userId],
    ["UPDATE device_groups SET owner_id = ? WHERE owner_id IS NULL", userId],
    ["UPDATE uploads SET user_id = ? WHERE user_id IS NULL", userId],
    [`INSERT INTO account_settings (user_id, key, value) SELECT ?, key, value FROM settings WHERE key NOT IN ('enrollment_key', 'site_admin_id')
      ON CONFLICT (user_id, key) DO NOTHING`, userId],
    ["DELETE FROM settings WHERE key NOT IN ('enrollment_key', 'site_admin_id')"],
    ["INSERT INTO settings (key, value) VALUES ('site_admin_id', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", String(userId)],
    [`INSERT INTO account_secrets (user_id, name, value, updated_at) SELECT ?, name, value, updated_at FROM secrets WHERE true
      ON CONFLICT (user_id, name) DO NOTHING`, userId],
    ["DELETE FROM secrets"],
  ]);
  return ensureDefaultPlaylist(env, userId);
}

// An admin hands a projector to another account (or to nobody). What it pointed at must be the new
// content account's or go, so a projector only ever plays its owner's content: a playlist or group
// of another account is cleared (it then plays the new account's Default playlist) and schedule
// rules for another account's playlists are deleted, audited like the playlist delete's cascade.
// The new account's camera_config_version is raised above the old one's so the Pi refetches the
// camera config (it now comes from the new account's Wyze login). All in one batch. Returns
// {old_owner, new_owner, playlist_cleared, group_cleared, schedules_deleted} for the caller's audit row.
export async function reassignDevice(ctx, deviceId, newOwnerId) {
  const env = ctx.env;
  const site = await siteAdminId(env);
  const row = await db.first(env, "SELECT id, owner_id, playlist_id, group_id FROM devices WHERE id = ?", deviceId);
  const oldContent = row.owner_id ?? site;
  const newContent = newOwnerId ?? site;
  const changes = { playlist_cleared: false, group_cleared: false, schedules_deleted: 0 };
  const stmts = [["UPDATE devices SET owner_id = ? WHERE id = ?", newOwnerId, deviceId]];
  let rules = [];
  if (oldContent !== newContent) {
    const keep = await db.first(env,
      `SELECT (SELECT id FROM playlists WHERE id = ?1 AND owner_id IS ?3) AS playlist_ok,
              (SELECT id FROM device_groups WHERE id = ?2 AND owner_id IS ?3) AS group_ok`,
      row.playlist_id, row.group_id, newContent);
    changes.playlist_cleared = row.playlist_id !== null && !keep.playlist_ok;
    changes.group_cleared = row.group_id !== null && !keep.group_ok;
    if (changes.playlist_cleared) stmts.push(["UPDATE devices SET playlist_id = NULL WHERE id = ?", deviceId]);
    if (changes.group_cleared) stmts.push(["UPDATE devices SET group_id = NULL WHERE id = ?", deviceId]);
    rules = await db.all(env,
      `SELECT s.id, s.name, s.playlist_id FROM device_schedules s JOIN playlists p ON p.id = s.playlist_id
        WHERE s.device_id = ? AND p.owner_id IS NOT ?`, deviceId, newContent);
    if (rules.length) stmts.push([`DELETE FROM device_schedules WHERE device_id = ? AND playlist_id NOT IN (SELECT id FROM playlists WHERE owner_id IS ?)`, deviceId, newContent]);
    changes.schedules_deleted = rules.length;
    if (newContent !== null) {
      const old = oldContent === null ? 0 : (await db.loadSettings(env, oldContent)).camera_config_version;
      stmts.push(db.cameraConfigBump(newContent, old));
    }
  }
  await db.batch(env, stmts);
  for (const rule of rules) {
    await audit.log(ctx, "device_schedule_delete", "device_schedule", rule.id,
      { device_id: deviceId, name: rule.name, cascade_from_owner_change: true }, undefined, row.owner_id);
  }
  return { old_owner: row.owner_id, new_owner: newOwnerId, ...changes };
}

// Deleting an account takes its library with it (media.owner_id ON DELETE CASCADE); the R2 objects
// are not rows, so the Users page collects their keys first and removes them after the delete.
export async function mediaKeys(env, userId) {
  return (await db.all(env, "SELECT filename FROM media WHERE owner_id = ?", userId)).map((r) => `media/${r.filename}`);
}

export function register() {}
