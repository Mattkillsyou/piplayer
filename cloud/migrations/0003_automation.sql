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

-- D (camera zero-config): the Wyze account (Settings page) lives in `secrets`, each value
-- AES-GCM encrypted with a key HKDF-derived from the SESSION_SECRET worker secret (secrets.js);
-- the camera name pattern and camera_config_version (bumped on any change, sent in the
-- manifest) live in `settings`. Per-device override of the site default: camera_source NULL =
-- site default (wyze when the account is set, else none) | 'none' | 'wyze' | 'rtsp'.
-- camera_config_audited_at throttles the camera_config_fetched audit row to once a day.
CREATE TABLE IF NOT EXISTS secrets (
    name TEXT PRIMARY KEY,
    value TEXT NOT NULL,                                 -- 'v1:<iv b64url>:<ciphertext b64url>'
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
ALTER TABLE devices ADD COLUMN camera_source TEXT CHECK (camera_source IN ('none', 'wyze', 'rtsp'));
ALTER TABLE devices ADD COLUMN camera_rtsp_url TEXT;
ALTER TABLE devices ADD COLUMN camera_wyze_name TEXT;
ALTER TABLE devices ADD COLUMN camera_config_audited_at TEXT;

-- E (projector power): how the player switches the projector (none | broadlink RM4 mini IR |
-- HDMI-CEC), the learned Broadlink packets as JSON {power_on, power_off, input_hdmi1} (base64,
-- stored from ir-learn:<name> command results), an optional RM4 host (else LAN discovery),
-- manual | auto power mode (auto follows the manifest's projector.want, computed from the
-- schedule with the Settings lead / idle minutes) and what the player last reported through
-- sync ?projector_state= / ?projector_error=.
ALTER TABLE devices ADD COLUMN projector_control TEXT NOT NULL DEFAULT 'none' CHECK (projector_control IN ('none', 'broadlink', 'cec'));
ALTER TABLE devices ADD COLUMN projector_ir_codes TEXT;
ALTER TABLE devices ADD COLUMN broadlink_host TEXT;
ALTER TABLE devices ADD COLUMN projector_power_mode TEXT NOT NULL DEFAULT 'manual' CHECK (projector_power_mode IN ('manual', 'auto'));
ALTER TABLE devices ADD COLUMN projector_power_state TEXT;
ALTER TABLE devices ADD COLUMN projector_error TEXT;
-- E: settings keys projector_lead_minutes / projector_idle_minutes live in `settings`.

-- F (alerts): one row per (device, kind) while the condition holds (closed_at NULL = open);
-- alerts.evaluate (the */5 cron) opens, closes and re-notifies them. notified_at is when the
-- channels were last told (open, repeat after alert_repeat_minutes, recovered). Settings keys
-- alert_offline_minutes / alert_repeat_minutes / alert_email / alert_webhook_url live in
-- `settings`; the Twilio credentials in `secrets`.
CREATE TABLE IF NOT EXISTS alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    opened_at TEXT NOT NULL DEFAULT (datetime('now')),
    closed_at TEXT,
    notified_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_alerts_open ON alerts(closed_at, device_id, kind);

-- G (auto tunnel): the Cloudflare Tunnel provisioned for the device (cloudflare.js: tunnel
-- p5k-<device_id>, DNS, ingress, Access app) and its public hostname
-- <device_id>-cam.photogen5000.com. The tunnel token is fetched from the Cloudflare API on
-- every sync (manifest `tunnel`) and never stored.
ALTER TABLE devices ADD COLUMN tunnel_id TEXT;
ALTER TABLE devices ADD COLUMN tunnel_hostname TEXT;

INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '3');
