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
from conftest import PUBKEY, fake_wifi, new_root
from test_console import OPERATOR_TOKEN, TAKEN, VIEW_ONLY, VIEWER_TOKEN, StubConsole, _serve

FLASHER = Path(flasher.__file__)
DISK = {"number": 2, "name": "Generic MassStorageClass", "bus": "USB", "size": 31914983424, "sector": 512,
        "unique_id": "USBSTOR\\X&0:", "serial": "", "signature": 1, "boot": False,
        "label": "Disk 2  Generic MassStorageClass  29.7 GiB"}
KEY = "form-enrollment-key_0123456789abcdef"
# The form's values (widgets plus the hidden ones: keymap and country come from Windows, the image from --image),
# as the operator fills them.
FORM = {"name": "Lobby", "ssid": "Venue", "wifi_password": "wp123456", "wifi_hidden": False, "timezone": "UTC",
        "keymap": "us", "wifi_country": "us", "image_mode": "local", "image_path": "", "static_ip": "",
        "gateway": ""}
# What App.values() adds from outside the widgets (the fixed login, the baked key, the sign-in, the SSH key).
FULL = dict(FORM, token="", device_id="lobby", username="projector-admin", password="pw",
            console_url="http://console.local/", enrollment_key=KEY, operator_token="", ssh_pubkey=PUBKEY,
            dry_run=False)
ME = {"username": "matt", "role": "editor", "console_url": "https://c.example", "timezone": "UTC",
      "groups": [{"id": 1, "name": "Lobby"}], "playlists": [{"id": 7, "name": "Loop"}], "wyze_configured": False}
REGISTERED = {"device_id": "lobby", "token": "tok-lobby-0123456789", "cms_url": "https://c.example", "owner": "matt",
              "created": True}


_roots = []


def _root():
    root = new_root()
    _roots.append(root)
    return root


def _signed_in(monkeypatch, username="matt", token="p5k_stored_token"):
    """Store a sign-in before App() so the form shows straight away (the exe opens on the sign-in box
    otherwise); the background token check answers without a console."""
    flasher.save_operator_config(flasher.console_url(), token, username)
    monkeypatch.setattr(flasher.console, "me", lambda *a: {"username": username, "role": "editor"})


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


def _status(app):
    return app.status_label.cget("text")


def _visible_texts(w, out):
    """Buttons and row labels (grid column 0) that are on screen, top to bottom."""
    if not w.winfo_manager():
        return out  # collapsed: its children are not on screen either
    if isinstance(w, flasher.ttk.Button) or (isinstance(w, flasher.ttk.Label) and w.grid_info().get("column") == 0):
        if w.cget("text"):
            out.append(w.cget("text"))
    for c in w.winfo_children():
        _visible_texts(c, out)
    return out


def _all_texts(w, out):
    for c in w.winfo_children():
        try:
            out.append(str(c.cget("text")))
        except tk.TclError:
            pass
        _all_texts(c, out)
    return out


def _widgets(w, kind, out=None):
    out = [] if out is None else out
    for c in w.winfo_children():
        if isinstance(c, kind):
            out.append(c)
        _widgets(c, kind, out)
    return out


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
    assert f"\ndefaults from {flasher.host.NAME}: timezone " in r.stdout and "ssh key " in r.stdout
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
    assert flasher.console_summary() == "console: https://frozen.example (enrollment key: none; projectors are registered with the sign-in)"
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
    monkeypatch.setattr(flasher, "relaunch_elevated", lambda argv: calls.append(("relaunch", list(argv))) or True)
    monkeypatch.setattr(flasher, "not_admin_message", lambda: calls.append("message"))
    assert flasher.ensure_admin(["--image", "x.img"]) is False
    assert calls == [("relaunch", ["--image", "x.img"])]  # the elevated copy gets the same arguments

    calls.clear()
    monkeypatch.setattr(flasher, "relaunch_elevated", lambda argv: calls.append("relaunch") or False)
    assert flasher.ensure_admin([]) is False
    assert calls == ["relaunch", "message"]  # UAC declined: message box, no crash

    calls.clear()
    assert flasher.ensure_admin(["--elevated"]) is False
    assert calls == ["message"]  # never relaunch in a loop


def test_settings_never_store_secrets(tmp_path):
    flasher.save_settings({"name": "Lobby", "password": "pi-secret", "wifi_password": "wifi-secret",
                           "enrollment_key": "k-secret", "token": "tok", "operator_token": "p5k_secret",
                           "ssh_pubkey": "ssh-ed25519 AAAA", "ssid": "Venue", "static_ip": "10.0.0.5/24"})
    path = flasher.settings_path()
    assert path.is_relative_to(tmp_path) and path.name == "flasher.json"  # the conftest sandbox, never the real one
    text = path.read_text()
    assert "Lobby" in text and "Venue" in text and "10.0.0.5/24" in text
    for secret in ("pi-secret", "wifi-secret", "k-secret", "tok", "p5k_secret", "ssh-ed25519"):
        assert secret not in text
    assert flasher.load_settings()["name"] == "Lobby"
    # A corrupt or non-object settings file must not stop the program from starting.
    for junk in ("[]", "123", '"x"', "null", "true", "{not json"):
        path.write_text(junk)
        assert flasher.load_settings() == {}


@pytest.mark.skipif(sys.platform != "win32", reason="DPAPI is Windows; test_machost covers the keychain")
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


@pytest.mark.skipif(sys.platform != "win32", reason="crypt32 is Windows")
def test_dpapi_prefers_win32crypt_and_falls_back_to_crypt32(monkeypatch):
    import types

    import winhost

    calls = []
    fake = types.ModuleType("win32crypt")
    fake.CryptProtectData = lambda data, *a: calls.append(("protect", data)) or b"blob:" + data
    fake.CryptUnprotectData = lambda data, *a: calls.append(("unprotect", data)) or ("", data[5:])
    monkeypatch.setitem(sys.modules, "win32crypt", fake)
    assert winhost._dpapi(b"tok", protect=True) == b"blob:tok"
    assert winhost._dpapi(b"blob:tok", protect=False) == b"tok"
    assert calls == [("protect", b"tok"), ("unprotect", b"blob:tok")]
    # Without pywin32 (the venv and the frozen exe) the same calls go through ctypes crypt32.
    monkeypatch.setitem(sys.modules, "win32crypt", None)
    blob = winhost._dpapi(b"tok", protect=True)
    assert blob != b"tok" and winhost._dpapi(blob, protect=False) == b"tok"


def test_operator_config_falls_back_to_plain_text_with_a_warning(monkeypatch, tmp_path):
    def no_seal(token):
        raise OSError("no crypt32")

    monkeypatch.setattr(flasher.host, "seal_token", no_seal)
    warning = flasher.save_operator_config("https://c.example", OPERATOR_TOKEN)
    assert warning.startswith(f"WARNING: {flasher.host.SEAL_NAME} is not available")
    assert flasher.host.SIGNIN_FILE in warning  # flasher.json on Windows, signin.json on a Mac
    text = flasher.operator_config_path().read_text("utf-8")
    assert OPERATOR_TOKEN in text and '"token_dpapi": false' in text
    assert flasher.load_operator_config()["token"] == OPERATOR_TOKEN


# ---------------------------------------------------------------- the one screen

def test_gui_shows_exactly_the_per_pi_fields(monkeypatch):
    """One button. The visible top level: the masthead (logo, name, wordmark), Device name, Pi model, Wi-Fi network,
    Wi-Fi password, SD card, Refresh, FLASH, the status line, Advanced, plus the one line that says whose account
    the projectors go to. No console line, no sign-in box once signed in, no log box."""
    monkeypatch.setattr(flasher.disk, "list_disks", lambda: [])
    _signed_in(monkeypatch)
    root = _root()
    app = flasher.App(root)
    root.update()
    fields = []
    for c in root.winfo_children():
        _visible_texts(c, fields)
    assert fields == ["Device name", "Pi model", "Wi-Fi network", "Wi-Fi password", "SD card", "Refresh", "FLASH",
                      "Ready.", "Advanced"]
    assert app.acct_line.winfo_manager() == "pack" and app.acct_label.cget("text") == "Signed in as matt"
    assert root.title() == flasher.APP_TITLE == "Matt Brown Projection 5000"
    # The masthead: the projector icon at 64 px, the name over the wordmark, nothing else in that frame.
    head = app.eyebrow.master.master
    assert app.logo.width() == app.logo.height() == 64 and head.cget("height") == 96
    assert app.eyebrow.cget("text") == "MATT BROWN'S" and app.wordmark.cget("text") == "PROJECTION5000"
    assert _all_texts(head, []) == ["", "MATT BROWN'S", "PROJECTION5000"]  # the icon label (frames have no text)
    # Nothing on the screen names the console or the fonts; the log box lives under Advanced.
    texts = _all_texts(root, [])
    assert not any("Console" in t or "Fonts" in t or "SD FLASHER" in t for t in texts), texts
    assert not app.signin.winfo_manager() and _visible_texts(app.signin, []) == []  # the sign-in box is hidden
    assert _status(app) == "Ready." and app.status_label.cget("style") == "Status.TLabel"
    assert not app.details.winfo_manager() and app.log_text.master is app.details  # hidden until Show details
    # No field ever holds the console URL, a username, a password, a key or a token on the main screen.
    entries = [w for w in app.id_label.master.winfo_children() if isinstance(w, flasher.ttk.Entry)]
    assert entries[1] is app.model_box  # the Pi model box shows labels; its key lives in v["pi_model"]
    assert [e.cget("textvariable") for e in entries] == [str(app.v["name"]), "", str(app.v["ssid"]),
                                                          str(app.v["wifi_password"]), str(app.v["disk"])]
    # The network is an editable Combobox (the networks this PC sees, any other name typed), the rest are Entries.
    assert isinstance(app.ssid_box, flasher.ttk.Combobox) and str(app.ssid_box["state"]) == "normal"
    assert [isinstance(e, flasher.ttk.Combobox) for e in entries] == [False, True, True, False, True]
    assert not app.advanced.winfo_manager() and not app.cancel_btn.winfo_manager()
    # Advanced opens one frame with the rest; the button toggles it. No image source, token, keymap, country or
    # SSH key rows any more: the model picks the image, Windows picks the locale, the key is automatic.
    app.adv_btn.invoke()
    assert app.advanced.winfo_manager() == "pack"
    assert _visible_texts(app.advanced, []) == ["Time zone", "Static IP", "Gateway", "Account", "Sign out"]
    assert app.account_label.cget("text") == "Signed in as matt"
    checks = [w.cget("text") for w in _widgets(app.advanced, flasher.ttk.Checkbutton)]
    assert checks == ["Hidden Wi-Fi network", "Show details"]  # the dry-run box exists only under --dry-run
    assert any(isinstance(w, flasher.ttk.Label) and w.cget("text").startswith("Build: ")
               for w in app.advanced.winfo_children())
    assert _widgets(app.advanced, flasher.ttk.Radiobutton) == []
    # Show details reveals the technical log box, still styled as the console's terminal.
    assert not app.details.winfo_manager()
    app.v["show_details"].set(True)
    app._toggle_details()
    root.update()
    assert app.details.winfo_manager() == "grid" and app.log_text.winfo_manager() == "pack"
    assert "Fonts: " in _log(app) and "Console " in _log(app)
    app.v["show_details"].set(False)
    app._toggle_details()
    assert not app.details.winfo_manager()
    app.adv_btn.invoke()
    assert not app.advanced.winfo_manager()
    root.destroy()


def test_theme_is_the_console_look(monkeypatch):
    """Black ground, white ink, the Flash button as the solid white primary action, the fields as dark wells."""
    monkeypatch.setattr(flasher.disk, "list_disks", lambda: [])
    root = _root()
    app = flasher.App(root)
    st = flasher.ttk.Style(root)
    assert st.theme_use() == "clam"
    assert st.lookup(".", "background") == "#000000" and st.lookup("TLabel", "foreground") == "#E6E6E6"
    assert app.flash_btn.cget("style") == "Primary.TButton" and app.flash_btn.cget("text") == "FLASH"
    assert st.lookup("Primary.TButton", "background") == "#FFFFFF"
    assert st.lookup("Primary.TButton", "foreground") == "#000000"
    assert st.lookup("Primary.TButton", "background", ["disabled"]) == "#4A4A4A"
    assert st.lookup("Primary.TButton", "background", ["active"]) == "#E6E6E6"
    assert st.lookup("TButton", "background") == "#000000" and st.lookup("TButton", "bordercolor") == "#727272"
    assert st.lookup("TEntry", "fieldbackground") == "#0A0A0A" and st.lookup("TEntry", "bordercolor") == "#3A3A3A"
    assert st.lookup("TEntry", "bordercolor", ["focus"]) == "#FFFFFF"
    assert st.lookup("Horizontal.TProgressbar", "background") == "#FFFFFF"
    assert root.option_get("*TCombobox*Listbox.background", "") in ("", "#0A0A0A")  # option_add, not a widget
    assert app.log_text.cget("background") == "#000000" and app.log_text.cget("foreground") == "#C9C9C9"
    assert app.log_text.cget("highlightbackground") == "#FFFFFF" and app.log_text.cget("highlightthickness") == 1
    # inline errors: white text behind the hatch marker; brackets on the four corners of the form panel
    assert all(lbl.cget("style") == "Error.TLabel" and str(app.marker) in lbl.cget("image")
               for lbl in app.err.values())
    assert len(app.brackets) == 4 and all(isinstance(c, tk.Canvas) for c in app.brackets)
    assert set(app.fonts) == {"display", "mono", "sans"}
    # the masthead: the name in the pixel face at 13 pt in ink, the wordmark bold at 24 pt in white
    display = app.fonts["display"]
    fam = f"{{{display}}}" if " " in display else display
    assert st.lookup("Eyebrow.TLabel", "font") == f"{fam} 13" and st.lookup("Eyebrow.TLabel", "foreground") == "#E6E6E6"
    assert st.lookup("Wordmark.TLabel", "font") == f"{fam} 24 bold"
    assert st.lookup("Wordmark.TLabel", "foreground") == "#FFFFFF"
    assert app.eyebrow.cget("style") == "Eyebrow.TLabel" and app.wordmark.cget("style") == "Wordmark.TLabel"
    # the status line in the mono face; no lamp anywhere (the four bracket canvases and the sign-in box's rain
    # are the only canvases)
    assert st.lookup("Status.TLabel", "font").endswith(" 10") and st.lookup("Status.TLabel", "foreground") == "#E6E6E6"
    assert not hasattr(app, "lamp") and len(_widgets(root, tk.Canvas)) == 5
    assert isinstance(app.rain, flasher.MatrixRain) and app.rain.master is app.signin
    root.destroy()


def test_fonts_come_from_the_bundle_with_the_hosts_fallbacks(monkeypatch, tmp_path):
    """load_fonts hands every bundled TTF to the host (gdi32 on Windows, CoreText on macOS); a failure only
    means the host's fallback families."""
    calls = []
    monkeypatch.setattr(flasher.host, "load_fonts", lambda paths: calls.extend(paths) or [p.name for p in paths])
    monkeypatch.setattr(flasher.sys, "frozen", True, raising=False)
    monkeypatch.setattr(flasher.sys, "_MEIPASS", str(tmp_path), raising=False)
    assert flasher.load_fonts() == list(flasher.FONT_FILES)
    assert calls == [tmp_path / "fonts" / n for n in flasher.FONT_FILES]
    assert {p.name for p in flasher.font_paths()} == {p.name for p in (FLASHER.parent / "fonts").glob("*.ttf")}
    assert flasher.font_families([]) == flasher.host.FALLBACK_FONTS
    assert flasher.font_families(["Silkscreen", "IBM Plex Mono", "Space Grotesk"]) == {
        "display": "Silkscreen", "mono": "IBM Plex Mono", "sans": "Space Grotesk"}
    if sys.platform == "win32":
        assert flasher.host.FALLBACK_FONTS == {"display": "Consolas", "mono": "Consolas", "sans": "Segoe UI"}


@pytest.mark.skipif(sys.platform != "win32", reason="gdi32 is Windows; test_machost covers CoreText")
def test_fonts_load_privately_with_gdi32(monkeypatch, tmp_path):
    """Every TTF is registered with gdi32 AddFontResourceExW(path, FR_PRIVATE, 0): visible to this process only."""
    import winhost

    calls = []
    fake_gdi = type("G", (), {"AddFontResourceExW": staticmethod(lambda p, f, r: calls.append((p, f, r)) or 1)})
    monkeypatch.setattr(winhost.ctypes, "windll", type("W", (), {"gdi32": fake_gdi}))
    paths = [tmp_path / "fonts" / n for n in flasher.FONT_FILES]
    assert winhost.load_fonts(paths) == list(flasher.FONT_FILES)
    assert calls == [(str(p), 0x10, 0) for p in paths]
    fake_gdi.AddFontResourceExW = staticmethod(lambda p, f, r: 0)
    assert winhost.load_fonts(paths) == []


def test_wifi_dropdown_lists_the_networks_and_fills_a_saved_password(monkeypatch):
    monkeypatch.setattr(flasher.disk, "list_disks", lambda: [])
    nets = [{"ssid": "Cafe", "signal": 60, "auth": "Open"}, {"ssid": "Venue", "signal": 30, "auth": "WPA2-Personal"},
            {"ssid": "Far", "signal": 3, "auth": "WPA2-Personal"}]
    monkeypatch.setattr(flasher, "wifi", fake_wifi(nets, current="Venue", passwords={"Venue": "p4ss: word 1"}))
    root = _root()
    app = flasher.App(root)
    assert app.ssid_hint.cget("text") == flasher.SCANNING_HINT == "Looking for networks..."
    assert _pump(root, app, lambda: list(app.ssid_box["values"]) == ["Venue", "Cafe", "Far"])  # connected one first
    assert app.ssid_hint.cget("text") == "leave blank for a wired Pi" and app.pw_hint.cget("text") == ""
    # Picking a network with a profile on this PC fills the password (from netsh, off the Tk thread).
    app.ssid_box.set("Venue")
    app.ssid_box.event_generate("<<ComboboxSelected>>")
    assert _pump(root, app, lambda: app.v["wifi_password"].get() == "p4ss: word 1")
    assert app.pw_hint.cget("text") == "password from this computer"
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


def test_window_grows_inside_the_work_area(monkeypatch):
    """Windows opens the window low on the screen (cascade); Advanced + details grow it. It never hangs behind
    the taskbar: capped to the work area and moved up when needed. Under --dry-run the dry-run box appears."""
    top = 25 if sys.platform == "darwin" else 0  # macOS keeps every window under the menu bar
    monkeypatch.setattr(flasher, "work_area", lambda root: (top, 700))  # a short work area
    _signed_in(monkeypatch)
    root = _root()
    app = flasher.App(root, dry_run=True)
    assert [w.cget("text") for w in _widgets(app.advanced, flasher.ttk.Checkbutton)][-1].startswith("Dry run")
    root.deiconify()
    root.geometry("+50+300")
    root.update()
    app.adv_btn.invoke()
    app.v["show_details"].set(True)
    app._toggle_details()
    root.update()
    chrome = root.winfo_rooty() - root.winfo_y() + 8
    assert root.winfo_y() + root.winfo_height() + chrome <= 700 and root.winfo_x() == 50
    assert root.winfo_height() >= 600  # it did grow, as far as the work area allows
    root.destroy()


def test_gui_constructs_with_windows_defaults(monkeypatch):
    monkeypatch.setattr(flasher.disk, "list_disks", lambda: [DISK])
    monkeypatch.setattr(flasher.defaults, "timezone", lambda name=None: "Europe/London")
    monkeypatch.setattr(flasher.defaults, "keymap", lambda langid=None: "gb")
    monkeypatch.setattr(flasher.defaults, "country", lambda valid=None: "GB")
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
    assert "token" not in v and v["static_ip"] == "" and v["image_mode"] == "latest"  # no bundle when run from source
    assert v["image_path"] == "" and flasher.card_cfg(dict(v, ssh_pubkey=PUBKEY))["token"] == ""
    # Text fields are stripped (pasted trailing spaces/newlines), the Wi-Fi password is not.
    app.v["name"].set(" Lobby \n")
    app.v["wifi_password"].set(" keep me ")
    assert app.values()["name"] == "Lobby" and app.values()["wifi_password"] == " keep me "
    assert app.id_label.cget("text").endswith(": lobby")
    app.v["name"].set("---")
    assert app.id_label.cget("text") == ""
    assert root.winfo_reqheight() <= root.winfo_screenheight() - 120
    # Not signed in, no baked key: the sign-in box is up in place of the form until the operator signs in.
    assert _status(app) == flasher.SIGNIN_FIRST_TEXT and app.account_label.cget("text") == "Not signed in"
    assert app.signin.winfo_manager() == "pack" and not app.form.winfo_manager() and not app.acct_line.winfo_manager()
    # The rain under the box runs only while the box is up: a frame is drawn, the timer is armed, and it stops
    # (drawing nothing more) once the operator is signed in.
    root.update()
    assert app.rain._job is not None and app.rain.find_all()
    app.op = {"token": "p5k_x", "username": "matt"}
    app._signin_done()
    assert app.rain._job is None and not app.signin.winfo_manager() and app.form.winfo_manager() == "pack"
    assert app.account_btn.cget("text") == "Sign out"
    app.v["timezone"].set("Europe/Paris")
    app.on_close()  # saves the form
    # The remembered form survives a restart; keymap and country are never remembered (always this PC's).
    monkeypatch.setattr(flasher.defaults, "keymap", lambda langid=None: "de")
    app2 = flasher.App(_root())
    assert app2.values()["name"] == "---" and app2.values()["timezone"] == "Europe/Paris"
    assert app2.values()["keymap"] == "de" and app2.values()["wifi_country"] == "GB"
    assert set(flasher.load_settings()) <= set(flasher.SETTINGS_KEYS)
    assert not {"keymap", "wifi_country", "image_mode", "image_path", "token"} & set(flasher.SETTINGS_KEYS)
    app2.root.destroy()


def test_blank_wifi_means_wired(monkeypatch):
    monkeypatch.setattr(flasher.disk, "list_disks", lambda: [])
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
    monkeypatch.setattr(flasher.disk, "list_disks", lambda: [])
    monkeypatch.setattr(flasher.messagebox, "showerror", lambda *a, **k: pytest.fail("dialog instead of inline text"))
    _signed_in(monkeypatch)
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
        ("timezone", "Europe/Londn x", "adv", "Timezone must look like Area/City (e.g. Europe/London) or UTC."),
        ("static_ip", "192.168.1.300/24", "adv", "Static IP must be an IPv4 address with a prefix (e.g. 192.168.1.50/24)."),
        # no widgets for these (Windows fills them): a bad value still stops the flash, under the button
        ("wifi_country", "UK", "flash", "Wi-Fi country UK is not an ISO code: use GB."),
        ("keymap", "us/dvorak", "flash", "Keyboard layout must be 2-8 lowercase letters (e.g. us, gb, de)."),
    ]:
        _fill(app, image_mode="latest", **{key: val})
        assert app.validate() is None, (key, val)
        assert _shown_errors(app) == {field: words}, (key, val, _shown_errors(app))
    # An Advanced problem opens the Advanced section so the words are on screen.
    assert app.advanced.winfo_manager() == "pack"
    # Static IP: the gateway must sit in the network; a good pair renders manual addressing.
    _fill(app, image_mode="latest", static_ip="192.168.1.50/24", gateway="10.0.0.1")
    assert app.validate() is None and _shown_errors(app)["adv"].startswith("Gateway must be another IPv4 address in 192.168.1.0/24")
    _fill(app, image_mode="latest", static_ip="192.168.1.50/24", gateway="192.168.1.1")
    v = app.validate()
    assert v is not None and "address1=192.168.1.50/24,192.168.1.1" in firstboot.render_firstrun(flasher.card_cfg(v))
    # Not signed in and nothing baked is not a form error: FLASH asks for the sign-in first (see those tests).
    app.baked_key = ""
    _fill(app, image_mode="latest")
    assert app.validate() is not None and _shown_errors(app) == {}
    app.op["token"] = OPERATOR_TOKEN  # connected: the key is fetched at flash time
    _fill(app, image_mode="latest")
    assert app.validate() is not None and app.values()["operator_token"] == OPERATOR_TOKEN
    # A developer's --image must exist and look like an image.
    _fill(app, image_mode="local", image_path=str(img))
    assert app.validate() is None and _shown_errors(app) == {"flash": f"Image file not found: {img}"}
    zipped = tmp_path / "os.zip"
    zipped.write_bytes(b"PK\x03\x04" + b"\0" * 100)
    _fill(app, image_mode="local", image_path=str(zipped))
    assert app.validate() is None and "zip archive" in _shown_errors(app)["flash"]
    # The SSH key is created on first use; a failure is an inline error, never a card without a key.
    monkeypatch.setattr(flasher.sshkey, "ensure_keypair", lambda log=None: (_ for _ in ()).throw(OSError("disk full")))
    _fill(app, image_mode="latest")
    assert app.validate() is None and _shown_errors(app) == {"flash": "Could not create the SSH key: disk full"}
    root.destroy()


def test_dry_run_validate_needs_no_disk(monkeypatch):
    monkeypatch.setattr(flasher.disk, "list_disks", lambda: [])
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


def test_flash_signs_in_then_makes_the_card(monkeypatch, stub):
    """Not signed in, no baked key: FLASH shows the sign-in box (username, masked password, Sign in) with the
    plain-words hint, and once the console answers the flash runs with no further click."""
    monkeypatch.setattr(flasher.disk, "list_disks", lambda: [])
    monkeypatch.setattr(flasher, "console_url", lambda: stub)
    flashed = []
    monkeypatch.setattr(flasher, "run_flash", lambda v, *a, **k: flashed.append(v) or "matt")
    root = _root()
    app = flasher.App(root)
    root.update()
    # Not signed in: the sign-in box is the whole panel, the form waits behind it, FLASH is off.
    assert app.console_url == stub and not app.connected()
    assert app.signin.winfo_manager() == "pack" and not app.form.winfo_manager()
    assert _status(app) == flasher.SIGNIN_FIRST_TEXT == "Sign in."
    assert str(app.flash_btn["state"]) == "disabled"
    assert _visible_texts(app.signin, []) == ["Username", "Password", "Sign in"]  # no hint, no Cancel: nothing to go back to
    assert app.pass_entry.cget("show") == "*" and root.focus_get() in (app.user_entry, None)
    assert not app.cancel_btn.winfo_manager()
    # Nothing typed: said inline, no request.
    app.signin_btn.invoke()
    assert _shown_errors(app) == {"signin": "Enter your username and password."} and StubConsole.calls == []
    app.op_username.set("matt")
    app.op_password.set("secret")
    app.signin_btn.invoke()
    assert _pump(root, app, lambda: app.connected(), timeout=8)
    assert app.op["token"] == OPERATOR_TOKEN
    # Signed in: the form is up; a dry-run FLASH goes through with the token in hand.
    _fill(app, image_mode="latest")
    app.v["dry_run"].set(True)
    app.flash_btn.invoke()
    assert _pump(root, app, lambda: bool(flashed), timeout=8)
    assert flashed[0]["operator_token"] == OPERATOR_TOKEN
    assert flasher.load_operator_config() == {"console_url": stub, "token": OPERATOR_TOKEN, "username": "matt"}
    assert StubConsole.calls[0] == ("/api/operator/login", {"username": "matt", "password": "secret",
                                                           "hostname": flasher.socket.gethostname()})
    assert "Signed in as matt." in _log(app) and "secret" not in _log(app)
    assert not app.signin.winfo_manager() and app.op_password.get() == ""  # the box is gone, the password with it
    assert app.form.winfo_manager() == "pack" and app.acct_label.cget("text") == "Signed in as matt"
    assert _pump(root, app, lambda: _status(app) == flasher.DRY_RUN_TEXT)
    assert str(app.flash_btn["state"]) == "normal" and not app.cancel_btn.winfo_manager()
    # Advanced names the account; Sign out forgets the token, Sign in comes back with the username prefilled.
    assert app.account_label.cget("text") == "Signed in as matt" and app.account_btn.cget("text") == "Sign out"
    app.account_btn.invoke()
    assert app.op["token"] == "" and not flasher.operator_config_path().exists()
    assert app.account_label.cget("text") == "Not signed in"
    assert "Signed out" in _log(app)
    # Signed out: straight back to the sign-in box with the username prefilled, no flash afterwards.
    assert app.signin.winfo_manager() == "pack" and not app.form.winfo_manager()
    assert app.op_username.get() == "matt" and app._then is None
    assert _status(app) == flasher.SIGNIN_FIRST_TEXT and str(app.account_btn["state"]) == "disabled"
    root.destroy()


def test_sign_in_box_links_open_the_console_in_the_browser(monkeypatch, stub):
    """Forgot password and Create an account, under the Sign in button, open the console's /forgot and /signup in
    the default browser (packed labels: _visible_texts does not count them), and do nothing while a sign-in
    request is in flight."""
    monkeypatch.setattr(flasher.disk, "list_disks", lambda: [])
    monkeypatch.setattr(flasher, "console_url", lambda: stub)
    opened = []
    monkeypatch.setattr(flasher.webbrowser, "open_new_tab", lambda url: opened.append(url))
    root = _root()
    app = flasher.App(root)
    root.update()
    assert list(app.signin_links) == ["Forgot password", "Create an account"]
    assert all(lbl.winfo_manager() == "pack" and lbl.cget("style") == "Link.TLabel"
               for lbl in app.signin_links.values())
    app.signin_links["Forgot password"].event_generate("<Button-1>")
    app.signin_links["Create an account"].event_generate("<Button-1>")
    assert opened == [stub + "/forgot", stub + "/signup"]
    app.signin_btn.configure(state="disabled")  # a request in flight
    app.signin_links["Forgot password"].event_generate("<Button-1>")
    assert opened == [stub + "/forgot", stub + "/signup"]
    root.destroy()


def test_sign_in_wrong_password_view_only_throttled_and_offline(monkeypatch, stub):
    """Every refusal is said inline under the box in plain words, the box stays open for another try, and no
    token is kept. Cancel closes it and puts the status line back to Ready."""
    monkeypatch.setattr(flasher.disk, "list_disks", lambda: [])
    monkeypatch.setattr(flasher, "console_url", lambda: stub)
    root = _root()
    app = flasher.App(root)
    app.adv_btn.invoke()
    app.account_btn.invoke()
    app.op_username.set("matt")
    app.op_password.set("wrong")
    app.signin_btn.invoke()
    assert str(app.signin_btn["state"]) == "disabled"  # one request at a time
    assert _pump(root, app, lambda: "signin" in _shown_errors(app), timeout=5)
    assert _shown_errors(app)["signin"] == "Invalid username or password" and str(app.signin_btn["state"]) == "normal"
    assert "Sign in failed: Invalid username or password" in _log(app) and app.op["token"] == ""
    app.op_username.set("viewer")
    app.op_password.set("secret")
    app.signin_btn.invoke()
    assert _pump(root, app, lambda: _shown_errors(app).get("signin") == VIEW_ONLY, timeout=5)
    assert not flasher.operator_config_path().exists()
    for _ in range(2):
        app.op_username.set("matt")
        app.op_password.set("wrong")
        app.signin_btn.invoke()
        assert _pump(root, app, lambda: str(app.signin_btn["state"]) == "normal", timeout=5)
    app.op_password.set("secret")
    app.signin_btn.invoke()
    assert _pump(root, app, lambda: "Too many" in _shown_errors(app).get("signin", ""), timeout=5)
    assert _shown_errors(app)["signin"] == "Too many failed attempts; try again in 60 s"
    # The console is down: reported in plain words, the box stays.
    monkeypatch.setattr(flasher.console, "login", lambda *a: (_ for _ in ()).throw(
        flasher.console.ConsoleError("cannot reach it")))
    app.signin_btn.invoke()
    assert _pump(root, app, lambda: "cannot reach it" in _shown_errors(app).get("signin", ""))
    assert _shown_errors(app)["signin"] == "Could not reach the console: cannot reach it"
    assert app.signin.winfo_manager() == "pack" and str(app.flash_btn["state"]) == "disabled"
    # Cancel with no sign-in to go back to: the box stays (only a request in flight is dropped).
    app.signin_cancel_btn.invoke()
    assert app.signin.winfo_manager() == "pack" and not app.form.winfo_manager() and app._signin_cancel.is_set()
    assert str(app.flash_btn["state"]) == "disabled" and str(app.signin_btn["state"]) == "normal"
    assert app.account_label.cget("text") == "Not signed in"  # the typed password stays for a retry
    assert "Sign in cancelled." in _log(app)
    # Closing the window while the box is open is fine too.
    app.account_btn.invoke()
    app.on_close()
    assert app._signin_cancel.is_set()


def test_gui_uses_a_stored_token_silently(monkeypatch):
    monkeypatch.setattr(flasher.disk, "list_disks", lambda: [])
    flasher.save_operator_config(flasher.DEFAULT_CONSOLE_URL, OPERATOR_TOKEN, "matt")
    seen = []

    def me(url, token):
        seen.append((url, token))
        if len(seen) > 1:
            err = flasher.console.ConsoleError("HTTP 401 Unauthorized")
            err.code = 401
            raise err
        return dict(ME)

    monkeypatch.setattr(flasher.console, "me", me)
    root = _root()
    app = flasher.App(root)
    assert app.connected() and app.account_label.cget("text") == "Signed in as matt"
    assert _pump(root, app, lambda: "Signed in as matt (checked with the console)." in _log(app))
    assert seen == [(flasher.DEFAULT_CONSOLE_URL, OPERATOR_TOKEN)]
    assert _status(app) == "Ready."  # the check is a detail
    assert app.op_username.get() == "matt" and not app.signin.winfo_manager()
    root.destroy()
    # The console rejects the stored token (revoked): forgotten; the next FLASH signs in again.
    root = _root()
    app = flasher.App(root)
    assert _pump(root, app, lambda: not app.connected())
    assert app.account_label.cget("text") == "Not signed in"
    assert _status(app) == "The stored sign-in was rejected by the console: sign in again."
    assert app.signin.winfo_manager() == "pack" and not app.form.winfo_manager()
    assert "sign in again" in _log(app)
    assert not flasher.operator_config_path().exists()
    assert app.op_username.get() == "matt"  # still prefilled for the next sign-in
    root.destroy()
    # A token saved for another console does not count for this build.
    flasher.save_operator_config("https://other.example", OPERATOR_TOKEN, "matt")
    root = _root()
    app = flasher.App(root)
    assert not app.connected() and len(seen) == 2 and app.op_username.get() == ""
    root.destroy()
    # Offline at launch: the stored sign-in is kept.
    flasher.save_operator_config(flasher.DEFAULT_CONSOLE_URL, OPERATOR_TOKEN, "matt")
    monkeypatch.setattr(flasher.console, "me",
                        lambda *a: (_ for _ in ()).throw(flasher.console.ConsoleError("cannot reach")))
    root = _root()
    app = flasher.App(root)
    assert _pump(root, app, lambda: "Console check failed (cannot reach); the stored sign-in is kept." in _log(app))
    assert app.op["token"] == OPERATOR_TOKEN and app.account_label.cget("text") == "Signed in as matt"
    root.destroy()
    # The account was made view-only meanwhile (403): forgotten, and the console's words reach the status line.
    err = flasher.console.ConsoleError("/api/operator/me: " + VIEW_ONLY)
    err.code, err.body = 403, {"detail": VIEW_ONLY}
    monkeypatch.setattr(flasher.console, "me", lambda *a: (_ for _ in ()).throw(err))
    root = _root()
    app = flasher.App(root)
    assert _pump(root, app, lambda: not app.connected())
    assert _status(app) == VIEW_ONLY and VIEW_ONLY in _log(app) and not flasher.operator_config_path().exists()
    root.destroy()


def test_log_goes_to_the_details_box_and_the_file(monkeypatch, tmp_path):
    monkeypatch.setattr(flasher.disk, "list_disks", lambda: [])
    path = flasher.log_path()
    assert path.is_relative_to(tmp_path) and path.name == "flasher.log"  # the conftest sandbox
    _signed_in(monkeypatch)
    root = _root()
    app = flasher.App(root)
    app.log("Using bundled image x.img.xz")
    assert "Using bundled image x.img.xz" in _log(app)
    lines = path.read_text("utf-8").splitlines()
    assert lines[0].split(" ", 2)[2].startswith("Console ") and lines[1].split(" ", 2)[2].startswith("Fonts: ")
    assert lines[-1].endswith(" Using bundled image x.img.xz") and lines[-1][4] == "-"  # timestamped
    assert _status(app) == "Ready."  # none of it reaches the status line
    # Rotation: over 2 MB the file moves to flasher.log.1 and a fresh one starts.
    path.write_text("x" * (flasher.LOG_MAX + 1))
    app.log("after rotation")
    assert path.with_suffix(".log.1").stat().st_size == flasher.LOG_MAX + 1
    assert path.read_text("utf-8").endswith(" after rotation\n") and path.stat().st_size < 100
    # An unwritable log never stops the program.
    monkeypatch.setattr(flasher, "log_path", lambda: tmp_path / "nope" / "dir" / "x" / "flasher.log")
    (tmp_path / "nope").write_text("a file, not a directory")
    app.log("still fine")
    assert "still fine" in _log(app)
    root.destroy()


def test_status_line_speaks_plain_words(monkeypatch):
    monkeypatch.setattr(flasher.disk, "list_disks", lambda: [])
    root = _root()
    app = flasher.App(root)
    app.set_phase("Writing the card")
    assert _status(app) == "Writing the card..."
    app.set_progress(43.4, "1234 MB written, 21.0 MB/s")
    assert _status(app) == "Writing the card (43%)..." and app.progress["value"] == 43.4
    app.set_status(flasher.done_text("matt"))
    app.set_progress(100, "verified")  # a late tick never overwrites a sentence
    assert _status(app) == flasher.done_text("matt")
    assert flasher.done_text("matt") == ("Done. Put the card in the Pi and turn it on. It shows up under Devices in "
                                         "matt's account in a few minutes.")
    assert flasher.done_text() == ("Done. Put the card in the Pi and turn it on. It shows up on the Devices page in a "
                                   "few minutes.")  # a baked enrollment key: no account
    # A failed flash: the first line of the reason, plus the dialog; the button comes back.
    errors = []
    monkeypatch.setattr(flasher.messagebox, "showerror", lambda *a, **k: errors.append(a))
    monkeypatch.setattr(flasher, "run_flash", lambda *a, **k: (_ for _ in ()).throw(
        flasher.disk.DiskError("read-back verification failed\n\nmore words")))
    app._run_flash(dict(FULL, dry_run=False))
    assert _pump(root, app, lambda: bool(errors))
    assert _status(app) == "Failed: read-back verification failed" and "FAILED: read-back" in _log(app)
    # Cancelled: said once, in words.
    monkeypatch.setattr(flasher, "run_flash", lambda *a, **k: (_ for _ in ()).throw(
        flasher.disk.Cancelled("The card is NOT usable; flash it again.")))
    app._run_flash(dict(FULL, dry_run=False))
    assert _pump(root, app, lambda: _status(app).startswith("Cancelled"))
    assert _status(app) == "Cancelled. The card is NOT usable; flash it again."
    root.destroy()


def test_image_override_flag_and_env(monkeypatch, tmp_path):
    monkeypatch.setattr(flasher.disk, "list_disks", lambda: [])
    img = tmp_path / "dev.img"
    assert flasher.image_arg(["--dry-run"], env={}) == ""
    assert flasher.image_arg(["--image", str(img), "--dry-run"], env={}) == str(img)
    assert flasher.image_arg(["--dry-run", "--image"], env={"FLASHER_IMAGE": " e.img "}) == "e.img"  # no value
    assert flasher.image_arg([], env={"FLASHER_IMAGE": "e.img"}) == "e.img"
    monkeypatch.setenv("FLASHER_IMAGE", "env.img")
    assert flasher.image_arg([]) == "env.img"
    _signed_in(monkeypatch)
    root = _root()
    app = flasher.App(root, dry_run=True, image=str(img))
    assert app.values()["image_mode"] == "local" and app.values()["image_path"] == str(img)
    assert f"Image override: {img}" in _log(app) and _status(app) == "Ready."
    app.baked_key = KEY
    _fill(app, image_mode="local", image_path=str(img))
    assert app.validate() is None and _shown_errors(app) == {"flash": f"Image file not found: {img}"}
    img.write_bytes(b"\x01" * 1024)
    assert app.validate() is not None
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
    with pytest.raises(flasher.disk.DiskError, match="cmdline.txt not found"):
        flasher.write_firstboot_files(other, "a", "b", b"c")
    assert list(other.iterdir()) == []


def test_refresh_keeps_selected_disk(monkeypatch):
    disk3 = dict(DISK, number=3, label="Disk 3  Reader B  (no card)", size=0)
    monkeypatch.setattr(flasher.disk, "list_disks", lambda: [DISK, disk3])
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
    monkeypatch.setattr(flasher.disk, "list_disks", lambda: [])
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
    monkeypatch.setattr(flasher.disk, "list_disks", lambda: [DISK])
    monkeypatch.setattr(flasher, "is_admin", lambda: True)
    errors = []
    monkeypatch.setattr(flasher.messagebox, "showerror", lambda *a, **k: errors.append(a))
    monkeypatch.setattr(flasher.messagebox, "askyesno", lambda *a, **k: True)

    def fail(*a, **k):
        raise flasher.imagefetch.FetchError("image resolution boom")

    monkeypatch.setattr(flasher, "obtain_image", fail)
    _signed_in(monkeypatch)
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
    assert "FAILED: image resolution boom" in _log(app) and _status(app) == "Failed: image resolution boom"
    root.destroy()


def test_confirmation_defaults_to_no_and_rechecks_the_disk(monkeypatch, tmp_path):
    monkeypatch.setattr(flasher.disk, "list_disks", lambda: [DISK])
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
    monkeypatch.setattr(flasher.disk, "list_disks", lambda: [dict(DISK, unique_id="USBSTOR\\Y&0:")])
    dialogs.clear()
    app.on_flash()
    assert dialogs == [] and _shown_errors(app)["disk"].startswith("The card changed since it was chosen")
    # Without admin rights a real flash is refused with a clear message.
    monkeypatch.setattr(flasher.disk, "list_disks", lambda: [DISK])
    monkeypatch.setattr(flasher, "is_admin", lambda: False)
    app.on_flash()
    assert dialogs == [] and "Restart as administrator" in _shown_errors(app)["flash"]
    root.destroy()


def test_close_during_flash_cancels_and_defaults_to_no(monkeypatch):
    monkeypatch.setattr(flasher.disk, "list_disks", lambda: [])
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
    monkeypatch.setattr(flasher.disk, "check_disk", lambda d: calls.append("check"))
    monkeypatch.setattr(flasher.disk, "clear_disk", lambda n, uid="": calls.append("clear"))
    monkeypatch.setattr(flasher.disk, "volume_paths", lambda n: [])

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

    monkeypatch.setattr(flasher.disk, "open_physical_drive", Drive)
    monkeypatch.setattr(flasher.disk, "find_boot_volume",
                        lambda n, timeout=30.0, cancel_event=None, log=None: calls.append("find") or "Z:/")
    monkeypatch.setattr(flasher, "Path", lambda s: boot if str(s).startswith("Z:") else Path(s))
    monkeypatch.setattr(flasher.disk, "eject", lambda letter: calls.append("eject"))
    return card, boot


def test_run_flash_end_to_end_with_stubs(monkeypatch, tmp_path):
    calls, lines = [], []
    card, boot = _flash_stubs(monkeypatch, tmp_path, calls)
    img = tmp_path / "x.img"
    img.write_bytes(bytes(range(256)) * 8)
    v = dict(FULL, image_path=str(img), disk_info=dict(DISK, size=1 << 20))
    steps = []
    flasher.run_flash(v, lines.append, lambda pct, text: None, threading.Event(), status=steps.append)
    assert calls == ["check", "clear", "lock", "commit", "refresh", "find", "eject"]
    assert steps == ["Writing the card", "Checking the card", "Finishing the card"]  # what the user reads
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
    assert flasher.done_text() in lines and "Device id: lobby" in lines
    assert KEY not in text  # the log never shows the key
    # Oversized image: refused before the card is touched.
    calls.clear()
    v["disk_info"] = dict(DISK, size=1024)
    with pytest.raises(flasher.disk.DiskError, match="larger than the card"):
        flasher.run_flash(v, lines.append, lambda pct, text: None, threading.Event())
    assert calls == []
    # Advanced: a device token on the card bypasses enrollment (no key on the card at all).
    lines.clear()
    v.update(disk_info=dict(DISK, size=1 << 20), token="tok-lobby-0123456789", enrollment_key="")
    flasher.run_flash(v, lines.append, lambda pct, text: None, threading.Event())
    provision = (boot / "projection5000-provision.sh").read_bytes()
    assert b"\nDEVICE_TOKEN=tok-lobby-0123456789\n" in provision and b"\nENROLL_KEY=" not in provision
    assert any("device token given, no enrollment" in s for s in lines)


def test_run_flash_registers_the_projector_with_the_sign_in(monkeypatch, tmp_path):
    """No baked key, no device token: the projector is registered in the signed-in account at flash time and
    the device token the console issues goes on the card (no enrollment key anywhere); /me's wyze_configured
    reaches the provision script; the Done sentence names the account."""
    calls, lines = [], []
    card, boot = _flash_stubs(monkeypatch, tmp_path, calls)
    seen = []
    monkeypatch.setattr(flasher.console, "me", lambda url, token: seen.append(("me", url, token))
                        or dict(ME, wyze_configured=True))
    monkeypatch.setattr(flasher.console, "register_device",
                        lambda url, token, dev, name, model: seen.append(("register", url, token, dev, name, model))
                        or dict(REGISTERED))
    img = tmp_path / "x.img"
    img.write_bytes(b"\x01" * 4096)
    v = dict(FULL, image_path=str(img), disk_info=dict(DISK, size=1 << 20), enrollment_key="",
             operator_token=OPERATOR_TOKEN, pi_model="pi5")
    owner = flasher.run_flash(v, lines.append, lambda pct, text: None, threading.Event())
    assert owner == "matt"
    assert seen == [("me", "http://console.local", OPERATOR_TOKEN),
                    ("register", "http://console.local", OPERATOR_TOKEN, "lobby", "Lobby", "Raspberry Pi 5 / 500")]
    assert "Signed in as matt. Wyze bridge: will be installed (the console has a Wyze account)." in lines
    assert "Registered lobby in matt's account (new projector). Device token: ok." in lines
    provision = (boot / "projection5000-provision.sh").read_bytes()
    assert b"\nDEVICE_TOKEN=tok-lobby-0123456789\n" in provision and b"\nCMS_URL=https://c.example\n" in provision
    assert b"\nENROLL_KEY=" not in provision and b" --with-wyze" in provision
    assert flasher.done_text("matt") in lines and "matt's account" in flasher.done_text("matt")
    assert "tok-lobby-0123456789" not in "\n".join(lines)  # the token is never logged
    assert any("device token: keep it safe" in s for s in lines)
    # A re-flash of an existing projector is said so.
    seen.clear()
    monkeypatch.setattr(flasher.console, "register_device", lambda *a: dict(REGISTERED, created=False, owner=""))
    flasher.run_flash(v, lines.append, lambda pct, text: None, threading.Event())
    assert "Registered lobby in matt's account (already there, new device token). Device token: ok." in lines
    # Not signed in and nothing baked: refused before anything is rendered or written.
    calls.clear()
    with pytest.raises(ValueError, match="Sign in first"):
        flasher.run_flash(dict(v, operator_token=""), lines.append, lambda pct, text: None, threading.Event())
    assert calls == []
    # A rejected sign-in, or another account's id, surfaces as the console's error with its code.
    for code, words in ((401, "invalid API token"), (409, TAKEN)):
        err = flasher.console.ConsoleError(f"/api/operator/devices: {words}")
        err.code, err.body = code, {"detail": words}
        monkeypatch.setattr(flasher.console, "register_device", lambda *a, e=err: (_ for _ in ()).throw(e))
        with pytest.raises(flasher.console.ConsoleError, match=words) as info:
            flasher.run_flash(v, lines.append, lambda pct, text: None, threading.Event())
        assert info.value.code == code and calls == []
    # A dry run checks the sign-in and stops there: nothing is registered.
    monkeypatch.setattr(flasher.console, "register_device", lambda *a: pytest.fail("registered in a dry run"))
    lines.clear()
    assert flasher.run_flash(v, lines.append, lambda pct, text: None, threading.Event(), dry_run=True) == "matt"
    assert "Dry run: the projector is not registered on the console." in lines
    # A baked key (offline build) or a device token: the console is not contacted at all.
    monkeypatch.setattr(flasher.console, "me", lambda *a: pytest.fail("checked with a baked key"))
    assert flasher.run_flash(dict(v, enrollment_key=KEY, operator_token=""), lines.append, lambda pct, text: None,
                             threading.Event()) == ""
    provision = (boot / "projection5000-provision.sh").read_bytes()
    assert b"\nENROLL_KEY=" + KEY.encode() + b"\n" in provision and b"\nDEVICE_TOKEN=\n" in provision
    assert flasher.done_text() in lines and any("carries the enrollment key" in s for s in lines)
    flasher.run_flash(dict(v, token="tok-lobby-0123456789", operator_token=""), lines.append,
                      lambda pct, text: None, threading.Event())


def test_taken_name_is_said_under_the_name_field(monkeypatch):
    """409 from the console (the id belongs to another account): the words under Device name, the focus there,
    the sign-in kept; 403 (the account can only view now): the words on the status line, the sign-in forgotten."""
    monkeypatch.setattr(flasher.disk, "list_disks", lambda: [])
    dialogs = []
    monkeypatch.setattr(flasher.messagebox, "showerror", lambda *a, **k: dialogs.append(a))
    _signed_in(monkeypatch, token=OPERATOR_TOKEN)
    root = _root()
    app = flasher.App(root)
    app.op = {"token": OPERATOR_TOKEN, "username": "matt"}
    flasher.save_operator_config(app.console_url, OPERATOR_TOKEN, "matt")
    err = flasher.console.ConsoleError("/api/operator/devices: " + TAKEN)
    err.code, err.body = 409, {"detail": TAKEN}
    monkeypatch.setattr(flasher, "run_flash", lambda *a, **k: (_ for _ in ()).throw(err))
    app._run_flash(dict(FULL, enrollment_key="", operator_token=OPERATOR_TOKEN))
    assert _pump(root, app, lambda: "name" in _shown_errors(app))
    assert _shown_errors(app)["name"] == TAKEN and root.focus_get() in (app.name_entry, None)
    assert _status(app) == "That name is taken. Pick another name and press FLASH again."
    assert dialogs == [] and app.connected() and str(app.flash_btn["state"]) == "normal"
    err = flasher.console.ConsoleError("/api/operator/devices: " + VIEW_ONLY)
    err.code, err.body = 403, {"detail": VIEW_ONLY}
    app._run_flash(dict(FULL, enrollment_key="", operator_token=OPERATOR_TOKEN))
    assert _pump(root, app, lambda: not app.connected())
    assert _status(app) == VIEW_ONLY and dialogs == [] and not flasher.operator_config_path().exists()
    root.destroy()


def test_cancel_after_write_is_honoured_and_reported(monkeypatch, tmp_path):
    calls, lines = [], []
    card, boot = _flash_stubs(monkeypatch, tmp_path, calls)
    img = tmp_path / "x.img"
    img.write_bytes(b"\x01" * 4096)
    cancel = threading.Event()
    monkeypatch.setattr(flasher.disk, "find_boot_volume",
                        lambda n, timeout=30.0, cancel_event=None, log=None: cancel.set() or "Z:/")
    v = dict(FULL, image_path=str(img), disk_info=dict(DISK, size=1 << 20))
    with pytest.raises(flasher.disk.Cancelled, match="first-boot files are NOT"):
        flasher.run_flash(v, lines.append, lambda pct, text: None, cancel)
    assert not (boot / "firstrun.sh").exists() and "eject" not in calls
    # Cancel before the disk is touched: a plain cancellation, the card was never touched.
    calls.clear()
    cancel = threading.Event()
    real_obtain = flasher.obtain_image
    monkeypatch.setattr(flasher, "obtain_image", lambda *a, **k: cancel.set() or real_obtain(*a, **k))
    with pytest.raises(flasher.disk.Cancelled) as e:
        flasher.run_flash(v, lines.append, lambda pct, text: None, cancel)
    assert str(e.value) == "" and calls == []
    # Cancel during the write: the card is reported unusable.
    cancel = threading.Event()
    monkeypatch.setattr(flasher, "obtain_image", real_obtain)
    with pytest.raises(flasher.disk.Cancelled, match="NOT usable"):
        flasher.run_flash(v, lines.append, lambda pct, text: cancel.set() if "written" in text else None, cancel)


def test_failure_after_write_explains_the_card_state(monkeypatch, tmp_path):
    calls, lines = [], []
    _flash_stubs(monkeypatch, tmp_path, calls)
    img = tmp_path / "x.img"
    img.write_bytes(b"\x01" * 4096)

    def no_volume(n, timeout=30.0, cancel_event=None, log=None):
        raise flasher.disk.DiskError("no FAT boot partition appeared on disk 2 within 30 s")

    monkeypatch.setattr(flasher.disk, "find_boot_volume", no_volume)
    v = dict(FULL, image_path=str(img), disk_info=dict(DISK, size=1 << 20))
    with pytest.raises(flasher.disk.DiskError) as e:
        flasher.run_flash(v, lines.append, lambda pct, text: None, threading.Event())
    assert "no FAT boot partition" in str(e.value) and "first-boot files were NOT" in str(e.value)


def test_dry_run_stops_before_disk(monkeypatch, tmp_path):
    img = tmp_path / "x.img"
    img.write_bytes(b"\x01" * 1024)
    # A dry run validates, renders and resolves the image; with a baked key it never contacts the console.
    monkeypatch.setattr(flasher.console.urllib.request, "urlopen",
                        lambda *a, **k: pytest.fail("console contacted in dry run"))
    monkeypatch.setattr(flasher.disk, "clear_disk", lambda *a: pytest.fail("clear_disk called in dry run"))
    monkeypatch.setattr(flasher.disk, "check_disk", lambda d: pytest.fail("check_disk called in dry run"))
    monkeypatch.setattr(flasher.disk, "open_physical_drive",
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
    monkeypatch.setattr(flasher.disk, "list_disks", lambda: [])
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
    assert "Image: raspios-lite-arm64-test.img.xz (bundled in this program)" in text
    # Dry run names it too and stays off the network.
    lines.clear()
    flasher.run_flash(dict(v, disk_info=None), lines.append, lambda pct, text: None, threading.Event(), dry_run=True)
    assert any(s.startswith("Dry run: would write raspios-lite-arm64-test.img.xz to") for s in lines)
    # Oversized: refused with the bundled name before the card is touched.
    calls.clear()
    with pytest.raises(flasher.disk.DiskError, match="raspios-lite-arm64-test.img.xz is larger than the card"):
        flasher.run_flash(dict(v, disk_info=dict(DISK, size=1024)), lines.append, lambda pct, text: None,
                          threading.Event())
    assert calls == []


def test_gui_uses_the_bundled_image_by_default(monkeypatch, tmp_path):
    monkeypatch.setattr(flasher.disk, "list_disks", lambda: [])
    b = _bundled_exe(tmp_path)
    monkeypatch.setattr(flasher.bundle, "find_bundle", lambda path=None: b)
    root = _root()
    app = flasher.App(root)
    assert app.bundled is b and app.v["image_mode"].get() == "bundled"  # no image choice on the screen
    texts = " ".join(_all_texts(root, []))
    assert _widgets(root, flasher.ttk.Radiobutton) == [] and "Bundled" not in texts and "Local image" not in texts
    # Done: the status line and a dialog naming the device id.
    done = []
    monkeypatch.setattr(flasher.messagebox, "showinfo", lambda *a, **k: done.append(a[1]))
    monkeypatch.setattr(flasher, "run_flash", lambda *a, **k: None)
    app._run_flash(dict(FULL, dry_run=False))
    assert _pump(root, app, lambda: bool(done))
    assert done == [flasher.done_text() + "\n\nDevice id: lobby"] and _status(app) == flasher.done_text()
    root.destroy()
    # A developer's --image wins over the bundle; without a bundle the model's image is downloaded.
    root = _root()
    assert flasher.App(root, image="C:/dev/x.img").v["image_mode"].get() == "local"
    root.destroy()
    monkeypatch.setattr(flasher.bundle, "find_bundle", lambda path=None: None)
    root = _root()
    assert flasher.App(root).v["image_mode"].get() == "latest"
    root.destroy()
