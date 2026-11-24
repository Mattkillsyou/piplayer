-- Pause alerts (a projector's card on the Devices page): for a spare or seasonal projector that is
-- off on purpose. The alert check (src/alerts.js) opens and sends nothing for it, the Dashboard
-- does not count it as a fault, and pausing closes the alerts it had open. 0 = alerts as usual, as
-- every projector has had until now. A column with a default: the worker from before this keeps
-- working on it until the new one is deployed.
ALTER TABLE devices ADD COLUMN alerts_paused INTEGER NOT NULL DEFAULT 0 CHECK (alerts_paused IN (0, 1));

-- Devices and the Dashboard name a file in Recently deleted by its Library name
-- (pages/devices.js visibleDevices): one indexed read per projector, not a scan of the account's trash.
CREATE INDEX IF NOT EXISTS idx_media_trash_filename ON media_trash(owner_id, filename);

INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '20');
