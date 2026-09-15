import io
import subprocess
import sys
import tarfile
import threading
import time
import tkinter as tk
from pathlib import Path

import pytest

import firstboot
import flasher

FLASHER = Path(flasher.__file__)
DISK = {"number": 2, "name": "Generic MassStorageClass", "bus": "USB", "size": 31914983424, "sector": 512,
        "unique_id": "USBSTOR\\X&0:", "serial": "", "signature": 1, "boot": False,
        "label": "Disk 2  Generic MassStorageClass  29.7 GiB"}
FORM = {"device_id": "lobby", "name": "Lobby", "username": "pi", "password": "pw", "ssh": True, "ssid": "Venue",
        "wifi_password": "wp123456", "wifi_hidden": False, "ethernet_only": False, "timezone": "UTC", "keymap": "us",
        "wifi_country": "us", "console_url": "http://console.local/", "reg_mode": "register",
        "console_user": "admin", "console_password": "secret", "token": "", "image_mode": "local"}


def _root():
    try:
        root = tk.Tk()
    except tk.TclError as e:
        pytest.skip(f"no display: {e}")
    root.withdraw()
    return root


def _pump(root, app, until, timeout=3.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        root.update()
        if until():
            return True
        time.sleep(0.02)
    return until()


def test_selfcheck_prints_scripts():
    r = subprocess.run([sys.executable, str(FLASHER), "--selfcheck"], capture_output=True, text=True, timeout=60)
    assert r.returncode == 0, r.stderr
    assert "=== firstrun.sh ===" in r.stdout
    assert "set_hostname lobby-projector" in r.stdout
    assert "=== projection5000-provision.sh ===" in r.stdout
    assert "install-player.sh" in r.stdout
    assert "player archive:" in r.stdout and "tk:" in r.stdout
    assert firstboot.CMDLINE_ARGS in r.stdout


def test_player_archive_holds_the_player_tree():
    data = flasher.player_archive()
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as tar:
        names = tar.getnames()
        assert "player/deploy/install-player.sh" in names
        assert "player/player/daemon.py" in names and "player/requirements.txt" in names
        assert not any("__pycache__" in n or "/tests/" in n or n.endswith(".pyc") for n in names)
        for ti in tar.getmembers():
            assert ti.uid == 0 and ti.gid == 0


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
    # A corrupt or non-object settings file must not stop the program from starting.
    for junk in ("[]", "123", '"x"', "null", "true", "{not json"):
        (tmp_path / "Projection5000" / "flasher.json").write_text(junk)
        assert flasher.load_settings() == {}


def test_write_firstboot_files(tmp_path):
    (tmp_path / "cmdline.txt").write_text("console=tty1 root=PARTUUID=abc rootwait\n")
    flasher.write_firstboot_files(tmp_path, "#!/bin/bash\necho hi\n", "#!/bin/bash\necho prov\n", b"tgz")
    assert (tmp_path / "firstrun.sh").read_bytes() == b"#!/bin/bash\necho hi\n"
    assert (tmp_path / "projection5000-provision.sh").read_bytes() == b"#!/bin/bash\necho prov\n"
    assert (tmp_path / firstboot.PLAYER_ARCHIVE).read_bytes() == b"tgz"
    assert (tmp_path / "cmdline.txt").read_bytes() == \
        b"console=tty1 root=PARTUUID=abc rootwait " + firstboot.CMDLINE_ARGS.encode() + b"\n"
    # Not a Pi image (no cmdline.txt): refuse before writing anything.
    other = tmp_path / "other"
    other.mkdir()
    with pytest.raises(flasher.windisk.DiskError, match="cmdline.txt not found"):
        flasher.write_firstboot_files(other, "a", "b", b"c")
    assert list(other.iterdir()) == []


def test_gui_constructs(monkeypatch, tmp_path):
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path))
    monkeypatch.setattr(flasher.windisk, "list_disks", lambda: [DISK])
    root = _root()
    app = flasher.App(root)
    app.v["name"].set("Lobby Projector")
    assert _pump(root, app, lambda: bool(app.disks))  # the disk scan thread posts through the queue pump
    assert app.v["device_id"].get() == "lobby-projector"
    assert app.disk_box.get().startswith("Disk 2")
    v = app.values()
    assert v["username"] == "pi" and len(v["password"]) >= 16 and v["timezone"] == "America/Los_Angeles"
    # Text fields are stripped (pasted trailing spaces/newlines), passwords are not.
    app.v["device_id"].set("lobby-projector\n")
    app.v["password"].set(" keep me ")
    assert app.values()["device_id"] == "lobby-projector" and app.values()["password"] == " keep me "
    assert root.winfo_reqheight() <= root.winfo_screenheight() - 120
    root.destroy()


def test_refresh_keeps_selected_disk(monkeypatch, tmp_path):
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path))
    disk3 = dict(DISK, number=3, label="Disk 3  Reader B  (no card)", size=0)
    monkeypatch.setattr(flasher.windisk, "list_disks", lambda: [DISK, disk3])
    root = _root()
    app = flasher.App(root)
    assert _pump(root, app, lambda: bool(app.disks))
    app.disk_box.current(1)
    assert app.selected_disk()["number"] == 3
    app._show_disks([DISK, dict(disk3, size=1000, label="Disk 3  Reader B  0 MiB")], None)
    assert app.selected_disk()["number"] == 3  # still the operator's choice, with the fresh label
    app._show_disks([DISK], None)
    assert app.selected_disk()["number"] == 2
    assert "Target reset to Disk 2" in app.log_text.get("1.0", "end")
    root.destroy()


def test_pump_survives_a_raising_callback(monkeypatch, tmp_path):
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path))
    monkeypatch.setattr(flasher.windisk, "list_disks", lambda: [])
    root = _root()
    app = flasher.App(root)
    hits = []

    def boom():
        raise RuntimeError("callback boom")

    app.post(boom)
    app.post(lambda: hits.append(1))
    assert _pump(root, app, lambda: hits == [1])
    app.post(lambda: hits.append(2))
    assert _pump(root, app, lambda: hits == [1, 2])
    assert "callback boom" in app.log_text.get("1.0", "end")
    root.destroy()


def test_failed_flash_reenables_the_form_and_shows_the_error(monkeypatch, tmp_path):
    """Any exception in run_flash must end with a dialog and the Flash button back (not a frozen GUI)."""
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path))
    monkeypatch.setattr(flasher.windisk, "list_disks", lambda: [DISK])
    monkeypatch.setattr(flasher, "is_admin", lambda: True)
    errors = []
    monkeypatch.setattr(flasher.messagebox, "showerror", lambda *a, **k: errors.append(a))
    monkeypatch.setattr(flasher.messagebox, "askyesno", lambda *a, **k: True)
    monkeypatch.setattr(flasher.messagebox, "askokcancel", lambda *a, **k: True)

    def fail(*a, **k):
        raise flasher.console.ConsoleError("Invalid username or password")

    monkeypatch.setattr(flasher.console, "register_device", fail)
    img = tmp_path / "x.img"
    img.write_bytes(b"\x01" * 1024)
    root = _root()
    app = flasher.App(root)
    assert _pump(root, app, lambda: bool(app.disks))
    for k, val in FORM.items():
        app.v[k].set(val)
    app.v["image_path"].set(str(img))
    app.on_flash()
    assert str(app.flash_btn["state"]) == "disabled"
    assert _pump(root, app, lambda: str(app.flash_btn["state"]) == "normal", timeout=10)
    assert str(app.cancel_btn["state"]) == "disabled"
    assert errors and "Invalid username or password" in errors[-1][1]
    assert "FAILED: Invalid username or password" in app.log_text.get("1.0", "end")
    root.destroy()


def test_confirmations_default_to_no_and_recheck_the_disk(monkeypatch, tmp_path):
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path))
    monkeypatch.setattr(flasher.windisk, "list_disks", lambda: [DISK])
    monkeypatch.setattr(flasher, "is_admin", lambda: True)
    dialogs = []
    monkeypatch.setattr(flasher.messagebox, "showerror", lambda *a, **k: dialogs.append(("error", a, k)))
    monkeypatch.setattr(flasher.messagebox, "askyesno", lambda *a, **k: dialogs.append(("yesno", a, k)) or False)
    monkeypatch.setattr(flasher.messagebox, "askokcancel", lambda *a, **k: dialogs.append(("okcancel", a, k)) or False)
    img = tmp_path / "x.img"
    img.write_bytes(b"\x01" * 1024)
    root = _root()
    app = flasher.App(root)
    assert _pump(root, app, lambda: bool(app.disks))
    for k, val in FORM.items():
        app.v[k].set(val)
    app.v["image_path"].set(str(img))
    app.on_flash()
    assert dialogs[-1][0] == "yesno" and dialogs[-1][2]["default"] == flasher.messagebox.NO
    assert str(img) in dialogs[-1][1][1] and "http://console.local" in dialogs[-1][1][1]
    assert app.worker is None
    # A different card in the same reader (new signature/size) after Refresh: the flash is refused.
    monkeypatch.setattr(flasher.windisk, "list_disks", lambda: [dict(DISK, unique_id="USBSTOR\\Y&0:")])
    dialogs.clear()
    app.on_flash()
    assert dialogs[-1][0] == "error" and "target disk changed" in dialogs[-1][1][1]
    # Without admin rights a real flash is refused with a clear message.
    monkeypatch.setattr(flasher.windisk, "list_disks", lambda: [DISK])
    monkeypatch.setattr(flasher, "is_admin", lambda: False)
    dialogs.clear()
    app.on_flash()
    assert dialogs[-1][0] == "error" and "Restart as administrator" in dialogs[-1][1][1]
    root.destroy()


def test_close_during_flash_cancels_and_defaults_to_no(monkeypatch, tmp_path):
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path))
    monkeypatch.setattr(flasher.windisk, "list_disks", lambda: [])
    asked = []
    monkeypatch.setattr(flasher.messagebox, "askyesno", lambda *a, **k: asked.append(k) or True)
    root = _root()
    app = flasher.App(root)
    stop = threading.Event()

    def worker():
        app.cancel.wait(5)
        stop.set()

    app.worker = threading.Thread(target=worker, daemon=True)
    app.worker.start()
    app.on_close()
    assert asked and asked[0]["default"] == flasher.messagebox.NO
    assert app.cancel.is_set() and stop.is_set()


def _flash_stubs(monkeypatch, tmp_path, calls):
    """Stub every disk touching call so run_flash can be driven end to end against a temp file."""
    card = tmp_path / "card.bin"
    boot = tmp_path / "boot"
    boot.mkdir(exist_ok=True)
    (boot / "cmdline.txt").write_text("console=tty1 rootwait\n")
    monkeypatch.setattr(flasher.console, "register_device", lambda *a: ("tok-lobby-0123456789", True))
    monkeypatch.setattr(flasher.windisk, "check_disk", lambda d: calls.append("check"))
    monkeypatch.setattr(flasher.windisk, "clear_disk", lambda n, uid="": calls.append("clear"))
    monkeypatch.setattr(flasher.windisk, "volume_paths", lambda n: [])

    class Drive:
        def __init__(self, n, expect_size=0):
            self.f = open(card, "w+b")

        def __enter__(self):
            return self

        def __exit__(self, *a):
            self.f.close()

        def lock(self, paths):
            calls.append("lock")

        def write(self, b):
            return self.f.write(b)

        def read(self, n):
            return self.f.read(n)

        def seek(self, o, w=0):
            self.f.seek(o, w)

        def flush(self):
            self.f.flush()

        def refresh_partitions(self):
            calls.append("refresh")

    monkeypatch.setattr(flasher.windisk, "open_physical_drive", Drive)
    monkeypatch.setattr(flasher.windisk, "find_boot_volume",
                        lambda n, timeout=30.0, cancel_event=None, log=None: calls.append("find") or "Z")
    monkeypatch.setattr(flasher, "Path", lambda s: boot if str(s).startswith("Z:") else Path(s))
    monkeypatch.setattr(flasher.windisk, "eject", lambda letter: calls.append("eject"))
    return card, boot


def test_run_flash_end_to_end_with_stubs(monkeypatch, tmp_path):
    calls, lines = [], []
    card, boot = _flash_stubs(monkeypatch, tmp_path, calls)
    img = tmp_path / "x.img"
    img.write_bytes(bytes(range(256)) * 8)
    v = dict(FORM, image_path=str(img), disk_info=dict(DISK, size=1 << 20))
    flasher.run_flash(v, lines.append, lambda pct, text: None, threading.Event())
    assert calls == ["check", "clear", "lock", "refresh", "find", "eject"]
    assert card.read_bytes() == bytes(range(256)) * 8
    assert (boot / "firstrun.sh").read_bytes().startswith(b"#!/bin/bash\n")
    assert b"DEVICE_TOKEN=tok-lobby-0123456789" in (boot / "projection5000-provision.sh").read_bytes()
    assert (boot / firstboot.PLAYER_ARCHIVE).stat().st_size > 1000
    assert firstboot.CMDLINE_ARGS in (boot / "cmdline.txt").read_text()
    text = "\n".join(lines)
    assert "Registered, token received." in text and "SUMMARY" in text
    assert "password: pw" in text and "Record the password now" in text
    # Oversized image: refused before the card is touched.
    calls.clear()
    v["disk_info"] = dict(DISK, size=1024)
    with pytest.raises(flasher.windisk.DiskError, match="larger than the card"):
        flasher.run_flash(v, lines.append, lambda pct, text: None, threading.Event())
    assert calls == []
    # Reused registration is reported.
    lines.clear()
    v["disk_info"] = dict(DISK, size=1 << 20)
    monkeypatch.setattr(flasher.console, "register_device", lambda *a: ("tok-lobby-0123456789", False))
    flasher.run_flash(v, lines.append, lambda pct, text: None, threading.Event())
    assert any("already exists on the console: reusing its token" in s for s in lines)


def test_cancel_after_write_is_honoured_and_reported(monkeypatch, tmp_path):
    calls, lines = [], []
    card, boot = _flash_stubs(monkeypatch, tmp_path, calls)
    img = tmp_path / "x.img"
    img.write_bytes(b"\x01" * 4096)
    cancel = threading.Event()
    monkeypatch.setattr(flasher.windisk, "find_boot_volume",
                        lambda n, timeout=30.0, cancel_event=None, log=None: cancel.set() or "Z")
    v = dict(FORM, image_path=str(img), disk_info=dict(DISK, size=1 << 20))
    with pytest.raises(flasher.windisk.Cancelled, match="first-boot files are NOT"):
        flasher.run_flash(v, lines.append, lambda pct, text: None, cancel)
    assert not (boot / "firstrun.sh").exists() and "eject" not in calls
    # Cancel before the disk is touched: a plain cancellation, the card was never touched.
    calls.clear()
    cancel = threading.Event()
    monkeypatch.setattr(flasher.console, "register_device", lambda *a: cancel.set() or ("tok-lobby-0123456789", True))
    with pytest.raises(flasher.windisk.Cancelled) as e:
        flasher.run_flash(v, lines.append, lambda pct, text: None, cancel)
    assert str(e.value) == "" and calls == []
    # Cancel during the write: the card is reported unusable.
    cancel = threading.Event()
    monkeypatch.setattr(flasher.console, "register_device", lambda *a: ("tok-lobby-0123456789", True))
    with pytest.raises(flasher.windisk.Cancelled, match="NOT usable"):
        flasher.run_flash(v, lines.append, lambda pct, text: cancel.set() if "written" in text else None, cancel)


def test_failure_after_write_explains_the_card_state(monkeypatch, tmp_path):
    calls, lines = [], []
    _flash_stubs(monkeypatch, tmp_path, calls)
    img = tmp_path / "x.img"
    img.write_bytes(b"\x01" * 4096)

    def no_volume(n, timeout=30.0, cancel_event=None, log=None):
        raise flasher.windisk.DiskError("no FAT boot partition appeared on disk 2 within 30 s")

    monkeypatch.setattr(flasher.windisk, "find_boot_volume", no_volume)
    v = dict(FORM, image_path=str(img), disk_info=dict(DISK, size=1 << 20))
    with pytest.raises(flasher.windisk.DiskError) as e:
        flasher.run_flash(v, lines.append, lambda pct, text: None, threading.Event())
    assert "no FAT boot partition" in str(e.value) and "first-boot files were NOT" in str(e.value)


def test_dry_run_stops_before_disk(monkeypatch, tmp_path):
    img = tmp_path / "x.img"
    img.write_bytes(b"\x01" * 1024)
    monkeypatch.setattr(flasher.console, "register_device",
                        lambda url, user, pw, dev, name: (f"tok-{dev}-0123456789", True))
    monkeypatch.setattr(flasher.windisk, "clear_disk", lambda *a: pytest.fail("clear_disk called in dry run"))
    monkeypatch.setattr(flasher.windisk, "check_disk", lambda d: pytest.fail("check_disk called in dry run"))
    monkeypatch.setattr(flasher.windisk, "open_physical_drive",
                        lambda *a, **k: pytest.fail("open_physical_drive called in dry run"))
    v = dict(FORM, image_path=str(img), disk_info=None)
    lines = []
    flasher.run_flash(v, lines.append, lambda pct, text: None, threading.Event(), dry_run=True)
    assert any("Registering lobby on http://console.local" in s for s in lines)
    assert any(s.startswith("Dry run: would write x.img to") for s in lines)
    assert any("Dry run: device lobby now exists on http://console.local" in s for s in lines)
    assert not any("Wrote" in s or "SUMMARY" in s for s in lines)

    v["disk_info"] = {"number": 2, "name": "Generic MassStorageClass", "size": 1, "label": "Disk 2"}
    lines.clear()
    flasher.run_flash(v, lines.append, lambda pct, text: None, threading.Event(), dry_run=True)
    assert "Dry run: would write x.img to Disk 2 (Generic MassStorageClass). Nothing was written." in lines


def test_run_flash_validates_before_registering(monkeypatch, tmp_path):
    img = tmp_path / "x.img"
    img.write_bytes(b"\x01" * 1024)
    monkeypatch.setattr(flasher.console, "register_device", lambda *a: pytest.fail("registered with a bad form"))
    v = dict(FORM, image_path=str(img), disk_info=None, ssid="a\nb")
    with pytest.raises(ValueError, match="line breaks"):
        flasher.run_flash(v, lambda s: None, lambda pct, text: None, threading.Event(), dry_run=True)


def test_validate_applies_card_rules(monkeypatch, tmp_path):
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path))
    monkeypatch.setattr(flasher.windisk, "list_disks", lambda: [])
    root = _root()
    app = flasher.App(root, dry_run=True)
    errors = []
    monkeypatch.setattr(flasher.messagebox, "showerror", lambda *a: errors.append(a[1]))
    img = tmp_path / "x.img"
    img.write_bytes(b"\x01" * 1024)
    for k, val in FORM.items():
        app.v[k].set(val)
    app.v["image_path"].set(str(img))
    assert app.validate() is not None
    for key, val, fragment in [("wifi_country", "UK", "use GB"), ("wifi_country", "1!", "ISO 3166"),
                               ("username", "root", "not be root"), ("username", "Matt Brown", "Pi username"),
                               ("password", "a\nb", "line breaks"), ("wifi_password", "1234567", "8-63"),
                               ("ssid", "C:\\net", "backslash"), ("device_id", "hall-2-", "device_id"),
                               ("console_url", "http://projectors.photogen5000.com", "https://"),
                               ("timezone", "Europe/Londn x", "Timezone"), ("keymap", "us/dvorak", "Keyboard")]:
        old = app.v[key].get()
        app.v[key].set(val)
        assert app.validate() is None, (key, val)
        assert fragment in errors[-1], (key, val, errors[-1])
        app.v[key].set(old)
    app.v["reg_mode"].set("token")
    app.v["token"].set("tok'en")
    assert app.validate() is None and "Device token" in errors[-1]
    app.v["token"].set("A-valid_token_0123456789")
    assert app.validate() is not None
    zipped = tmp_path / "os.zip"
    zipped.write_bytes(b"PK\x03\x04" + b"\0" * 100)
    app.v["image_path"].set(str(zipped))
    assert app.validate() is None and "zip archive" in errors[-1]
    root.destroy()


def test_dry_run_validate_needs_no_disk(monkeypatch, tmp_path):
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path))
    monkeypatch.setattr(flasher.windisk, "list_disks", lambda: [])
    root = _root()
    app = flasher.App(root, dry_run=True)
    app.v["name"].set("Lobby")
    app.v["reg_mode"].set("token")
    app.v["token"].set("A-valid_token_0123456789")
    app.v["ssid"].set("Venue")
    app.v["wifi_password"].set("wp123456")
    errors = []
    monkeypatch.setattr(flasher.messagebox, "showerror", lambda *a: errors.append(a))
    monkeypatch.setattr(flasher, "is_admin", lambda: True)
    assert app.v["dry_run"].get() is True
    assert app.validate()["disk_info"] is None
    app.v["dry_run"].set(False)
    assert app.validate() is None
    assert "Select a target SD card." in errors[-1][1]
    root.destroy()


def test_generated_password_rotates_after_a_flash(monkeypatch, tmp_path):
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path))
    monkeypatch.setattr(flasher.windisk, "list_disks", lambda: [])
    root = _root()
    app = flasher.App(root)
    first = app.v["password"].get()
    app._finished()
    assert app.v["password"].get() != first and len(app.v["password"].get()) >= 16
    app.v["password"].set("operator-chosen")
    app._finished()
    assert app.v["password"].get() == "operator-chosen"
    root.destroy()


def _bundled_exe(tmp_path, data=bytes(range(256)) * 8):
    import lzma
    import bundle
    exe = tmp_path / "fake.exe"
    exe.write_bytes(b"MZ" + b"\0" * 5000)
    xz = tmp_path / "os.img.xz"
    xz.write_bytes(lzma.compress(data, format=lzma.FORMAT_XZ))
    return bundle.append_bundle(exe, xz, "raspios-lite-arm64-test.img.xz")


def test_obtain_image_bundled_never_touches_the_network(monkeypatch, tmp_path):
    b = _bundled_exe(tmp_path)
    monkeypatch.setattr(flasher.bundle, "find_bundle", lambda path=None: b)
    monkeypatch.setattr(flasher.imagefetch.urllib.request, "urlopen",
                        lambda *a, **k: pytest.fail("network touched in bundled mode"))
    lines = []
    image, sha = flasher.obtain_image({"image_mode": "bundled"}, lines.append, lambda p, t: None, threading.Event())
    assert image is b and sha == b.sha256
    assert any("Using bundled image raspios-lite-arm64-test.img.xz" in s for s in lines)
    monkeypatch.setattr(flasher.bundle, "find_bundle", lambda path=None: None)
    with pytest.raises(flasher.imagefetch.FetchError, match="no bundled image"):
        flasher.obtain_image({"image_mode": "bundled"}, lines.append, lambda p, t: None, threading.Event())


def test_run_flash_bundled_end_to_end(monkeypatch, tmp_path):
    calls, lines = [], []
    card, boot = _flash_stubs(monkeypatch, tmp_path, calls)
    b = _bundled_exe(tmp_path)
    monkeypatch.setattr(flasher.bundle, "find_bundle", lambda path=None: b)
    monkeypatch.setattr(flasher.imagefetch.urllib.request, "urlopen",
                        lambda *a, **k: pytest.fail("network touched in bundled mode"))
    v = dict(FORM, image_mode="bundled", image_path="", disk_info=dict(DISK, size=1 << 20))
    flasher.run_flash(v, lines.append, lambda pct, text: None, threading.Event())
    assert calls == ["check", "clear", "lock", "refresh", "find", "eject"]
    assert card.read_bytes() == bytes(range(256)) * 8
    text = "\n".join(lines)
    assert "Writing raspios-lite-arm64-test.img.xz to disk 2" in text
    assert "Image: raspios-lite-arm64-test.img.xz (bundled in this exe)" in text
    # Dry run names it too and stays off the network.
    lines.clear()
    flasher.run_flash(dict(v, disk_info=None), lines.append, lambda pct, text: None, threading.Event(), dry_run=True)
    assert any(s.startswith("Dry run: would write raspios-lite-arm64-test.img.xz to") for s in lines)
    # Oversized: refused with the bundled name before the card is touched.
    calls.clear()
    with pytest.raises(flasher.windisk.DiskError, match="raspios-lite-arm64-test.img.xz is larger than the card"):
        flasher.run_flash(dict(v, disk_info=dict(DISK, size=1024)), lines.append, lambda pct, text: None,
                          threading.Event())
    assert calls == []


def test_gui_offers_the_bundled_image_first(monkeypatch, tmp_path):
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path))
    monkeypatch.setattr(flasher.windisk, "list_disks", lambda: [])
    b = _bundled_exe(tmp_path)
    monkeypatch.setattr(flasher.bundle, "find_bundle", lambda path=None: b)
    root = _root()
    app = flasher.App(root)
    assert app.bundled is b and app.v["image_mode"].get() == "bundled"
    radios = [w for w in app.root.winfo_children()[0].winfo_children()[0].winfo_children()[4].winfo_children()
              if isinstance(w, flasher.ttk.Radiobutton)]
    assert radios[0].cget("text").startswith("Bundled: raspios-lite-arm64-test.img.xz (") and \
        radios[0].cget("value") == "bundled"
    assert len(radios) == 3
    # Confirmation dialog names the bundled image.
    monkeypatch.setattr(flasher, "is_admin", lambda: True)
    dialogs = []
    monkeypatch.setattr(flasher.messagebox, "showerror", lambda *a, **k: dialogs.append(("error", a[1])))
    monkeypatch.setattr(flasher.messagebox, "askyesno", lambda *a, **k: dialogs.append(("yesno", a[1])) or False)
    monkeypatch.setattr(flasher.windisk, "list_disks", lambda: [DISK])
    app._show_disks([DISK], None)
    for k, val in FORM.items():
        app.v[k].set(val)
    app.v["image_mode"].set("bundled")
    app.v["dry_run"].set(False)
    app.on_flash()
    assert dialogs[-1][0] == "yesno" and "Image: bundled raspios-lite-arm64-test.img.xz" in dialogs[-1][1]
    root.destroy()
    # The saved mode survives a restart of a bundled exe but falls back when this build has no bundle.
    flasher.save_settings(dict(FORM, image_mode="bundled"))
    root = _root()
    assert flasher.App(root).v["image_mode"].get() == "bundled"
    root.destroy()
    monkeypatch.setattr(flasher.bundle, "find_bundle", lambda path=None: None)
    root = _root()
    assert flasher.App(root).v["image_mode"].get() == "latest"
    root.destroy()
