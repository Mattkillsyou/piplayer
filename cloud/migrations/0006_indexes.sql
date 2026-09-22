-- Dedupe and single-open-alert rules enforced by the database, not only by SELECT-then-act
-- checks that two concurrent requests can both pass (audit L11, L13). A database that already
-- holds two media rows with the same sha256 or two open alerts of one kind for a device is
-- healed here before the indexes go on; nothing to do by hand. To see what it will touch:
--   SELECT sha256, COUNT(*) FROM media GROUP BY sha256 HAVING COUNT(*) > 1;
--   SELECT device_id, kind, COUNT(*) FROM alerts WHERE closed_at IS NULL GROUP BY device_id, kind HAVING COUNT(*) > 1;

-- Media: every playlist item that points at a duplicate row is moved to the oldest row with
-- that sha256, an item that now repeats a media row inside its playlist goes (lowest id kept),
-- then the duplicate rows are deleted. Their R2 objects stay behind as harmless orphans (the
-- library only ever reads through media.filename). Positions are not renumbered: playlists
-- read ORDER BY position, id, so a gap is fine.
UPDATE playlist_items SET media_id = (SELECT MIN(id) FROM media m2 WHERE m2.sha256 = (SELECT sha256 FROM media WHERE id = playlist_items.media_id))
  WHERE media_id NOT IN (SELECT MIN(id) FROM media GROUP BY sha256);
DELETE FROM playlist_items WHERE id NOT IN (SELECT MIN(id) FROM playlist_items GROUP BY playlist_id, media_id);
DELETE FROM media WHERE id NOT IN (SELECT MIN(id) FROM media GROUP BY sha256);

-- Alerts: all but the newest open alert per (device, kind) are closed now; notified_at stays.
UPDATE alerts SET closed_at = datetime('now')
  WHERE closed_at IS NULL AND id NOT IN (SELECT MAX(id) FROM alerts WHERE closed_at IS NULL GROUP BY device_id, kind);

-- idx_alerts_open (0003, non-unique) keeps its name; a UNIQUE index needs a new one.
CREATE UNIQUE INDEX IF NOT EXISTS idx_media_sha256 ON media(sha256);
CREATE UNIQUE INDEX IF NOT EXISTS idx_alerts_one_open ON alerts(device_id, kind) WHERE closed_at IS NULL;

INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '6');
