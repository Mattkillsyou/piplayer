-- Dedupe and single-open-alert rules enforced by the database, not only by SELECT-then-act
-- checks that two concurrent requests can both pass (audit L11, L13). This migration FAILS on
-- a database that already holds two media rows with the same sha256 or two open alerts of one
-- kind for a device; find them first and pick which row to keep by hand (deleting a media row
-- cascades into playlist_items, so nothing is deleted here):
--   SELECT sha256, COUNT(*) FROM media GROUP BY sha256 HAVING COUNT(*) > 1;
--   SELECT device_id, kind, COUNT(*) FROM alerts WHERE closed_at IS NULL GROUP BY device_id, kind HAVING COUNT(*) > 1;
-- idx_alerts_open (0003, non-unique) keeps its name; a UNIQUE index needs a new one.
CREATE UNIQUE INDEX IF NOT EXISTS idx_media_sha256 ON media(sha256);
CREATE UNIQUE INDEX IF NOT EXISTS idx_alerts_one_open ON alerts(device_id, kind) WHERE closed_at IS NULL;

INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '6');
