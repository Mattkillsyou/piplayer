"""Regression tests for the defects the September 2026 audit found (see the commit that added this file):
each one failed before its fix. Grouped by module, runnable on any OS."""
import http.server
import ipaddress
import lzma
import os
import threading
import time
import tkinter as tk

import pytest

import console
import firstboot
import flasher
import imagefetch
import wifi
import windisk
import winlocale
from conftest import PUBKEY, new_root, signed_in
from test_console import KEY, OPERATOR_TOKEN, StubConsole, _serve

DISK = {"number": 2, "name": "Generic MassStorageClass", "bus": "USB", "size": 31914983424, "sector": 512,
        "unique_id": "USBSTOR\\X&0:", "serial": "", "signature": 1, "boot": False,
        "label": "Disk 2  Generic MassStorageClass  29.7 GiB"}
FORM = {"name": "Lobby", "ssid": "Venue", "wifi_password": "wp123456", "wifi_hidden": False, "timezone": "UTC",
        "keymap": "us", "wifi_country": "us", "image_mode": "local", "image_path": "", "static_ip": "",
        "gateway": ""}
FULL = dict(FORM, token="", device_id="lobby", username="projector-admin", password="pw",
            console_url="http://console.local/", enrollment_key=KEY, operator_token="", ssh_pubkey=PUBKEY,
            dry_run=False)


# ---------------------------------------------------------------- wifi.py (netsh)

def test_netsh_output_is_utf8_with_the_oem_fallback():
    """netsh writes UTF-8 to a pipe on Windows 10/11: "Café" must not become "Caf├⌐"."""
    text = "SSID 1 : Caf\u00e9\n    Signal : 60%\n"
    assert wifi.decode(text.encode("utf-8")) == text
    assert wifi.parse_networks(wifi.decode(text.encode("utf-8")))[0]["ssid"] == "Caf\u00e9"
    try:
        oem = text.encode("oem")
    except LookupError:
        oem = text.encode("cp437")
    assert "Caf" in wifi.decode(oem) and "\ufffd" not in wifi.decode(oem) or os.name != "nt"


def test_ssid_and_password_spaces_survive_parsing():
    """netsh prints one space after the colon; what follows is the value, spaces and all (validate_cfg then says
    'must not start or end with a space' instead of the card getting a name that does not exist)."""
    assert wifi.parse_networks("SSID 1 :  Lead\n    Signal : 50%\n")[0]["ssid"] == " Lead"
    assert wifi.parse_networks("SSID 1 : Trail \n    Signal : 50%\n")[0]["ssid"] == "Trail "
    assert wifi.parse_saved_password("    Key Content            :  spaced pw \n") == " spaced pw "
    assert wifi.parse_saved_password("    Key Content            : \n") is None
    assert wifi.parse_networks("SSID 1 : Plain\r\n    Signal : 50%\r\n")[0]["ssid"] == "Plain"  # CRLF from netsh
    assert wifi.parse_profiles("\nUser profiles\n-------------\n    All User Profile     : ghost in the wifi\n") \
        == ["ghost in the wifi"]


def test_saved_password_profile_name_has_no_quotes_of_its_own(monkeypatch):
    """netsh rejects name=\\"ghost in the wifi\\" (the quotes survive subprocess's own quoting); name=ghost in the
    wifi is what works for names with spaces."""
    calls = []

    class P:
        returncode = 0
        stdout = b"    Key Content            : p4ss\n"

    monkeypatch.setattr(wifi.subprocess, "run", lambda argv, **kw: calls.append(argv) or P())
    assert wifi.saved_password("ghost in the wifi") == "p4ss"
    assert calls[0][2:] == ["show", "profile", "name=ghost in the wifi", "key=clear"]
    assert wifi.NETSH.lower().endswith(os.path.join("system32", "netsh.exe")) and "SystemRoot" not in wifi.NETSH


def test_current_ssid_on_a_pc_with_two_adapters():
    """The internal adapter connected, a USB dongle listed after it as disconnected: still connected."""
    two = ("\nThere are 2 interfaces on the system:\n\n    Name                   : Wi-Fi\n"
           "    State                  : connected\n    SSID                   : HomeNet\n\n"
           "    Name                   : Wi-Fi 2\n    State                  : disconnected\n")
    assert wifi.parse_current_ssid(two) == "HomeNet"
    assert wifi.parse_current_ssid(two.replace("HomeNet", "HomeNet").replace("connected\n    SSID", "disconnected\n    SSID", 1)) is None
    reversed_ = ("    Name : Wi-Fi 2\n    State : disconnected\n\n    Name : Wi-Fi\n    State : connected\n"
                 "    SSID : HomeNet\n")
    assert wifi.parse_current_ssid(reversed_) == "HomeNet"


# ---------------------------------------------------------------- winlocale.py

def test_keymap_reads_the_layout_word_of_the_hkl(monkeypatch):
    """A German keyboard under an English Windows is HKL 0x04070409: the high word names the layout."""
    monkeypatch.setattr(winlocale.ctypes, "windll",
                        type("W", (), {"user32": type("U", (), {"GetKeyboardLayout": staticmethod(lambda n: 0x04070409)})}),
                        raising=False)
    assert winlocale.input_langid() == 0x0407 and winlocale.keymap() == "de"
    monkeypatch.setattr(winlocale.ctypes.windll.user32, "GetKeyboardLayout", staticmethod(lambda n: 0xF0010409))
    assert winlocale.input_langid() == 0x0409 and winlocale.keymap() == "us"  # a special layout: the low word
    monkeypatch.setattr(winlocale.ctypes.windll.user32, "GetKeyboardLayout", staticmethod(lambda n: 0xE0010411))
    assert winlocale.input_langid() == 0x0411 and winlocale.keymap() == "jp"  # a Japanese IME: the input language
    assert winlocale.keymap(0x1009) == "us"  # English (Canada) is the plain US keyboard
    assert winlocale.keymap(0x0c0c) == "ca"  # French (Canada)
    assert winlocale.keymap(0x0813) == "be" and winlocale.keymap(0x080c) == "be"
    assert winlocale.keymap(0x080a) == "latam" and winlocale.keymap(0x2c0a) == "latam"  # Mexico, Argentina
    assert winlocale.keymap(0x0c0a) == "es" and winlocale.keymap(0x040a) == "es"  # Spain
    for km in ("latam", "be", "ca"):
        assert firstboot.KEYMAP_RE.fullmatch(km)


# ---------------------------------------------------------------- firstboot.py

def test_static_ip_must_be_prefix_form_and_gateway_another_host():
    assert firstboot.static_ip_problems("192.168.1.50/255.255.255.0", "192.168.1.1") == \
        ["Static IP must be an IPv4 address with a prefix (e.g. 192.168.1.50/24)."]
    assert firstboot.static_ip_problems("192.168.1.50/0.0.0.255", "192.168.1.1")[0].startswith("Static IP must")
    for gw in ("192.168.1.50", "192.168.1.0", "192.168.1.255"):
        assert firstboot.static_ip_problems("192.168.1.50/24", gw) == \
            ["Gateway must be another IPv4 address in 192.168.1.0/24 (e.g. 192.168.1.1)."]
    assert firstboot.static_ip_problems("192.168.1.50/24", "192.168.1.1") == []
    assert ipaddress.IPv4Interface("192.168.1.50/255.255.255.0")  # what ipaddress alone would have accepted


def test_firstrun_fallback_password_step_counts_its_failure():
    """`printf | run chpasswd -e` ran run() in a subshell, so a failed chpasswd never raised FAILS."""
    s = firstboot.render_firstrun(firstboot.sample_config())
    assert '  run chpasswd -e <<<"pi:$HASH"' in s and "| run chpasswd" not in s


def test_console_wait_hint_names_the_network_kind():
    wired = firstboot.render_provision(dict(firstboot.sample_config(), ethernet_only=True, ssid="", wifi_password=""))
    assert "check the network cable." in wired and "Wi-Fi name" not in wired
    static = firstboot.render_provision(dict(firstboot.sample_config(), static_ip="192.168.1.50/24", gateway="192.168.1.1"))
    assert "check the static IP and gateway, the Wi-Fi name and the password." in static
    wifi_ = firstboot.render_provision(firstboot.sample_config())
    assert "check the Wi-Fi name and password." in wifi_


# ---------------------------------------------------------------- windisk.py

def test_multistream_xz_header_straddling_the_read_boundary(tmp_path):
    """Stream A ends 4 bytes before a 1 MiB read boundary: the next header arrives in two pieces."""
    a = os.urandom(2000)
    xa = lzma.compress(a, format=lzma.FORMAT_XZ)
    b = b"\x11" * 5000
    xb = lzma.compress(b, format=lzma.FORMAT_XZ)
    pad = (1024 * 1024 - 4) - len(xa)
    assert pad > 0 and pad % 4 == 0
    xz = tmp_path / "straddle.img.xz"
    xz.write_bytes(xa + b"\0" * pad + xb)  # stream padding (multiples of 4 nulls) is allowed between streams
    assert b"".join(d for d, _ in windisk.iter_image(str(xz), chunk=65536)) == a + b
    assert windisk.image_size(str(xz)) == len(a) + len(b)


# ---------------------------------------------------------------- console.py

def test_api_calls_never_follow_a_redirect(monkeypatch):
    """A 3xx from the console would re-send the bearer token to the new location (another host, plain http)
    and turn a POST into a GET: it is an error, with the not-a-console hint."""
    class Redirecting(http.server.BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def do_GET(self):
            self.send_response(302)
            self.send_header("Location", "http://127.0.0.1:1/api/operator/me")
            self.send_header("Content-Length", "0")
            self.end_headers()

        do_POST = do_GET

    srv, base = _serve(Redirecting)
    try:
        with pytest.raises(console.ConsoleError, match="HTTP 302.*is this a Projection5000 console") as e:
            console.me(base, OPERATOR_TOKEN)
        assert e.value.code == 302
        with pytest.raises(console.ConsoleError, match="302"):
            console.login(base, "matt", "pw", "pc")
        with pytest.raises(console.ConsoleError, match="302"):
            console.register_device(base, OPERATOR_TOKEN, "lobby", "Lobby")
    finally:
        srv.shutdown()


def test_odd_http_answers_become_console_errors():
    class Broken(http.server.BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def do_GET(self):
            self.wfile.write(b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\nshort")  # IncompleteRead
            self.close_connection = True

    srv, base = _serve(Broken)
    try:
        with pytest.raises(console.ConsoleError, match="cannot reach"):
            console.check_health(base)
    finally:
        srv.shutdown()


# ---------------------------------------------------------------- imagefetch.py

def test_cached_image_serves_offline(tmp_path, monkeypatch):
    """The one-time download the docs promise: the sha256 is kept alongside and the image is used offline."""
    monkeypatch.setattr(imagefetch, "app_dir", lambda: tmp_path)
    (tmp_path / "images").mkdir()
    old = imagefetch.cached_path("2026-01-01-raspios-bookworm-armhf-lite.img.xz")
    old.write_bytes(lzma.compress(b"old" * 100, format=lzma.FORMAT_XZ))
    imagefetch.remember_sha256(old, imagefetch.sha256_file(old).upper())
    assert (tmp_path / "images" / (old.name + ".sha256")).read_text().split() == [imagefetch.sha256_file(old), old.name]
    new = imagefetch.cached_path("2026-09-15-raspios-trixie-armhf-lite.img.xz")
    new.write_bytes(lzma.compress(b"new" * 100, format=lzma.FORMAT_XZ))
    assert imagefetch.newest_cached("armhf") == (old, imagefetch.sha256_file(old))  # the new one has no sha256 yet
    imagefetch.remember_sha256(new, imagefetch.sha256_file(new))
    assert imagefetch.newest_cached("armhf") == (new, imagefetch.sha256_file(new))
    assert imagefetch.newest_cached("arm64") is None
    # obtain_image offline (the redirect cannot be resolved): the cached image, verified, no dialog.
    monkeypatch.setattr(imagefetch, "resolve_latest", lambda url: (_ for _ in ()).throw(imagefetch.FetchError("cannot resolve")))
    lines = []
    image, sha = flasher.obtain_image({"image_mode": "latest", "pi_model": "pi2"}, lines.append, lambda p, t: None,
                                      threading.Event())
    assert image == str(new) and sha == imagefetch.sha256_file(new)
    assert any("Could not reach raspberrypi.com" in s for s in lines) and "Cached image is valid (offline)." in lines
    # A corrupt cached copy is refused (plain words under the model row for an armhf model).
    new.write_bytes(b"garbage")
    with pytest.raises(flasher.ImageOffline):
        flasher.obtain_image({"image_mode": "latest", "pi_model": "pi2"}, lines.append, lambda p, t: None, threading.Event())
    assert any("is corrupt; connect to the internet" in s for s in lines)
    # Nothing cached: the old behaviour (ImageOffline for armhf, FetchError for arm64).
    monkeypatch.setattr(imagefetch, "newest_cached", lambda arch: None)
    with pytest.raises(flasher.ImageOffline):
        flasher.obtain_image({"image_mode": "latest", "pi_model": "pi2"}, lines.append, lambda p, t: None, threading.Event())
    with pytest.raises(imagefetch.FetchError, match="cannot resolve"):
        flasher.obtain_image({"image_mode": "latest", "pi_model": "pi5"}, lines.append, lambda p, t: None, threading.Event())


def test_interrupted_download_is_a_fetch_error(tmp_path):
    class Stalls(http.server.BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def do_GET(self):
            self.send_response(200)
            self.send_header("Content-Length", "10000000")
            self.end_headers()
            self.wfile.write(b"x" * 1000)
            self.wfile.flush()
            self.connection.close()  # reset mid-body

    srv, base = _serve(Stalls)
    try:
        with pytest.raises(imagefetch.FetchError, match="download interrupted|download truncated"):
            imagefetch.download(base + "/x.img.xz", tmp_path / "x.img.xz")
    finally:
        srv.shutdown()
    assert not (tmp_path / "x.img.xz.part").exists()


# ---------------------------------------------------------------- flasher.py (the GUI)

_roots = []


def _root():
    root = new_root()
    _roots.append(root)
    return root


@pytest.fixture(autouse=True)
def _no_leaked_roots():
    yield
    for root in _roots:
        try:
            root.destroy()
        except tk.TclError:
            pass
    _roots.clear()


def _pump(root, until, timeout=3.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        root.update()
        if until():
            return True
        time.sleep(0.02)
    return until()


@pytest.fixture
def stub():
    StubConsole.reset()
    srv, base = _serve(StubConsole)
    try:
        yield base
    finally:
        srv.shutdown()


def test_account_buttons_are_off_while_a_flash_runs(monkeypatch):
    """Sign in/Sign out under Advanced, and FLASH itself, cannot interrupt a running write: a Cancel meant for
    a sign-in must never abort the card."""
    monkeypatch.setattr(flasher.disk, "list_disks", lambda: [])
    flasher.save_operator_config(flasher.console_url(), "p5k_stored", "matt")  # signed in: the form is up
    monkeypatch.setattr(flasher.console, "me", lambda *a: {"username": "matt", "role": "editor"})
    root = _root()
    app = flasher.App(root)
    release = threading.Event()
    monkeypatch.setattr(flasher, "run_flash", lambda *a, **k: release.wait(5))
    monkeypatch.setattr(flasher.messagebox, "showinfo", lambda *a, **k: None)
    app._run_flash_started = False
    app.worker = threading.Thread(target=app._run_flash, args=(dict(FULL, dry_run=True),), daemon=True)
    app.flash_btn.configure(state="disabled")
    app.account_btn.configure(state="disabled")
    app.cancel_btn.grid()
    app.set_phase("Writing the card")
    app.worker.start()
    assert app.busy()
    app.sign_in()  # ignored: nothing changes, the status line keeps the phase, no sign-in box
    assert app.status_label.cget("text") == "Writing the card..." and not app.signin.winfo_manager()
    app.on_flash()  # ignored too
    app._signin_done()  # a late sign-in result must not re-enable FLASH or hide Cancel mid-write
    assert str(app.flash_btn["state"]) == "disabled" and app.cancel_btn.winfo_manager() == "grid"
    release.set()
    assert _pump(root, lambda: not app.busy() and str(app.flash_btn["state"]) == "normal")
    assert str(app.account_btn["state"]) == "normal" and not app.cancel_btn.winfo_manager()
    root.destroy()


def test_on_flash_disables_the_account_row(monkeypatch, tmp_path):
    monkeypatch.setattr(flasher.disk, "list_disks", lambda: [DISK])
    monkeypatch.setattr(flasher, "is_admin", lambda: True)
    monkeypatch.setattr(flasher.messagebox, "askyesno", lambda *a, **k: True)
    monkeypatch.setattr(flasher.messagebox, "showinfo", lambda *a, **k: None)
    seen = []
    monkeypatch.setattr(flasher, "run_flash", lambda *a, **k: seen.append(1))
    img = tmp_path / "x.img"
    img.write_bytes(b"\x01" * 1024)
    signed_in(monkeypatch)
    root = _root()
    app = flasher.App(root)
    app.baked_key = KEY
    assert _pump(root, lambda: bool(app.disks))
    for k, val in dict(FORM, image_path=str(img)).items():
        app.v[k].set(val)
    app.on_flash()
    assert str(app.account_btn["state"]) == "disabled"
    assert _pump(root, lambda: bool(seen) and str(app.flash_btn["state"]) == "normal", timeout=10)
    assert str(app.account_btn["state"]) == "normal"
    root.destroy()


def test_sign_in_answered_after_cancel_is_ignored(monkeypatch, stub):
    """The console answers the sign-in a moment after Cancel: no token is kept, FLASH's erase confirmation never
    fires, the box is closed and the status line is back to Ready."""
    monkeypatch.setattr(flasher.disk, "list_disks", lambda: [])
    monkeypatch.setattr(flasher, "console_url", lambda: stub)
    fired = []
    gate = threading.Event()
    real = console.login

    def slow(*a):
        gate.wait(5)  # Cancel is pressed while the console is still answering
        return real(*a)

    monkeypatch.setattr(flasher.console, "login", slow)
    root = _root()
    app = flasher.App(root)
    app.sign_in(then=lambda: fired.append(1))
    app.op_username.set("matt")
    app.op_password.set("pw")
    app.submit_signin()
    app.cancel_signin()
    gate.set()
    assert _pump(root, lambda: any(path == "/api/operator/login" for path, _ in StubConsole.calls), timeout=5)
    time.sleep(0.5)
    root.update()
    assert fired == [] and app.op["token"] == "" and not flasher.operator_config_path().exists()
    # never signed in: the box stays up (there is no form to go back to) and the late answer changed nothing
    assert app.signin.winfo_manager() == "pack" and not app.form.winfo_manager()
    root.destroy()


def test_stale_401_does_not_wipe_a_newer_sign_in(monkeypatch):
    monkeypatch.setattr(flasher.disk, "list_disks", lambda: [])
    root = _root()
    app = flasher.App(root)
    app.op = {"token": "new-token", "username": "matt"}
    flasher.save_operator_config(app.console_url, "new-token", "matt")
    app._token_rejected("old-token")  # the check of the token that was replaced meanwhile
    assert app.op["token"] == "new-token" and flasher.operator_config_path().exists()
    app._token_rejected("new-token")
    assert app.op["token"] == "" and not flasher.operator_config_path().exists()
    assert "rejected by the console" in app.log_text.get("1.0", "end")
    root.destroy()


def test_unwritable_config_keeps_the_sign_in_for_this_run(monkeypatch, tmp_path):
    monkeypatch.setattr(flasher.disk, "list_disks", lambda: [])
    monkeypatch.setattr(flasher, "save_operator_config", lambda *a: (_ for _ in ()).throw(OSError("read-only profile")))
    root = _root()
    app = flasher.App(root)
    then = []
    app._signed_in("https://c.example", {"token": OPERATOR_TOKEN, "username": "matt"}, lambda: then.append(1))
    assert app.op["token"] == OPERATOR_TOKEN and then == [1]
    assert "WARNING: could not save the sign-in (read-only profile)" in app.log_text.get("1.0", "end")
    assert app.status_label.cget("text") == "Ready." and str(app.flash_btn["state"]) == "normal"
    root.destroy()


def test_revoked_token_during_flash_is_forgotten_in_plain_words(monkeypatch):
    monkeypatch.setattr(flasher.disk, "list_disks", lambda: [])
    dialogs = []
    monkeypatch.setattr(flasher.messagebox, "showerror", lambda *a, **k: dialogs.append(a))
    root = _root()
    app = flasher.App(root)
    app.op = {"token": OPERATOR_TOKEN, "username": "matt"}
    flasher.save_operator_config(app.console_url, OPERATOR_TOKEN, "matt")
    err = console.ConsoleError("/api/operator/me: invalid API token")
    err.code = 401
    monkeypatch.setattr(flasher, "run_flash", lambda *a, **k: (_ for _ in ()).throw(err))
    app._run_flash(dict(FULL, enrollment_key="", operator_token=OPERATOR_TOKEN))
    assert _pump(root, lambda: not app.connected())
    assert app.status_label.cget("text") == ("The console no longer accepts this computer's sign-in. "
                                             "Sign in again to continue.")
    assert dialogs == [] and not flasher.operator_config_path().exists()
    # The sign-in box is back in place of the form; FLASH stays off until the operator has signed in again.
    assert app.account_label.cget("text") == "Not signed in" and str(app.flash_btn["state"]) == "disabled"
    assert app.signin.winfo_manager() == "pack" and not app.form.winfo_manager()
    # Any other console error: the dialog as before.
    other = console.ConsoleError("/api/operator/me: HTTP 503")
    other.code = 503
    monkeypatch.setattr(flasher, "run_flash", lambda *a, **k: (_ for _ in ()).throw(other))
    app._run_flash(dict(FULL, enrollment_key="", operator_token=OPERATOR_TOKEN))
    assert _pump(root, lambda: bool(dialogs))
    assert app.status_label.cget("text") == "Failed: /api/operator/me: HTTP 503"
    root.destroy()
