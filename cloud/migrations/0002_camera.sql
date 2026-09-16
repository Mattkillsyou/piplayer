-- Camera feed: per-device snapshot timestamp, the player's last capture error and the
-- operator-set live URL. The camera_interval site setting lives in `settings` (db.js defaults).
ALTER TABLE devices ADD COLUMN last_camera_at TEXT;
ALTER TABLE devices ADD COLUMN camera_error TEXT;                 -- player's last camera capture error, NULL = healthy
ALTER TABLE devices ADD COLUMN camera_live_url TEXT;              -- validated https URL or NULL (Devices page)
INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '2');
