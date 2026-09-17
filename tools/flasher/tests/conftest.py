import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import flasher  # noqa: E402


@pytest.fixture(autouse=True)
def _operator_config_sandbox(monkeypatch, tmp_path, request):
    """Never read or write the real %APPDATA% (sign-in token, SSH key) or %LOCALAPPDATA% (settings), never open
    a browser, and use a fixed SSH key so no test spends time on key generation or icacls."""
    monkeypatch.setenv("APPDATA", str(tmp_path / "appdata"))
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path / "localappdata"))
    monkeypatch.setattr(flasher.webbrowser, "open", lambda url, *a, **k: pytest.fail(f"browser opened: {url}"))
    if request.module.__name__ != "test_sshkey":
        monkeypatch.setattr(flasher.sshkey, "ensure_keypair", lambda log=None: PUBKEY)


PUBKEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIIUL3nG/VzzJ6wyH+UdpX4KRzETi9LJnhz6FuBwRr0U5 projection5000-flasher@pc"
