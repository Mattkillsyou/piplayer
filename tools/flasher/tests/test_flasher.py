import os
import subprocess
import sys
import threading
import time
import tkinter as tk
from pathlib import Path

import pytest

import firstboot
import flasher

FLASHER = Path(flasher.__file__)


def test_selfcheck_prints_scripts():
    r = subprocess.run([sys.executable, str(FLASHER), "--selfcheck"], capture_output=True, text=True, timeout=60)
    assert r.returncode == 0, r.stderr
    assert "=== firstrun.sh ===" in r.stdout
    assert "set_hostname lobby-projector" in r.stdout
    assert "=== projection5000-provision.sh ===" in r.stdout
    assert "install-player.sh" in r.stdout
    assert firstboot.CMDLINE_ARGS in r.stdout


def test_ensure_admin_paths(monkeypatch):
    calls = []
    monkeypatch.setattr(flasher, "is_admin", lambda: True)
    assert flasher.ensure_admin([]) is True

    monkeypatch.setattr(flasher, "is_admin", lambda: False)
    monkeypatch.setattr(flasher, "relaunch_elevated", lambda: calls.append("relaunch") or True)
    monkeypatch.setattr(flasher, "not_admin_message", lambda: calls.append("message"))
    assert flasher.ensure_admin([]) is False
    assert calls == ["relaunch"]

    calls.clear()
    monkeypatch.setattr(flasher, "relaunch_elevated", lambda: calls.append("relaunch") or False)
    assert flasher.ensure_admin([]) is False
    assert calls == ["relaunch", "message"]  # UAC declined: message box, no crash

    calls.clear()
    assert flasher.ensure_admin(["--elevated"]) is False
    assert calls == ["message"]  # never relaunch in a loop


def test_settings_never_store_secrets(monkeypatch, tmp_path):
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path))
    flasher.save_settings({"name": "Lobby", "password": "pi-secret", "wifi_password": "wifi-secret",
                           "console_password": "c-secret", "token": "tok", "ssid": "Venue"})
    text = (tmp_path / "Projection5000" / "flasher.json").read_text()
    assert "Lobby" in text and "Venue" in text
    for secret in ("pi-secret", "wifi-secret", "c-secret", "tok"):
        assert secret not in text
    assert flasher.load_settings()["name"] == "Lobby"


def test_write_firstboot_files(tmp_path):
    (tmp_path / "cmdline.txt").write_text("console=tty1 root=PARTUUID=abc rootwait\n")
    flasher.write_firstboot_files(tmp_path, "#!/bin/bash\necho hi\n", "#!/bin/bash\necho prov\n")
    assert (tmp_path / "firstrun.sh").read_bytes() == b"#!/bin/bash\necho hi\n"
    assert (tmp_path / "projection5000-provision.sh").read_bytes() == b"#!/bin/bash\necho prov\n"
    assert (tmp_path / "cmdline.txt").read_bytes() == \
        b"console=tty1 root=PARTUUID=abc rootwait " + firstboot.CMDLINE_ARGS.encode() + b"\n"


def test_gui_constructs(monkeypatch, tmp_path):
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path))
    monkeypatch.setattr(flasher.windisk, "list_disks",
                        lambda: [{"number": 2, "name": "Generic MassStorageClass", "bus": "USB",
                                  "size": 31914983424, "label": "Disk 2  Generic MassStorageClass  29.7 GB"}])
    try:
        root = tk.Tk()
    except tk.TclError as e:
        pytest.skip(f"no display: {e}")
    root.withdraw()
    app = flasher.App(root)
    app.v["name"].set("Lobby Projector")
    for _ in range(60):
        root.update()
        if app.disks:
            break
        time.sleep(0.05)  # the disk scan thread posts through the 50 ms queue pump
    assert app.v["device_id"].get() == "lobby-projector"
    assert app.disk_box.get().startswith("Disk 2")
    v = app.values()
    assert v["username"] == "pi" and len(v["password"]) >= 16 and v["timezone"] == "America/Los_Angeles"
    root.destroy()


def test_dry_run_stops_before_disk(monkeypatch, tmp_path):
    img = tmp_path / "x.img"
    img.write_bytes(b"\x01" * 1024)
    monkeypatch.setattr(flasher.console, "register_device",
                        lambda url, user, pw, dev, name: f"tok-{dev}-{url}")
    monkeypatch.setattr(flasher.windisk, "clear_disk", lambda n: pytest.fail("clear_disk called in dry run"))
    monkeypatch.setattr(flasher.windisk, "open_physical_drive",
                        lambda n: pytest.fail("open_physical_drive called in dry run"))
    v = {"device_id": "lobby", "name": "Lobby", "username": "pi", "password": "pw", "ssh": True, "ssid": "Venue",
         "wifi_password": "wp", "wifi_hidden": False, "ethernet_only": False, "timezone": "UTC", "keymap": "us",
         "wifi_country": "us", "console_url": "http://console.local/", "reg_mode": "register",
         "console_user": "admin", "console_password": "secret", "token": "", "image_mode": "local",
         "image_path": str(img), "disk_info": None}
    lines = []
    flasher.run_flash(v, lines.append, lambda pct, text: None, threading.Event(), dry_run=True)
    assert any("Registering lobby on http://console.local" in s for s in lines)
    assert any(s.startswith("Dry run: would write x.img to") for s in lines)
    assert not any("Wrote" in s or "SUMMARY" in s for s in lines)

    v["disk_info"] = {"number": 2, "name": "Generic MassStorageClass", "size": 1, "label": "Disk 2"}
    lines.clear()
    flasher.run_flash(v, lines.append, lambda pct, text: None, threading.Event(), dry_run=True)
    assert "Dry run: would write x.img to Disk 2 (Generic MassStorageClass). Nothing was written." in lines


def test_dry_run_validate_needs_no_disk(monkeypatch, tmp_path):
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path))
    monkeypatch.setattr(flasher.windisk, "list_disks", lambda: [])
    try:
        root = tk.Tk()
    except tk.TclError as e:
        pytest.skip(f"no display: {e}")
    root.withdraw()
    app = flasher.App(root, dry_run=True)
    app.v["name"].set("Lobby")
    app.v["reg_mode"].set("token")
    app.v["token"].set("t")
    app.v["ssid"].set("Venue")
    errors = []
    monkeypatch.setattr(flasher.messagebox, "showerror", lambda *a: errors.append(a))
    assert app.v["dry_run"].get() is True
    assert app.validate()["disk_info"] is None
    app.v["dry_run"].set(False)
    assert app.validate() is None
    assert "Select a target SD card." in errors[-1][1]
    root.destroy()
