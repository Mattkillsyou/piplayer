"""Schema migration: init_schema() on a database created by the pre-fix release
(contracts 4 and 5: delivery_count / last_error added with a PRAGMA-guarded
ALTER TABLE; the audit_log index gains a tie-breaker on id).

Every already-deployed Pi takes this path on upgrade, and CREATE TABLE IF NOT
EXISTS never adds columns to an existing table, so the fresh-DB session the
rest of the suite runs against cannot see a broken migration. This module
builds a DB from the original schema text and upgrades it in place.
"""
import sqlite3

from cms_helpers import bearer

# The device_commands / devices / audit_log definitions exactly as the first release
# created them (cms/app/db.py at commit b184589), plus the tables they reference.
OLD_SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'admin' CHECK (role IN ('admin', 'editor', 'viewer')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS playlists (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

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
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS device_commands (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    command TEXT NOT NULL CHECK (command IN ('reboot', 'force-sync', 'restart-mpv')),
    issued_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    issued_at TEXT NOT NULL DEFAULT (datetime('now')),
    delivered_at TEXT,
    completed_at TEXT,
    result TEXT
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
    ON audit_log(created_at DESC);
"""

OLD_TOKEN = "old-release-token-0123456789abcdef"


def _columns(conn, table):
    return [r[1] for r in conn.execute(f"PRAGMA table_info({table})")]


def _schema_sql(conn):
    return sorted(r[0] or "" for r in conn.execute("SELECT sql FROM sqlite_master"))


def test_init_schema_upgrades_a_pre_fix_database_in_place(cms, client, monkeypatch, tok):
    old_db = cms.data_dir / f"upgrade-{tok}.db"
    conn = sqlite3.connect(old_db)
    conn.executescript(OLD_SCHEMA)
    conn.execute("INSERT INTO devices (device_id, name, token) VALUES (?, ?, ?)", (f"old-pi-{tok}", "Old Pi", OLD_TOKEN))
    conn.execute("INSERT INTO device_commands (device_id, command) VALUES (1, 'force-sync')")
    conn.execute("INSERT INTO audit_log (action) VALUES ('old-row')")
    conn.commit()
    assert "delivery_count" not in _columns(conn, "device_commands")
    assert "last_error" not in _columns(conn, "devices")
    conn.close()

    # db.connect() reads config.DB_PATH at call time, so the running app now uses the old DB.
    monkeypatch.setattr(cms.config, "DB_PATH", old_db)
    statements = []
    orig_connect = sqlite3.connect

    def spy_connect(*a, **kw):
        c = orig_connect(*a, **kw)
        c.set_trace_callback(statements.append)
        return c

    monkeypatch.setattr(cms.db.sqlite3, "connect", spy_connect)
    cms.db.init_schema()
    altered = [s for s in statements if s.lstrip().upper().startswith(("ALTER", "DROP INDEX"))]
    assert len(altered) == 3, altered

    conn = sqlite3.connect(old_db)
    assert "delivery_count" in _columns(conn, "device_commands")
    assert "last_error" in _columns(conn, "devices")
    idx = conn.execute("SELECT sql FROM sqlite_master WHERE name = 'idx_audit_log_created'").fetchone()[0]
    assert "id DESC" in idx
    # existing rows got the declared default, not NULL
    assert conn.execute("SELECT delivery_count FROM device_commands").fetchone()[0] == 0
    after_first = _schema_sql(conn)
    conn.close()

    # idempotent: a second start changes nothing
    statements.clear()
    cms.db.init_schema()
    assert [s for s in statements if s.lstrip().upper().startswith(("ALTER", "DROP", "CREATE INDEX idx_audit"))] == []
    conn = sqlite3.connect(old_db)
    assert _schema_sql(conn) == after_first
    conn.close()

    # the pre-existing device syncs against the migrated columns and receives its old command
    r = client.get(f"/api/sync/old-pi-{tok}", headers=bearer(OLD_TOKEN), params={"sync_error": "x"})
    assert r.status_code == 200, f"{r.status_code} {r.text[:300]}"
    assert [c["command"] for c in r.json()["commands"]] == ["force-sync"]
    conn = sqlite3.connect(old_db)
    assert conn.execute("SELECT delivery_count FROM device_commands").fetchone()[0] == 1
    assert conn.execute("SELECT last_error FROM devices").fetchone()[0] == "x"
    conn.close()
