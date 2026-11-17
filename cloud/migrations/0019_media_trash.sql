-- Recently deleted (src/pages/library.js): a Library delete moves each file's row here, with the
-- playlist places it held (`places`: a JSON array of {playlist_id, position, override}, position
-- being its place in that playlist's order), and keeps its R2 objects. Restore puts the row back
-- under its old id (media.id is AUTOINCREMENT, so nothing else ever took it) and the places back
-- where they were; Empty and the daily purge after 30 days remove the objects and the rows.
-- Deleting the account deletes its rows (the Users page removes their objects first).
CREATE TABLE IF NOT EXISTS media_trash (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    media_id INTEGER NOT NULL,
    filename TEXT NOT NULL,
    original_name TEXT NOT NULL,
    media_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    duration_seconds REAL,
    width INTEGER,
    height INTEGER,
    codec TEXT,
    sha256 TEXT NOT NULL,
    uploaded_at TEXT NOT NULL,
    places TEXT NOT NULL,
    deleted_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_media_trash_owner ON media_trash(owner_id, deleted_at);

-- Every media delete (Library, an account delete) looked up the file's playlist items by
-- media_id, a full scan of playlist_items each time: a 500-file delete read millions of rows.
CREATE INDEX IF NOT EXISTS idx_playlist_items_media ON playlist_items(media_id);

INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '19');
