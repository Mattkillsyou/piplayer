"""pytest configuration for the CMS test suite.

Run from the `cms` directory:

    .venv/Scripts/python.exe -m pytest tests          # Windows
    .venv/bin/python -m pytest tests                  # Linux / Pi

The CMS reads PIPLAYER_DATA_DIR and PIPLAYER_ADMIN_PASSWORD at import time
(app/config.py), so this file sets them BEFORE anything imports `app.main`.
Every session gets a fresh temporary data dir (database, media, screenshots)
that is deleted when the session ends; nothing is ever written inside the repo.

Shared constants (admin credentials, CMS root, upload cap) live in cms_support.py
so test modules never have to import `conftest` by name.
"""
import logging
import os
import secrets
import shutil
import sys
import tempfile
import time
import types
from pathlib import Path

import pytest

TESTS_DIR = Path(__file__).resolve().parent

# Make the tests' helper modules importable before anything imports them.
if str(TESTS_DIR) in sys.path:
    sys.path.remove(str(TESTS_DIR))
sys.path.insert(0, str(TESTS_DIR))

from cms_support import (ADMIN_PASSWORD, ADMIN_USERNAME, CMS_ROOT, MAX_SCREENSHOT_BYTES,  # noqa: E402
                         MAX_UPLOAD_BYTES)

# Make `app` resolve to the CMS under test.
if str(CMS_ROOT) in sys.path:
    sys.path.remove(str(CMS_ROOT))
sys.path.insert(0, str(CMS_ROOT))

DATA_DIR = Path(tempfile.mkdtemp(prefix="piplayer-tests-"))
os.environ["PIPLAYER_DATA_DIR"] = str(DATA_DIR)
os.environ["PIPLAYER_ADMIN_PASSWORD"] = ADMIN_PASSWORD
os.environ["PIPLAYER_ADMIN_USERNAME"] = ADMIN_USERNAME
os.environ["PIPLAYER_MAX_UPLOAD_BYTES"] = str(MAX_UPLOAD_BYTES)
os.environ["PIPLAYER_SCREENSHOT_INTERVAL"] = "60"
os.environ["PIPLAYER_MAX_SCREENSHOT_BYTES"] = str(MAX_SCREENSHOT_BYTES)
for _var in ("PIPLAYER_SECRET_KEY", "PIPLAYER_PUBLIC_BASE_URL", "PIPLAYER_HTTPS_ONLY"):
    os.environ.pop(_var, None)

# A stale .upload_*.tmp left by a crashed upload must be swept at startup (contract 11);
# it is seeded here, before app.main is imported, and checked by test_cms_media.
STARTUP_STALE_TMP = DATA_DIR / "media" / ".upload_startup_stale.tmp"
STARTUP_STALE_TMP.parent.mkdir(parents=True, exist_ok=True)
STARTUP_STALE_TMP.write_bytes(b"crashed upload")
_two_hours_ago = time.time() - 2 * 3600
os.utime(STARTUP_STALE_TMP, (_two_hours_ago, _two_hours_ago))


class _ListHandler(logging.Handler):
    """Collects the log records emitted while `app.main` is imported (startup)."""

    def __init__(self):
        super().__init__(level=logging.DEBUG)
        self.records = []

    def emit(self, record):
        self.records.append(record)


STARTUP_LOG = _ListHandler()
logging.getLogger().setLevel(logging.INFO)


def _import_cms():
    root = logging.getLogger()
    root.addHandler(STARTUP_LOG)
    try:
        import app.main as main_mod  # noqa: WPS433  (import at call time on purpose)
    finally:
        root.removeHandler(STARTUP_LOG)
    from app import auth, config, db, schedules  # noqa: E402
    from app.routes import api as api_routes  # noqa: E402
    from app.routes import web as web_routes  # noqa: E402

    return types.SimpleNamespace(
        app=main_mod.app,
        main=main_mod,
        auth=auth,
        config=config,
        db=db,
        schedules=schedules,
        api_routes=api_routes,
        web_routes=web_routes,
        startup_records=STARTUP_LOG.records,
        startup_stale_tmp=STARTUP_STALE_TMP,
        data_dir=DATA_DIR,
        root=CMS_ROOT,
    )


@pytest.fixture(scope="session")
def cms():
    """The imported CMS: `.app` (FastAPI), `.config`, `.db`, `.schedules`, ..."""
    return _import_cms()


@pytest.fixture
def tok():
    """A short unique token to build names that never collide with earlier tests."""
    return secrets.token_hex(3)


@pytest.fixture
def client(cms):
    """A fresh anonymous TestClient (own cookie jar)."""
    from fastapi.testclient import TestClient

    with TestClient(cms.app) as c:
        yield c


@pytest.fixture
def admin(cms):
    """A TestClient logged in as the admin user."""
    from fastapi.testclient import TestClient

    from cms_helpers import login

    with TestClient(cms.app) as c:
        r = login(c, ADMIN_USERNAME, ADMIN_PASSWORD)
        assert r.status_code == 303, f"admin login failed: {r.status_code} {r.text[:300]}"
        yield c


@pytest.fixture
def make_client(cms):
    """Factory for extra TestClients (viewer / editor / second admin)."""
    from fastapi.testclient import TestClient

    clients = []

    def _make():
        c = TestClient(cms.app)
        c.__enter__()
        clients.append(c)
        return c

    yield _make
    for c in clients:
        c.__exit__(None, None, None)


@pytest.fixture(scope="session")
def media_dir(tmp_path_factory):
    return tmp_path_factory.mktemp("media-src")


@pytest.fixture
def make_media(media_dir, tok):
    """Factory: make_media('mp4' | 'png', name=None) -> Path with unique content."""
    from cms_mediagen import make_mp4, make_png

    counter = {"n": 0}

    def _make(kind, name=None):
        counter["n"] += 1
        seed = secrets.token_hex(8)
        name = name or f"{kind}_{tok}_{counter['n']}.{kind}"
        path = media_dir / name
        if kind == "mp4":
            make_mp4(path, seed=seed)
        elif kind == "png":
            make_png(path, seed=seed)
        else:
            raise ValueError(kind)
        return path

    return _make


def pytest_configure(config):
    # Keep pytest's own cache (.pytest_cache) out of the repo: point it at the
    # per-session temp dir. Uses a private pytest API, so fall back silently.
    try:
        from _pytest.cacheprovider import Cache

        config.cache = Cache(DATA_DIR / ".pytest_cache", config, _ispytest=True)
    except Exception:  # pragma: no cover - older/newer pytest layout
        pass


def pytest_sessionfinish(session, exitstatus):
    shutil.rmtree(DATA_DIR, ignore_errors=True)
