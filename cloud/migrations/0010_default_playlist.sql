-- One site-wide default playlist: every projector plays it unless a schedule rule matches or
-- the device / its group has a default playlist of its own (manifest.pick_playlist), and every
-- upload lands in it (uploads.uploadComplete). Its id lives under settings.default_playlist_id
-- (the Settings page can point that at another playlist); media in no playlist at all joins it
-- here, after whatever it already holds.
INSERT INTO playlists (name) SELECT 'Default' WHERE NOT EXISTS (SELECT 1 FROM playlists WHERE name = 'Default');
INSERT INTO settings (key, value) SELECT 'default_playlist_id', CAST(id AS TEXT) FROM playlists
 WHERE name = 'Default' AND NOT EXISTS (SELECT 1 FROM settings WHERE key = 'default_playlist_id');
INSERT INTO playlist_items (playlist_id, media_id, position)
SELECT p.id, m.id,
       (SELECT COALESCE(MAX(position), -1) FROM playlist_items WHERE playlist_id = p.id) + ROW_NUMBER() OVER (ORDER BY m.uploaded_at, m.id)
  FROM media m, playlists p
 WHERE p.id = (SELECT CAST(value AS INTEGER) FROM settings WHERE key = 'default_playlist_id')
   AND NOT EXISTS (SELECT 1 FROM playlist_items pi WHERE pi.media_id = m.id);

INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '10');
