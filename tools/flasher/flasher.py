"""Projection5000 SD Flasher: write Raspberry Pi OS Lite to a card and pre-configure the Pi.

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
import sys
import tarfile
import threading
import time
import tkinter as tk
import traceback
from pathlib import Path
from tkinter import filedialog, messagebox, simpledialog, ttk

import bundle
import console
import firstboot
import imagefetch
import windisk

APP_TITLE = "Projection5000 SD Flasher"
# Persisted between runs (%LOCALAPPDATA%). Never the enrollment key or a token: the key is fetched from the console
# on every launch with the operator token, which lives DPAPI-protected in the operator config (%APPDATA%).
SETTINGS_KEYS = ("name", "device_id", "console_url", "ssid", "wifi_country", "wifi_hidden", "ethernet_only",
                 "username", "ssh", "timezone", "keymap", "image_mode", "image_path")
# Entry fields whose value is taken verbatim (everything else is stripped of surrounding whitespace).
UNSTRIPPED = ("password", "wifi_password")
CONSOLE_JSON = "console.json"  # {"console_url": ..., "enrollment_key": ...}, written by build.ps1 (key optional)
DEFAULT_CONSOLE_URL = "https://projectors.photogen5000.com"
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


# ---------------------------------------------------------------- operator config (console URL + API token)

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
    """{"console_url", "token"} from %APPDATA%\\Projection5000\\flasher.json; empty strings when absent or unreadable
    (a DPAPI blob from another account or a damaged file simply means the operator is asked again)."""
    out = {"console_url": "", "token": ""}
    try:
        d = json.loads(operator_config_path().read_text("utf-8"))
    except (OSError, ValueError):
        return out
    if not isinstance(d, dict):
        return out
    if isinstance(d.get("console_url"), str):
        out["console_url"] = d["console_url"].strip()
    tok = d.get("token")
    if isinstance(tok, str) and tok:
        if d.get("token_dpapi"):
            try:
                tok = _dpapi(base64.b64decode(tok), protect=False).decode("utf-8")
            except Exception:
                tok = ""
        out["token"] = tok.strip()
    return out


def save_operator_config(console_url: str, token: str) -> str:
    """Write the operator config, DPAPI-protecting the token. Returns a warning ('' when protected)."""
    d = {"console_url": console_url.strip().rstrip("/"), "token": token.strip(), "token_dpapi": False}
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
    """One line for --selfcheck: what this build will prefill."""
    c = console_defaults()
    if not c["console_url"]:
        return "console: none (the operator enters the console URL and API token on first run)"
    key = "set" if c["enrollment_key"] else "fetched with the operator token"
    return f"console: {c['console_url']} (enrollment key: {key})"


# ---------------------------------------------------------------- GUI

class App:
    def __init__(self, root: tk.Tk, dry_run: bool = False):
        self.root = root
        root.title(APP_TITLE)
        root.minsize(720, 560)
        self.dry_run_default = dry_run
        self.cancel = threading.Event()
        self.worker = None
        self.q = queue.Queue()
        self.disks = []
        self.v = {}  # tk variables by key
        self._build()
        self._apply_settings(load_settings())
        root.protocol("WM_DELETE_WINDOW", self.on_close)
        self._fit_to_screen()
        self._pump()
        self.refresh_disks()
        # The operator config wins over the remembered URL; with a token the key is fetched on every launch.
        op = load_operator_config()
        if op["console_url"]:
            self.v["console_url"].set(op["console_url"])
        self.v["operator_token"].set(op["token"])
        if op["token"]:
            self.fetch_key()
        else:
            root.after(0, self.first_run)

    # ----- form
    def _var(self, key, default="", kind=tk.StringVar):
        self.v[key] = kind(value=default)
        return self.v[key]

    def _entry(self, parent, row, label, key, default="", show=None, width=40):
        ttk.Label(parent, text=label).grid(row=row, column=0, sticky="w", padx=4, pady=2)
        e = ttk.Entry(parent, textvariable=self._var(key, default), width=width, show=show)
        e.grid(row=row, column=1, sticky="we", padx=4, pady=2)
        return e

    def _build(self):
        outer = ttk.Frame(self.root, padding=8)
        outer.pack(fill="both", expand=True)
        form = ttk.Frame(outer)
        form.pack(fill="x")
        form.columnconfigure(0, weight=1)
        form.columnconfigure(1, weight=1)

        dev = ttk.LabelFrame(form, text="Device", padding=6)
        dev.grid(row=0, column=0, sticky="nsew", padx=4, pady=4)
        dev.columnconfigure(1, weight=1)
        self._entry(dev, 0, "Device name", "name")
        self._entry(dev, 1, "device_id (hostname)", "device_id")
        self.v["name"].trace_add("write", self._derive_id)
        self._id_manual = False
        self.v["device_id"].trace_add("write", self._id_edited)

        con = ttk.LabelFrame(form, text="Console", padding=6)
        con.grid(row=1, column=0, sticky="nsew", padx=4, pady=4)
        con.columnconfigure(1, weight=1)
        self.baked = console_defaults()
        self._entry(con, 0, "Console URL", "console_url", self.baked["console_url"] or DEFAULT_CONSOLE_URL)
        # Row 2 is created before row 1 on purpose: the key's "Show" stays the first one in the frame.
        key = self._entry(con, 2, "Enrollment key", "enrollment_key", self.baked["enrollment_key"], show="*")
        self._var("show_key", False, tk.BooleanVar)
        ttk.Checkbutton(con, text="Show", variable=self.v["show_key"],
                        command=lambda: key.configure(show="" if self.v["show_key"].get() else "*")
                        ).grid(row=2, column=2, padx=2)
        tok = self._entry(con, 1, "Operator API token", "operator_token", show="*")
        self._var("show_token", False, tk.BooleanVar)
        ttk.Checkbutton(con, text="Show", variable=self.v["show_token"],
                        command=lambda: tok.configure(show="" if self.v["show_token"].get() else "*")
                        ).grid(row=1, column=2, padx=2)
        self.console_status = ttk.Label(con, text="(the key is fetched from the console with the token; "
                                                  "the Pi enrolls itself on first boot)")
        self.console_status.grid(row=3, column=0, columnspan=3, sticky="w", padx=4)
        btns = ttk.Frame(con)
        btns.grid(row=4, column=0, columnspan=3, sticky="w")
        ttk.Button(btns, text="Connect", command=self.connect).pack(side="left", padx=4, pady=2)
        ttk.Button(btns, text="Test connection", command=self.test_connection).pack(side="left", padx=4, pady=2)
        ttk.Checkbutton(con, text="Advanced: I already have a device token",
                        variable=self._var("advanced", False, tk.BooleanVar), command=self._toggle_advanced
                        ).grid(row=5, column=0, columnspan=2, sticky="w", padx=4)
        self.advanced = ttk.Frame(con)
        self.advanced.grid(row=6, column=0, columnspan=3, sticky="we")
        self.advanced.columnconfigure(1, weight=1)
        self._entry(self.advanced, 0, "Device token", "token")
        self.advanced.grid_remove()  # collapsed until the box is ticked

        wifi = ttk.LabelFrame(form, text="Wi-Fi", padding=6)
        wifi.grid(row=0, column=1, sticky="nsew", padx=4, pady=4)
        wifi.columnconfigure(1, weight=1)
        self._entry(wifi, 0, "SSID", "ssid")
        pw = self._entry(wifi, 1, "Password", "wifi_password", show="*")
        self._var("show_wifi", False, tk.BooleanVar)
        ttk.Checkbutton(wifi, text="Show", variable=self.v["show_wifi"],
                        command=lambda: pw.configure(show="" if self.v["show_wifi"].get() else "*")
                        ).grid(row=1, column=2, padx=2)
        ttk.Label(wifi, text="Country").grid(row=2, column=0, sticky="w", padx=4, pady=2)
        ttk.Combobox(wifi, textvariable=self._var("wifi_country", "US"), values=COUNTRIES, width=8
                     ).grid(row=2, column=1, sticky="w", padx=4, pady=2)
        ttk.Checkbutton(wifi, text="Hidden network", variable=self._var("wifi_hidden", False, tk.BooleanVar)
                        ).grid(row=3, column=0, columnspan=2, sticky="w", padx=4)
        ttk.Checkbutton(wifi, text="Ethernet only (no Wi-Fi)", variable=self._var("ethernet_only", False, tk.BooleanVar)
                        ).grid(row=4, column=0, columnspan=2, sticky="w", padx=4)

        pi = ttk.LabelFrame(form, text="Pi login", padding=6)
        pi.grid(row=1, column=1, sticky="nsew", padx=4, pady=4)
        pi.columnconfigure(1, weight=1)
        self._entry(pi, 0, "Username", "username", "pi")
        self._generated_password = secrets.token_urlsafe(12)
        self._entry(pi, 1, "Password", "password", self._generated_password)
        ttk.Label(pi, text="(shown in the log after the flash; not saved anywhere else)").grid(
            row=2, column=1, sticky="w", padx=4)
        ttk.Checkbutton(pi, text="Enable SSH", variable=self._var("ssh", True, tk.BooleanVar)
                        ).grid(row=3, column=0, columnspan=2, sticky="w", padx=4)
        ttk.Label(pi, text="Timezone").grid(row=4, column=0, sticky="w", padx=4, pady=2)
        ttk.Combobox(pi, textvariable=self._var("timezone", "America/Los_Angeles"), values=TIMEZONES
                     ).grid(row=4, column=1, sticky="we", padx=4, pady=2)
        self._entry(pi, 5, "Keyboard layout", "keymap", "us", width=8)

        img = ttk.LabelFrame(form, text="Image", padding=6)
        img.grid(row=2, column=0, sticky="nsew", padx=4, pady=4)
        img.columnconfigure(1, weight=1)
        self.bundled = bundle.find_bundle()
        self._var("image_mode", "bundled" if self.bundled else "latest")
        if self.bundled:
            ttk.Radiobutton(img, text=f"Bundled: {self.bundled.name} ({windisk.human_size(self.bundled.length)})",
                            variable=self.v["image_mode"], value="bundled").grid(row=0, column=0, columnspan=3,
                                                                                 sticky="w")
        ttk.Radiobutton(img, text="Raspberry Pi OS Lite (64-bit), latest (downloaded and cached)",
                        variable=self.v["image_mode"], value="latest").grid(row=1, column=0, columnspan=3, sticky="w")
        ttk.Radiobutton(img, text="Local image file (.img or .img.xz)", variable=self.v["image_mode"],
                        value="local").grid(row=2, column=0, columnspan=3, sticky="w")
        ttk.Entry(img, textvariable=self._var("image_path")).grid(row=3, column=0, columnspan=2, sticky="we", padx=4)
        ttk.Button(img, text="Browse...", command=self.browse_image).grid(row=3, column=2, padx=4)

        tgt = ttk.LabelFrame(form, text="Target SD card", padding=6)
        tgt.grid(row=2, column=1, sticky="nsew", padx=4, pady=4)
        tgt.columnconfigure(0, weight=1)
        self.disk_box = ttk.Combobox(tgt, textvariable=self._var("disk"), state="readonly")
        self.disk_box.grid(row=0, column=0, sticky="we", padx=4, pady=2)
        ttk.Button(tgt, text="Refresh", command=self.refresh_disks).grid(row=0, column=1, padx=4)
        ttk.Label(tgt, text="Everything on the selected card will be erased.").grid(row=1, column=0, columnspan=2,
                                                                                    sticky="w", padx=4)

        buttons = ttk.Frame(outer)
        buttons.pack(fill="x", pady=4)
        self.flash_btn = ttk.Button(buttons, text="Flash", command=self.on_flash)
        self.flash_btn.pack(side="left", padx=4)
        self.cancel_btn = ttk.Button(buttons, text="Cancel", command=self.on_cancel, state="disabled")
        self.cancel_btn.pack(side="left", padx=4)
        ttk.Checkbutton(buttons, text="Dry run (validate + resolve image, do not write)",
                        variable=self._var("dry_run", self.dry_run_default, tk.BooleanVar)).pack(side="left", padx=4)
        self.progress = ttk.Progressbar(buttons, maximum=100)
        self.progress.pack(side="left", fill="x", expand=True, padx=8)
        self.status = ttk.Label(buttons, text="")
        self.status.pack(side="left", padx=4)

        logf = ttk.Frame(outer)
        logf.pack(fill="both", expand=True, pady=4)
        self.log_text = tk.Text(logf, height=8, wrap="word", state="disabled")
        sb = ttk.Scrollbar(logf, orient="vertical", command=self.log_text.yview)
        self.log_text.configure(yscrollcommand=sb.set)
        sb.pack(side="right", fill="y")
        self.log_text.pack(side="left", fill="both", expand=True)

    def _fit_to_screen(self):
        # Never taller than the screen minus the taskbar and title bar, so the log stays visible.
        self.root.update_idletasks()
        w = max(self.root.winfo_reqwidth(), 720)
        h = min(max(self.root.winfo_reqheight(), 560), self.root.winfo_screenheight() - 120)
        self.root.geometry(f"{w}x{h}")

    def _derive_id(self, *_):
        if not self._id_manual:
            self._setting_id = True
            self.v["device_id"].set(firstboot.derive_device_id(self.v["name"].get()))
            self._setting_id = False

    def _id_edited(self, *_):
        if not getattr(self, "_setting_id", False):
            self._id_manual = bool(self.v["device_id"].get())

    def _toggle_advanced(self):
        if self.v["advanced"].get():
            self.advanced.grid()
        else:
            self.advanced.grid_remove()

    def test_connection(self):
        """GET /api/health on the console URL in the form (never enrolls, never sends the key)."""
        url = self.values()["console_url"]
        problem = firstboot.console_url_problem(url)
        if problem:
            self.log(f"Console test: {problem}")
            return
        self.log(f"Testing {url} ...")

        def work():
            try:
                console.check_health(url)
                msg = f"Console at {url} answers /api/health: ok."
            except console.ConsoleError as e:
                msg = f"Console test FAILED: {e}"
            self.post(lambda: self.log(msg))

        threading.Thread(target=work, daemon=True).start()

    def first_run(self):
        """No operator token yet: ask for the console URL and an API token. Cancel leaves the manual key entry."""
        url = simpledialog.askstring(APP_TITLE, "Console URL:", initialvalue=self.values()["console_url"],
                                     parent=self.root)
        token = url and simpledialog.askstring(
            APP_TITLE, "Operator API token (console Settings page, \"My API tokens\"):", show="*", parent=self.root)
        if not url or not token:
            self.log("No operator API token: click Connect after entering one, or paste an enrollment key.")
            return
        self.v["console_url"].set(url)
        self.v["operator_token"].set(token)
        self.connect()

    def connect(self):
        """Save the console URL + operator token (%APPDATA%, DPAPI-protected) and fetch the enrollment key."""
        v = self.values()
        problem = firstboot.console_url_problem(v["console_url"]) or (
            "" if v["operator_token"] else "Operator API token is required (console Settings page).")
        if problem:
            messagebox.showerror(APP_TITLE, problem)
            return
        warning = save_operator_config(v["console_url"], v["operator_token"])
        if warning:
            self.log(warning)
        self.fetch_key()

    def fetch_key(self):
        """GET /api/operator/enrollment with the operator token; the answer fills the enrollment key field."""
        v = self.values()
        self.console_status.configure(text=f"Fetching the enrollment key from {v['console_url']} ...")

        def work():
            try:
                r = console.fetch_enrollment(v["console_url"], v["operator_token"])
            except console.ConsoleError as e:
                msg = f"Enrollment key fetch FAILED: {e}"
                self.post(lambda: (self.log(msg), self.console_status.configure(text=msg)))
                return
            self.post(lambda: self._apply_enrollment(r))

        threading.Thread(target=work, daemon=True).start()

    def _apply_enrollment(self, r: dict):
        self.v["enrollment_key"].set(r["enrollment_key"])
        groups = ", ".join(g["name"] for g in r["groups"]) or "none"
        playlists = ", ".join(p["name"] for p in r["playlists"]) or "none"
        self.console_status.configure(text=f"Console {r['console_url']}: enrollment key fetched "
                                           f"({len(r['groups'])} groups, {len(r['playlists'])} playlists).")
        self.log(f"Console {r['console_url']}: enrollment key fetched. Groups: {groups}. Playlists: {playlists}.")

    def _apply_settings(self, s: dict):
        for k in SETTINGS_KEYS:
            if k in s and k in self.v:
                try:
                    self.v[k].set(s[k])
                except tk.TclError:
                    pass
        self._id_manual = bool(s.get("device_id")) and s.get("device_id") != firstboot.derive_device_id(s.get("name", ""))
        if self.v["image_mode"].get() == "bundled" and not self.bundled:  # saved by an exe that had one
            self.v["image_mode"].set("latest")

    def values(self) -> dict:
        """Form values; text fields are stripped (pasted spaces and newlines otherwise reach the card)."""
        out = {}
        for k, var in self.v.items():
            val = var.get()
            if isinstance(val, str) and k not in UNSTRIPPED:
                val = val.strip()
            out[k] = val
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
        save_settings(self.values())
        self.root.destroy()

    def on_cancel(self):
        self.cancel.set()
        self.log("Cancelling...")

    def validate(self) -> dict:
        v = self.values()
        problems = []
        if v["advanced"] and not v["token"]:
            problems.append("Device token is required (or untick the Advanced box to enroll with the key).")
        # The same rules the card scripts enforce (enrollment key unless a token bypasses enrollment).
        problems += firstboot.validate_cfg(card_cfg(v))
        if v["image_mode"] == "local":
            if not Path(v["image_path"]).is_file():
                problems.append("Local image file not found.")
            else:
                try:
                    windisk.check_image_magic(v["image_path"])
                except windisk.DiskError as e:
                    problems.append(str(e))
        disk = self.selected_disk()
        if not v["dry_run"]:  # a dry run never touches the card, so none is needed
            if not is_admin():
                problems.append("Restart as administrator to write a card (dry run works without).")
            if disk is None:
                problems.append("Select a target SD card.")
            elif disk["size"] == 0:
                problems.append("The selected reader has no card inserted.")
            elif disk["size"] > windisk.MAX_CARD_BYTES:
                problems.append(f"Refusing to write a disk larger than {windisk.human_size(windisk.MAX_CARD_BYTES)}.")
        if problems:
            messagebox.showerror(APP_TITLE, "\n".join(problems))
            return None
        v["disk_info"] = disk
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
                messagebox.showerror(APP_TITLE, f"Disk scan failed: {e}")
                return
            d = self.selected_disk()
            if d is None or (d["number"], d["unique_id"]) != (chosen["number"], chosen["unique_id"]):
                messagebox.showerror(APP_TITLE, "The target disk changed since it was selected. "
                                     "Check the target list and click Flash again.")
                return
            v = self.validate()  # size checks against the fresh scan
            if not v:
                return
            d = v["disk_info"]
            image = {"bundled": f"bundled {self.bundled.name}" if self.bundled else "bundled (missing)",
                     "latest": "latest Raspberry Pi OS Lite"}.get(v["image_mode"], v["image_path"])
            if not messagebox.askyesno(APP_TITLE, f"Flash {v['name']} ({v['device_id']}) to:\n\n{d['label']}\n\n"
                                       f"Image: {image}\nConsole: {v['console_url']} ({console_mode(v)})\n\n"
                                       "Everything on that card will be erased. Continue?", default=messagebox.NO):
                return
            if not messagebox.askokcancel(APP_TITLE, f"FINAL CONFIRMATION\n\nDisk {d['number']}: {d['name']}\n"
                                          f"Size: {windisk.human_size(d['size'])}\n\nAll data on this disk will be "
                                          "destroyed.", icon="warning", default=messagebox.CANCEL):
                return
        save_settings(v)
        self.cancel.clear()
        self.flash_btn.configure(state="disabled")
        self.cancel_btn.configure(state="normal")
        self.set_progress(0, "")
        self.worker = threading.Thread(target=self._run_flash, args=(v,), daemon=True)
        self.worker.start()

    # ----- worker
    def _run_flash(self, v: dict):
        log = lambda s: self.post(lambda: self.log(s))
        try:
            run_flash(v, log, lambda pct, text: self.post(lambda: self.set_progress(pct, text)), self.cancel,
                      dry_run=v["dry_run"])
            log("Done.")
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
        self.cancel_btn.configure(state="disabled")
        self.status.configure(text="")
        if self.v["password"].get() == self._generated_password:
            # A fresh random password per flash; the one just used is in the log.
            self._generated_password = secrets.token_urlsafe(12)
            self.v["password"].set(self._generated_password)


# ---------------------------------------------------------------- flash sequence (no widgets here)

def card_cfg(v: dict) -> dict:
    cfg = {k: v[k] for k in ("device_id", "name", "username", "password", "ssh", "ssid", "wifi_password",
                              "wifi_hidden", "ethernet_only", "timezone", "keymap", "enrollment_key")}
    cfg["wifi_country"] = v["wifi_country"].strip().upper()
    cfg["console_url"] = v["console_url"].strip().rstrip("/")
    # The token field only counts while the Advanced box is ticked (a collapsed leftover must not bypass enrollment).
    cfg["token"] = v["token"].strip() if v.get("advanced") else ""
    return cfg


def console_mode(v: dict) -> str:
    return "device token given, no enrollment" if card_cfg(v)["token"] else "enrolls itself on first boot"


def run_flash(v: dict, log, progress, cancel: threading.Event, dry_run: bool = False):
    """The flash sequence. Never contacts the console (the Pi enrolls itself on first boot);
    dry_run stops after image resolution, before any disk access."""
    d = v["disk_info"]
    cfg = card_cfg(v)
    problems = firstboot.validate_cfg(cfg)
    if problems:  # checked before anything is written
        raise ValueError(" ".join(problems))

    # 1. first-boot files
    log(f"Console {cfg['console_url']}: {console_mode(v)}.")
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
    log(f"  Device: {v['name'].strip()} ({v['device_id']}), hostname {v['device_id']}")
    log("  Network: Ethernet only" if v["ethernet_only"] else f"  Wi-Fi: {v['ssid']} ({cfg['wifi_country']})")
    log(f"  Pi user: {v['username']}   password: {v['password']}   SSH: {'on' if v['ssh'] else 'off'}")
    log("  Record the password now: it is not saved anywhere else.")
    log(f"  Console: {cfg['console_url']} ({console_mode(v)})")
    log(f"  Image: {windisk.source_name(image)}" + (" (bundled in this exe)" if v["image_mode"] == "bundled" else ""))
    log("  Insert the card into the Pi and power on. It enrolls itself and appears on the console's Devices page")
    log("  within about 5 minutes on first boot (it needs internet access for apt and pip). Progress is logged on")
    log("  the Pi in /var/log/projection5000-provision.log; firstrun.log and firstrun.ok appear on the boot partition.")
    log("  A card that never booted still carries the enrollment key: keep it safe or rotate the key on the console.")


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
