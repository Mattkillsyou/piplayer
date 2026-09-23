import sys
import tkinter as tk
import types
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import flasher  # noqa: E402


@pytest.fixture(autouse=True)
def _operator_config_sandbox(monkeypatch, tmp_path, request):
    """Never read or write the real %APPDATA% (sign-in token, SSH key), %LOCALAPPDATA% (settings) or, on macOS,
    ~/Library/Application Support (HOME is moved), and use a fixed SSH key so no test spends time on key
    generation or icacls."""
    monkeypatch.setenv("APPDATA", str(tmp_path / "appdata"))
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path / "localappdata"))
    monkeypatch.setenv("ProgramData", str(tmp_path / "programdata"))  # where a downloaded update waits
    # The real updates folder is locked to administrators (winhost.updates_dir), which a test process cannot
    # write to: a plain folder here instead, and test_updater checks the ACL call itself.
    updates = tmp_path / "updates"
    updates.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(flasher.updater, "updates_dir", lambda: updates)
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    if request.module.__name__ not in ("test_sshkey", "test_machost"):
        monkeypatch.setattr(flasher.sshkey, "ensure_keypair", lambda log=None: PUBKEY)
    # No netsh from the GUI tests: a PC with no Wi-Fi (test_wifi drives the real module with a fake netsh).
    monkeypatch.setattr(flasher, "wifi", fake_wifi())
    # On a Mac the host keeps the sign-in in the login keychain through `security`, which can put up a dialog
    # and wait: an in-memory keychain instead (test_machost drives the real module with a fake `security`).
    if sys.platform == "darwin" and request.module.__name__ != "test_machost":
        import machost
        vault = {}
        monkeypatch.setattr(machost, "seal_token", lambda token: vault.update(token=token) or {"token": "", "token_keychain": True})
        monkeypatch.setattr(machost, "open_token", lambda d: vault.get("token", "") if d.get("token_keychain")
                            else (d.get("token") or "").strip() if isinstance(d.get("token"), str) else "")
        monkeypatch.setattr(machost, "forget_token", lambda d: vault.clear())


def fake_wifi(networks=(), current=None, passwords=None):
    """A stand-in for the wifi module: what this PC sees, what it is connected to, the saved passwords."""
    pw = dict(passwords or {})
    return types.SimpleNamespace(scan_networks=lambda: list(networks), current_ssid=lambda: current,
                                 saved_password=lambda ssid: pw.get(ssid), saved_profiles=lambda: list(pw))


PUBKEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIIUL3nG/VzzJ6wyH+UdpX4KRzETi9LJnhz6FuBwRr0U5 projection5000-flasher@pc"

_shared_tk = []


def signed_in(monkeypatch, username="matt", token="p5k_stored_token"):
    """Store a sign-in before App() so the form shows straight away (the exe opens on the sign-in box otherwise);
    the background token check answers without a console."""
    import console
    flasher.save_operator_config(flasher.console_url(), token, username)
    monkeypatch.setattr(console, "me", lambda *a: {"username": username, "role": "editor"})


def new_root():
    """A window for one GUI test, skipping when there is no display. Windows: a fresh, withdrawn tk.Tk(). macOS:
    a Toplevel of one Tk kept for the whole session, left on screen: Tk/Aqua never returns from update() on a
    hidden window that is not the process's first once its geometry is set and its labels change (seen on the
    GitHub macOS runners; the real app has one window and is not affected)."""
    try:
        if sys.platform == "darwin":
            if not _shared_tk:
                base = tk.Tk()
                base.withdraw()
                _shared_tk.append(base)
            root = tk.Toplevel(_shared_tk[0])
            root.geometry("+0+0")
        else:
            root = tk.Tk()
            root.withdraw()
    except tk.TclError as e:
        pytest.skip(f"no display: {e}")
    return root
