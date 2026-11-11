-- Upload links (src/pages/links.js; Settings page "Upload links"): a secret web address,
-- /u/<token>, that lets someone without an account put files on the projectors of the account
-- that made the link. The token is the whole key (24 random bytes, urlsafe), so only its SHA-256
-- hex is stored, like api_tokens: the address is shown once, when the link is made. Revoking a
-- link deletes its row; deleting the account deletes its links with it. last_used_at is stamped
-- each time the link puts something on a projector.
CREATE TABLE IF NOT EXISTS upload_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_used_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_upload_links_user ON upload_links(user_id);

INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '17');
