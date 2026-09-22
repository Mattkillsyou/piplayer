-- Each projector belongs to the account that flashed it (the SD flasher signs in as that user
-- and registers the device through POST /api/operator/devices). NULL = no owner: devices from
-- before this migration, the Devices page "Add device" form and POST /api/enroll; only admins
-- see those until an owner is set on the Devices page. Editors see their own projectors only.
ALTER TABLE devices ADD COLUMN owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_devices_owner ON devices(owner_id);

INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '9');
