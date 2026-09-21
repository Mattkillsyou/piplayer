import sys
import types
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import flasher  # noqa: E402


@pytest.fixture(autouse=True)
def _operator_config_sandbox(monkeypatch, tmp_path, request):
    """Never read or write the real %APPDATA% (sign-in token, SSH key), %LOCALAPPDATA% (settings) or, on macOS,
    ~/Library/Application Support (HOME is moved), never open a browser, and use a fixed SSH key so no test
    spends time on key generation or icacls."""
    monkeypatch.setenv("APPDATA", str(tmp_path / "appdata"))
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path / "localappdata"))
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    monkeypatch.setattr(flasher.webbrowser, "open", lambda url, *a, **k: pytest.fail(f"browser opened: {url}"))
    if request.module.__name__ not in ("test_sshkey", "test_machost"):
        monkeypatch.setattr(flasher.sshkey, "ensure_keypair", lambda log=None: PUBKEY)
    # No netsh from the GUI tests: a PC with no Wi-Fi (test_wifi drives the real module with a fake netsh).
    monkeypatch.setattr(flasher, "wifi", fake_wifi())


def fake_wifi(networks=(), current=None, passwords=None):
    """A stand-in for the wifi module: what this PC sees, what it is connected to, the saved passwords."""
    pw = dict(passwords or {})
    return types.SimpleNamespace(scan_networks=lambda: list(networks), current_ssid=lambda: current,
                                 saved_password=lambda ssid: pw.get(ssid), saved_profiles=lambda: list(pw))


PUBKEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIIUL3nG/VzzJ6wyH+UdpX4KRzETi9LJnhz6FuBwRr0U5 projection5000-flasher@pc"
