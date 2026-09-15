-- Mirror of cms/app/db.py SCHEMA (including the post-release columns delivery_count and
-- last_error) plus the tables the cloud manager needs instead of process memory / disk:
-- settings, sessions, login_failures, uploads, meta.

CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'admin' CHECK (role IN ('admin', 'editor', 'viewer')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS media (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    filename TEXT NOT NULL UNIQUE,
    original_name TEXT NOT NULL,
    media_type TEXT NOT NULL CHECK (media_type IN ('video', 'image')),
    size_bytes INTEGER NOT NULL,
    duration_seconds REAL,
    width INTEGER,
    height INTEGER,
    codec TEXT,
    sha256 TEXT NOT NULL,
    uploaded_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS playlists (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS playlist_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
    media_id INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    duration_override_seconds REAL
);

CREATE INDEX IF NOT EXISTS idx_playlist_items_playlist
    ON playlist_items(playlist_id, position);

CREATE TABLE IF NOT EXISTS device_groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    playlist_id INTEGER REFERENCES playlists(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS devices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    token TEXT NOT NULL UNIQUE,
    playlist_id INTEGER REFERENCES playlists(id) ON DELETE SET NULL,
    group_id INTEGER REFERENCES device_groups(id) ON DELETE SET NULL,
    last_seen_at TEXT,
    last_ip TEXT,
    player_version TEXT,
    current_position INTEGER,
    current_filename TEXT,
    player_status TEXT,
    last_screenshot_at TEXT,
    last_error TEXT,                                     -- player's last sync_error report, NULL/empty = healthy
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS device_schedules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    priority INTEGER NOT NULL DEFAULT 0,
    start_time TEXT,                                     -- "HH:MM" 24-hour, NULL = no time bound
    end_time TEXT,                                       -- "HH:MM" 24-hour, NULL = no time bound
    days_of_week TEXT,                                   -- subset of "0123456" (0=Mon..6=Sun), NULL = all days
    start_date TEXT,                                     -- "YYYY-MM-DD", NULL = no date bound
    end_date TEXT,                                       -- "YYYY-MM-DD", NULL = no date bound
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_device_schedules_device
    ON device_schedules(device_id, priority DESC);

CREATE TABLE IF NOT EXISTS device_commands (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    command TEXT NOT NULL CHECK (command IN ('reboot', 'force-sync', 'restart-mpv')),
    issued_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    issued_at TEXT NOT NULL DEFAULT (datetime('now')),
    delivered_at TEXT,
    completed_at TEXT,
    result TEXT,
    delivery_count INTEGER NOT NULL DEFAULT 0            -- times handed to the player; capped, see api.js
);

CREATE INDEX IF NOT EXISTS idx_device_commands_pending
    ON device_commands(device_id, completed_at);

CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    username TEXT,
    action TEXT NOT NULL,
    target_type TEXT,
    target_id TEXT,
    details TEXT,
    ip TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_audit_log_created
    ON audit_log(created_at DESC, id DESC);

-- Cloud-only tables ---------------------------------------------------------

-- Site settings edited on /settings (timezone, screenshot_interval, default_image_duration).
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- Browser sessions. user_id is NULL for an anonymous session (login page, setup page) that
-- only exists to carry a CSRF token; login rotates the row (new id, new csrf).
CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    csrf TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

-- Failed-login throttle (5 failures per ip+username within 30 s -> 429). `at` is unix seconds.
CREATE TABLE IF NOT EXISTS login_failures (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ip TEXT NOT NULL,
    username TEXT NOT NULL,
    at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_login_failures_key ON login_failures(ip, username, at);

-- In-flight chunked uploads (R2 multipart). parts is a JSON array of {partNumber, etag}.
CREATE TABLE IF NOT EXISTS uploads (
    id TEXT PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    key TEXT NOT NULL,
    upload_id TEXT NOT NULL,
    name TEXT NOT NULL,
    size INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    media_type TEXT NOT NULL,
    duration_seconds REAL,
    width INTEGER,
    height INTEGER,
    parts TEXT NOT NULL DEFAULT '[]',
    received INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Schema marker; db.js checks this table exists so an unmigrated database fails loudly.
CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '1');
