-- Pause alerts (a projector's card on the Devices page): for a spare or seasonal projector that is
-- off on purpose. The alert check (src/alerts.js) opens and sends nothing for it, the Dashboard
-- does not count it as a fault, and pausing closes the alerts it had open. 0 = alerts as usual, as
-- every projector has had until now. A column with a default: the worker from before this keeps
-- working on it until the new one is deployed.
ALTER TABLE devices ADD COLUMN alerts_paused INTEGER NOT NULL DEFAULT 0 CHECK (alerts_paused IN (0, 1));

-- A stored name waiting in Recently deleted, looked up by every upload init (src/uploads.js: without
-- this, each init read every account's Recently deleted) and by Devices and the Dashboard, which
-- name such a file by its Library name (pages/devices.js visibleDevices): one indexed read each. A
-- stored name carries its account's id, so the name alone finds that account's rows. Here, not in
-- 0019: a database that already ran 0019 gets it too.
CREATE INDEX IF NOT EXISTS idx_media_trash_filename ON media_trash(filename);

INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '20');
