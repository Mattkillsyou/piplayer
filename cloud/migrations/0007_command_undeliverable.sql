-- The "undeliverable" badge on the Devices page used to be read from the result text, which a
-- player can also post; the console's own close (manifest.pending_commands) now sets this flag.
ALTER TABLE device_commands ADD COLUMN undeliverable INTEGER NOT NULL DEFAULT 0;
UPDATE device_commands SET undeliverable = 1 WHERE result LIKE 'undeliverable:%';

INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '7');
