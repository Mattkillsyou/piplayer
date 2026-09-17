-- Device-code sign-in for the SD flasher (device_codes.js): the flasher asks for a code
-- (POST /api/operator/device-code), the operator approves it on /authorize, the flasher polls
-- POST /api/operator/device-token and receives an api_tokens token once. Only the SHA-256 hex
-- of the device_code is stored; the minted token waits in token_plain_until_claimed until the
-- flasher collects it (the row is deleted then). ip feeds the per-IP rate limit. Rows are
-- short-lived: codes expire 10 minutes after created_at, housekeeping prunes after an hour.
CREATE TABLE IF NOT EXISTS device_codes (
    device_code_hash TEXT PRIMARY KEY,
    user_code TEXT NOT NULL UNIQUE,
    hostname TEXT NOT NULL,
    ip TEXT NOT NULL DEFAULT '-',
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    token_plain_until_claimed TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    approved_at TEXT,
    denied INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_device_codes_ip ON device_codes(ip, created_at);

INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '4');
