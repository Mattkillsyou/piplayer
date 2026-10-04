-- Accounts: every account is its own private space. Projectors were already per account
-- (devices.owner_id, migration 0009); from here on the media library, playlists (each account with
-- its own Default playlist), groups, settings, secrets and the audit rows about an account are its
-- own too (src/accounts.js has the rules). Everything that existed before was shared, so it all goes
-- to the site admin: the lowest-id user with role admin. On a database with no users yet (a fresh
-- install, the test harness) those rows keep no owner and /setup hands them to the first admin
-- (accounts.adoptOrphans).
--
-- Besides adding columns and tables, it changes what a projector of ANOTHER account than the site
-- admin points at: such a projector may only play its own account's content, and the shared
-- playlists and groups are now the site admin's, so its playlist / group is cleared and its schedule
-- rules for those playlists are removed (an audit row records each). To see what that will touch:
--   SELECT id, device_id, name, owner_id, playlist_id, group_id FROM devices
--    WHERE owner_id IS NOT NULL AND owner_id IS NOT (SELECT MIN(id) FROM users WHERE role = 'admin')
--      AND (playlist_id IS NOT NULL OR group_id IS NOT NULL);
--   SELECT s.id, s.device_id, s.name FROM device_schedules s JOIN devices d ON d.id = s.device_id
--    WHERE d.owner_id IS NOT NULL AND d.owner_id IS NOT (SELECT MIN(id) FROM users WHERE role = 'admin');
-- Nothing else is deleted: settings and secrets move (copy, then delete the copied rows) from the
-- site-wide tables to account_settings / account_secrets; the device enrollment key stays site-wide.

-- 1. Owner columns (NULL = no owner yet, only before /setup). Deleting an account deletes its
-- library, playlists and groups with it (the Users page removes the media files from R2 first); its
-- projectors stay, without an owner (devices.owner_id ON DELETE SET NULL). An audit row survives
-- its account (owner_id SET NULL: only admins see it then).
ALTER TABLE media ADD COLUMN owner_id INTEGER REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE playlists ADD COLUMN owner_id INTEGER REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE device_groups ADD COLUMN owner_id INTEGER REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE audit_log ADD COLUMN owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL;  -- the account the row is about

-- 2. Playlist and group names are unique per account: every account has a playlist called Default,
-- and a taken name must not tell one account what another has. The UNIQUE on the old name column
-- cannot be dropped without rebuilding the table, and D1 cannot rebuild a table other tables point
-- at: foreign keys stay on, so dropping the old copy fires its ON DELETE actions (every playlist
-- item and schedule rule would go), and a rename carries the children's references along. So the
-- old column is renamed, keeping its UNIQUE on a value nobody sees (the old name for rows from
-- before, a random token for new rows: accounts.uniqueKey), and a new `name` takes its place,
-- unique per account through the indexes at the end of this file.
ALTER TABLE playlists RENAME COLUMN name TO legacy_name;
ALTER TABLE playlists ADD COLUMN name TEXT NOT NULL DEFAULT '';
UPDATE playlists SET name = legacy_name;
ALTER TABLE device_groups RENAME COLUMN name TO legacy_name;
ALTER TABLE device_groups ADD COLUMN name TEXT NOT NULL DEFAULT '';
UPDATE device_groups SET name = legacy_name;

-- 3. Per-account settings (every key but the site-wide enrollment_key, which stays in `settings`)
-- and secrets (the Wyze account and the Twilio credentials). account_secrets values are AES-GCM
-- like `secrets`: 'v1:...' for a value moved here from `secrets` (bound to its name), 'v2:...' for
-- one written since (bound to the account and the name; the nightly housekeeping rewrites v1 as v2).
CREATE TABLE IF NOT EXISTS account_settings (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (user_id, key)
);
CREATE TABLE IF NOT EXISTS account_secrets (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, name)
);

-- 4. Everything from before belongs to the site admin. With no admin the subquery is NULL and the
-- rows keep no owner for /setup. An upload in flight keeps its uploader, who owns the file it
-- becomes; only one whose uploader is gone (NULL) goes to the site admin.
UPDATE media SET owner_id = (SELECT MIN(id) FROM users WHERE role = 'admin') WHERE owner_id IS NULL;
UPDATE playlists SET owner_id = (SELECT MIN(id) FROM users WHERE role = 'admin') WHERE owner_id IS NULL;
UPDATE device_groups SET owner_id = (SELECT MIN(id) FROM users WHERE role = 'admin') WHERE owner_id IS NULL;
UPDATE uploads SET user_id = (SELECT MIN(id) FROM users WHERE role = 'admin') WHERE user_id IS NULL;
INSERT INTO account_settings (user_id, key, value)
SELECT u.id, s.key, s.value FROM settings s JOIN users u ON u.id = (SELECT MIN(id) FROM users WHERE role = 'admin')
 WHERE s.key != 'enrollment_key';
DELETE FROM settings WHERE key != 'enrollment_key' AND EXISTS (SELECT 1 FROM users WHERE role = 'admin');
INSERT INTO account_secrets (user_id, name, value, updated_at)
SELECT u.id, s.name, s.value, s.updated_at FROM secrets s JOIN users u ON u.id = (SELECT MIN(id) FROM users WHERE role = 'admin');
DELETE FROM secrets WHERE EXISTS (SELECT 1 FROM users WHERE role = 'admin');
-- What each person did so far is about their own account. Rows with no user (device reports, the
-- alert cron, failed logins) keep no owner: only admins see those.
UPDATE audit_log SET owner_id = user_id WHERE user_id IS NOT NULL;

-- 5. Every account has its own Default playlist (uploads join it; a projector with nothing of its
-- own plays it). The site admin's is the site default from migration 0010, whose settings row moved
-- above; every other account gets an empty one. "Usable" = the account's default_playlist_id names
-- one of its own playlists; an account without one gets its playlist called Default, created when
-- it has none.
INSERT INTO playlists (owner_id, name, legacy_name)
SELECT u.id, 'Default', lower(hex(randomblob(16))) FROM users u
 WHERE NOT EXISTS (SELECT 1 FROM playlists p WHERE p.owner_id = u.id AND p.name = 'Default')
   AND NOT EXISTS (SELECT 1 FROM account_settings s JOIN playlists p ON p.id = CAST(s.value AS INTEGER) AND p.owner_id = s.user_id
                    WHERE s.user_id = u.id AND s.key = 'default_playlist_id');
INSERT INTO account_settings (user_id, key, value)
SELECT u.id, 'default_playlist_id', CAST(p.id AS TEXT) FROM users u JOIN playlists p ON p.owner_id = u.id AND p.name = 'Default'
 WHERE NOT EXISTS (SELECT 1 FROM account_settings s JOIN playlists p2 ON p2.id = CAST(s.value AS INTEGER) AND p2.owner_id = s.user_id
                    WHERE s.user_id = u.id AND s.key = 'default_playlist_id')
ON CONFLICT (user_id, key) DO UPDATE SET value = excluded.value;

-- 6. A projector plays only its own account's content; an ownerless one the site admin's (its
-- "content account": COALESCE(owner_id, site admin)). A reference to another account's playlist or
-- group is cleared and a schedule rule for another account's playlist removed, each with an audit
-- row first (no user: the migration did it; owner: the projector's account). A group pointing at
-- another account's playlist cannot exist after step 4; the last UPDATE keeps the rule whole anyway.
INSERT INTO audit_log (action, target_type, target_id, details, owner_id)
SELECT 'device_assign_playlist', 'device', CAST(d.id AS TEXT),
       printf('{"playlist_id": null, "was": %d, "reason": "migration 0016: that playlist belongs to another account"}', d.playlist_id), d.owner_id
  FROM devices d JOIN playlists p ON p.id = d.playlist_id
 WHERE p.owner_id IS NOT COALESCE(d.owner_id, (SELECT MIN(id) FROM users WHERE role = 'admin'));
UPDATE devices SET playlist_id = NULL
 WHERE playlist_id IS NOT NULL
   AND (SELECT owner_id FROM playlists WHERE id = devices.playlist_id) IS NOT COALESCE(devices.owner_id, (SELECT MIN(id) FROM users WHERE role = 'admin'));
INSERT INTO audit_log (action, target_type, target_id, details, owner_id)
SELECT 'device_set_group', 'device', CAST(d.id AS TEXT),
       printf('{"group_id": null, "was": %d, "reason": "migration 0016: that group belongs to another account"}', d.group_id), d.owner_id
  FROM devices d JOIN device_groups g ON g.id = d.group_id
 WHERE g.owner_id IS NOT COALESCE(d.owner_id, (SELECT MIN(id) FROM users WHERE role = 'admin'));
UPDATE devices SET group_id = NULL
 WHERE group_id IS NOT NULL
   AND (SELECT owner_id FROM device_groups WHERE id = devices.group_id) IS NOT COALESCE(devices.owner_id, (SELECT MIN(id) FROM users WHERE role = 'admin'));
INSERT INTO audit_log (action, target_type, target_id, details, owner_id)
SELECT 'device_schedule_delete', 'device_schedule', CAST(s.id AS TEXT),
       printf('{"device_id": %d, "name": %s, "playlist_id": %d, "reason": "migration 0016: that playlist belongs to another account"}', s.device_id, json_quote(s.name), s.playlist_id), d.owner_id
  FROM device_schedules s JOIN devices d ON d.id = s.device_id JOIN playlists p ON p.id = s.playlist_id
 WHERE p.owner_id IS NOT COALESCE(d.owner_id, (SELECT MIN(id) FROM users WHERE role = 'admin'));
DELETE FROM device_schedules
 WHERE id IN (SELECT s.id FROM device_schedules s JOIN devices d ON d.id = s.device_id JOIN playlists p ON p.id = s.playlist_id
               WHERE p.owner_id IS NOT COALESCE(d.owner_id, (SELECT MIN(id) FROM users WHERE role = 'admin')));
UPDATE device_groups SET playlist_id = NULL
 WHERE playlist_id IS NOT NULL AND (SELECT owner_id FROM playlists WHERE id = device_groups.playlist_id) IS NOT device_groups.owner_id;

-- 7. Uniqueness per account: the same file may sit in two libraries (each its own row and R2
-- object, so deleting one leaves the other), names repeat across accounts. Plus the indexes of
-- the per-account audit page (the rows about an account, and a person's own actions).
DROP INDEX IF EXISTS idx_media_sha256;
CREATE UNIQUE INDEX IF NOT EXISTS idx_media_owner_sha256 ON media(owner_id, sha256);
CREATE UNIQUE INDEX IF NOT EXISTS idx_playlists_owner_name ON playlists(owner_id, name);
CREATE UNIQUE INDEX IF NOT EXISTS idx_device_groups_owner_name ON device_groups(owner_id, name);
CREATE INDEX IF NOT EXISTS idx_audit_log_owner ON audit_log(owner_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_user ON audit_log(user_id, created_at DESC, id DESC);

INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '16');
