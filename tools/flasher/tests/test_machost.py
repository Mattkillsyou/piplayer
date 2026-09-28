"""The macOS host layer on any OS: the folders under ~/Library/Application Support, the sign-in token in the
login keychain (`security` faked) as the flasher's operator config uses it, the CoreText font registration
(the frameworks faked), the 0600 key file, the work area and where the .app leaves selfcheck.txt."""
import os
import plistlib
import shutil
import ssl
import subprocess
import sys
from pathlib import Path

import pytest

import console
import flasher
import imagefetch
import machost
import sshkey
import sysplat
from conftest import new_root
from test_console import OPERATOR_TOKEN


class FakeSecurity:
    """/usr/bin/security with one generic-password slot; records every call."""

    def __init__(self, monkeypatch):
        self.calls = []
        self.stored = None
        self.deny = False
        self.pem = ""  # what find-certificate prints for a keychain
        self.missing = False  # no /usr/bin/security at all
        monkeypatch.setattr(machost.subprocess, "run", self)

    def __call__(self, argv, **kw):
        assert argv[0] == machost.SECURITY and kw["stdin"] is subprocess.DEVNULL and kw["capture_output"]
        self.calls.append(argv[1:])
        verb = argv[1]
        if self.missing:
            raise FileNotFoundError(argv[0])
        if verb == "find-certificate":
            assert argv[2:4] == ["-a", "-p"] and argv[4] in machost.SYSTEM_KEYCHAINS
            return subprocess.CompletedProcess(argv, 0, self.pem, "")
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


APP = "Projection5000 SD Flasher.app"


def _app(where, text, bundle_id=machost.BUNDLE_ID, name=APP):
    exe = where / name / "Contents" / "MacOS" / "Projection5000 SD Flasher"
    exe.parent.mkdir(parents=True)
    exe.write_text(text)
    with open(where / name / "Contents" / "Info.plist", "wb") as f:
        plistlib.dump({"CFBundleIdentifier": bundle_id}, f)
    return exe


class FakeMacTools:
    """hdiutil, ditto and open on a temp folder standing in for /Applications: attach puts the new app at the
    mount point it is given, ditto copies (or fails half way), open records what it was asked to open."""

    def __init__(self, monkeypatch):
        self.calls = []
        self.ditto_fails = False
        self.image = lambda mount: _app(mount, "new")  # what attach puts on the image
        self.running = None  # the running app's executable text when open -n -a is called
        monkeypatch.setattr(machost.subprocess, "run", self)

    def __call__(self, argv, **kw):
        assert argv[0].startswith("/usr/bin/")
        assert kw["timeout"] and kw["stdin"] is subprocess.DEVNULL and kw["capture_output"]
        self.calls.append(argv)
        ok = subprocess.CompletedProcess(argv, 0, "", "")
        if argv[:2] == [machost.HDIUTIL, "attach"]:
            self.image(Path(argv[argv.index("-mountpoint") + 1]))
        elif argv[:2] == [machost.HDIUTIL, "detach"]:
            for p in Path(argv[2]).iterdir():
                shutil.rmtree(p)
        elif argv[0] == machost.DITTO:
            if self.ditto_fails:
                Path(argv[2]).mkdir()  # half a copy
                return subprocess.CompletedProcess(argv, 1, "", "ditto: No space left on device")
            shutil.copytree(argv[1], argv[2])
        elif argv[:3] == [machost.OPEN, "-n", "-a"]:
            self.running = (Path(argv[3]) / "Contents" / "MacOS" / "Projection5000 SD Flasher").read_text()
        else:
            assert argv[0] == machost.OPEN and len(argv) == 2, argv
        return ok

    def tools(self):
        return [Path(c[0]).name for c in self.calls]


@pytest.fixture
def mac_update(monkeypatch, tmp_path):
    """/Applications with the running (old) app in it, and the downloaded disk image."""
    apps = tmp_path / "Applications"
    exe = _app(apps, "old")
    monkeypatch.setattr(machost.sys, "executable", str(exe))
    monkeypatch.setattr(machost.sys, "frozen", True, raising=False)   # the built app, not python3 flasher.py
    dmg = tmp_path / "downloaded" / "Projection5000-SD-Flasher-mac-arm64.dmg"
    dmg.parent.mkdir()
    dmg.write_bytes(b"x")
    return FakeMacTools(monkeypatch), apps, exe, dmg


def _fell_back(tools, dmg, line, quits, why):
    assert quits is False and why in line and line.endswith("Drag the new app to Applications to finish.")
    assert tools.calls[-1] == [machost.OPEN, str(dmg)]  # the image, opened in Finder as before


def test_an_update_replaces_the_app_and_starts_the_new_one(mac_update):
    tools, apps, exe, dmg = mac_update
    line, quits = machost.install_update(dmg)
    assert (line, quits) == ("Updated. Starting the new version.", True)
    assert tools.tools() == ["hdiutil", "ditto", "hdiutil", "open"]
    attach = tools.calls[0]
    assert attach[-1] == str(dmg) and "-readonly" in attach and "-nobrowse" in attach and "-noautoopen" in attach
    mount = Path(attach[attach.index("-mountpoint") + 1])
    assert tools.calls[1][1:] == [str(mount / APP), str(apps / f".{APP}.new-{os.getpid()}")]  # beside the old: a rename
    assert tools.calls[2][:3] == [machost.HDIUTIL, "detach", str(mount)] and not mount.exists()
    assert exe.read_text() == "new" and sorted(p.name for p in apps.iterdir()) == [APP]  # nothing left over
    assert tools.calls[3] == [machost.OPEN, "-n", "-a", str(apps / APP)] and tools.running == "new"
    assert machost.UPDATE_ASSET in ("mac_arm64", "mac_intel")


def test_a_folder_this_user_cannot_change_opens_the_image(mac_update, monkeypatch):
    """A standard account and /Applications: nothing is attached or copied, the image is opened instead."""
    tools, apps, exe, dmg = mac_update
    access = os.access
    monkeypatch.setattr(machost.os, "access", lambda p, m: False if Path(p) == apps else access(p, m))
    _fell_back(tools, dmg, *machost.install_update(dmg), "cannot change")
    assert len(tools.calls) == 1 and exe.read_text() == "old"


def test_running_from_the_disk_image_opens_the_image(mac_update, monkeypatch):
    tools, _, _, dmg = mac_update
    monkeypatch.setattr(machost.sys, "executable",
                        f"/Volumes/Projection5000 SD Flasher/{APP}/Contents/MacOS/Projection5000 SD Flasher")
    _fell_back(tools, dmg, *machost.install_update(dmg), "running from a disk image")
    assert len(tools.calls) == 1
    # From source (python3 flasher.py) there is no app to replace either.
    tools.calls.clear()
    monkeypatch.setattr(machost.sys, "executable", "/usr/local/bin/python3")
    _fell_back(tools, dmg, *machost.install_update(dmg), "not running from an app")


def test_a_failed_copy_leaves_the_old_app_untouched(mac_update):
    tools, apps, exe, dmg = mac_update
    tools.ditto_fails = True
    _fell_back(tools, dmg, *machost.install_update(dmg), "No space left on device")
    assert exe.read_text() == "old" and sorted(p.name for p in apps.iterdir()) == [APP]  # the half copy is gone
    assert tools.calls[-2][:2] == [machost.HDIUTIL, "detach"]  # the image let go before Finder opens it


def test_a_failed_swap_puts_the_old_app_back(mac_update, monkeypatch):
    """The old app is moved aside, then the new one cannot be renamed in: the old one goes back."""
    tools, apps, exe, dmg = mac_update
    rename = os.rename

    def failing(src, dst):
        if Path(src).name.startswith(f".{APP}.new"):
            raise OSError("Operation not permitted")
        rename(src, dst)

    monkeypatch.setattr(machost.os, "rename", failing)
    _fell_back(tools, dmg, *machost.install_update(dmg), "Operation not permitted")
    assert exe.read_text() == "old" and sorted(p.name for p in apps.iterdir()) == [APP]
    assert not any(c[:3] == [machost.OPEN, "-n", "-a"] for c in tools.calls)


def test_an_image_that_will_not_open_is_said_so(mac_update, monkeypatch):
    _, _, _, dmg = mac_update
    monkeypatch.setattr(machost.subprocess, "run",
                        lambda argv, **kw: subprocess.CompletedProcess([], 1, "", "image not recognized"))
    with pytest.raises(OSError, match="image not recognized"):
        machost.install_update(dmg)


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
        assert root.title() == "Matt Brown Projection 5000" and app.status_label.cget("text") == flasher.SIGNIN_FIRST_TEXT
        log = app.log_text.get("1.0", "end")
        assert "Fonts: " in log and app.account_label.cget("text") == "Not signed in"
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


def _bare_context():
    """A context that trusts nothing (create_default_context on the test machine would load its own roots)."""
    return ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)


def _a_root_pem() -> str:
    ders = ssl.create_default_context().get_ca_certs(binary_form=True)
    if not ders and hasattr(ssl, "enum_certificates"):  # Windows keeps them in its store, not in the context
        ders = [der for der, enc, _ in ssl.enum_certificates("ROOT") if enc == "x509_asn"]
    if not ders:
        pytest.skip("no trusted roots on this machine to borrow")
    return ssl.DER_cert_to_PEM_cert(ders[0])


def test_https_trusts_the_roots_this_mac_trusts(monkeypatch):
    """The bundled OpenSSL finds no certificate file on a Mac: the roots come from the system keychains via
    `security find-certificate -a -p`, one certificate at a time so a bad one is skipped, not fatal."""
    root = _a_root_pem()  # before the patch below empties create_default_context()
    monkeypatch.setattr(machost.ssl, "create_default_context", _bare_context)
    sec = FakeSecurity(monkeypatch)
    sec.pem = "\n".join(["-----BEGIN CERTIFICATE-----", "not a certificate", "-----END CERTIFICATE-----", ""]) + root
    machost.ssl_context.cache_clear()
    ctx = machost.ssl_context()
    assert [c[:3] + [c[3]] for c in sec.calls] == [["find-certificate", "-a", "-p", k] for k in machost.SYSTEM_KEYCHAINS]
    assert ctx.cert_store_stats()["x509_ca"] == 1  # the same root from both keychains counts once
    assert ctx.verify_mode == ssl.CERT_REQUIRED and ctx.check_hostname
    assert machost.ssl_context() is ctx  # built once

    sec.missing = True
    machost.ssl_context.cache_clear()
    assert machost.ssl_context().cert_store_stats()["x509_ca"] == 0  # no security tool: still a verifying context
    machost.ssl_context.cache_clear()


def test_console_and_image_download_use_the_host_context(monkeypatch):
    marker = _bare_context()
    monkeypatch.setattr(sysplat.host, "ssl_context", lambda: marker)
    console._opener.cache_clear()
    https = [h for h in console._opener().handlers if isinstance(h, console.urllib.request.HTTPSHandler)]
    assert https and https[0]._context is marker
    console._opener.cache_clear()

    seen = {}
    monkeypatch.setattr(imagefetch.urllib.request, "urlopen", lambda req, **kw: seen.update(kw) or (_ for _ in ()).throw(OSError("stop")))
    assert imagefetch.remote_size("https://example.invalid/x") is None
    assert seen["context"] is marker and seen["timeout"] == 30


@pytest.mark.skipif(sys.platform != "darwin", reason="the real security tool and keychains")
def test_the_real_keychains_give_the_roots(monkeypatch):
    """On a Mac: with OpenSSL's own file taken away, the keychains alone give Apple's ~150 roots."""
    monkeypatch.setattr(machost.ssl, "create_default_context", _bare_context)
    machost.ssl_context.cache_clear()
    try:
        assert machost.ssl_context().cert_store_stats()["x509_ca"] > 100
    finally:
        machost.ssl_context.cache_clear()


def test_only_our_own_app_is_replaced_and_only_by_our_own_app(mac_update, monkeypatch):
    """Two apps on the image, a symlinked one, an app that is not the flasher on either side, or the program
    running from source: nothing is copied or swapped, the image is opened instead."""
    tools, apps, exe, dmg = mac_update
    tools.image = lambda mount: (_app(mount, "new"), _app(mount, "other", name="Other.app"))
    _fell_back(tools, dmg, *machost.install_update(dmg), "holds 2 apps")
    tools.calls.clear()
    tools.image = lambda mount: (mount.mkdir(parents=True, exist_ok=True), (mount / APP).symlink_to(apps / APP))
    try:
        _fell_back(tools, dmg, *machost.install_update(dmg), "holds 0 apps")
    except OSError:
        pytest.skip("symlinks need privileges on this Windows")
    tools.calls.clear()
    tools.image = lambda mount: _app(mount, "new", bundle_id="com.example.other")
    _fell_back(tools, dmg, *machost.install_update(dmg), "not this program")
    tools.calls.clear()
    tools.image = lambda mount: _app(mount, "new")
    with open(apps / APP / "Contents" / "Info.plist", "wb") as f:     # the running app is not ours
        plistlib.dump({"CFBundleIdentifier": "org.python.python"}, f)
    _fell_back(tools, dmg, *machost.install_update(dmg), "is not this program")
    assert exe.read_text() == "old" and sorted(p.name for p in apps.iterdir()) == [APP]


def test_leftovers_of_an_earlier_attempt_never_block_an_update(mac_update):
    tools, apps, exe, dmg = mac_update
    for name in (f".{APP}.new", f".{APP}.old", f".{APP}.old-1234"):
        _app(apps, "leftover", name=name)
    line, quits = machost.install_update(dmg)
    assert quits and exe.read_text() == "new" and sorted(p.name for p in apps.iterdir()) == [APP]


def test_an_app_that_cannot_be_moved_aside_leaves_no_copy_behind(mac_update, monkeypatch):
    """macOS App Management (or a busy bundle) refuses to move the running app: the fresh copy goes too."""
    tools, apps, exe, dmg = mac_update
    rename = os.rename

    def refuse_first(src, dst):
        if Path(src) == apps / APP:
            raise OSError("Operation not permitted")
        rename(src, dst)

    monkeypatch.setattr(machost.os, "rename", refuse_first)
    _fell_back(tools, dmg, *machost.install_update(dmg), "Operation not permitted")
    assert exe.read_text() == "old" and sorted(p.name for p in apps.iterdir()) == [APP]


def test_python_itself_is_never_taken_for_our_app(monkeypatch, tmp_path):
    """From source, sys.executable can be Python.app's own binary: that is not a bundle to replace."""
    exe = tmp_path / "Python.app" / "Contents" / "MacOS" / "Python"
    exe.parent.mkdir(parents=True)
    exe.write_text("python")
    monkeypatch.setattr(machost.sys, "executable", str(exe))
    monkeypatch.delattr(machost.sys, "frozen", raising=False)
    assert machost.running_bundle() is None
