-- Pi model select (flasher): the player reports its board (/proc/device-tree/model) and
-- whether the camera bridge can run there (arm64 with at least 900 MB RAM) on every sync.
-- NULL = unknown / old player that does not send the fields yet.
ALTER TABLE devices ADD COLUMN pi_model TEXT;
ALTER TABLE devices ADD COLUMN camera_supported INTEGER;

INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '5');
