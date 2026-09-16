import sqlite3
import secrets
from contextlib import contextmanager
from typing import Iterator

from . import config


# Remote commands the console may queue (also the CHECK on device_commands.command).
# SQLite cannot alter a CHECK: extending this list needs the rename-copy-drop in
# init_schema (_rebuild_device_commands), keyed on the newest value.
COMMANDS = ("reboot", "force-sync", "restart-mpv", "update-player", "update-os", "update-all",
            "projector-on", "projector-off")
# E: "ir-learn:<name>" is also admitted (CHECK ... OR command LIKE 'ir-learn:%'); the player answers
# with the learned Broadlink packet (base64) and api.report_command_result files it under <name>.
IR_CODE_NAMES = ("power_on", "power_off", "input_hdmi1")
PROJECTOR_CONTROLS = ("none", "broadlink", "cec")
PROJECTOR_MODES = ("manual", "auto")
_COMMAND_CHECK = ", ".join(f"'{c}'" for c in COMMANDS)

# Kept out of SCHEMA so _rebuild_device_commands can run them as single statements
# (executescript would COMMIT the half-done rename first).
DEVICE_COMMANDS_TABLE = f"""CREATE TABLE IF NOT EXISTS device_commands (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    command TEXT NOT NULL CHECK (command IN ({_COMMAND_CHECK}) OR command LIKE 'ir-learn:%'),
    issued_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    issued_at TEXT NOT NULL DEFAULT (datetime('now')),
    delivered_at TEXT,
    completed_at TEXT,
    result TEXT,
    delivery_count INTEGER NOT NULL DEFAULT 0            -- times handed to the player; capped, see api._pending_commands
)"""
DEVICE_COMMANDS_INDEX = """CREATE INDEX IF NOT EXISTS idx_device_commands_pending
    ON device_commands(device_id, completed_at)"""

SCHEMA = f"""
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
    last_camera_at TEXT,                                 -- camera snapshot (camera_<device_id>.jpg) timestamp
    camera_error TEXT,                                   -- player's last camera capture error, NULL = healthy
    camera_live_url TEXT,                                -- validated https URL or NULL (Devices page)
    last_update_at TEXT,                                 -- when the player last reported an update-player run
    last_update_ok INTEGER,                              -- 1 ok / 0 failed (sync update_status)
    last_update_message TEXT,
    last_update_ref TEXT,                                -- git ref that run installed
    projector_control TEXT,                              -- none|broadlink|cec (NULL = none)
    projector_ir_codes TEXT,                             -- JSON name -> base64 Broadlink packet (IR_CODE_NAMES)
    broadlink_host TEXT,                                 -- RM4 address; NULL = discover on the LAN
    projector_power_mode TEXT,                           -- manual|auto (NULL = manual)
    projector_power_state TEXT,                          -- on|off|unknown as last reported by the player
    projector_error TEXT,                                -- player's last projector control error, NULL = healthy
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

{DEVICE_COMMANDS_TABLE};

{DEVICE_COMMANDS_INDEX};

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

CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
"""

# Columns added after the first release. init_schema adds any that are missing
# (CREATE TABLE IF NOT EXISTS does nothing for existing tables), guarded by
# PRAGMA table_info so re-running is a no-op.
MIGRATIONS = [
    ("device_commands", "delivery_count", "INTEGER NOT NULL DEFAULT 0"),
    ("devices", "last_error", "TEXT"),
    ("devices", "last_camera_at", "TEXT"),
    ("devices", "camera_error", "TEXT"),
    ("devices", "camera_live_url", "TEXT"),
    ("devices", "last_update_at", "TEXT"),
    ("devices", "last_update_ok", "INTEGER"),
    ("devices", "last_update_message", "TEXT"),
    ("devices", "last_update_ref", "TEXT"),
    ("devices", "projector_control", "TEXT"),
    ("devices", "projector_ir_codes", "TEXT"),
    ("devices", "broadlink_host", "TEXT"),
    ("devices", "projector_power_mode", "TEXT"),
    ("devices", "projector_power_state", "TEXT"),
    ("devices", "projector_error", "TEXT"),
]


def connect() -> sqlite3.Connection:
    # 15 s busy timeout (sqlite3 default 5 s): device polls plus an admin reordering a
    # playlist can queue behind BEGIN IMMEDIATE on an SD card without surfacing 503s.
    conn = sqlite3.connect(config.DB_PATH, detect_types=sqlite3.PARSE_DECLTYPES, timeout=15)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    # WAL + NORMAL is durable across process crashes and halves the fsyncs per commit
    # (every device poll commits), which matters on an SD card.
    conn.execute("PRAGMA synchronous = NORMAL")
    return conn


@contextmanager
def cursor() -> Iterator[sqlite3.Cursor]:
    conn = connect()
    try:
        cur = conn.cursor()
        yield cur
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def _column_exists(conn: sqlite3.Connection, table: str, column: str) -> bool:
    cols = conn.execute(f"PRAGMA table_info({table})").fetchall()
    return any(c["name"] == column for c in cols)


def _rebuild_device_commands(conn: sqlite3.Connection) -> None:
    """Rename-copy-drop so the CHECK on device_commands.command accepts COMMANDS.

    Keeps rows, ids and the AUTOINCREMENT counter (a re-used id would look like a
    repeat to the player). Nothing references device_commands, so the rename is safe
    with foreign keys on."""
    cols = ", ".join(c["name"] for c in conn.execute("PRAGMA table_info(device_commands)").fetchall())
    conn.execute("ALTER TABLE device_commands RENAME TO device_commands_old")
    conn.execute("DROP INDEX IF EXISTS idx_device_commands_pending")   # moved with the table
    conn.execute(DEVICE_COMMANDS_TABLE)
    conn.execute(DEVICE_COMMANDS_INDEX)
    conn.execute(f"INSERT INTO device_commands ({cols}) SELECT {cols} FROM device_commands_old")
    conn.execute("DELETE FROM sqlite_sequence WHERE name = 'device_commands'")
    conn.execute("""INSERT INTO sqlite_sequence (name, seq)
                    SELECT 'device_commands', seq FROM sqlite_sequence WHERE name = 'device_commands_old'""")
    conn.execute("DROP TABLE device_commands_old")


def init_schema() -> None:
    config.ensure_dirs()
    conn = connect()
    try:
        conn.executescript(SCHEMA)
        for table, column, decl in MIGRATIONS:
            if not _column_exists(conn, table, column):
                conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {decl}")
                if (table, column) == ("device_commands", "delivery_count"):
                    # Pre-upgrade CMS re-sent a delivered-but-unreported command forever; do not
                    # hand those out 5 more times (a lost 'reboot' result would reboot the Pi
                    # again). Rows never delivered stay queued for their offline device.
                    conn.execute(
                        """UPDATE device_commands
                           SET completed_at = datetime('now'), result = 'closed at upgrade (no result)'
                           WHERE completed_at IS NULL AND delivered_at IS NOT NULL"""
                    )
        cmds = conn.execute("SELECT sql FROM sqlite_master WHERE name = 'device_commands'").fetchone()
        if f"'{COMMANDS[-1]}'" not in (cmds["sql"] or ""):
            _rebuild_device_commands(conn)
        # The original index was on created_at only; replace it so same-second rows order by id.
        idx = conn.execute("SELECT sql FROM sqlite_master WHERE name = 'idx_audit_log_created'").fetchone()
        if idx and "id DESC" not in (idx["sql"] or ""):
            conn.execute("DROP INDEX idx_audit_log_created")
            conn.execute("CREATE INDEX idx_audit_log_created ON audit_log(created_at DESC, id DESC)")
        conn.commit()
    finally:
        conn.close()


def prune_audit_log(retention_days: int) -> int:
    """Delete audit rows older than retention_days (0 = keep forever). Returns rows removed."""
    if retention_days <= 0:
        return 0
    with cursor() as cur:
        cur.execute(
            "DELETE FROM audit_log WHERE created_at < datetime('now', ?)",
            (f"-{int(retention_days)} days",),
        )
        return cur.rowcount


def new_token() -> str:
    return secrets.token_urlsafe(32)


ENROLLMENT_KEY = "enrollment_key"


def enrollment_key() -> str:
    """The secret a freshly flashed Pi presents to POST /api/enroll; generated on first read."""
    with cursor() as cur:
        cur.execute("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)", (ENROLLMENT_KEY, new_token()))
        return cur.execute("SELECT value FROM settings WHERE key = ?", (ENROLLMENT_KEY,)).fetchone()["value"]


def rotate_enrollment_key() -> str:
    """Replace the enrollment key; cards flashed with the old key that have not booted yet stop working."""
    key = new_token()
    with cursor() as cur:
        cur.execute("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", (ENROLLMENT_KEY, key))
    return key


ENROLL_DEFAULT_KEYS = {"enroll_group_id": "device_groups", "enroll_playlist_id": "playlists"}


def set_setting(cur: sqlite3.Cursor, key: str, value: str | None) -> None:
    """Upsert one settings row; None deletes it (absent = feature off)."""
    if value is None:
        cur.execute("DELETE FROM settings WHERE key = ?", (key,))
    else:
        cur.execute("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", (key, str(value)))


def enroll_defaults(cur: sqlite3.Cursor) -> dict[str, int | None]:
    """{enroll_group_id, enroll_playlist_id} for a first enrollment. A value whose
    group/playlist row was deleted since it was saved reads as None (not cleared on disk)."""
    out: dict[str, int | None] = {}
    for key, table in ENROLL_DEFAULT_KEYS.items():
        row = cur.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
        try:
            wanted = int(row["value"]) if row else None
        except ValueError:
            wanted = None
        if wanted is not None and not cur.execute(f"SELECT 1 FROM {table} WHERE id = ?", (wanted,)).fetchone():
            wanted = None
        out[key] = wanted
    return out
