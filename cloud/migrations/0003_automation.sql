-- Automation features A-G (one file, additive: append new ALTERs / CREATE TABLEs at the end,
-- never edit 0001/0002; keep the schema_version bump as the last statement).
-- A (auto-assign on enrollment): settings keys enroll_group_id / enroll_playlist_id live in the
-- existing `settings` table, no columns needed.
-- B (flasher key): personal operator API tokens (Settings page "My API tokens"; bearer
-- `p5k_<32 urlsafe chars>` on GET /api/operator/enrollment). Only the SHA-256 hex of the token
-- is stored; last_used_at throttles the api_token_used audit row to once per hour.
CREATE TABLE IF NOT EXISTS api_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_used_at TEXT
);

INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '3');
