"""Projection5000 SD Flasher: write Raspberry Pi OS Lite to a card and pre-configure the Pi.

One screen: the console is fixed (baked in by build.ps1), Sign in happens in the browser, and only what changes
per Pi is asked (name, Wi-Fi, card). Everything else is automatic or under Advanced.

Run: python flasher.py            (relaunches itself elevated if needed)
     python flasher.py --selfcheck (prints the generated first-boot scripts, exits 0)
     python flasher.py --dry-run   (no admin needed; Flash stops before touching the card)
"""
import base64
import ctypes
import io
import json
import os
import queue
import secrets
import socket
import sys
import tarfile
import threading
import time
import tkinter as tk
import traceback
import urllib.parse
import webbrowser
from pathlib import Path
from tkinter import filedialog, messagebox, ttk

import bundle
import console
import firstboot
import imagefetch
import sshkey
import windisk
import winlocale

APP_TITLE = "Projection5000 SD Flasher"
# Persisted between runs (%LOCALAPPDATA%). Never a secret: the enrollment key is fetched from the console at flash
# time with the operator token, which lives DPAPI-protected in the operator config (%APPDATA%).
SETTINGS_KEYS = ("name", "ssid", "wifi_country", "wifi_hidden", "timezone", "keymap", "image_mode", "image_path",
                 "static_ip", "gateway")
# Entry fields whose value is taken verbatim (everything else is stripped of surrounding whitespace).
UNSTRIPPED = ("wifi_password",)
CONSOLE_JSON = "console.json"  # {"console_url": ..., "enrollment_key": ...}, written by build.ps1 (key optional)
DEFAULT_CONSOLE_URL = "https://projectors.photogen5000.com"
# The Pi's login: one fixed user, SSH by key only (the flasher's key, see sshkey.py). The OS still needs a
# password to create the user: a random one per flash that is never shown or saved (sudo needs none on Pi OS).
PI_USERNAME = "projector-admin"
# validate_cfg problems -> (form field, plain words; None keeps the rule's own text). Unlisted problems go under
# the Flash button.
PLAIN_WORDS = [("Device name", "name", "Give the Pi a name."),
               ("device_id", "name", "The name needs at least one letter or digit."),
               ("Wi-Fi SSID", "ssid", None),
               ("Wi-Fi password", "wifi_password", "Wi-Fi password must be 8-63 characters."),
               ("Enrollment key", "signin", "Sign in first."),
               ("Wi-Fi country", "adv", None), ("Timezone", "adv", None), ("Keyboard", "adv", None),
               ("Static IP", "adv", None), ("Gateway", "adv", None), ("Device token", "adv", None),
               ("SSH public key", "adv", None)]
COUNTRIES = ["US", "GB", "CA", "AU", "NZ", "DE", "FR", "ES", "IT", "NL", "SE", "NO", "DK", "FI", "IE", "JP", "MX", "BR"]
TIMEZONES = ["America/Los_Angeles", "America/Denver", "America/Chicago", "America/New_York", "America/Phoenix",
             "America/Anchorage", "Pacific/Honolulu", "America/Toronto", "America/Vancouver", "America/Mexico_City",
             "America/Sao_Paulo", "Europe/London", "Europe/Dublin", "Europe/Paris", "Europe/Berlin", "Europe/Madrid",
             "Europe/Rome", "Europe/Amsterdam", "Europe/Stockholm", "Australia/Sydney", "Australia/Melbourne",
             "Pacific/Auckland", "Asia/Tokyo", "Asia/Singapore", "UTC"]
PLAYER_EXCLUDE = ("__pycache__", ".venv", ".pytest_cache", "tests")


# ---------------------------------------------------------------- elevation

def is_admin() -> bool:
    try:
        return bool(ctypes.windll.shell32.IsUserAnAdmin())
    except Exception:
        return False


def relaunch_elevated() -> bool:
    """ShellExecuteW 'runas' this program with --elevated. False when the UAC prompt was declined."""
    if getattr(sys, "frozen", False):
        exe, params = sys.executable, "--elevated"
    else:
        exe, params = sys.executable, f'"{os.path.abspath(__file__)}" --elevated'
    # Values <= 32 are errors (5 = SE_ERR_ACCESSDENIED: the user declined the UAC prompt).
    rc = ctypes.windll.shell32.ShellExecuteW(None, "runas", exe, params, None, 1)
    return rc > 32


def not_admin_message() -> None:
    root = tk.Tk()
    root.withdraw()
    messagebox.showerror(APP_TITLE, "Run as administrator.\n\nWriting an SD card needs administrator rights. "
                         "Right-click the program and choose \"Run as administrator\".")
    root.destroy()


def ensure_admin(argv) -> bool:
    """True when we may continue. Otherwise the elevated copy is running (or the user declined)."""
    if is_admin():
        return True
    if "--elevated" not in argv and relaunch_elevated():
        return False
    not_admin_message()
    return False


# ---------------------------------------------------------------- settings

def settings_path() -> Path:
    return imagefetch.app_dir() / "flasher.json"


def load_settings() -> dict:
    try:
        s = json.loads(settings_path().read_text("utf-8"))
    except Exception:
        return {}
    if not isinstance(s, dict):
        return {}
    # The file lives in the user profile and is read by an elevated process: keep only known
    # keys with plain string/bool values so a hand-edited or damaged file cannot crash startup.
    return {k: v for k, v in s.items() if k in SETTINGS_KEYS and isinstance(v, (str, bool))}


def save_settings(values: dict) -> None:
    try:
        settings_path().parent.mkdir(parents=True, exist_ok=True)
        settings_path().write_text(json.dumps({k: values[k] for k in SETTINGS_KEYS if k in values}, indent=2), "utf-8")
    except OSError:
        pass


# ---------------------------------------------------------------- operator config (sign-in token)

def operator_config_path() -> Path:
    base = os.environ.get("APPDATA") or str(Path.home())
    return Path(base) / "Projection5000" / "flasher.json"


class _DataBlob(ctypes.Structure):
    _fields_ = [("cbData", ctypes.c_uint32), ("pbData", ctypes.c_void_p)]


def _dpapi(data: bytes, protect: bool) -> bytes:
    """CryptProtectData / CryptUnprotectData (user-scoped DPAPI: only this Windows account can read it back).
    win32crypt (pywin32) when it is installed, else the same crypt32 calls through ctypes."""
    try:
        import win32crypt
    except ImportError:
        return _dpapi_ctypes(data, protect)
    if protect:
        return win32crypt.CryptProtectData(data, None, None, None, None, 0)
    return win32crypt.CryptUnprotectData(data, None, None, None, 0)[1]


def _dpapi_ctypes(data: bytes, protect: bool) -> bytes:
    crypt32 = ctypes.WinDLL("crypt32", use_last_error=True)
    kernel32 = ctypes.WinDLL("kernel32")
    kernel32.LocalFree.argtypes = [ctypes.c_void_p]
    buf = ctypes.create_string_buffer(data, len(data))
    inp = _DataBlob(len(data), ctypes.cast(buf, ctypes.c_void_p))
    out = _DataBlob()
    fn = crypt32.CryptProtectData if protect else crypt32.CryptUnprotectData
    if not fn(ctypes.byref(inp), None, None, None, None, 0, ctypes.byref(out)):
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        return ctypes.string_at(out.pbData, out.cbData)
    finally:
        kernel32.LocalFree(out.pbData)


def load_operator_config() -> dict:
    """{"console_url", "token", "username"} from %APPDATA%\\Projection5000\\flasher.json; empty strings when absent
    or unreadable (a DPAPI blob from another account or a damaged file simply means: sign in again)."""
    out = {"console_url": "", "token": "", "username": ""}
    try:
        d = json.loads(operator_config_path().read_text("utf-8"))
    except (OSError, ValueError):
        return out
    if not isinstance(d, dict):
        return out
    for k in ("console_url", "username"):
        if isinstance(d.get(k), str):
            out[k] = d[k].strip()
    tok = d.get("token")
    if isinstance(tok, str) and tok:
        if d.get("token_dpapi"):
            try:
                tok = _dpapi(base64.b64decode(tok), protect=False).decode("utf-8")
            except Exception:
                tok = ""
        out["token"] = tok.strip()
    return out


def save_operator_config(console_url: str, token: str, username: str = "") -> str:
    """Write the operator config, DPAPI-protecting the token. Returns a warning ('' when protected)."""
    d = {"console_url": console_url.strip().rstrip("/"), "token": token.strip(), "token_dpapi": False,
         "username": username.strip()}
    warning = ""
    try:
        d["token"] = base64.b64encode(_dpapi(d["token"].encode("utf-8"), protect=True)).decode("ascii")
        d["token_dpapi"] = True
    except Exception as e:
        warning = f"WARNING: DPAPI is not available ({e}); the operator token is stored in plain text in {operator_config_path()}."
    p = operator_config_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(d, indent=2), "utf-8")
    return warning


def clear_operator_config() -> None:
    """Sign out: forget the token (the console keeps the api_tokens row until it is revoked there)."""
    operator_config_path().unlink(missing_ok=True)


# ---------------------------------------------------------------- player files for the card

def build_player_archive(out=None) -> bytes:
    """player/ from this checkout as player.tar.gz (the Pi cannot clone the private GitHub repo)."""
    src = Path(__file__).resolve().parents[2] / "player"
    if not (src / "deploy" / "install-player.sh").is_file():
        raise FileNotFoundError(f"player tree not found at {src}")

    def keep(ti):
        if any(part in PLAYER_EXCLUDE or part.endswith(".pyc") for part in ti.name.split("/")[1:]):
            return None
        ti.uid = ti.gid = 0
        ti.uname = ti.gname = "root"
        return ti

    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        tar.add(str(src), arcname="player", filter=keep)
    data = buf.getvalue()
    if out:
        Path(out).write_bytes(data)
    return data


def resource_path(name: str) -> Path:
    """A file build.ps1 bundled with --add-data (frozen), or the same name next to this script (source)."""
    base = Path(sys._MEIPASS) if getattr(sys, "frozen", False) else Path(__file__).resolve().parent
    return base / name


def player_archive() -> bytes:
    """The bundled archive in the exe (build.ps1 adds it), or a fresh one when run from source."""
    if getattr(sys, "frozen", False):
        return resource_path("player.tar.gz").read_bytes()
    return build_player_archive()


def build_info() -> str:
    if getattr(sys, "frozen", False):
        try:
            return resource_path("build_info.txt").read_text("utf-8").strip()
        except OSError:
            return "frozen build, no build_info.txt"
    return f"source {Path(__file__).resolve().parent}"


def console_defaults() -> dict:
    """console_url and enrollment_key baked in at build time (console.json); empty strings when absent."""
    out = {"console_url": "", "enrollment_key": ""}
    try:
        d = json.loads(resource_path(CONSOLE_JSON).read_text("utf-8"))
    except (OSError, ValueError):
        return out
    if isinstance(d, dict):
        for k in out:
            if isinstance(d.get(k), str):
                out[k] = d[k].strip()
    return out


def write_console_json(path, console_url: str, enrollment_key: str = "") -> None:
    """build.ps1 stages console.json with this (same rules as the form, so a bad key fails the build). The key
    is optional: without one the flasher fetches it from the console with the operator token (build.ps1 -Key
    bakes one for offline builds)."""
    problems = [firstboot.console_url_problem(console_url)]
    if enrollment_key.strip():
        problems.append(firstboot.enrollment_key_problem(enrollment_key.strip()))
    problems = [p for p in problems if p]
    if problems:
        raise ValueError(" ".join(problems))
    Path(path).write_text(json.dumps({"console_url": console_url.strip().rstrip("/"),
                                      "enrollment_key": enrollment_key.strip()}), "utf-8")


def console_summary() -> str:
    """One line for --selfcheck: what this build talks to."""
    c = console_defaults()
    if not c["console_url"]:
        return f"console: none baked in (the default {DEFAULT_CONSOLE_URL} is used; build.ps1 -ConsoleUrl sets one)"
    key = "set" if c["enrollment_key"] else "fetched with the operator token"
    return f"console: {c['console_url']} (enrollment key: {key})"


def console_url() -> str:
    """The console this build talks to: baked in by build.ps1, else the product default. Never a form field."""
    return console_defaults()["console_url"] or DEFAULT_CONSOLE_URL


# ---------------------------------------------------------------- GUI

class App:
    def __init__(self, root: tk.Tk, dry_run: bool = False):
        self.root = root
        root.title(APP_TITLE)
        root.minsize(700, 540)
        self.dry_run_default = dry_run
        self.cancel = threading.Event()
        self.worker = None
        self.q = queue.Queue()
        self.disks = []
        self.v = {}  # tk variables by key
        self.err = {}  # inline error labels by field
        self.console_url = console_url()
        self.baked_key = console_defaults()["enrollment_key"]
        self.op = {"token": "", "username": ""}  # the sign-in (operator token), never a widget
        self._password = secrets.token_urlsafe(24)  # the Pi user's password: random, never shown, fresh per flash
        self._signin_cancel = threading.Event()
        self._build()
        self._apply_settings(load_settings())
        root.protocol("WM_DELETE_WINDOW", self.on_close)
        self._fit_to_screen()
        self._pump()
        self.refresh_disks()
        self.log(f"Console {self.console_url}.")
        op = load_operator_config()
        if op["token"] and op["console_url"] in ("", self.console_url):
            self.op = {"token": op["token"], "username": op["username"]}
            self._show_signed_in()
            self.check_token()
        else:
            self._show_sign_in("")

    # ----- form
    def _var(self, key, default="", kind=tk.StringVar):
        self.v[key] = kind(value=default)
        return self.v[key]

    def _entry(self, parent, row, label, key, default="", show=None, width=40):
        ttk.Label(parent, text=label).grid(row=row, column=0, sticky="w", padx=4, pady=2)
        e = ttk.Entry(parent, textvariable=self._var(key, default), width=width, show=show)
        e.grid(row=row, column=1, sticky="we", padx=4, pady=2)
        return e

    def _err(self, parent, row, field, column=1, columnspan=2):
        """An inline error line under a field (empty and collapsed until validate() fills it)."""
        lbl = ttk.Label(parent, text="", foreground="#b00020", wraplength=520, justify="left")
        lbl.grid(row=row, column=column, columnspan=columnspan, sticky="w", padx=4)
        lbl.grid_remove()
        self.err[field] = lbl
        return lbl

    def _build(self):
        outer = ttk.Frame(self.root, padding=8)
        outer.pack(fill="both", expand=True)

        # 1. header: the console is fixed; sign in or the signed-in user.
        header = ttk.Frame(outer)
        header.pack(fill="x", pady=(0, 6))
        header.columnconfigure(1, weight=1)
        ttk.Label(header, text=f"Console: {urllib.parse.urlsplit(self.console_url).netloc}",
                  font=("", 10, "bold")).grid(row=0, column=0, sticky="w", padx=4)
        self.signin_label = ttk.Label(header, text="")
        self.signin_label.grid(row=0, column=1, sticky="e", padx=4)
        self.signin_btn = ttk.Button(header, text="Sign in", command=self.sign_in)
        self.signin_btn.grid(row=0, column=2, sticky="e", padx=4)
        self._err(header, 1, "signin")

        # 2-4. what changes per Pi.
        form = ttk.Frame(outer)
        form.pack(fill="x")
        form.columnconfigure(1, weight=1)
        self._entry(form, 0, "Device name", "name")
        self.id_label = ttk.Label(form, text="", foreground="grey")
        self.id_label.grid(row=1, column=1, sticky="w", padx=4)
        self._err(form, 2, "name")
        self.v["name"].trace_add("write", self._derive_id)
        self._entry(form, 3, "Wi-Fi network", "ssid")
        ttk.Label(form, text="leave blank for a wired Pi", foreground="grey").grid(row=3, column=2, sticky="w", padx=4)
        self._err(form, 4, "ssid")
        pw = self._entry(form, 5, "Wi-Fi password", "wifi_password", show="*")
        self._var("show_wifi", False, tk.BooleanVar)
        ttk.Checkbutton(form, text="Show", variable=self.v["show_wifi"],
                        command=lambda: pw.configure(show="" if self.v["show_wifi"].get() else "*")
                        ).grid(row=5, column=2, sticky="w", padx=4)
        self._err(form, 6, "wifi_password")
        ttk.Label(form, text="SD card").grid(row=7, column=0, sticky="w", padx=4, pady=2)
        self.disk_box = ttk.Combobox(form, textvariable=self._var("disk"), state="readonly")
        self.disk_box.grid(row=7, column=1, sticky="we", padx=4, pady=2)
        ttk.Button(form, text="Refresh", command=self.refresh_disks).grid(row=7, column=2, sticky="w", padx=4)
        self._err(form, 8, "disk")

        # 5. Flash, progress, log.
        buttons = ttk.Frame(outer)
        buttons.pack(fill="x", pady=6)
        style = ttk.Style(self.root)
        style.configure("Flash.TButton", font=("", 11, "bold"), padding=(24, 6))
        buttons.columnconfigure(2, weight=1)
        self.flash_btn = ttk.Button(buttons, text="Flash", command=self.on_flash, style="Flash.TButton")
        self.flash_btn.grid(row=0, column=0, padx=4)
        self.cancel_btn = ttk.Button(buttons, text="Cancel", command=self.on_cancel)
        self.cancel_btn.grid(row=0, column=1, padx=4)
        self.cancel_btn.grid_remove()  # shown while a flash runs
        self.progress = ttk.Progressbar(buttons, maximum=100)
        self.progress.grid(row=0, column=2, sticky="we", padx=8)
        self.status = ttk.Label(buttons, text="")
        self.status.grid(row=0, column=3, padx=4)
        self._err(buttons, 1, "flash", column=0, columnspan=4)

        logf = ttk.Frame(outer)
        logf.pack(fill="both", expand=True, pady=4)
        self.log_text = tk.Text(logf, height=8, wrap="word", state="disabled")
        sb = ttk.Scrollbar(logf, orient="vertical", command=self.log_text.yview)
        self.log_text.configure(yscrollcommand=sb.set)
        sb.pack(side="right", fill="y")
        self.log_text.pack(side="left", fill="both", expand=True)

        # Advanced: one collapsed disclosure holding everything else.
        self.adv_btn = ttk.Button(outer, text="Advanced", command=self._toggle_advanced)
        self.adv_btn.pack(anchor="w", pady=(4, 0))
        self.advanced = ttk.Frame(outer, padding=(12, 4, 4, 4))
        self._build_advanced(self.advanced)

    def _build_advanced(self, adv):
        adv.columnconfigure(1, weight=1)
        self._err(adv, 0, "adv", column=0, columnspan=3)

        ttk.Label(adv, text="Image").grid(row=1, column=0, sticky="nw", padx=4, pady=2)
        img = ttk.Frame(adv)
        img.grid(row=1, column=1, columnspan=2, sticky="we")
        img.columnconfigure(0, weight=1)
        self.bundled = bundle.find_bundle()
        self._var("image_mode", "bundled" if self.bundled else "latest")
        if self.bundled:
            ttk.Radiobutton(img, text=f"Bundled: {self.bundled.name} ({windisk.human_size(self.bundled.length)})",
                            variable=self.v["image_mode"], value="bundled").grid(row=0, column=0, columnspan=2,
                                                                                 sticky="w")
        ttk.Radiobutton(img, text="Latest Raspberry Pi OS Lite (64-bit), downloaded and cached",
                        variable=self.v["image_mode"], value="latest").grid(row=1, column=0, columnspan=2, sticky="w")
        ttk.Radiobutton(img, text="Local image file (.img or .img.xz)", variable=self.v["image_mode"],
                        value="local").grid(row=2, column=0, columnspan=2, sticky="w")
        ttk.Entry(img, textvariable=self._var("image_path")).grid(row=3, column=0, sticky="we", padx=4)
        ttk.Button(img, text="Browse...", command=self.browse_image).grid(row=3, column=1, padx=4)

        ttk.Label(adv, text="Timezone").grid(row=2, column=0, sticky="w", padx=4, pady=2)
        ttk.Combobox(adv, textvariable=self._var("timezone", winlocale.timezone()), values=TIMEZONES
                     ).grid(row=2, column=1, sticky="we", padx=4, pady=2)
        self._entry(adv, 3, "Keyboard layout", "keymap", winlocale.keymap(), width=8)
        ttk.Label(adv, text="Wi-Fi country").grid(row=4, column=0, sticky="w", padx=4, pady=2)
        ttk.Combobox(adv, textvariable=self._var("wifi_country", winlocale.country(firstboot.ISO3166)),
                     values=COUNTRIES, width=8).grid(row=4, column=1, sticky="w", padx=4, pady=2)
        ttk.Checkbutton(adv, text="Hidden Wi-Fi network", variable=self._var("wifi_hidden", False, tk.BooleanVar)
                        ).grid(row=5, column=1, sticky="w", padx=4)
        self._entry(adv, 6, "Static IP", "static_ip", width=20)
        ttk.Label(adv, text="e.g. 192.168.1.50/24; blank for DHCP", foreground="grey").grid(row=6, column=2, sticky="w")
        self._entry(adv, 7, "Gateway", "gateway", width=20)
        ttk.Label(adv, text="also used as the DNS server", foreground="grey").grid(row=7, column=2, sticky="w")
        self._entry(adv, 8, "Existing device token", "token")
        ttk.Label(adv, text="from the Devices page; skips enrollment", foreground="grey").grid(row=8, column=2,
                                                                                               sticky="w")
        ttk.Label(adv, text="SSH key").grid(row=9, column=0, sticky="w", padx=4, pady=2)
        ttk.Label(adv, text=str(sshkey.private_path())).grid(row=9, column=1, sticky="w", padx=4)
        ttk.Button(adv, text="Copy public key", command=self.copy_public_key).grid(row=9, column=2, sticky="w", padx=4)
        row10 = ttk.Frame(adv)
        row10.grid(row=10, column=1, columnspan=2, sticky="w")
        self.signout_btn = ttk.Button(row10, text="Sign out", command=self.sign_out)
        self.signout_btn.pack(side="left", padx=4, pady=4)
        ttk.Checkbutton(row10, text="Dry run (validate and resolve the image, do not write)",
                        variable=self._var("dry_run", self.dry_run_default, tk.BooleanVar)).pack(side="left", padx=8)
        ttk.Label(adv, text=f"Build: {build_info()}", foreground="grey", wraplength=520, justify="left"
                  ).grid(row=11, column=1, columnspan=2, sticky="w", padx=4)

    def _fit_to_screen(self):
        # Never taller than the screen minus the taskbar and title bar, so the log stays visible.
        self.root.update_idletasks()
        w = max(self.root.winfo_reqwidth(), 700)
        h = min(max(self.root.winfo_reqheight(), 540), self.root.winfo_screenheight() - 120)
        self.root.geometry(f"{w}x{h}")

    def _derive_id(self, *_):
        dev = firstboot.derive_device_id(self.v["name"].get())
        self.id_label.configure(text=f"device id (hostname): {dev}" if dev else "")

    def device_id(self) -> str:
        return firstboot.derive_device_id(self.v["name"].get())

    def _toggle_advanced(self):
        if self.advanced.winfo_manager():
            self.advanced.pack_forget()
        else:
            self.advanced.pack(fill="x", after=self.adv_btn)

    def copy_public_key(self):
        try:
            line = sshkey.ensure_keypair(self.log)
        except OSError as e:
            self.log(f"SSH key: {e}")
            return
        self.root.clipboard_clear()
        self.root.clipboard_append(line)
        self.log("Public key copied to the clipboard (paste it into authorized_keys on any other machine).")

    # ----- sign in (device-code flow: the browser approves, this thread polls)
    def _show_sign_in(self, note: str):
        self.signin_label.configure(text=note)
        self.signin_btn.configure(state="normal")
        self.signin_btn.grid()
        self.signout_btn.configure(state="disabled")

    def _show_signed_in(self):
        self.signin_btn.grid_remove()
        self.signin_label.configure(text=f"Signed in as {self.op['username'] or 'operator'}")
        self.signout_btn.configure(state="normal")
        self._show_error("signin", "")

    def sign_in(self):
        self.signin_btn.configure(state="disabled")
        self.signin_label.configure(text="Contacting the console ...")
        self._signin_cancel = threading.Event()
        threading.Thread(target=self._sign_in_work, args=(self._signin_cancel,), daemon=True).start()

    def _sign_in_work(self, cancel: threading.Event):
        url = self.console_url
        try:
            r = console.request_device_code(url, socket.gethostname())
        except console.ConsoleError as e:
            msg = f"Sign in failed: {e}"
            self.post(lambda: self._sign_in_failed(msg))
            return
        link = f"{r['verification_url']}?code={urllib.parse.quote(r['user_code'])}"
        try:
            opened = webbrowser.open(link)
        except Exception:
            opened = False
        self.post(lambda: self._show_code(console.display_code(r["user_code"]), link, opened))
        deadline = time.monotonic() + r["expires_in"]
        while time.monotonic() < deadline and not cancel.is_set():
            time.sleep(r["interval"])
            try:
                tok = console.poll_device_token(url, r["device_code"])
            except console.Pending:
                continue
            except console.ConsoleError as e:
                msg = f"Sign in failed: {e}"
                self.post(lambda: self._sign_in_failed(msg))
                return
            self.post(lambda: self._signed_in(url, tok))
            return
        if not cancel.is_set():
            self.post(lambda: self._sign_in_failed("Sign in timed out (10 minutes): click Sign in again."))

    def _show_code(self, code: str, link: str, opened: bool):
        self.signin_label.configure(text=f"Approve in your browser (code {code})")
        if opened:
            self.log(f"Browser opened at {link}: approve the sign-in there (code {code}).")
        else:
            self.log(f"Could not open a browser. Open {link} yourself and type the code {code}.")

    def _sign_in_failed(self, msg: str):
        self.log(msg)
        self._show_sign_in(msg if len(msg) < 60 else "Sign in failed (see the log)")

    def _signed_in(self, url: str, tok: dict):
        warning = save_operator_config(url, tok["token"], tok["username"])
        if warning:
            self.log(warning)
        self.op = {"token": tok["token"], "username": tok["username"]}
        self._show_signed_in()
        self.log(f"Signed in as {tok['username'] or 'operator'}.")

    def check_token(self):
        """A stored token is checked against GET /api/operator/enrollment; 401 means sign in again."""
        url, token = self.console_url, self.op["token"]

        def work():
            try:
                console.fetch_enrollment(url, token)
            except console.ConsoleError as e:
                if e.code == 401:
                    self.post(lambda: (clear_operator_config(), self.op.update(token="", username=""),
                                       self._show_sign_in("Session expired: sign in again"),
                                       self.log("The stored sign-in was rejected by the console: sign in again.")))
                else:
                    msg = f"Console check failed ({e}); the stored sign-in is kept."
                    self.post(lambda: self.log(msg))
                return
            msg = f"Signed in as {self.op['username'] or 'operator'} (checked with the console)."
            self.post(lambda: self.log(msg))

        threading.Thread(target=work, daemon=True).start()

    def sign_out(self):
        self._signin_cancel.set()
        clear_operator_config()
        self.op = {"token": "", "username": ""}
        self._show_sign_in("")
        self.log("Signed out. Revoke the token on the console's Settings page too if this PC changes hands.")

    def _apply_settings(self, s: dict):
        for k in SETTINGS_KEYS:
            if k in s and k in self.v:
                try:
                    self.v[k].set(s[k])
                except tk.TclError:
                    pass
        if self.v["image_mode"].get() == "bundled" and not self.bundled:  # saved by an exe that had one
            self.v["image_mode"].set("latest")

    def values(self) -> dict:
        """Form values; text fields are stripped (pasted spaces and newlines otherwise reach the card).
        Plus what is not a widget: the derived device id, the fixed Pi login, the baked key, the sign-in token."""
        out = {}
        for k, var in self.v.items():
            val = var.get()
            if isinstance(val, str) and k not in UNSTRIPPED:
                val = val.strip()
            out[k] = val
        out["device_id"] = firstboot.derive_device_id(out["name"])
        out["username"] = PI_USERNAME
        out["password"] = self._password
        out["console_url"] = self.console_url
        out["enrollment_key"] = self.baked_key
        out["operator_token"] = self.op["token"]
        out["ssh_pubkey"] = ""  # filled by validate() (the key is created on first use)
        return out

    # ----- actions
    def browse_image(self):
        p = filedialog.askopenfilename(title="Choose image", filetypes=[("Disk images", "*.img *.xz"), ("All", "*")])
        if p:
            self.v["image_path"].set(p)
            self.v["image_mode"].set("local")

    def refresh_disks(self):
        previous = self.selected_disk()  # read before the placeholder replaces the combobox text
        self.disk_box.set("Scanning...")

        def work():
            try:
                disks = windisk.list_disks()
            except Exception as e:
                disks, err = [], str(e)
            else:
                err = None
            self.post(lambda: self._show_disks(disks, err, previous))

        threading.Thread(target=work, daemon=True).start()

    def _show_disks(self, disks, err, previous=None):
        if previous is None:
            previous = self.selected_disk()
        self.disks = disks
        self.disk_box["values"] = [d["label"] for d in disks]
        if err:
            self.log(f"Disk scan failed: {err}")
        if not disks:
            self.disk_box.set("(no removable disks found)")
            return
        # Keep the operator's choice (by disk number) across a rescan; fall back to the first reader.
        numbers = [d["number"] for d in disks]
        if previous and previous["number"] in numbers:
            self.disk_box.current(numbers.index(previous["number"]))
        else:
            self.disk_box.current(0)
            if previous:
                self.log(f"Target reset to {disks[0]['label']} (the previous selection is gone).")

    def selected_disk(self):
        label = self.v["disk"].get()
        return next((d for d in self.disks if d["label"] == label), None)

    def post(self, fn):
        """Queue fn for the Tk thread (workers must not touch widgets directly)."""
        self.q.put(fn)

    def _pump(self):
        # after() itself is not safe to call from worker threads before mainloop runs, so
        # workers only enqueue and this 50 ms poll on the Tk thread drains the queue.
        try:
            while True:
                fn = self.q.get_nowait()
                try:
                    fn()
                except Exception:
                    # One bad callback must not stop the pump (the GUI would freeze for good).
                    try:
                        self.log("Internal error:\n" + traceback.format_exc())
                    except Exception:
                        pass
        except queue.Empty:
            pass
        finally:
            self.root.after(50, self._pump)

    def log(self, line: str):
        self.log_text.configure(state="normal")
        self.log_text.insert("end", line.rstrip("\n") + "\n")
        self.log_text.see("end")
        self.log_text.configure(state="disabled")

    def set_progress(self, pct, text=""):
        self.progress["value"] = max(0, min(100, pct))
        self.status.configure(text=text)

    def on_close(self):
        if self.worker and self.worker.is_alive():
            if not messagebox.askyesno(APP_TITLE, "A flash is in progress. Quit anyway?\n\n"
                                       "The card will be left unusable and must be flashed again.",
                                       default=messagebox.NO):
                return
            self.cancel.set()
            deadline = time.monotonic() + 5
            while self.worker.is_alive() and time.monotonic() < deadline:
                self.root.update()
                time.sleep(0.05)
        self._signin_cancel.set()
        save_settings(self.values())
        self.root.destroy()

    def on_cancel(self):
        self.cancel.set()
        self.log("Cancelling...")

    def _show_error(self, field: str, text: str):
        lbl = self.err[field]
        lbl.configure(text=text)
        if text:
            lbl.grid()
        else:
            lbl.grid_remove()

    def errors(self) -> dict:
        """Inline validation: {field: plain words}. The rules are firstboot.validate_cfg, worded for the form."""
        v = self.values()
        problems = {}
        if not v["name"]:
            problems["name"] = "Give the Pi a name."
        if not v["ssid"] and v["wifi_password"]:
            problems["ssid"] = "Enter the Wi-Fi network name (or clear the password for a wired Pi)."
        cfg = card_cfg(v)
        if not cfg["enrollment_key"] and not cfg["token"]:
            if not v["operator_token"]:
                problems["signin"] = "Sign in first."
            cfg["enrollment_key"] = "fetched-at-flash-time-with-the-token"  # the other rules still apply
        try:
            cfg["ssh_pubkey"] = sshkey.ensure_keypair(self.log)
        except OSError as e:
            problems["flash"] = f"Could not create the SSH key: {e}"
        for p in firstboot.validate_cfg(cfg):
            for prefix, field, words in PLAIN_WORDS:
                if p.startswith(prefix):
                    problems.setdefault(field, words or p)
                    break
            else:
                problems.setdefault("flash", p)
        if v["image_mode"] == "local":
            if not Path(v["image_path"]).is_file():
                problems.setdefault("adv", "Local image file not found.")
            else:
                try:
                    windisk.check_image_magic(v["image_path"])
                except windisk.DiskError as e:
                    problems.setdefault("adv", str(e))
        disk = self.selected_disk()
        if not v["dry_run"]:  # a dry run never touches the card, so none is needed
            if not is_admin():
                problems.setdefault("flash", "Restart as administrator to write a card (dry run works without).")
            if disk is None:
                problems["disk"] = "Choose the SD card to write."
            elif disk["size"] == 0:
                problems["disk"] = "The selected reader has no card inserted."
            elif disk["size"] > windisk.MAX_CARD_BYTES:
                problems["disk"] = f"Refusing to write a disk larger than {windisk.human_size(windisk.MAX_CARD_BYTES)}."
        return problems

    def validate(self) -> dict:
        problems = self.errors()
        for field in self.err:
            self._show_error(field, problems.get(field, ""))
        if problems.get("adv") and not self.advanced.winfo_manager():
            self._toggle_advanced()
        if problems:
            return None
        v = self.values()
        v["ssh_pubkey"] = sshkey.ensure_keypair()
        v["disk_info"] = self.selected_disk()
        return v

    def on_flash(self):
        v = self.validate()
        if not v:
            return
        if not v["dry_run"]:
            # Rescan so the confirmation names the disk as it is now (cards get swapped, numbers move).
            chosen = v["disk_info"]
            try:
                self._show_disks(windisk.list_disks(), None)
            except Exception as e:
                self._show_error("disk", f"Disk scan failed: {e}")
                return
            d = self.selected_disk()
            if d is None or (d["number"], d["unique_id"]) != (chosen["number"], chosen["unique_id"]):
                self._show_error("disk", "The card changed since it was chosen. Check the list and click Flash again.")
                return
            v = self.validate()  # size checks against the fresh scan
            if not v:
                return
            d = v["disk_info"]
            if not messagebox.askyesno(APP_TITLE, f"Flash {v['name']} ({v['device_id']}) to\n\n{d['label']}\n"
                                       f"({windisk.human_size(d['size'])})\n\nEverything on that card will be erased. "
                                       "Continue?", icon="warning", default=messagebox.NO):
                return
        save_settings(v)
        self.cancel.clear()
        self.flash_btn.configure(state="disabled")
        self.cancel_btn.grid()
        self.set_progress(0, "")
        self.worker = threading.Thread(target=self._run_flash, args=(v,), daemon=True)
        self.worker.start()

    # ----- worker
    def _run_flash(self, v: dict):
        log = lambda s: self.post(lambda: self.log(s))
        try:
            run_flash(v, log, lambda pct, text: self.post(lambda: self.set_progress(pct, text)), self.cancel,
                      dry_run=v["dry_run"])
            if not v["dry_run"]:
                done = DONE_TEXT + f"\n\nDevice id: {v['device_id']}"
                self.post(lambda: messagebox.showinfo(APP_TITLE, done))
        except (windisk.Cancelled, imagefetch.Cancelled) as e:
            log(f"Cancelled. {e}".rstrip())
        except Exception as e:
            msg = str(e)  # bound now: the except variable is gone by the time the Tk thread runs the lambda
            log(f"FAILED: {msg}")
            self.post(lambda: messagebox.showerror(APP_TITLE, msg))
        finally:
            self.post(self._finished)

    def _finished(self):
        self.flash_btn.configure(state="normal")
        self.cancel_btn.grid_remove()
        self.status.configure(text="")
        self._password = secrets.token_urlsafe(24)  # never reuse a Pi password across cards


# ---------------------------------------------------------------- flash sequence (no widgets here)

DONE_TEXT = ("Done. Put the card in the Pi and power it on. It appears on the Devices page within a few minutes.")


def card_cfg(v: dict) -> dict:
    """The firstboot config for the form values (validate_cfg's input)."""
    cfg = {k: v[k] for k in ("device_id", "name", "username", "password", "ssid", "wifi_password", "wifi_hidden",
                              "timezone", "keymap", "enrollment_key", "static_ip", "gateway")}
    cfg["ssh"] = True
    cfg["ssh_pubkey"] = v.get("ssh_pubkey") or ""
    cfg["ethernet_only"] = not v["ssid"]  # blank Wi-Fi fields: a wired Pi
    cfg["wifi_country"] = v["wifi_country"].strip().upper()
    cfg["console_url"] = v["console_url"].strip().rstrip("/")
    cfg["token"] = v["token"].strip()  # Advanced: an existing device token bypasses enrollment
    cfg["with_wyze"] = bool(v.get("with_wyze"))
    return cfg


def console_mode(cfg: dict) -> str:
    return "device token given, no enrollment" if cfg["token"] else "enrolls itself on first boot"


def fetch_key(cfg: dict, operator_token: str, log) -> None:
    """No baked key and no device token: fetch the console's enrollment key with the sign-in token. The key is
    never shown; the answer also says whether the console has a Wyze account (installer --with-wyze)."""
    if cfg["enrollment_key"] or cfg["token"]:
        return
    if not operator_token:
        raise ValueError("Sign in first.")
    r = console.fetch_enrollment(cfg["console_url"], operator_token)
    cfg["enrollment_key"] = r["enrollment_key"]
    cfg["with_wyze"] = r["wyze_configured"]
    log("Enrollment key: ok. " + ("Wyze bridge: will be installed (the console has a Wyze account)."
                                  if cfg["with_wyze"] else "Wyze bridge: not configured on the console."))


def run_flash(v: dict, log, progress, cancel: threading.Event, dry_run: bool = False):
    """The flash sequence. Contacts the console only for the enrollment key (the Pi enrolls itself on first
    boot); dry_run stops after image resolution, before any disk access."""
    d = v["disk_info"]
    cfg = card_cfg(v)
    fetch_key(cfg, v.get("operator_token") or "", log)
    problems = firstboot.validate_cfg(cfg)
    if problems:  # checked before anything is written
        raise ValueError(" ".join(problems))

    # 1. first-boot files
    log(f"Console {cfg['console_url']}: {console_mode(cfg)}.")
    firstrun = firstboot.render_firstrun(cfg)
    provision = firstboot.render_provision(cfg)
    archive = player_archive()
    log(f"Player files for the card: {len(archive) / 1e3:.0f} kB ({build_info()}).")

    # 2. image
    image, sha256 = obtain_image(v, log, progress, cancel, dry_run)
    if cancel.is_set():
        raise windisk.Cancelled()
    if dry_run:
        target = f"Disk {d['number']} ({d['name']})" if d else "the selected card (none chosen)"
        log(f"Dry run: would write {windisk.source_name(image)} to {target}. Nothing was written.")
        return
    windisk.check_image_magic(image)
    size = windisk.image_size(image)
    if size > d["size"]:
        raise windisk.DiskError(f"{windisk.source_name(image)} is larger than the card "
                                f"({windisk.human_size(size)} > {windisk.human_size(d['size'])}); nothing was written")

    # 3-5. identity check, clear, write, verify
    log(f"Checking disk {d['number']} is still {d['name']} ({windisk.human_size(d['size'])}) ...")
    windisk.check_disk(d)
    if cancel.is_set():
        raise windisk.Cancelled()
    try:
        log(f"Removing partitions from disk {d['number']} ...")
        windisk.clear_disk(d["number"], d.get("unique_id", ""))
        log(f"Writing {windisk.source_name(image)} to disk {d['number']} ...")
        with windisk.open_physical_drive(d["number"], expect_size=d["size"]) as drive:
            drive.lock(windisk.volume_paths(d["number"]))
            start = time.monotonic()

            def on_write(written, consumed, total):
                pct = consumed * 100 / total if total else 0
                rate = written / max(time.monotonic() - start, 1e-6) / 1e6
                progress(pct, f"{written / 1e6:.0f} MB written, {rate:.1f} MB/s")

            written = windisk.write_image(image, drive, on_write, cancel, limit=d["size"],
                                          sector=d.get("sector") or windisk.SECTOR, expected_sha256=sha256)
            drive.flush()
            drive.refresh_partitions()
            log(f"Wrote {written / 1e6:.0f} MB. Reading the whole card back to verify ...")

            def on_verify(checked, consumed, total):
                progress(consumed * 100 / total if total else 0, f"verified {checked / 1e6:.0f} MB")

            if not windisk.verify_image(image, drive, on_verify, cancel):
                raise windisk.DiskError("read-back verification failed: the card did not store what was written "
                                        "(worn or counterfeit card?)")
    except windisk.Cancelled:
        raise windisk.Cancelled("The card is NOT usable; flash it again.")
    progress(100, "written and verified")

    # 6-7. boot volume and first-boot files
    try:
        log("Waiting for the boot partition to mount ...")
        letter = windisk.find_boot_volume(d["number"], cancel_event=cancel, log=log)
        boot = Path(f"{letter}:/")
        log(f"Boot partition is {letter}:")
        if cancel.is_set():
            raise windisk.Cancelled()
        write_firstboot_files(boot, firstrun, provision, archive)
    except windisk.Cancelled:
        raise windisk.Cancelled("The image is on the card but the first-boot files are NOT; "
                                "the card will not enroll. Flash it again.")
    except Exception as e:
        raise windisk.DiskError(f"{e}\n\nThe image was written but the first-boot files were NOT: this card "
                                "will not enroll. Re-insert it and Flash again.") from e
    log("First-boot files written. Ejecting ...")
    try:
        windisk.eject(letter)
    except Exception as e:
        log(f"Eject failed ({e}); remove the card safely from Explorer.")

    # 8. summary
    log("")
    log("SUMMARY")
    log(f"  Device: {cfg['name'].strip()} ({cfg['device_id']}), hostname {cfg['device_id']}")
    net = "Ethernet" if cfg["ethernet_only"] else f"Wi-Fi {cfg['ssid']} ({cfg['wifi_country']})"
    log(f"  Network: {net}" + (f", static IP {cfg['static_ip']} via {cfg['gateway']}" if cfg["static_ip"] else ", DHCP"))
    log(f"  Login: ssh {cfg['username']}@{cfg['device_id']}.local with the key {sshkey.private_path()} "
        "(password login is off)" if cfg["ssh_pubkey"] else f"  Login: {cfg['username']} (no SSH key on the card)")
    log(f"  Console: {cfg['console_url']} ({console_mode(cfg)})")
    log(f"  Image: {windisk.source_name(image)}" + (" (bundled in this exe)" if v["image_mode"] == "bundled" else ""))
    log("  The Pi needs internet access on its first boot (apt and pip). Progress is logged on the Pi in")
    log("  /var/log/projection5000-provision.log; firstrun.log and firstrun.ok appear on the boot partition.")
    log("  A card that never booted still carries the enrollment key: keep it safe or rotate the key on the console.")
    log("")
    log(DONE_TEXT)
    log(f"Device id: {cfg['device_id']}")


def obtain_image(v: dict, log, progress, cancel, dry_run: bool = False) -> tuple:
    """Returns (image source, expected_sha256 or ''): a path, or the BundledImage inside this exe."""
    if v["image_mode"] == "bundled":
        b = bundle.find_bundle()
        if b is None:
            raise imagefetch.FetchError("this build carries no bundled image; choose another image source")
        log(f"Using bundled image {b.name} ({windisk.human_size(b.length)} compressed, sha256 {b.sha256[:12]}...)")
        return b, b.sha256
    if v["image_mode"] == "local":
        log(f"Using local image {v['image_path']}")
        return v["image_path"], ""
    log("Resolving latest Raspberry Pi OS Lite (64-bit) ...")
    url, name = imagefetch.resolve_latest()
    expected = imagefetch.fetch_sha256(url)
    dest = imagefetch.cached_path(name)
    if dest.exists():
        log(f"Checking cached {name} ...")
        if imagefetch.verify_sha256(dest, expected):
            log("Cached image is valid.")
            return str(dest), expected
        log("Cached image is stale or corrupt, downloading again.")
    if dry_run:
        log(f"Dry run: would download {url}")
        return str(dest), expected
    log(f"Downloading {name} ...")

    def on_dl(done, total, rate):
        pct = done * 100 / total if total else 0
        progress(pct, f"downloading {done / 1e6:.0f} MB, {rate / 1e6:.1f} MB/s")

    imagefetch.download(url, dest, on_dl, cancel)
    log("Verifying download ...")
    if not imagefetch.verify_sha256(dest, expected):
        dest.unlink(missing_ok=True)
        raise imagefetch.FetchError("downloaded image failed sha256 verification")
    log("Download verified.")
    return str(dest), expected


def write_firstboot_files(boot: Path, firstrun: str, provision: str, archive: bytes = b"") -> None:
    cmdline = boot / "cmdline.txt"
    if not cmdline.is_file():
        raise windisk.DiskError(f"cmdline.txt not found on the boot partition {boot}: is this a Raspberry Pi OS image?")
    patched = firstboot.patch_cmdline(cmdline.read_text("utf-8"))
    (boot / "firstrun.sh").write_bytes(firstrun.encode("utf-8"))
    (boot / "projection5000-provision.sh").write_bytes(provision.encode("utf-8"))
    (boot / firstboot.PLAYER_ARCHIVE).write_bytes(archive)
    cmdline.write_bytes(patched.encode("utf-8"))


# ---------------------------------------------------------------- entry points

def selfcheck() -> int:
    cfg = firstboot.sample_config()
    archive = player_archive()
    with tarfile.open(fileobj=io.BytesIO(archive), mode="r:gz") as tar:
        names = tar.getnames()
    if "player/deploy/install-player.sh" not in names:
        raise RuntimeError("player archive is missing deploy/install-player.sh")
    tk_ok = "not tested"
    try:
        # The frozen exe must be able to start Tcl/Tk (a mis-bundled init.tcl only fails here).
        root = tk.Tk()
        root.withdraw()
        root.destroy()
        tk_ok = "ok"
    except tk.TclError as e:
        tk_ok = f"FAILED: {e}"
    b = bundle.find_bundle()
    text = "\n".join([
        f"=== {APP_TITLE}: {build_info()} ===",
        f"tk: {tk_ok}",
        f"player archive: {len(archive)} bytes, {len(names)} entries",
        f"bundled image: {b.name} {b.length} bytes sha256 {b.sha256} (trailer ok)" if b else "bundled image: none",
        console_summary(),
        f"defaults from Windows: timezone {winlocale.timezone()}, keymap {winlocale.keymap()}, "
        f"country {winlocale.country(firstboot.ISO3166)}, ssh key {sshkey.private_path()}",
        "=== firstrun.sh ===", firstboot.render_firstrun(cfg),
        "=== projection5000-provision.sh ===", firstboot.render_provision(cfg),
        "=== cmdline.txt ===", firstboot.patch_cmdline("console=tty1 root=PARTUUID=x rootfstype=ext4 rootwait\n"),
    ])
    if getattr(sys, "frozen", False):
        # --windowed exe has no console: print when launched from one (AttachConsole succeeds when the
        # parent process has one), and also leave the output next to the exe (or in %LOCALAPPDATA%).
        if ctypes.windll.kernel32.AttachConsole(-1):
            sys.stdout = open("CONOUT$", "w", encoding="utf-8")
        for out in (Path(sys.executable).with_name("selfcheck.txt"), imagefetch.app_dir() / "selfcheck.txt"):
            try:
                out.parent.mkdir(parents=True, exist_ok=True)
                out.write_bytes(text.encode("utf-8"))  # byte-faithful (LF), like the files written to the card
                text += f"\n(written to {out})"
                break
            except OSError:
                continue
    if sys.stdout:
        print(text)
        sys.stdout.flush()
    return 0 if tk_ok == "ok" or not getattr(sys, "frozen", False) else 1


def main(argv=None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    if "--selfcheck" in argv:
        return selfcheck()
    dry_run = "--dry-run" in argv
    # A dry run never opens the disk, so it does not need (or ask for) elevation.
    if not dry_run and not ensure_admin(argv):
        return 1
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(1)  # crisp text on high-DPI screens
    except Exception:
        pass
    root = tk.Tk()
    App(root, dry_run=dry_run)
    root.mainloop()
    return 0


if __name__ == "__main__":
    sys.exit(main())
