"""Constants shared by conftest.py and the CMS test modules.

Kept out of conftest.py on purpose: pytest registers every conftest.py under the
bare module name `conftest`, so `from conftest import ...` resolves to whichever
suite's conftest was loaded first when cms/tests and player/tests are collected
in one run. Import from here instead.

Set PIPLAYER_CMS_ROOT to test another checkout of the CMS (a directory that
contains the `app` package) instead of the one next to this tests/ folder.
"""
import os
from pathlib import Path

TESTS_DIR = Path(__file__).resolve().parent
CMS_ROOT = Path(os.environ.get("PIPLAYER_CMS_ROOT") or TESTS_DIR.parent).resolve()

ADMIN_USERNAME = "admin"
ADMIN_PASSWORD = "test1234"
MAX_UPLOAD_BYTES = 2 * 1024 * 1024  # small so the 413 path is testable with tiny files
MAX_SCREENSHOT_BYTES = 512 * 1024
