"""The macOS host layer on any OS: the folders under ~/Library/Application Support, the sign-in token in the
login keychain (`security` faked) as the flasher's operator config uses it, the CoreText font registration
(the frameworks faked), the 0600 key file, the work area and where the .app leaves selfcheck.txt."""
import os
import subprocess
import sys

import pytest

import flasher
import machost
import sshkey
from conftest import new_root
from test_console import OPERATOR_TOKEN


class FakeSecurity:
    """/usr/bin/security with one generic-password slot; records every call."""

    def __init__(self, monkeypatch):
        self.calls = []
        self.stored = None
        self.deny = False
        monkeypatch.setattr(machost.subprocess, "run", self)

    def __call__(self, argv, **kw):
        assert argv[0] == machost.SECURITY and kw["stdin"] is subprocess.DEVNULL and kw["capture_output"]
        self.calls.append(argv[1:])
        verb = argv[1]
        if self.deny:
            return subprocess.CompletedProcess(argv, 51, "", "security: SecKeychainSearchCopyNext: User interaction is not allowed.\n")
        if verb == "add-generic-password":
            assert argv[2:8] == ["-U", "-s", machost.KEYCHAIN_SERVICE, "-a", machost.KEYCHAIN_ACCOUNT, "-w"]
            self.stored = argv[8]
            return subprocess.CompletedProcess(argv, 0, "", "")
        if verb == "find-generic-password":
            assert argv[2:] == ["-s", machost.KEYCHAIN_SERVICE, "-a", machost.KEYCHAIN_ACCOUNT, "-w"]
            if self.stored is None:
                return subprocess.CompletedProcess(argv, 44, "", "The specified item could not be found in the keychain.\n")
            return subprocess.CompletedProcess(argv, 0, self.stored + "\n", "")
        if verb == "delete-generic-password":
            assert argv[2:] == ["-s", machost.KEYCHAIN_SERVICE, "-a", machost.KEYCHAIN_ACCOUNT]
            rc = 0 if self.stored is not None else 44
            self.stored = None
            return subprocess.CompletedProcess(argv, rc, "", "")
        raise AssertionError(argv)


def test_folders_live_in_application_support(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    if sys.platform == "win32":
        monkeypatch.setenv("USERPROFILE", str(tmp_path))  # Path.home() reads this on Windows
    assert machost.data_dir() == tmp_path / "Library" / "Application Support" / "Projection5000"
    assert machost.config_dir() == machost.data_dir()  # no roaming/local split; the token is in the keychain
    assert machost.NAME == "macOS" and machost.is_admin() is True and machost.relaunch_elevated(["--x"]) is False
    assert machost.KEYCHAIN_SERVICE == "Matt Brown's Projection5000"
    assert machost.FALLBACK_FONTS == {"display": "Menlo", "mono": "Menlo", "sans": "Helvetica Neue"}
    assert machost.NO_SCAN_HINT == "type the network name"


def test_token_round_trip_through_the_keychain(monkeypatch):
    sec = FakeSecurity(monkeypatch)
    fields = machost.seal_token(OPERATOR_TOKEN)
    assert fields == {"token": "", "token_keychain": True} and sec.stored == OPERATOR_TOKEN
    assert machost.open_token(dict(fields, console_url="x")) == OPERATOR_TOKEN
    assert machost.open_token({"token": " plain ", "token_keychain": False}) == "plain"  # the plain-text fallback
    assert machost.open_token({}) == "" and machost.open_token({"token": 5}) == ""
    machost.forget_token(fields)
    assert sec.stored is None and machost.open_token(fields) == ""  # gone: sign in again
    machost.forget_token(fields)  # twice is fine
    machost.forget_token({"token": "plain"})  # nothing in the keychain to delete
    assert [c[0] for c in sec.calls] == ["add-generic-password", "find-generic-password", "delete-generic-password",
                                         "find-generic-password", "delete-generic-password"]
    # Access denied in the keychain prompt: no token (the next FLASH connects again), never an exception.
    machost.seal_token(OPERATOR_TOKEN)
    sec.deny = True
    assert machost.open_token(fields) == ""
    with pytest.raises(machost.HostError, match="User interaction is not allowed"):
        machost.seal_token(OPERATOR_TOKEN)
    machost.forget_token(fields)  # a failing delete is swallowed
    monkeypatch.setattr(machost.subprocess, "run", lambda argv, **kw: (_ for _ in ()).throw(FileNotFoundError("security")))
    with pytest.raises(machost.HostError, match="security"):
        machost.seal_token(OPERATOR_TOKEN)
    assert machost.open_token(fields) == ""
    machost.forget_token(fields)


def test_flasher_operator_config_keeps_no_secret_in_the_file_on_macos(monkeypatch, tmp_path):
    """The Windows twin of this test is test_operator_config_round_trip_is_dpapi_protected."""
    monkeypatch.setattr(flasher, "host", machost)
    monkeypatch.setattr(machost, "config_dir", lambda: tmp_path / "Projection5000")
    sec = FakeSecurity(monkeypatch)
    path = tmp_path / "Projection5000" / "signin.json"  # not flasher.json: that is the remembered form, same folder
    assert flasher.operator_config_path() == path
    monkeypatch.setattr(machost, "data_dir", lambda: tmp_path / "Projection5000")
    monkeypatch.setattr(flasher.imagefetch, "host", machost)
    assert flasher.settings_path() == tmp_path / "Projection5000" / "flasher.json" != path
    assert flasher.load_operator_config() == {"console_url": "", "token": "", "username": ""}
    assert flasher.save_operator_config("https://c.example/", " " + OPERATOR_TOKEN + " ", " matt ") == ""
    text = path.read_text("utf-8")
    assert OPERATOR_TOKEN not in text and '"token_keychain": true' in text and '"token": ""' in text
    assert sec.stored == OPERATOR_TOKEN
    assert flasher.load_operator_config() == {"console_url": "https://c.example", "token": OPERATOR_TOKEN,
                                              "username": "matt"}
    # Sign out deletes the keychain item and the file; twice is fine.
    flasher.clear_operator_config()
    flasher.clear_operator_config()
    assert sec.stored is None and not path.exists() and flasher.load_operator_config()["token"] == ""
    # The keychain refusing: plain text with a warning that names it.
    sec.deny = True
    warning = flasher.save_operator_config("https://c.example", OPERATOR_TOKEN)
    assert warning.startswith("WARNING: the keychain is not available") and "signin.json" in warning
    assert OPERATOR_TOKEN in path.read_text("utf-8")
    sec.deny = False
    assert flasher.load_operator_config()["token"] == OPERATOR_TOKEN
    for junk in ("[]", "{not json", '{"console_url": 5, "token": 7}'):
        path.write_text(junk, "utf-8")
        assert flasher.load_operator_config() == {"console_url": "", "token": "", "username": ""}


def test_fonts_register_through_coretext_for_this_process(monkeypatch, tmp_path):
    calls = []

    class CF:
        def CFStringCreateWithCString(self, alloc, path, enc):
            calls.append(("string", path, enc))
            return 0x1001

        def CFURLCreateWithFileSystemPath(self, alloc, s, style, is_dir):
            calls.append(("url", s, style, is_dir))
            return 0x2002

        def CFRelease(self, ref):
            calls.append(("release", ref))

    class CT:
        ok = True

        def CTFontManagerRegisterFontsForURL(self, url, scope, error):
            calls.append(("register", url, scope))
            return self.ok

    monkeypatch.setattr(machost, "_frameworks", lambda: (CF(), CT()))
    paths = [tmp_path / "fonts" / n for n in flasher.FONT_FILES]
    assert machost.load_fonts(paths) == list(flasher.FONT_FILES)
    registered = [c for c in calls if c[0] == "register"]
    assert registered == [("register", 0x2002, machost.kCTFontManagerScopeProcess)] * len(paths)
    assert machost.kCTFontManagerScopeProcess == 1  # never installed, gone with the process
    assert [c for c in calls if c[0] == "string"] == [("string", os.fsencode(str(p)), machost.kCFStringEncodingUTF8)
                                                       for p in paths]
    assert [c for c in calls if c[0] == "url"] == [("url", 0x1001, machost.kCFURLPOSIXPathStyle, False)] * len(paths)
    assert [c for c in calls if c[0] == "release"] == [("release", 0x2002), ("release", 0x1001)] * len(paths)
    CT.ok = False
    assert machost.load_fonts(paths) == []
    monkeypatch.setattr(machost, "_frameworks", lambda: (_ for _ in ()).throw(OSError("no CoreText")))
    assert machost.load_fonts(paths) == []  # Tk then falls back to Menlo / Helvetica Neue
    # flasher's font_families with the macOS fallbacks
    monkeypatch.setattr(flasher, "host", machost)
    assert flasher.font_families([]) == {"display": "Menlo", "mono": "Menlo", "sans": "Helvetica Neue"}
    assert flasher.font_families(["Silkscreen"])["display"] == "Silkscreen"


def test_private_key_is_owner_only(tmp_path, monkeypatch):
    f = tmp_path / "id_ed25519"
    f.write_text("secret")
    assert machost.restrict_file(f) == ""
    if sys.platform != "win32":
        assert oct(f.stat().st_mode & 0o777) == "0o600"
    assert machost.restrict_file(tmp_path / "missing").startswith("WARNING: could not make")
    # sshkey on macOS: the key under Application Support, made 0600 by this host.
    monkeypatch.setattr(sshkey, "host", machost)
    monkeypatch.setattr(machost, "config_dir", lambda: tmp_path / "Projection5000")
    line = sshkey.ensure_keypair()
    priv = tmp_path / "Projection5000" / "ssh" / "id_ed25519"
    assert sshkey.private_path() == priv and priv.is_file() and line.startswith("ssh-ed25519 ")
    if sys.platform != "win32":
        assert oct(priv.stat().st_mode & 0o777) == "0o600"


def test_work_area_icon_dpi_and_selfcheck_paths(monkeypatch, tmp_path):
    class Root:
        def winfo_screenheight(self):
            return 1080

        def iconbitmap(self, *a):
            raise AssertionError("iconbitmap is a no-op on macOS")

    assert machost.work_area(Root()) == (machost.MENU_BAR, 1080)
    machost.set_window_icon(Root(), tmp_path / "icon.ico")
    machost.set_dpi_aware()
    app = tmp_path / "dist" / "Projection5000 SD Flasher.app" / "Contents" / "MacOS" / "Projection5000 SD Flasher"
    monkeypatch.setattr(machost.sys, "executable", str(app))
    monkeypatch.setattr(machost, "data_dir", lambda: tmp_path / "data")
    assert machost.selfcheck_paths() == [tmp_path / "dist" / "selfcheck.txt", tmp_path / "data" / "selfcheck.txt"]
    monkeypatch.setattr(machost.sys, "executable", str(tmp_path / "python3"))
    assert machost.selfcheck_paths()[0] == tmp_path / "selfcheck.txt"
    assert machost.attach_console() == (sys.stdout is not None)


def test_the_whole_gui_runs_on_the_mac_host(monkeypatch, tmp_path):
    """flasher.App with machost, macdisk, macwifi and maclocale behind sysplat's names: the same screen."""
    import tkinter as tk

    import macdisk
    import maclocale
    import macwifi
    from test_macdisk import FakeDiskutil

    monkeypatch.setattr(flasher, "host", machost)
    monkeypatch.setattr(flasher.imagefetch, "host", machost)  # the data folder (log, settings, images)
    monkeypatch.setattr(flasher, "disk", macdisk)
    monkeypatch.setattr(flasher, "defaults", maclocale)
    monkeypatch.setattr(flasher, "wifi", macwifi)
    monkeypatch.setattr(machost, "data_dir", lambda: tmp_path / "Projection5000")
    monkeypatch.setattr(machost, "config_dir", lambda: tmp_path / "Projection5000")
    monkeypatch.setattr(maclocale, "localtime_target", lambda: "/var/db/timezone/zoneinfo/Europe/Dublin")
    monkeypatch.setattr(maclocale, "_defaults", lambda *a: {("-g", "AppleLocale"): "en_IE"}.get(a, "com.apple.keylayout.Irish"))
    monkeypatch.setattr(macwifi, "_profile", lambda: "{}")
    monkeypatch.setattr(machost.subprocess, "run", lambda argv, **kw: subprocess.CompletedProcess(argv, 44, "", ""))
    FakeDiskutil(monkeypatch)
    root = new_root()
    try:
        app = flasher.App(root)
        v = app.values()
        assert (v["timezone"], v["keymap"], v["wifi_country"]) == ("Europe/Dublin", "ie", "IE")
        assert root.title() == "Matt Brown's Projection5000" and app.status_label.cget("text") == "Ready."
        log = app.log_text.get("1.0", "end")
        assert "Fonts: " in log and app.account_label.cget("text") == "Not connected"
        for _ in range(100):
            root.update()
            if app.disks and app.ssid_hint.cget("text") != flasher.SCANNING_HINT:
                break
            __import__("time").sleep(0.02)
        assert app.disk_box.get() == "disk4  SanDisk 3.2Gen1  32 GB"
        assert app.ssid_hint.cget("text") == "type the network name"  # nothing in range: no Location hint on a Mac
        assert flasher.log_path() == tmp_path / "Projection5000" / "flasher.log" and flasher.log_path().is_file()
        app.on_close()
        assert (tmp_path / "Projection5000" / "flasher.json").is_file()  # the remembered form, never a secret
    finally:
        try:
            root.destroy()
        except tk.TclError:
            pass
