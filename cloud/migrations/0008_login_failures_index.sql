-- The per-account login ceiling (auth.js) scans login_failures by username; the only index so far was by IP.
CREATE INDEX IF NOT EXISTS idx_login_failures_user ON login_failures(username, at);

INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '8');
