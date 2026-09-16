import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import flasher  # noqa: E402


@pytest.fixture(autouse=True)
def _operator_config_sandbox(monkeypatch, tmp_path):
    """Never read or write the real %APPDATA% operator config; the first-run prompt is cancelled unless a test
    answers it (simpledialog is modal and would hang a test under root.update())."""
    monkeypatch.setenv("APPDATA", str(tmp_path / "appdata"))
    monkeypatch.setattr(flasher.simpledialog, "askstring", lambda *a, **k: None)
