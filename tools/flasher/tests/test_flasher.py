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
from conftest import PUBKEY, fake_wifi
from test_console import OPERATOR_TOKEN, StubConsole, _serve

FLASHER = Path(flasher.__file__)
DISK = {"number": 2, "name": "Generic MassStorageClass", "bus": "USB", "size": 31914983424, "sector": 512,
        "unique_id": "USBSTOR\\X&0:", "serial": "", "signature": 1, "boot": False,
        "label": "Disk 2  Generic MassStorageClass  29.7 GiB"}
KEY = "form-enrollment-key_0123456789abcdef"
# The widgets of the one screen (plus Advanced), as the operator fills them.
FORM = {"name": "Lobby", "ssid": "Venue", "wifi_password": "wp123456", "wifi_hidden": False, "timezone": "UTC",
        "keymap": "us", "wifi_country": "us", "token": "", "image_mode": "local", "image_path": "", "static_ip": "",
        "gateway": ""}
# What App.values() adds from outside the widgets (the fixed login, the baked key, the sign-in, the SSH key).
FULL = dict(FORM, device_id="lobby", username="projector-admin", password="pw", console_url="http://console.local/",
            enrollment_key=KEY, operator_token="", ssh_pubkey=PUBKEY, dry_run=False)
ENROLLMENT = {"console_url": "https://c.example", "enrollment_key": KEY, "timezone": "UTC",
              "groups": [{"id": 1, "name": "Lobby"}], "playlists": [{"id": 7, "name": "Loop"}], "wyze_configured": False}


_roots = []


def _root():
    try:
        root = tk.Tk()
    except tk.TclError as e:
        pytest.skip(f"no display: {e}")
    root.withdraw()
    _roots.append(root)
    return root


@pytest.fixture(autouse=True)
def _no_leaked_roots():
    """A test that fails before root.destroy() would leave a Tk interpreter whose pump keeps running and whose
    _default_root captures the next test's variables: destroy leftovers after every test."""
    yield
    for root in _roots:
        try:
            root.destroy()
        except tk.TclError:
            pass
    _roots.clear()


def _pump(root, app, until, timeout=3.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        root.update()
        if until():
            return True
        time.sleep(0.02)
    return until()


def _fill(app, **over):
    for k, val in dict(FORM, **over).items():
        app.v[k].set(val)


def _log(app):
    return app.log_text.get("1.0", "end")


def _shown_errors(app):
    return {f: lbl.cget("text") for f, lbl in app.err.items() if lbl.winfo_manager()}


def test_selfcheck_prints_scripts():
    r = subprocess.run([sys.executable, str(FLASHER), "--selfcheck"], capture_output=True, text=True, timeout=60)
    assert r.returncode == 0, r.stderr
    assert "=== firstrun.sh ===" in r.stdout
    assert "set_hostname lobby-projector" in r.stdout
    assert "=== projection5000-provision.sh ===" in r.stdout
    assert "install-player.sh" in r.stdout
    assert "player archive:" in r.stdout and "tk:" in r.stdout
    assert firstboot.CMDLINE_ARGS in r.stdout
    assert "\nconsole: " in r.stdout  # what this build talks to (the default when run from source)
    assert "\ndefaults from Windows: timezone " in r.stdout and "ssh key " in r.stdout
    assert '"$CONSOLE/api/enroll"' in r.stdout


def test_console_json_resource_frozen_and_source(monkeypatch, tmp_path):
    # Source mode: next to flasher.py (a checkout normally has none: the product default, no crash).
    src = tmp_path / "src"
    src.mkdir()
    monkeypatch.setattr(flasher, "__file__", str(src / "flasher.py"))
    assert flasher.resource_path("build_info.txt") == src / "build_info.txt"
    assert flasher.console_defaults() == {"console_url": "", "enrollment_key": ""}
    assert flasher.console_url() == flasher.DEFAULT_CONSOLE_URL
    assert flasher.console_summary().startswith("console: none baked in")
    flasher.write_console_json(src / "console.json", "https://c.example/", " " + KEY + " ")
    assert flasher.console_defaults() == {"console_url": "https://c.example", "enrollment_key": KEY}
    assert flasher.console_url() == "https://c.example"
    assert flasher.console_summary() == "console: https://c.example (enrollment key: set)"
    # Damaged or partial file: still starts.
    (src / "console.json").write_text('{"console_url": 5, "enrollment_key": "k"}')
    assert flasher.console_defaults() == {"console_url": "", "enrollment_key": "k"}
    (src / "console.json").write_text("[1,")
    assert flasher.console_defaults() == {"console_url": "", "enrollment_key": ""}
    # Frozen mode: PyInstaller's _MEIPASS holds what --add-data staged.
    mei = tmp_path / "mei"
    mei.mkdir()
    (mei / "build_info.txt").write_text("built now\n")
    (mei / "console.json").write_text('{"console_url": "https://frozen.example", "enrollment_key": ""}')
    monkeypatch.setattr(flasher.sys, "frozen", True, raising=False)
    monkeypatch.setattr(flasher.sys, "_MEIPASS", str(mei), raising=False)
    assert flasher.build_info() == "built now"
    assert flasher.console_summary() == "console: https://frozen.example (enrollment key: fetched with the operator token)"
    # A URL-only console.json is the normal build (the key comes from the console at flash time).
    flasher.write_console_json(mei / "console.json", "https://frozen.example/")
    assert flasher.console_defaults() == {"console_url": "https://frozen.example", "enrollment_key": ""}
    (mei / "build_info.txt").unlink()
    assert flasher.build_info() == "frozen build, no build_info.txt"
    # build.ps1 refuses a bad key or URL before PyInstaller runs.
    with pytest.raises(ValueError, match="Enrollment key"):
        flasher.write_console_json(src / "console.json", "https://c.example", "short")
    with pytest.raises(ValueError, match="https://"):
        flasher.write_console_json(src / "console.json", "http://c.example", KEY)


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


def test_settings_never_store_secrets(tmp_path):
    flasher.save_settings({"name": "Lobby", "password": "pi-secret", "wifi_password": "wifi-secret",
                           "enrollment_key": "k-secret", "token": "tok", "operator_token": "p5k_secret",
                           "ssh_pubkey": "ssh-ed25519 AAAA", "ssid": "Venue", "static_ip": "10.0.0.5/24"})
    path = tmp_path / "localappdata" / "Projection5000" / "flasher.json"
    text = path.read_text()
    assert "Lobby" in text and "Venue" in text and "10.0.0.5/24" in text
    for secret in ("pi-secret", "wifi-secret", "k-secret", "tok", "p5k_secret", "ssh-ed25519"):
        assert secret not in text
    assert flasher.load_settings()["name"] == "Lobby"
    # A corrupt or non-object settings file must not stop the program from starting.
    for junk in ("[]", "123", '"x"', "null", "true", "{not json"):
        path.write_text(junk)
        assert flasher.load_settings() == {}


def test_operator_config_round_trip_is_dpapi_protected(tmp_path):
    path = Path(tmp_path / "appdata" / "Projection5000" / "flasher.json")  # APPDATA from conftest
    assert flasher.operator_config_path() == path
    assert flasher.load_operator_config() == {"console_url": "", "token": "", "username": ""}  # no file yet
    assert flasher.save_operator_config("https://c.example/", " " + OPERATOR_TOKEN + " ", " matt ") == ""
    text = path.read_text("utf-8")
    assert OPERATOR_TOKEN not in text and '"token_dpapi": true' in text and "https://c.example" in text
    assert flasher.load_operator_config() == {"console_url": "https://c.example", "token": OPERATOR_TOKEN,
                                              "username": "matt"}
    # A blob from another account (or a damaged file) reads back as "no token": sign in again.
    path.write_text(text.replace('"token": "', '"token": "AAAA'), "utf-8")
    assert flasher.load_operator_config() == {"console_url": "https://c.example", "token": "", "username": "matt"}
    for junk in ("[]", "{not json", '{"console_url": 5, "token": 7}'):
        path.write_text(junk, "utf-8")
        assert flasher.load_operator_config() == {"console_url": "", "token": "", "username": ""}
    # Sign out deletes the file; signing out twice is fine.
    flasher.save_operator_config("https://c.example", OPERATOR_TOKEN, "matt")
    flasher.clear_operator_config()
    flasher.clear_operator_config()
    assert not path.exists() and flasher.load_operator_config()["token"] == ""


def test_dpapi_prefers_win32crypt_and_falls_back_to_crypt32(monkeypatch):
    import sys
    import types

    calls = []
    fake = types.ModuleType("win32crypt")
    fake.CryptProtectData = lambda data, *a: calls.append(("protect", data)) or b"blob:" + data
    fake.CryptUnprotectData = lambda data, *a: calls.append(("unprotect", data)) or ("", data[5:])
    monkeypatch.setitem(sys.modules, "win32crypt", fake)
    assert flasher._dpapi(b"tok", protect=True) == b"blob:tok"
    assert flasher._dpapi(b"blob:tok", protect=False) == b"tok"
    assert calls == [("protect", b"tok"), ("unprotect", b"blob:tok")]
    # Without pywin32 (the venv and the frozen exe) the same calls go through ctypes crypt32.
    monkeypatch.setitem(sys.modules, "win32crypt", None)
    blob = flasher._dpapi(b"tok", protect=True)
    assert blob != b"tok" and flasher._dpapi(blob, protect=False) == b"tok"


def test_operator_config_falls_back_to_plain_text_with_a_warning(monkeypatch, tmp_path):
    def no_dpapi(data, protect):
        raise OSError("no crypt32")

    monkeypatch.setattr(flasher, "_dpapi", no_dpapi)
    warning = flasher.save_operator_config("https://c.example", OPERATOR_TOKEN)
    assert warning.startswith("WARNING: DPAPI is not available") and "flasher.json" in warning
    text = flasher.operator_config_path().read_text("utf-8")
    assert OPERATOR_TOKEN in text and '"token_dpapi": false' in text
    assert flasher.load_operator_config()["token"] == OPERATOR_TOKEN


# ---------------------------------------------------------------- the one screen

def test_gui_shows_exactly_the_per_pi_fields(monkeypatch):
    """The visible top level: console header, Sign in, Device name, Wi-Fi network, Wi-Fi password, SD card,
    Refresh, Flash, Advanced. Everything else is helper text, collapsed, or under Advanced."""
    monkeypatch.setattr(flasher.windisk, "list_disks", lambda: [])
    root = _root()
    app = flasher.App(root)
    root.update()

    def visible(w, out):
        if not w.winfo_manager():
            return  # collapsed: its children are not on screen either
        if isinstance(w, flasher.ttk.Button) or (isinstance(w, flasher.ttk.Label) and w.grid_info().get("column") == 0):
            if w.cget("text"):
                out.append(w.cget("text"))
        for c in w.winfo_children():
            visible(c, out)

    fields = []
    for c in root.winfo_children():
        visible(c, fields)
    assert fields == ["Console: projectors.photogen5000.com", "Sign in", "Device name", "Wi-Fi network",
                      "Wi-Fi password", "SD card", "Refresh", "Flash", "Advanced"]
    # No field ever holds the console URL, a username, a password, a key or a token on the main screen.
    entries = [w for w in app.id_label.master.winfo_children() if isinstance(w, flasher.ttk.Entry)]
    assert [e.cget("textvariable") for e in entries] == [str(app.v[k]) for k in ("name", "ssid", "wifi_password",
                                                                                   "disk")]
    # The network is an editable Combobox (the networks this PC sees, any other name typed), the rest are Entries.
    assert isinstance(app.ssid_box, flasher.ttk.Combobox) and str(app.ssid_box["state"]) == "normal"
    assert [isinstance(e, flasher.ttk.Combobox) for e in entries] == [False, True, False, True]
    assert not app.advanced.winfo_manager() and not app.cancel_btn.winfo_manager()
    # Advanced opens one frame with the rest; the button toggles it.
    app.adv_btn.invoke()
    assert app.advanced.winfo_manager() == "pack"
    texts = []
    visible(app.advanced, texts)
    assert texts == ["Image", "Browse...", "Timezone", "Keyboard layout", "Wi-Fi country", "Static IP", "Gateway",
                     "Existing device token", "SSH key", "Copy public key", "Sign out"]
    assert any(isinstance(w, flasher.ttk.Checkbutton) and w.cget("text").startswith("Hidden Wi-Fi")
               for w in app.advanced.winfo_children())
    assert any(isinstance(w, flasher.ttk.Label) and w.cget("text").startswith("Build: ")
               for w in app.advanced.winfo_children())
    app.adv_btn.invoke()
    assert not app.advanced.winfo_manager()
    root.destroy()


def test_wifi_dropdown_lists_the_networks_and_fills_a_saved_password(monkeypatch):
    monkeypatch.setattr(flasher.windisk, "list_disks", lambda: [])
    nets = [{"ssid": "Cafe", "signal": 60, "auth": "Open"}, {"ssid": "Venue", "signal": 30, "auth": "WPA2-Personal"},
            {"ssid": "Far", "signal": 3, "auth": "WPA2-Personal"}]
    monkeypatch.setattr(flasher, "wifi", fake_wifi(nets, current="Venue", passwords={"Venue": "p4ss: word 1"}))
    root = _root()
    app = flasher.App(root)
    assert app.ssid_hint.cget("text") == "scanning ..."
    assert _pump(root, app, lambda: list(app.ssid_box["values"]) == ["Venue", "Cafe", "Far"])  # connected one first
    assert app.ssid_hint.cget("text") == "leave blank for a wired Pi" and app.pw_hint.cget("text") == ""
    # Picking a network with a profile on this PC fills the password (from netsh, off the Tk thread).
    app.ssid_box.set("Venue")
    app.ssid_box.event_generate("<<ComboboxSelected>>")
    assert _pump(root, app, lambda: app.v["wifi_password"].get() == "p4ss: word 1")
    assert app.pw_hint.cget("text") == "password from this PC"
    assert "p4ss" not in _log(app)
    # Editing the password drops the hint; picking a network without a profile leaves the field alone.
    app.v["wifi_password"].set("p4ss: word 2")
    assert app.pw_hint.cget("text") == ""
    app.ssid_box.set("Cafe")
    app.ssid_box.event_generate("<<ComboboxSelected>>")
    root.update()
    time.sleep(0.1)
    root.update()
    assert app.v["wifi_password"].get() == "p4ss: word 2"
    # A typed name that is not in the list is an ordinary value with the ordinary rules.
    app.baked_key = KEY
    _fill(app, ssid="Typed Net", wifi_password="wp123456", image_mode="latest")
    app.v["dry_run"].set(True)
    v = app.validate()
    assert v is not None and flasher.card_cfg(v)["ssid"] == "Typed Net" and _shown_errors(app) == {}
    _fill(app, ssid="C:\\net", image_mode="latest")
    assert app.validate() is None and _shown_errors(app) == {"ssid": "Wi-Fi SSID must not contain a backslash."}
    # Refresh rescans; nothing seen: the box is empty and editable with a hint to type the name.
    monkeypatch.setattr(flasher, "wifi", fake_wifi())
    app.refresh_networks()
    assert _pump(root, app, lambda: app.ssid_hint.cget("text") == "type the network name")
    assert list(app.ssid_box["values"]) == [] and app.v["ssid"].get() == "C:\\net"
    # Windows 11 with Location off for desktop apps: connected, but the scan shows nothing.
    monkeypatch.setattr(flasher, "wifi", fake_wifi(current="Venue"))
    app.refresh_networks()
    assert _pump(root, app, lambda: app.ssid_hint.cget("text") == flasher.LOCATION_HINT)
    assert list(app.ssid_box["values"]) == []
    root.destroy()


def test_gui_constructs_with_windows_defaults(monkeypatch):
    monkeypatch.setattr(flasher.windisk, "list_disks", lambda: [DISK])
    monkeypatch.setattr(flasher.winlocale, "timezone", lambda name=None: "Europe/London")
    monkeypatch.setattr(flasher.winlocale, "keymap", lambda langid=None: "gb")
    monkeypatch.setattr(flasher.winlocale, "country", lambda valid=None: "GB")
    root = _root()
    app = flasher.App(root)
    app.v["name"].set("Lobby Projector")
    assert _pump(root, app, lambda: bool(app.disks))  # the disk scan thread posts through the queue pump
    assert app.id_label.cget("text") == "device id (hostname): lobby-projector"
    assert app.disk_box.get().startswith("Disk 2")
    v = app.values()
    assert v["device_id"] == "lobby-projector" and v["username"] == "projector-admin"
    assert len(v["password"]) >= 24 and v["password"] not in _log(app)  # random, never shown
    assert v["timezone"] == "Europe/London" and v["keymap"] == "gb" and v["wifi_country"] == "GB"
    assert v["console_url"] == flasher.DEFAULT_CONSOLE_URL and v["enrollment_key"] == "" and v["operator_token"] == ""
    assert v["token"] == "" and v["static_ip"] == "" and v["image_mode"] == "latest"  # no bundle when run from source
    # Text fields are stripped (pasted trailing spaces/newlines), the Wi-Fi password is not.
    app.v["name"].set(" Lobby \n")
    app.v["wifi_password"].set(" keep me ")
    assert app.values()["name"] == "Lobby" and app.values()["wifi_password"] == " keep me "
    assert app.id_label.cget("text").endswith(": lobby")
    app.v["name"].set("---")
    assert app.id_label.cget("text") == ""
    assert root.winfo_reqheight() <= root.winfo_screenheight() - 120
    # Not signed in, no baked key: the header offers Sign in.
    assert app.signin_btn.winfo_manager() == "grid" and app.signin_label.cget("text") == ""
    assert str(app.signout_btn["state"]) == "disabled"
    app.on_close()  # saves the form
    # The remembered form survives a restart; the Windows defaults only fill an empty form.
    app2 = flasher.App(_root())
    assert app2.values()["name"] == "---" and app2.values()["timezone"] == "Europe/London"
    app2.root.destroy()


def test_blank_wifi_means_wired(monkeypatch):
    monkeypatch.setattr(flasher.windisk, "list_disks", lambda: [])
    root = _root()
    app = flasher.App(root, dry_run=True)
    app.baked_key = KEY
    _fill(app, ssid="", wifi_password="", image_mode="latest")
    v = app.validate()
    assert v is not None and flasher.card_cfg(v)["ethernet_only"] is True
    assert "set_wlan" not in firstboot.render_firstrun(flasher.card_cfg(v))
    _fill(app, ssid="", wifi_password="secret12", image_mode="latest")
    assert app.validate() is None
    assert _shown_errors(app) == {"ssid": "Enter the Wi-Fi network name (or clear the password for a wired Pi)."}
    _fill(app, image_mode="latest")
    v = app.validate()
    assert v is not None and flasher.card_cfg(v)["ethernet_only"] is False and _shown_errors(app) == {}
    root.destroy()


def test_validate_shows_plain_words_inline(monkeypatch, tmp_path):
    monkeypatch.setattr(flasher.windisk, "list_disks", lambda: [])
    monkeypatch.setattr(flasher.messagebox, "showerror", lambda *a, **k: pytest.fail("dialog instead of inline text"))
    root = _root()
    app = flasher.App(root, dry_run=True)
    app.baked_key = KEY
    img = tmp_path / "missing.img"
    _fill(app, image_mode="latest")
    assert app.validate() is not None and _shown_errors(app) == {}
    for key, val, field, words in [
        ("name", "", "name", "Give the Pi a name."),
        ("name", "###", "name", "The name needs at least one letter or digit."),
        ("wifi_password", "1234567", "wifi_password", "Wi-Fi password must be 8-63 characters."),
        ("ssid", "C:\\net", "ssid", "Wi-Fi SSID must not contain a backslash."),
        ("wifi_country", "UK", "adv", "Wi-Fi country UK is not an ISO code: use GB."),
        ("timezone", "Europe/Londn x", "adv", "Timezone must look like Area/City (e.g. Europe/London) or UTC."),
        ("keymap", "us/dvorak", "adv", "Keyboard layout must be 2-8 lowercase letters (e.g. us, gb, de)."),
        ("static_ip", "192.168.1.300/24", "adv", "Static IP must be an IPv4 address with a prefix (e.g. 192.168.1.50/24)."),
        ("token", "tok'en", "adv", "Device token must be at least 16 letters, digits, '-' or '_' (as issued by the console)."),
    ]:
        _fill(app, image_mode="latest", **{key: val})
        assert app.validate() is None, (key, val)
        assert _shown_errors(app) == {field: words}, (key, val, _shown_errors(app))
    # An Advanced problem opens the Advanced section so the words are on screen.
    assert app.advanced.winfo_manager() == "pack"
    # Static IP: the gateway must sit in the network; a good pair renders manual addressing.
    _fill(app, image_mode="latest", static_ip="192.168.1.50/24", gateway="10.0.0.1")
    assert app.validate() is None and _shown_errors(app)["adv"].startswith("Gateway must be an IPv4 address in 192.168.1.0/24")
    _fill(app, image_mode="latest", static_ip="192.168.1.50/24", gateway="192.168.1.1")
    v = app.validate()
    assert v is not None and "address1=192.168.1.50/24,192.168.1.1" in firstboot.render_firstrun(flasher.card_cfg(v))
    # Advanced: a device token bypasses the key; the key rule returns when it is cleared.
    app.baked_key = ""
    _fill(app, image_mode="latest")
    assert app.validate() is None and _shown_errors(app) == {"signin": "Sign in first."}
    _fill(app, image_mode="latest", token="A-valid_token_0123456789")
    v = app.validate()
    assert v is not None and flasher.card_cfg(v)["token"] == "A-valid_token_0123456789"
    app.op["token"] = OPERATOR_TOKEN  # signed in: fine without a token or a baked key
    _fill(app, image_mode="latest")
    assert app.validate() is not None and app.values()["operator_token"] == OPERATOR_TOKEN
    # Local image: must exist and look like an image.
    _fill(app, image_mode="local", image_path=str(img))
    assert app.validate() is None and _shown_errors(app) == {"adv": "Local image file not found."}
    zipped = tmp_path / "os.zip"
    zipped.write_bytes(b"PK\x03\x04" + b"\0" * 100)
    _fill(app, image_mode="local", image_path=str(zipped))
    assert app.validate() is None and "zip archive" in _shown_errors(app)["adv"]
    # The SSH key is created on first use; a failure is an inline error, never a card without a key.
    monkeypatch.setattr(flasher.sshkey, "ensure_keypair", lambda log=None: (_ for _ in ()).throw(OSError("disk full")))
    _fill(app, image_mode="latest")
    assert app.validate() is None and _shown_errors(app) == {"flash": "Could not create the SSH key: disk full"}
    root.destroy()


def test_dry_run_validate_needs_no_disk(monkeypatch):
    monkeypatch.setattr(flasher.windisk, "list_disks", lambda: [])
    root = _root()
    app = flasher.App(root, dry_run=True)
    app.baked_key = KEY
    app.v["name"].set("Lobby")
    app.v["ssid"].set("Venue")
    app.v["wifi_password"].set("wp123456")
    monkeypatch.setattr(flasher, "is_admin", lambda: True)
    assert app.v["dry_run"].get() is True
    v = app.validate()
    assert v["disk_info"] is None and v["ssh_pubkey"] == PUBKEY
    app.v["dry_run"].set(False)
    assert app.validate() is None
    assert _shown_errors(app) == {"disk": "Choose the SD card to write."}
    monkeypatch.setattr(flasher, "is_admin", lambda: False)
    assert app.validate() is None
    assert _shown_errors(app)["flash"].startswith("Restart as administrator")
    root.destroy()


# ---------------------------------------------------------------- sign in

@pytest.fixture
def stub():
    StubConsole.reset()
    srv, base = _serve(StubConsole)
    try:
        yield base
    finally:
        srv.shutdown()


def test_gui_sign_in_through_the_browser(monkeypatch, stub):
    monkeypatch.setattr(flasher.windisk, "list_disks", lambda: [])
    monkeypatch.setattr(flasher, "console_url", lambda: stub)
    opened = []
    monkeypatch.setattr(flasher.webbrowser, "open", lambda url, *a, **k: opened.append(url) or True)
    StubConsole.approve_after = 2
    root = _root()
    app = flasher.App(root)
    assert app.console_url == stub and app.signin_btn.winfo_manager() == "grid"
    app.signin_btn.invoke()
    assert str(app.signin_btn["state"]) == "disabled"
    assert _pump(root, app, lambda: "Approve in your browser" in app.signin_label.cget("text"), timeout=5)
    assert app.signin_label.cget("text") == "Approve in your browser (code BCDF-GH)"  # shown XXXX-XX
    assert opened == [stub + "/authorize?code=BCDFGH"]  # the link carries the raw code
    assert _pump(root, app, lambda: app.op["token"] == OPERATOR_TOKEN, timeout=8)
    assert app.signin_label.cget("text") == "Signed in as matt" and not app.signin_btn.winfo_manager()
    assert flasher.load_operator_config() == {"console_url": stub, "token": OPERATOR_TOKEN, "username": "matt"}
    assert StubConsole.polls == 2 and "Signed in as matt." in _log(app)
    assert str(app.signout_btn["state"]) == "normal"
    # Signed in: the enrollment key is not needed on the form and the flash fetches it.
    _fill(app, image_mode="latest")
    app.v["dry_run"].set(True)
    assert app.validate() is not None
    # Sign out forgets the token.
    app.sign_out()
    assert app.op["token"] == "" and not flasher.operator_config_path().exists()
    assert app.signin_btn.winfo_manager() == "grid" and "Signed out" in _log(app)
    root.destroy()


def test_gui_sign_in_denied_and_browserless(monkeypatch, stub):
    monkeypatch.setattr(flasher.windisk, "list_disks", lambda: [])
    monkeypatch.setattr(flasher, "console_url", lambda: stub)
    monkeypatch.setattr(flasher.webbrowser, "open", lambda url, *a, **k: False)
    StubConsole.deny = True
    root = _root()
    app = flasher.App(root)
    app.sign_in()
    assert _pump(root, app, lambda: "Sign in failed" in app.signin_label.cget("text"), timeout=8)
    log = _log(app)
    assert f"Could not open a browser. Open {stub}/authorize?code=BCDFGH yourself and type the code BCDF-GH." in log
    assert "Sign in failed: denied on the console" in log
    assert app.signin_label.cget("text") == "Sign in failed: denied on the console"
    assert str(app.signin_btn["state"]) == "normal" and app.op["token"] == ""
    assert not flasher.operator_config_path().exists()
    # The console is down: reported, Sign in offered again.
    monkeypatch.setattr(flasher.console, "request_device_code", lambda *a: (_ for _ in ()).throw(
        flasher.console.ConsoleError("cannot reach it")))
    app.sign_in()
    assert _pump(root, app, lambda: "Sign in failed: cannot reach it" in _log(app))
    assert app.signin_label.cget("text") == "Sign in failed: cannot reach it"
    root.destroy()


def test_gui_sign_in_polls_until_the_code_expires(monkeypatch, stub):
    monkeypatch.setattr(flasher.windisk, "list_disks", lambda: [])
    monkeypatch.setattr(flasher, "console_url", lambda: stub)
    monkeypatch.setattr(flasher.webbrowser, "open", lambda url, *a, **k: True)
    StubConsole.approve_after = None
    real = flasher.console.request_device_code
    monkeypatch.setattr(flasher.console, "request_device_code", lambda *a: dict(real(*a), expires_in=2))
    root = _root()
    app = flasher.App(root)
    app.sign_in()
    assert _pump(root, app, lambda: "timed out" in app.signin_label.cget("text"), timeout=8)
    assert StubConsole.polls >= 1 and app.op["token"] == ""
    # Closing the window stops the poll thread.
    StubConsole.polls = 0
    monkeypatch.setattr(flasher.console, "request_device_code", lambda *a: dict(real(*a), expires_in=600))
    app.sign_in()
    assert _pump(root, app, lambda: StubConsole.polls >= 1, timeout=5)
    app.on_close()
    assert app._signin_cancel.is_set()


def test_gui_checks_a_stored_token_on_launch(monkeypatch):
    monkeypatch.setattr(flasher.windisk, "list_disks", lambda: [])
    flasher.save_operator_config(flasher.DEFAULT_CONSOLE_URL, OPERATOR_TOKEN, "matt")
    seen = []

    def fetch(url, token):
        seen.append((url, token))
        if len(seen) > 1:
            err = flasher.console.ConsoleError("HTTP 401 Unauthorized")
            err.code = 401
            raise err
        return dict(ENROLLMENT)

    monkeypatch.setattr(flasher.console, "fetch_enrollment", fetch)
    root = _root()
    app = flasher.App(root)
    assert app.signin_label.cget("text") == "Signed in as matt" and not app.signin_btn.winfo_manager()
    assert _pump(root, app, lambda: "Signed in as matt (checked with the console)." in _log(app))
    assert seen == [(flasher.DEFAULT_CONSOLE_URL, OPERATOR_TOKEN)]
    assert KEY not in _log(app)  # the key is never shown
    root.destroy()
    # The console rejects the stored token (revoked): Sign in is offered again and the file is gone.
    root = _root()
    app = flasher.App(root)
    assert _pump(root, app, lambda: app.signin_btn.winfo_manager() == "grid")
    assert app.signin_label.cget("text") == "Session expired: sign in again" and app.op["token"] == ""
    assert not flasher.operator_config_path().exists()
    root.destroy()
    # A token saved for another console does not count for this build.
    flasher.save_operator_config("https://other.example", OPERATOR_TOKEN, "matt")
    root = _root()
    app = flasher.App(root)
    assert app.signin_btn.winfo_manager() == "grid" and app.op["token"] == "" and len(seen) == 2
    root.destroy()
    # Offline at launch: the stored sign-in is kept.
    flasher.save_operator_config(flasher.DEFAULT_CONSOLE_URL, OPERATOR_TOKEN, "matt")
    monkeypatch.setattr(flasher.console, "fetch_enrollment",
                        lambda *a: (_ for _ in ()).throw(flasher.console.ConsoleError("cannot reach")))
    root = _root()
    app = flasher.App(root)
    assert _pump(root, app, lambda: "Console check failed (cannot reach); the stored sign-in is kept." in _log(app))
    assert app.op["token"] == OPERATOR_TOKEN and app.signin_label.cget("text") == "Signed in as matt"
    root.destroy()


def test_copy_public_key(monkeypatch):
    monkeypatch.setattr(flasher.windisk, "list_disks", lambda: [])
    root = _root()
    app = flasher.App(root)
    app.copy_public_key()
    assert root.clipboard_get() == PUBKEY and "copied to the clipboard" in _log(app)
    root.destroy()


# ---------------------------------------------------------------- flashing

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


def test_refresh_keeps_selected_disk(monkeypatch):
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
    assert "Target reset to Disk 2" in _log(app)
    root.destroy()


def test_pump_survives_a_raising_callback(monkeypatch):
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
    assert "callback boom" in _log(app)
    root.destroy()


def test_failed_flash_reenables_the_form_and_shows_the_error(monkeypatch, tmp_path):
    """Any exception in run_flash must end with a dialog and the Flash button back (not a frozen GUI)."""
    monkeypatch.setattr(flasher.windisk, "list_disks", lambda: [DISK])
    monkeypatch.setattr(flasher, "is_admin", lambda: True)
    errors = []
    monkeypatch.setattr(flasher.messagebox, "showerror", lambda *a, **k: errors.append(a))
    monkeypatch.setattr(flasher.messagebox, "askyesno", lambda *a, **k: True)

    def fail(*a, **k):
        raise flasher.imagefetch.FetchError("image resolution boom")

    monkeypatch.setattr(flasher, "obtain_image", fail)
    img = tmp_path / "x.img"
    img.write_bytes(b"\x01" * 1024)
    root = _root()
    app = flasher.App(root)
    app.baked_key = KEY
    assert _pump(root, app, lambda: bool(app.disks))
    _fill(app, image_path=str(img))
    app.on_flash()
    assert str(app.flash_btn["state"]) == "disabled" and app.cancel_btn.winfo_manager() == "grid"
    assert _pump(root, app, lambda: str(app.flash_btn["state"]) == "normal", timeout=10)
    assert not app.cancel_btn.winfo_manager()
    assert errors and "image resolution boom" in errors[-1][1]
    assert "FAILED: image resolution boom" in _log(app)
    root.destroy()


def test_confirmation_defaults_to_no_and_rechecks_the_disk(monkeypatch, tmp_path):
    monkeypatch.setattr(flasher.windisk, "list_disks", lambda: [DISK])
    monkeypatch.setattr(flasher, "is_admin", lambda: True)
    dialogs = []
    monkeypatch.setattr(flasher.messagebox, "showerror", lambda *a, **k: dialogs.append(("error", a, k)))
    monkeypatch.setattr(flasher.messagebox, "askyesno", lambda *a, **k: dialogs.append(("yesno", a, k)) or False)
    img = tmp_path / "x.img"
    img.write_bytes(b"\x01" * 1024)
    root = _root()
    app = flasher.App(root)
    app.baked_key = KEY
    assert _pump(root, app, lambda: bool(app.disks))
    _fill(app, image_path=str(img))
    app.on_flash()
    assert dialogs[-1][0] == "yesno" and dialogs[-1][2]["default"] == flasher.messagebox.NO
    assert "Flash Lobby (lobby) to" in dialogs[-1][1][1] and DISK["label"] in dialogs[-1][1][1]
    assert "Everything on that card will be erased" in dialogs[-1][1][1]
    assert app.worker is None
    # A different card in the same reader (new signature/size) after Refresh: the flash is refused inline.
    monkeypatch.setattr(flasher.windisk, "list_disks", lambda: [dict(DISK, unique_id="USBSTOR\\Y&0:")])
    dialogs.clear()
    app.on_flash()
    assert dialogs == [] and _shown_errors(app)["disk"].startswith("The card changed since it was chosen")
    # Without admin rights a real flash is refused with a clear message.
    monkeypatch.setattr(flasher.windisk, "list_disks", lambda: [DISK])
    monkeypatch.setattr(flasher, "is_admin", lambda: False)
    app.on_flash()
    assert dialogs == [] and "Restart as administrator" in _shown_errors(app)["flash"]
    root.destroy()


def test_close_during_flash_cancels_and_defaults_to_no(monkeypatch):
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
    # The flasher never enrolls: the Pi does that on first boot.
    monkeypatch.setattr(flasher.console, "enroll", lambda *a: pytest.fail("flasher enrolled"))
    monkeypatch.setattr(flasher.console, "check_health", lambda *a: pytest.fail("flasher contacted the console"))
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

        def commit_head(self):
            # A plain file target has nothing deferred; the real PhysicalDrive lands the partition
            # table here, after the body was verified.
            calls.append("commit")
            return 0

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
    v = dict(FULL, image_path=str(img), disk_info=dict(DISK, size=1 << 20))
    flasher.run_flash(v, lines.append, lambda pct, text: None, threading.Event())
    assert calls == ["check", "clear", "lock", "commit", "refresh", "find", "eject"]
    assert card.read_bytes() == bytes(range(256)) * 8
    firstrun = (boot / "firstrun.sh").read_bytes()
    assert firstrun.startswith(b"#!/bin/bash\n")
    # The fixed user with the flasher's key, password login off; the password itself never reaches the log.
    assert b"userconf projector-admin" in firstrun and PUBKEY.encode() in firstrun
    assert b"PasswordAuthentication no" in firstrun
    provision = (boot / "projection5000-provision.sh").read_bytes()
    assert b"\nENROLL_KEY=" + KEY.encode() + b"\n" in provision and b"\nDEVICE_TOKEN=\n" in provision
    assert b"DEVICE_NAME=Lobby\n" in provision and b'"$CONSOLE/api/enroll"' in provision
    assert (boot / firstboot.PLAYER_ARCHIVE).stat().st_size > 1000
    assert firstboot.CMDLINE_ARGS in (boot / "cmdline.txt").read_text()
    text = "\n".join(lines)
    assert "Console http://console.local: enrolls itself on first boot." in text and "SUMMARY" in text
    assert "Login: ssh projector-admin@lobby.local with the key" in text and "password login is off" in text
    assert "pw" not in text.split("SUMMARY")[1].replace("password login", "")
    assert flasher.DONE_TEXT in lines and "Device id: lobby" in lines
    assert KEY not in text  # the log never shows the key
    # Oversized image: refused before the card is touched.
    calls.clear()
    v["disk_info"] = dict(DISK, size=1024)
    with pytest.raises(flasher.windisk.DiskError, match="larger than the card"):
        flasher.run_flash(v, lines.append, lambda pct, text: None, threading.Event())
    assert calls == []
    # Advanced: a device token on the card bypasses enrollment (no key on the card at all).
    lines.clear()
    v.update(disk_info=dict(DISK, size=1 << 20), token="tok-lobby-0123456789", enrollment_key="")
    flasher.run_flash(v, lines.append, lambda pct, text: None, threading.Event())
    provision = (boot / "projection5000-provision.sh").read_bytes()
    assert b"\nDEVICE_TOKEN=tok-lobby-0123456789\n" in provision and b"\nENROLL_KEY=" not in provision
    assert any("device token given, no enrollment" in s for s in lines)


def test_run_flash_fetches_the_key_with_the_sign_in(monkeypatch, tmp_path):
    """No baked key, no device token: the enrollment key comes from the console at flash time, is never
    logged, and the answer's wyze_configured reaches the provision script."""
    calls, lines = [], []
    card, boot = _flash_stubs(monkeypatch, tmp_path, calls)
    seen = []
    monkeypatch.setattr(flasher.console, "fetch_enrollment",
                        lambda url, token: seen.append((url, token)) or dict(ENROLLMENT, wyze_configured=True))
    img = tmp_path / "x.img"
    img.write_bytes(b"\x01" * 4096)
    v = dict(FULL, image_path=str(img), disk_info=dict(DISK, size=1 << 20), enrollment_key="",
             operator_token=OPERATOR_TOKEN)
    flasher.run_flash(v, lines.append, lambda pct, text: None, threading.Event())
    assert seen == [("http://console.local", OPERATOR_TOKEN)]
    assert "Enrollment key: ok. Wyze bridge: will be installed (the console has a Wyze account)." in lines
    provision = (boot / "projection5000-provision.sh").read_bytes()
    assert b"\nENROLL_KEY=" + KEY.encode() + b"\n" in provision and b" --with-wyze" in provision
    assert KEY not in "\n".join(lines)
    # Not signed in and nothing baked: refused before anything is rendered or written.
    calls.clear()
    with pytest.raises(ValueError, match="Sign in first"):
        flasher.run_flash(dict(v, operator_token=""), lines.append, lambda pct, text: None, threading.Event())
    assert calls == []
    # A rejected sign-in surfaces as the console's message.
    monkeypatch.setattr(flasher.console, "fetch_enrollment",
                        lambda *a: (_ for _ in ()).throw(flasher.console.ConsoleError("HTTP 401 Unauthorized")))
    with pytest.raises(flasher.console.ConsoleError, match="401"):
        flasher.run_flash(v, lines.append, lambda pct, text: None, threading.Event())
    assert calls == []
    # A baked key (offline build) or a device token: no fetch at all.
    monkeypatch.setattr(flasher.console, "fetch_enrollment", lambda *a: pytest.fail("fetched with a baked key"))
    flasher.run_flash(dict(v, enrollment_key=KEY, operator_token=""), lines.append, lambda pct, text: None,
                      threading.Event())
    flasher.run_flash(dict(v, token="tok-lobby-0123456789", operator_token=""), lines.append,
                      lambda pct, text: None, threading.Event())


def test_cancel_after_write_is_honoured_and_reported(monkeypatch, tmp_path):
    calls, lines = [], []
    card, boot = _flash_stubs(monkeypatch, tmp_path, calls)
    img = tmp_path / "x.img"
    img.write_bytes(b"\x01" * 4096)
    cancel = threading.Event()
    monkeypatch.setattr(flasher.windisk, "find_boot_volume",
                        lambda n, timeout=30.0, cancel_event=None, log=None: cancel.set() or "Z")
    v = dict(FULL, image_path=str(img), disk_info=dict(DISK, size=1 << 20))
    with pytest.raises(flasher.windisk.Cancelled, match="first-boot files are NOT"):
        flasher.run_flash(v, lines.append, lambda pct, text: None, cancel)
    assert not (boot / "firstrun.sh").exists() and "eject" not in calls
    # Cancel before the disk is touched: a plain cancellation, the card was never touched.
    calls.clear()
    cancel = threading.Event()
    real_obtain = flasher.obtain_image
    monkeypatch.setattr(flasher, "obtain_image", lambda *a, **k: cancel.set() or real_obtain(*a, **k))
    with pytest.raises(flasher.windisk.Cancelled) as e:
        flasher.run_flash(v, lines.append, lambda pct, text: None, cancel)
    assert str(e.value) == "" and calls == []
    # Cancel during the write: the card is reported unusable.
    cancel = threading.Event()
    monkeypatch.setattr(flasher, "obtain_image", real_obtain)
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
    v = dict(FULL, image_path=str(img), disk_info=dict(DISK, size=1 << 20))
    with pytest.raises(flasher.windisk.DiskError) as e:
        flasher.run_flash(v, lines.append, lambda pct, text: None, threading.Event())
    assert "no FAT boot partition" in str(e.value) and "first-boot files were NOT" in str(e.value)


def test_dry_run_stops_before_disk(monkeypatch, tmp_path):
    img = tmp_path / "x.img"
    img.write_bytes(b"\x01" * 1024)
    # A dry run validates, renders and resolves the image; with a key in hand it never contacts the console.
    monkeypatch.setattr(flasher.console.urllib.request, "urlopen",
                        lambda *a, **k: pytest.fail("console contacted in dry run"))
    monkeypatch.setattr(flasher.windisk, "clear_disk", lambda *a: pytest.fail("clear_disk called in dry run"))
    monkeypatch.setattr(flasher.windisk, "check_disk", lambda d: pytest.fail("check_disk called in dry run"))
    monkeypatch.setattr(flasher.windisk, "open_physical_drive",
                        lambda *a, **k: pytest.fail("open_physical_drive called in dry run"))
    v = dict(FULL, image_path=str(img), disk_info=None)
    lines = []
    flasher.run_flash(v, lines.append, lambda pct, text: None, threading.Event(), dry_run=True)
    assert any("Console http://console.local: enrolls itself on first boot." in s for s in lines)
    assert any(s.startswith("Dry run: would write x.img to") for s in lines)
    assert not any("Wrote" in s or "SUMMARY" in s for s in lines)

    v["disk_info"] = {"number": 2, "name": "Generic MassStorageClass", "size": 1, "label": "Disk 2"}
    lines.clear()
    flasher.run_flash(v, lines.append, lambda pct, text: None, threading.Event(), dry_run=True)
    assert "Dry run: would write x.img to Disk 2 (Generic MassStorageClass). Nothing was written." in lines


def test_run_flash_validates_before_rendering(monkeypatch, tmp_path):
    img = tmp_path / "x.img"
    img.write_bytes(b"\x01" * 1024)
    monkeypatch.setattr(flasher, "player_archive", lambda: pytest.fail("rendered with a bad form"))
    v = dict(FULL, image_path=str(img), disk_info=None, ssid="a\nb")
    with pytest.raises(ValueError, match="line breaks"):
        flasher.run_flash(v, lambda s: None, lambda pct, text: None, threading.Event(), dry_run=True)
    v = dict(FULL, image_path=str(img), disk_info=None, enrollment_key="short")
    with pytest.raises(ValueError, match="Enrollment key"):
        flasher.run_flash(v, lambda s: None, lambda pct, text: None, threading.Event(), dry_run=True)
    v = dict(FULL, image_path=str(img), disk_info=None, ssh_pubkey="ssh-rsa AAAA")
    with pytest.raises(ValueError, match="SSH public key"):
        flasher.run_flash(v, lambda s: None, lambda pct, text: None, threading.Event(), dry_run=True)


def test_pi_password_is_random_and_rotates_after_a_flash(monkeypatch):
    monkeypatch.setattr(flasher.windisk, "list_disks", lambda: [])
    root = _root()
    app = flasher.App(root)
    first = app.values()["password"]
    assert len(first) >= 24 and first == app.values()["password"]  # stable during one flash
    app._finished()
    assert app.values()["password"] != first
    assert first not in _log(app)
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
    v = dict(FULL, image_mode="bundled", image_path="", disk_info=dict(DISK, size=1 << 20))
    flasher.run_flash(v, lines.append, lambda pct, text: None, threading.Event())
    assert calls == ["check", "clear", "lock", "commit", "refresh", "find", "eject"]
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


def test_gui_uses_the_bundled_image_by_default(monkeypatch, tmp_path):
    monkeypatch.setattr(flasher.windisk, "list_disks", lambda: [])
    b = _bundled_exe(tmp_path)
    monkeypatch.setattr(flasher.bundle, "find_bundle", lambda path=None: b)
    root = _root()
    app = flasher.App(root)
    assert app.bundled is b and app.v["image_mode"].get() == "bundled"
    radios = [w for f in app.advanced.winfo_children() for w in f.winfo_children()
              if isinstance(w, flasher.ttk.Radiobutton)]
    assert radios[0].cget("text").startswith("Bundled: raspios-lite-arm64-test.img.xz (") and \
        radios[0].cget("value") == "bundled"
    assert [r.cget("value") for r in radios] == ["bundled", "latest", "local"]
    # Done dialog after a successful flash names the device id.
    done = []
    monkeypatch.setattr(flasher.messagebox, "showinfo", lambda *a, **k: done.append(a[1]))
    monkeypatch.setattr(flasher, "run_flash", lambda *a, **k: None)
    app._run_flash(dict(FULL, dry_run=False))
    assert _pump(root, app, lambda: bool(done))
    assert done == [flasher.DONE_TEXT + "\n\nDevice id: lobby"]
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
