-- Self-service password reset by email (pages/forgot.js). users.email is optional: sign-up asks
-- for one from now on, accounts from before get theirs on the Users page; one account per address,
-- case-insensitively. A reset row holds only the sha256 of the mailed token, works once and for
-- 30 minutes (expires_at); housekeeping deletes rows older than a day.
ALTER TABLE users ADD COLUMN email TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower ON users(lower(email)) WHERE email IS NOT NULL AND email != '';

CREATE TABLE IF NOT EXISTS password_resets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL,
    used_at TEXT,
    ip TEXT
);
CREATE INDEX IF NOT EXISTS idx_password_resets_user ON password_resets(user_id);

INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '11');
