-- Automation features A-G (one file, additive: append new ALTERs / CREATE TABLEs at the end,
-- never edit 0001/0002; keep the schema_version bump as the last statement).
-- A (auto-assign on enrollment): settings keys enroll_group_id / enroll_playlist_id live in the
-- existing `settings` table, no columns needed.
-- B (flasher key): personal operator API tokens (Settings page "My API tokens"; bearer
-- `p5k_<32 urlsafe chars>` on GET /api/operator/enrollment). Only the SHA-256 hex of the token
-- is stored; last_used_at throttles the api_token_used audit row to once per hour.
CREATE TABLE IF NOT EXISTS api_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_used_at TEXT
);

-- C (remote updates): device_commands gains update-player / update-os / update-all. E's
-- projector-on / projector-off / ir-learn:<name> are admitted here too so the table is rebuilt
-- once. SQLite cannot alter a CHECK: rename, recreate, copy the rows, drop, re-index.
ALTER TABLE device_commands RENAME TO device_commands_old;
CREATE TABLE device_commands (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    command TEXT NOT NULL CHECK (
        command IN ('reboot', 'force-sync', 'restart-mpv', 'update-player', 'update-os', 'update-all',
                    'projector-on', 'projector-off')
        OR command LIKE 'ir-learn:%'),
    issued_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    issued_at TEXT NOT NULL DEFAULT (datetime('now')),
    delivered_at TEXT,
    completed_at TEXT,
    result TEXT,
    delivery_count INTEGER NOT NULL DEFAULT 0            -- times handed to the player; capped, see manifest.js
);
INSERT INTO device_commands (id, device_id, command, issued_by, issued_at, delivered_at, completed_at, result, delivery_count)
    SELECT id, device_id, command, issued_by, issued_at, delivered_at, completed_at, result, delivery_count
      FROM device_commands_old;
DROP TABLE device_commands_old;
CREATE INDEX IF NOT EXISTS idx_device_commands_pending
    ON device_commands(device_id, completed_at);

-- C: what the player reported after its last update-player / update-os run (sync
-- ?update_status=<json>), shown on the Devices page; last_update_ok = 0 highlights a failure.
ALTER TABLE devices ADD COLUMN last_update_at TEXT;
ALTER TABLE devices ADD COLUMN last_update_ok INTEGER;
ALTER TABLE devices ADD COLUMN last_update_message TEXT;
ALTER TABLE devices ADD COLUMN last_update_ref TEXT;
-- C: settings keys player_release / auto_update / auto_update_window live in `settings`.

INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '3');
