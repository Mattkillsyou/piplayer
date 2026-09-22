"""Projection5000 SD Flasher: write Raspberry Pi OS Lite to a card and pre-configure the Pi.

One button: the console is fixed (baked in by build.ps1 / build_mac.sh), the sign-in happens in the browser the
first time FLASH is pressed, and only what changes per Pi is asked (name, model, Wi-Fi, card). Everything else is
automatic or under Advanced. The technical log goes to the hidden details box and flasher.log in the data folder
(%LOCALAPPDATA%\\Projection5000 on Windows, ~/Library/Application Support/Projection5000 on macOS).

Windows and macOS: everything platform-specific lives behind sysplat (disk, wifi, defaults, host); nothing in
this file branches on the platform.

Run: python flasher.py            (Windows: relaunches itself elevated if needed; macOS: asks for the password
                                   when a card is written)
     python flasher.py --selfcheck (prints the generated first-boot scripts, exits 0)
     python flasher.py --dry-run   (no admin needed; Flash stops before touching the card)
     python flasher.py --image X   (developers: write this .img / .img.xz instead of the model's image;
                                    the FLASHER_IMAGE environment variable does the same)
"""
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
import tkinter.font as tkfont
import traceback
import urllib.parse
import webbrowser
from pathlib import Path
from tkinter import messagebox, ttk

import bundle
import console
import firstboot
import imagefetch
import pimodel
import sshkey
from sysplat import defaults, disk, host, wifi

APP_TITLE = "Matt Brown's Projection5000"
EYEBROW = "MATT BROWN'S"
# Persisted between runs (host.data_dir). Never a secret: the enrollment key is fetched from the console at flash
# time with the operator token, which lives DPAPI-protected in the operator config (Windows) or in the login
# keychain (macOS).
SETTINGS_KEYS = ("name", "pi_model", "ssid", "wifi_hidden", "timezone", "static_ip", "gateway")
LOG_NAME, LOG_MAX = "flasher.log", 2_000_000  # the technical log; rotated to flasher.log.1 at 2 MB
# The status line: plain sentences, one at a time (everything technical goes to the details box and the file).
READY_TEXT = "Ready."
CONNECT_TEXT = "Approve this computer in the browser window that just opened, then the card is made automatically."
DRY_RUN_TEXT = "Dry run finished. Nothing was written."
# An armhf model with no internet: shown under the model row instead of a dialog.
OFFLINE_TEXT = (f"This model needs the 32-bit image. Connect to the internet once (about {pimodel.DOWNLOAD_MB} MB) "
                "and press FLASH again.")
# Entry fields whose value is taken verbatim (everything else is stripped of surrounding whitespace).
UNSTRIPPED = ("wifi_password",)
CONSOLE_JSON = "console.json"  # {"console_url": ..., "enrollment_key": ...}, written by build.ps1 (key optional)
DEFAULT_CONSOLE_URL = "https://projectors.photogen5000.com"
# The Pi's login: one fixed user, SSH by key only (the flasher's key, see sshkey.py). The OS still needs a
# password to create the user: a random one per flash that is never shown or saved (firstrun.sh writes a
# sudoers drop-in, so sudo needs none).
PI_USERNAME = "projector-admin"
# validate_cfg problems -> (form field, plain words; None keeps the rule's own text). Unlisted problems go under
# the Flash button.
PLAIN_WORDS = [("Device name", "name", "Give the Pi a name."),
               ("device_id", "name", "The name needs at least one letter or digit."),
               ("Wi-Fi SSID", "ssid", None),
               ("Wi-Fi password", "wifi_password", "Wi-Fi password must be 8-63 characters."),
               ("Timezone", "adv", None), ("Static IP", "adv", None), ("Gateway", "adv", None)]
WIRED_HINT = "leave blank for a wired Pi"
SCANNING_HINT = "Looking for networks..."
LOCATION_HINT = host.NO_SCAN_HINT  # connected, yet the scan is empty (Windows 11 with Location off)
TIMEZONES = ["America/Los_Angeles", "America/Denver", "America/Chicago", "America/New_York", "America/Phoenix",
             "America/Anchorage", "Pacific/Honolulu", "America/Toronto", "America/Vancouver", "America/Mexico_City",
             "America/Sao_Paulo", "Europe/London", "Europe/Dublin", "Europe/Paris", "Europe/Berlin", "Europe/Madrid",
             "Europe/Rome", "Europe/Amsterdam", "Europe/Stockholm", "Australia/Sydney", "Australia/Melbourne",
             "Pacific/Auckland", "Asia/Tokyo", "Asia/Singapore", "UTC"]
PLAYER_EXCLUDE = ("__pycache__", ".venv", ".pytest_cache", "tests")


# ---------------------------------------------------------------- elevation (Windows; macOS asks per flash)

def work_area(root) -> tuple:
    """(top, bottom) of the work area in px: the screen without the taskbar (Windows) or the menu bar (macOS)."""
    return host.work_area(root)


def is_admin() -> bool:
    """True when this process may write a card (elevated on Windows; always on macOS, where authopen asks)."""
    return host.is_admin()


def relaunch_elevated(argv=()) -> bool:
    """Windows: 'runas' this program with --elevated and the same arguments; False when UAC was declined."""
    return host.relaunch_elevated(argv)


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
    if "--elevated" not in argv and relaunch_elevated(argv):
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


def log_path() -> Path:
    return imagefetch.app_dir() / LOG_NAME


def append_log(line: str) -> None:
    """The technical log on disk (what the details box shows), timestamped; rotated once at LOG_MAX. Never raises:
    a full or read-only profile must not stop a flash."""
    p = log_path()
    try:
        p.parent.mkdir(parents=True, exist_ok=True)
        if p.exists() and p.stat().st_size > LOG_MAX:
            p.replace(p.with_suffix(".log.1"))
        with p.open("a", encoding="utf-8") as f:
            f.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')} {line.rstrip()}\n")
    except OSError:
        pass


# ---------------------------------------------------------------- operator config (sign-in token)

def operator_config_path() -> Path:
    return host.config_dir() / host.SIGNIN_FILE


def _read_operator_config() -> dict:
    try:
        d = json.loads(operator_config_path().read_text("utf-8"))
    except (OSError, ValueError):
        return {}
    return d if isinstance(d, dict) else {}


def load_operator_config() -> dict:
    """{"console_url", "token", "username"} from flasher.json in host.config_dir(); empty strings when absent or
    unreadable (a DPAPI blob from another account, a keychain item that was denied or a damaged file simply
    means: sign in again). The token itself comes from host.open_token (DPAPI / the login keychain)."""
    out = {"console_url": "", "token": "", "username": ""}
    d = _read_operator_config()
    for k in ("console_url", "username"):
        if isinstance(d.get(k), str):
            out[k] = d[k].strip()
    if d:
        out["token"] = host.open_token(d)
    return out


def save_operator_config(console_url: str, token: str, username: str = "") -> str:
    """Write the operator config with the token sealed by the host (DPAPI blob in the file on Windows, the
    login keychain on macOS). Returns a warning ('' when sealed; plain text otherwise)."""
    d = {"console_url": console_url.strip().rstrip("/"), "token": token.strip(), "token_dpapi": False,
         "username": username.strip()}
    warning = ""
    try:
        d.update(host.seal_token(d["token"]))
    except Exception as e:
        warning = (f"WARNING: {host.SEAL_NAME} is not available ({e}); the operator token is stored in plain text "
                   f"in {operator_config_path()}.")
    p = operator_config_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(d, indent=2), "utf-8")
    return warning


def clear_operator_config() -> None:
    """Sign out: forget the token (the console keeps the api_tokens row until it is revoked there)."""
    host.forget_token(_read_operator_config())
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
    """A file the build bundled with --add-data (frozen), or the same name next to this script (source)."""
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


# ---------------------------------------------------------------- theme (the console's look, cms/app/static/style.css)

# Ground / ink ramp from the console's --p5k-* tokens; the translucent rules are baked to solid greys on black.
GROUND, RAISED, FIELD = "#000000", "#0D0D0D", "#0A0A0A"
PHOSPHOR, INK, BODY, MUTED, DIM = "#FFFFFF", "#E6E6E6", "#C9C9C9", "#7A7A7A", "#4A4A4A"
RULE_2, RULE_3, RULE_STRONG = "#242424", "#3A3A3A", "#727272"
FONT_FILES = ("Silkscreen-Regular.ttf", "Silkscreen-Bold.ttf", "IBMPlexMono-Regular.ttf", "IBMPlexMono-Medium.ttf",
              "SpaceGrotesk[wght].ttf")
FAMILIES = {"display": "Silkscreen", "mono": "IBM Plex Mono", "sans": "Space Grotesk"}
BRACKET = 14  # px arm of the panel's corner brackets


def font_paths() -> list:
    return [resource_path("fonts") / name for name in FONT_FILES]


def load_fonts() -> list:
    """Register the bundled TTFs for this process only (gdi32 on Windows, CoreText on macOS; nothing is
    installed). Call before the first widget; returns the files that loaded. The fallbacks in font_families()
    cover a failed load (the App logs the families in use)."""
    return host.load_fonts(font_paths())


def font_families(available=None) -> dict:
    """display/mono/sans family names, checked against Tk's font list (the host's fallbacks, Consolas / Segoe UI
    or Menlo / Helvetica Neue, when a load failed)."""
    have = set(tkfont.families() if available is None else available)
    return {k: fam if fam in have else host.FALLBACK_FONTS[k] for k, fam in FAMILIES.items()}


def apply_theme(root: tk.Tk) -> dict:
    """Black console theme on ttk's clam engine. Returns the font families in use."""
    fam = font_families()
    sans, mono, display = (fam["sans"], 10), (fam["mono"], 9), (fam["display"], 11, "bold")
    root.configure(background=GROUND)
    # The Combobox dropdown is a plain Tk listbox: styled through the option database.
    for opt, val in (("*TCombobox*Listbox.background", FIELD), ("*TCombobox*Listbox.foreground", INK),
                     ("*TCombobox*Listbox.selectBackground", PHOSPHOR), ("*TCombobox*Listbox.selectForeground", GROUND),
                     ("*TCombobox*Listbox.font", f'{{{fam["mono"]}}} 9'), ("*TCombobox*Listbox.borderWidth", 0)):
        root.option_add(opt, val)
    st = ttk.Style(root)
    st.theme_use("clam")
    st.configure(".", background=GROUND, foreground=INK, fieldbackground=FIELD, bordercolor=RULE_3, darkcolor=GROUND,
                 lightcolor=GROUND, troughcolor=RAISED, selectbackground=PHOSPHOR, selectforeground=GROUND,
                 insertcolor=PHOSPHOR, focuscolor=GROUND, font=sans)
    st.configure("TLabel", font=sans)
    # the masthead: the name over the wordmark, both in the pixel face (the product logo, not a page header)
    st.configure("Eyebrow.TLabel", font=(fam["display"], 13), foreground=INK)
    st.configure("Wordmark.TLabel", font=(fam["display"], 24, "bold"), foreground=PHOSPHOR)
    st.configure("Mono.TLabel", font=mono, foreground=BODY)
    st.configure("Status.TLabel", font=(fam["mono"], 10), foreground=INK)
    st.configure("Hint.TLabel", font=(fam["sans"], 9), foreground=MUTED)
    st.configure("MonoHint.TLabel", font=(fam["mono"], 8), foreground=MUTED)
    st.configure("Error.TLabel", font=(fam["sans"], 9), foreground=PHOSPHOR)
    st.configure("Link.TLabel", font=(fam["mono"], 9), foreground=BODY)
    # fields: #0A0A0A with a 1px grey edge, white when focused
    for w in ("TEntry", "TCombobox"):
        st.configure(w, fieldbackground=FIELD, foreground=PHOSPHOR, bordercolor=RULE_3, lightcolor=FIELD,
                     darkcolor=FIELD, insertcolor=PHOSPHOR, padding=(6, 4), font=mono, arrowcolor=INK, arrowsize=14,
                     background=FIELD)
        st.map(w, bordercolor=[("focus", PHOSPHOR)], lightcolor=[("focus", PHOSPHOR)], darkcolor=[("focus", PHOSPHOR)],
               fieldbackground=[("readonly", FIELD), ("disabled", RAISED)], foreground=[("disabled", DIM)],
               selectbackground=[("!focus", FIELD), ("readonly", FIELD)], selectforeground=[("readonly", PHOSPHOR)],
               background=[("active", RAISED), ("pressed", RAISED)], arrowcolor=[("disabled", DIM)])
    for w in ("TCheckbutton", "TRadiobutton"):
        st.configure(w, font=sans, indicatorbackground=FIELD, indicatorforeground=PHOSPHOR,
                     indicatormargin=(0, 0, 8, 0), upperbordercolor=RULE_STRONG, lowerbordercolor=RULE_STRONG, padding=2)
        st.map(w, background=[("active", GROUND)], foreground=[("disabled", DIM)],
               indicatorbackground=[("selected", FIELD), ("active", RAISED), ("disabled", RAISED)],
               upperbordercolor=[("active", PHOSPHOR)], lowerbordercolor=[("active", PHOSPHOR)])
    # buttons: outlined white on black; the primary action is solid white with black text
    st.configure("TButton", font=(fam["mono"], 9), foreground=PHOSPHOR, background=GROUND, bordercolor=RULE_STRONG,
                 lightcolor=GROUND, darkcolor=GROUND, padding=(12, 5), anchor="center")
    st.map("TButton", bordercolor=[("disabled", RULE_2), ("active", PHOSPHOR)], background=[("active", GROUND)],
           foreground=[("disabled", DIM)], lightcolor=[("active", GROUND)], darkcolor=[("active", GROUND)])
    st.configure("Primary.TButton", font=display, foreground=GROUND, background=PHOSPHOR, bordercolor=PHOSPHOR,
                 lightcolor=PHOSPHOR, darkcolor=PHOSPHOR, padding=(28, 8))
    st.map("Primary.TButton", background=[("disabled", DIM), ("active", INK)],
           bordercolor=[("disabled", DIM), ("active", INK)], lightcolor=[("disabled", DIM), ("active", INK)],
           darkcolor=[("disabled", DIM), ("active", INK)], foreground=[("disabled", GROUND)])
    st.configure("Horizontal.TProgressbar", background=PHOSPHOR, troughcolor=RAISED, bordercolor=RULE_3,
                 lightcolor=PHOSPHOR, darkcolor=PHOSPHOR, thickness=8)
    st.configure("Vertical.TScrollbar", background=RAISED, troughcolor=GROUND, bordercolor=GROUND, arrowcolor=MUTED,
                 lightcolor=RAISED, darkcolor=RAISED, gripcount=0)
    st.map("Vertical.TScrollbar", background=[("active", RULE_3)], arrowcolor=[("active", PHOSPHOR)])
    return fam


def hatch_marker(master, w=8, h=14) -> tk.PhotoImage:
    """The console's hatch (45 degree white stripes on black): the leading marker of an inline error."""
    img = tk.PhotoImage(master=master, width=w, height=h)
    img.put(GROUND, to=(0, 0, w, h))
    for y in range(h):
        for x in range(w):
            if (x + y) % 4 < 2:
                img.put(PHOSPHOR, (x, y))
    return img


def load_logo(master, size=64):
    """icon.png (256 px, bundled next to icon.ico) scaled to 64 px for the masthead; None when it is missing or Tk
    cannot read it (the masthead then shows the name alone)."""
    try:
        img = tk.PhotoImage(master=master, file=str(resource_path("icon.png")))
        factor = max(1, img.width() // size)
        return img.subsample(factor, factor) if factor > 1 else img
    except tk.TclError:
        return None


def draw_brackets(panel: tk.Frame, inset=5) -> list:
    """The console's panel frame: four corner L shapes, 1px white with 14px arms, on small canvases placed over
    the panel's corners (its padding, so nothing is covered)."""
    b, out = BRACKET, []
    for ax, ay in ((0, 0), (1, 0), (0, 1), (1, 1)):
        c = tk.Canvas(panel, width=b + 1, height=b + 1, bg=panel["bg"], highlightthickness=0, bd=0)
        x, y = (b if ax else 0), (b if ay else 0)  # the corner pixel of the L
        c.create_line(x, y, b - x, y, fill=PHOSPHOR)
        c.create_line(x, y, x, b - y, fill=PHOSPHOR)
        c.place(relx=ax, rely=ay, x=inset * (-1 if ax else 1), y=inset * (-1 if ay else 1),
                anchor=("nw", "ne", "sw", "se")[ax + ay * 2])
        out.append(c)
    return out


# ---------------------------------------------------------------- GUI

class App:
    def __init__(self, root: tk.Tk, dry_run: bool = False, image: str = ""):
        self.root = root
        root.title(APP_TITLE)
        root.minsize(700, 460)
        host.set_window_icon(root, resource_path("icon.ico"))  # macOS: the .app bundle carries the icon
        self.fonts = apply_theme(root)
        self.marker = hatch_marker(root)  # the error labels' leading hatch, kept alive here
        self.dry_run_default = dry_run
        self.image_override = image  # --image / FLASHER_IMAGE: a developer's local image instead of the model's
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
        self._phase = ""  # what the progress bar measures ("Writing the card"), shown with the percentage
        self._build()
        self._apply_settings(load_settings())
        root.protocol("WM_DELETE_WINDOW", self.on_close)
        self._pump()
        self.refresh_disks()
        self.refresh_networks()
        self.log(f"Console {self.console_url}.")
        self.log(f"Fonts: {', '.join(self.fonts.values())}.")
        if self.image_override:
            self.log(f"Image override: {self.image_override}")
        op = load_operator_config()
        if op["token"] and op["console_url"] in ("", self.console_url):
            self.op = {"token": op["token"], "username": op["username"]}
            self.check_token()
        self._show_account()
        self.set_status(READY_TEXT)
        # Last, once every widget holds its first text: Tk on macOS (Aqua) never returns from update() when a
        # hidden window that is not the process's first gets its geometry set and then its labels change.
        self._fit_to_screen()

    # ----- form
    def _var(self, key, default="", kind=tk.StringVar):
        self.v[key] = kind(value=default)
        return self.v[key]

    def _entry(self, parent, row, label, key, default="", show=None, width=40):
        ttk.Label(parent, text=label).grid(row=row, column=0, sticky="w", padx=4, pady=4)
        e = ttk.Entry(parent, textvariable=self._var(key, default), width=width, show=show)
        e.grid(row=row, column=1, sticky="we", padx=4, pady=4)
        return e

    def _err(self, parent, row, field, column=1, columnspan=2):
        """An inline error line under a field (empty and collapsed until validate() fills it)."""
        lbl = ttk.Label(parent, text="", style="Error.TLabel", wraplength=520, justify="left", image=self.marker,
                        compound="left", padding=(0, 2))
        lbl.grid(row=row, column=column, columnspan=columnspan, sticky="w", padx=4)
        lbl.grid_remove()
        self.err[field] = lbl
        return lbl

    def _build(self):
        outer = ttk.Frame(self.root, padding=16)
        outer.pack(fill="both", expand=True)

        # 1. masthead: the product logo (the projector icon, the name over the wordmark), nothing else.
        header = ttk.Frame(outer, height=96)
        header.pack(fill="x", pady=(0, 12))
        header.pack_propagate(False)
        self.logo = load_logo(self.root)
        if self.logo:
            ttk.Label(header, image=self.logo).pack(side="left", padx=(4, 16), anchor="center")
        mark = ttk.Frame(header)
        mark.pack(side="left", anchor="center")
        self.eyebrow = ttk.Label(mark, text=EYEBROW, style="Eyebrow.TLabel")
        self.eyebrow.pack(anchor="w", padx=(0, 0))
        self.wordmark = ttk.Label(mark, text="PROJECTION5000", style="Wordmark.TLabel")
        self.wordmark.pack(anchor="w")

        # 2-4. what changes per Pi, on a panel with the console's corner brackets.
        panel = tk.Frame(outer, bg=GROUND)
        panel.pack(fill="x")
        form = ttk.Frame(panel, padding=(16, 14))
        form.pack(fill="x")
        self.brackets = draw_brackets(panel)
        form.columnconfigure(1, weight=1)
        self._entry(form, 0, "Device name", "name")
        self.id_label = ttk.Label(form, text="", style="Hint.TLabel")
        self.id_label.grid(row=1, column=1, sticky="w", padx=4)
        self._err(form, 2, "name")
        self.v["name"].trace_add("write", self._derive_id)
        # Pi model: the key lives in v["pi_model"] (saved in flasher.json); the box shows the label.
        ttk.Label(form, text="Pi model").grid(row=3, column=0, sticky="w", padx=4, pady=4)
        self.model_box = ttk.Combobox(form, values=pimodel.LABELS, state="readonly", width=38)
        self.model_box.grid(row=3, column=1, sticky="we", padx=4, pady=4)
        self.model_box.bind("<<ComboboxSelected>>",
                            lambda e: self.v["pi_model"].set(pimodel.MODELS[self.model_box.current()].key))
        self.model_hint = ttk.Label(form, text="", style="MonoHint.TLabel", wraplength=520, justify="left")
        self.model_hint.grid(row=4, column=1, columnspan=2, sticky="w", padx=4)
        self._err(form, 5, "pi_model")
        self._var("pi_model", pimodel.DEFAULT).trace_add("write", self._model_changed)
        self._model_changed()
        ttk.Label(form, text="Wi-Fi network").grid(row=6, column=0, sticky="w", padx=4, pady=4)
        self.ssid_box = ttk.Combobox(form, textvariable=self._var("ssid"), width=38)  # editable: any name works
        self.ssid_box.grid(row=6, column=1, sticky="we", padx=4, pady=4)
        self.ssid_box.bind("<<ComboboxSelected>>", self._ssid_picked)
        side = ttk.Frame(form)
        side.grid(row=6, column=2, sticky="w")
        refresh = ttk.Label(side, text="Refresh", style="Link.TLabel", cursor="hand2", underline=0)
        refresh.pack(side="left", padx=4)
        refresh.bind("<Button-1>", lambda e: self.refresh_networks())
        self.ssid_hint = ttk.Label(side, text=WIRED_HINT, style="Hint.TLabel", wraplength=260, justify="left")
        self.ssid_hint.pack(side="left", padx=4)
        self._err(form, 7, "ssid")
        pw = self._entry(form, 8, "Wi-Fi password", "wifi_password", show="*")
        self._var("show_wifi", False, tk.BooleanVar)
        side = ttk.Frame(form)
        side.grid(row=8, column=2, sticky="w")
        ttk.Checkbutton(side, text="Show", variable=self.v["show_wifi"],
                        command=lambda: pw.configure(show="" if self.v["show_wifi"].get() else "*")
                        ).pack(side="left", padx=4)
        self.pw_hint = ttk.Label(side, text="", style="Hint.TLabel")
        self.pw_hint.pack(side="left", padx=4)
        self.v["wifi_password"].trace_add("write", self._password_edited)
        self._err(form, 9, "wifi_password")
        ttk.Label(form, text="SD card").grid(row=10, column=0, sticky="w", padx=4, pady=4)
        self.disk_box = ttk.Combobox(form, textvariable=self._var("disk"), state="readonly")
        self.disk_box.grid(row=10, column=1, sticky="we", padx=4, pady=4)
        ttk.Button(form, text="Refresh", command=self.refresh_disks).grid(row=10, column=2, sticky="w", padx=4)
        self._err(form, 11, "disk")

        # 5. Flash, progress, the one status line.
        buttons = ttk.Frame(form)
        buttons.grid(row=12, column=0, columnspan=3, sticky="we", pady=(12, 0))
        buttons.columnconfigure(2, weight=1)
        self.flash_btn = ttk.Button(buttons, text="FLASH", command=self.on_flash, style="Primary.TButton")
        self.flash_btn.grid(row=0, column=0, padx=4)
        self.cancel_btn = ttk.Button(buttons, text="Cancel", command=self.on_cancel)
        self.cancel_btn.grid(row=0, column=1, padx=4)
        self.cancel_btn.grid_remove()  # shown while a flash runs, and while the browser approval is awaited
        self.progress = ttk.Progressbar(buttons, maximum=100)
        self.progress.grid(row=0, column=2, sticky="we", padx=8)
        self.status_label = ttk.Label(buttons, text="", style="Status.TLabel", wraplength=560, justify="left")
        self.status_label.grid(row=1, column=0, columnspan=3, sticky="w", padx=4, pady=(10, 0))
        self._err(buttons, 2, "flash", column=0, columnspan=3)

        # Advanced: one collapsed disclosure holding everything else, the technical log included.
        self.adv_btn = ttk.Button(outer, text="Advanced", command=self._toggle_advanced)
        self.adv_btn.pack(anchor="w", pady=(12, 0))
        self.advanced = ttk.Frame(outer, padding=(12, 8, 4, 4))
        self._build_advanced(self.advanced)
        # Hidden values other code reads: the image (a developer's override, else the model decides) and the
        # locale defaults, always taken from this computer.
        self.bundled = bundle.find_bundle()
        self._var("image_mode", "local" if self.image_override else "bundled" if self.bundled else "latest")
        self._var("image_path", self.image_override)
        self._var("keymap", defaults.keymap())
        self._var("wifi_country", defaults.country(firstboot.ISO3166))

    def _build_advanced(self, adv):
        adv.columnconfigure(1, weight=1)
        self._err(adv, 0, "adv", column=0, columnspan=3)
        ttk.Label(adv, text="Time zone").grid(row=1, column=0, sticky="w", padx=4, pady=2)
        ttk.Combobox(adv, textvariable=self._var("timezone", defaults.timezone()), values=TIMEZONES
                     ).grid(row=1, column=1, sticky="we", padx=4, pady=2)
        ttk.Checkbutton(adv, text="Hidden Wi-Fi network", variable=self._var("wifi_hidden", False, tk.BooleanVar)
                        ).grid(row=2, column=1, sticky="w", padx=4)
        self._entry(adv, 3, "Static IP", "static_ip", width=20)
        ttk.Label(adv, text="e.g. 192.168.1.50/24; blank for DHCP", style="Hint.TLabel").grid(row=3, column=2, sticky="w")
        self._entry(adv, 4, "Gateway", "gateway", width=20)
        ttk.Label(adv, text="also used as the DNS server", style="Hint.TLabel").grid(row=4, column=2, sticky="w")
        ttk.Label(adv, text="Account").grid(row=5, column=0, sticky="w", padx=4, pady=2)
        account = ttk.Frame(adv)
        account.grid(row=5, column=1, columnspan=2, sticky="w")
        self.account_label = ttk.Label(account, text="", style="Mono.TLabel")
        self.account_label.pack(side="left", padx=4)
        self.account_btn = ttk.Button(account, text="Connect", command=self.toggle_account)
        self.account_btn.pack(side="left", padx=8)
        row6 = ttk.Frame(adv)
        row6.grid(row=6, column=1, columnspan=2, sticky="w")
        self._var("show_details", False, tk.BooleanVar)
        ttk.Checkbutton(row6, text="Show details", variable=self.v["show_details"], command=self._toggle_details
                        ).pack(side="left", padx=4, pady=4)
        self._var("dry_run", self.dry_run_default, tk.BooleanVar)
        if self.dry_run_default:  # a developer's --dry-run: the checkbox exists only then, never for the user
            ttk.Checkbutton(row6, text="Dry run (validate and resolve the image, do not write)",
                            variable=self.v["dry_run"]).pack(side="left", padx=8)
        self.details = ttk.Frame(adv)
        self.details.grid(row=7, column=0, columnspan=3, sticky="nsew", pady=(4, 4))
        self.details.grid_remove()
        adv.rowconfigure(7, weight=1)
        self.log_text = tk.Text(self.details, height=6, wrap="word", state="disabled", bg=GROUND, fg=BODY, bd=0,
                                highlightthickness=1, highlightbackground=PHOSPHOR, highlightcolor=PHOSPHOR,
                                insertbackground=PHOSPHOR, selectbackground=PHOSPHOR, selectforeground=GROUND,
                                font=(self.fonts["mono"], 9), padx=8, pady=6)
        sb = ttk.Scrollbar(self.details, orient="vertical", command=self.log_text.yview)
        self.log_text.configure(yscrollcommand=sb.set)
        sb.pack(side="right", fill="y")
        self.log_text.pack(side="left", fill="both", expand=True)
        ttk.Label(adv, text=f"Build: {build_info()}", style="Hint.TLabel", wraplength=520, justify="left"
                  ).grid(row=8, column=1, columnspan=2, sticky="w", padx=4)

    def _fit_to_screen(self):
        # Never taller than the work area (screen minus taskbar / menu bar); the window grows when Advanced opens.
        self.root.update_idletasks()
        self._size_to(max(self.root.winfo_reqwidth(), 700), max(self.root.winfo_reqheight(), 460))

    def _grow(self):
        """Advanced (and the details box) opened: make the window tall enough to show it all."""
        self.root.update_idletasks()
        need = self.root.winfo_reqheight()
        if need > self.root.winfo_height():
            self._size_to(self.root.winfo_width(), need)

    def _size_to(self, w: int, h: int):
        """Resize to w x h (client px) inside the work area: no taller than it, and moved up when the bottom
        would hang off the screen (Windows opens the window at a cascade position, then it grows)."""
        top, bottom = work_area(self.root)
        chrome = (self.root.winfo_rooty() - self.root.winfo_y() or 31) + 8  # title bar and bottom border
        h = min(h, bottom - top - chrome)
        pos = ""
        if self.root.winfo_viewable():  # before the first map there is no position to keep
            y = max(top, min(self.root.winfo_y(), bottom - h - chrome))
            pos = f"+{self.root.winfo_x()}+{y}"
        self.root.geometry(f"{w}x{h}{pos}")

    def _derive_id(self, *_):
        dev = firstboot.derive_device_id(self.v["name"].get())
        self.id_label.configure(text=f"device id (hostname): {dev}" if dev else "")

    def device_id(self) -> str:
        return firstboot.derive_device_id(self.v["name"].get())

    def _model_changed(self, *_):
        key = self.v["pi_model"].get()
        m = pimodel.get(key)
        if m.key != key:  # a bad flasher.json: back to the default, silently
            self.v["pi_model"].set(m.key)
            return
        self.model_box.current(pimodel.MODELS.index(m))
        self.model_hint.configure(text=m.hint)

    def _toggle_advanced(self):
        if self.advanced.winfo_manager():
            self.advanced.pack_forget()
        else:
            self.advanced.pack(fill="both", expand=True, after=self.adv_btn)
            self._grow()

    def _toggle_details(self):
        if self.v["show_details"].get():
            self.details.grid()
            self.log_text.see("end")
            self._grow()
        else:
            self.details.grid_remove()

    # ----- the account (device-code flow: the browser approves, this thread polls). Invisible in normal use: a
    # stored token is used silently, and FLASH connects first when there is none.
    def connected(self) -> bool:
        return bool(self.op["token"])

    def _show_account(self):
        """The Account row under Advanced: 'Connected as <name>' with Disconnect, or 'Not connected' with Connect."""
        if self.connected():
            self.account_label.configure(text=f"Connected as {self.op['username'] or 'operator'}")
            self.account_btn.configure(text="Disconnect", state="normal")
        else:
            self.account_label.configure(text="Not connected")
            self.account_btn.configure(text="Connect", state="normal")

    def toggle_account(self):
        if self.connected():
            self.disconnect()
        else:
            self.connect()

    def busy(self) -> bool:
        """A flash is running: the buttons that would start another action stay off until it ends."""
        return bool(self.worker and self.worker.is_alive())

    def connect(self, then=None):
        """Open the browser for approval; `then` runs on the Tk thread once the token is in hand (FLASH passes
        itself so the card is made with no further click). Cancel puts the UI back to Ready."""
        if self.busy():
            return
        self.account_btn.configure(state="disabled")
        self.flash_btn.configure(state="disabled")
        self.cancel_btn.grid()
        self.set_status(CONNECT_TEXT)
        self._signin_cancel = threading.Event()
        threading.Thread(target=self._connect_work, args=(self._signin_cancel, then), daemon=True).start()

    def _connect_work(self, cancel: threading.Event, then):
        """The sign-in thread. Every step checks `cancel`: a cancelled sign-in opens no browser, keeps no token
        and never fires `then`. A network hiccup while polling is retried until the code expires; only the
        console's own answer (denied, expired) ends the wait early."""
        url = self.console_url
        try:
            r = console.request_device_code(url, socket.gethostname())
        except console.ConsoleError as e:
            msg = f"Could not reach the console: {e}"
            self.post(lambda: self._connect_failed(msg))
            return
        if cancel.is_set():
            return
        link = f"{r['verification_url']}?code={urllib.parse.quote(r['user_code'])}"
        opened = console.same_site(url, r["verification_url"]) and self._open_browser(link)
        self.post(lambda: self._show_code(console.display_code(r["user_code"]), link, opened))
        deadline = time.monotonic() + r["expires_in"]
        while time.monotonic() < deadline and not cancel.is_set():
            time.sleep(r["interval"])
            if cancel.is_set():
                break
            try:
                tok = console.poll_device_token(url, r["device_code"])
            except console.Pending:
                continue
            except console.ConsoleError as e:
                if e.code is None or e.code >= 500:  # the network or the console hiccuped: keep polling
                    hiccup = f"Still waiting for the approval ({e})."
                    self.post(lambda: self.log(hiccup))
                    continue
                msg = f"Not approved: {e}"
                self.post(lambda: self._connect_failed(msg))
                return
            if not cancel.is_set():
                self.post(lambda: self._connected(url, tok, then))
            return
        if not cancel.is_set():
            self.post(lambda: self._connect_failed("The approval took too long (10 minutes). Press FLASH again."))

    @staticmethod
    def _open_browser(link: str) -> bool:
        try:
            return bool(webbrowser.open(link))
        except Exception:
            return False

    def _show_code(self, code: str, link: str, opened: bool):
        if opened:
            self.log(f"Browser opened at {link}: approve the sign-in there (code {code}).")
        else:
            self.log(f"Could not open a browser. Open {link} yourself and type the code {code}.")
            self.set_status(f"Open {link} in a browser and type the code {code}. Then the card is made "
                            "automatically.")

    def _connect_failed(self, msg: str):
        self.log(f"Connect failed: {msg}")
        self._connect_done()
        self.set_status(msg)

    def _connect_done(self):
        if not self.busy():  # a running flash keeps FLASH off and Cancel on until it ends
            self.flash_btn.configure(state="normal")
            self.cancel_btn.grid_remove()
        self._show_account()

    def _connected(self, url: str, tok: dict, then):
        self.op = {"token": tok["token"], "username": tok["username"]}  # in hand even if the file cannot be written
        try:
            warning = save_operator_config(url, tok["token"], tok["username"])
        except OSError as e:
            warning = f"WARNING: could not save the sign-in ({e}); it lasts until this program is closed."
        if warning:
            self.log(warning)
        self.log(f"Signed in as {tok['username'] or 'operator'}.")
        self._connect_done()
        self.set_status(READY_TEXT)
        if then:
            then()

    def cancel_connect(self):
        self._signin_cancel.set()
        self.log("Connect cancelled.")
        self._connect_done()
        self.set_status(READY_TEXT)

    def check_token(self):
        """A stored token is checked in the background against GET /api/operator/enrollment; 401 means the token
        was revoked, so it is forgotten and the next FLASH connects again. Nothing on the status line."""
        url, token = self.console_url, self.op["token"]

        def work():
            try:
                console.fetch_enrollment(url, token)
            except console.ConsoleError as e:
                if e.code == 401:
                    self.post(lambda: self._token_rejected(token))
                else:
                    msg = f"Console check failed ({e}); the stored sign-in is kept."
                    self.post(lambda: self.log(msg))
                return
            msg = f"Signed in as {self.op['username'] or 'operator'} (checked with the console)."
            self.post(lambda: self.log(msg))

        threading.Thread(target=work, daemon=True).start()

    def _token_rejected(self, token: str):
        """The console answered 401 for `token` (revoked): forget it, unless a newer sign-in replaced it meanwhile."""
        if self.op["token"] != token:
            return
        clear_operator_config()
        self.op = {"token": "", "username": ""}
        self._show_account()
        self.log("The stored sign-in was rejected by the console: FLASH connects again.")

    def disconnect(self):
        self._signin_cancel.set()
        clear_operator_config()
        self.op = {"token": "", "username": ""}
        self._show_account()
        self.log("Signed out. Revoke the token on the console's Settings page too if this computer changes hands.")

    def _apply_settings(self, s: dict):
        for k in SETTINGS_KEYS:
            if k in s and k in self.v:
                try:
                    self.v[k].set(s[k])
                except tk.TclError:
                    pass

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
    def refresh_disks(self):
        previous = self.selected_disk()  # read before the placeholder replaces the combobox text
        self.disk_box.set("Scanning...")

        def work():
            try:
                disks = disk.list_disks()
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

    # ----- Wi-Fi networks this computer sees (netsh / system_profiler, in a thread; the box stays editable)
    def refresh_networks(self):
        self.ssid_hint.configure(text=SCANNING_HINT)

        def work():
            nets, current = wifi.scan_networks(), wifi.current_ssid()
            self.post(lambda: self._show_networks(nets, current))

        threading.Thread(target=work, daemon=True).start()

    def _show_networks(self, nets, current):
        names = [n["ssid"] for n in nets]
        if current in names:
            names.remove(current)
            names.insert(0, current)
        self.ssid_box["values"] = names
        if names:
            hint = WIRED_HINT
        elif current:  # connected, yet nothing listed (Windows 11 hides scans from desktop apps without Location)
            hint = LOCATION_HINT
        else:
            hint = "type the network name"
        self.ssid_hint.configure(text=hint)

    def _ssid_picked(self, _event=None):
        ssid = self.v["ssid"].get()

        def work():
            pw = wifi.saved_password(ssid)  # None without a saved password on this computer; never logged
            if pw:
                self.post(lambda: self._fill_password(ssid, pw))

        threading.Thread(target=work, daemon=True).start()

    def _fill_password(self, ssid: str, pw: str):
        if self.v["ssid"].get() != ssid:  # the operator moved on while the lookup ran
            return
        self._setting_pw = True
        try:
            self.v["wifi_password"].set(pw)
        finally:
            self._setting_pw = False
        self.pw_hint.configure(text="password from this computer")

    def _password_edited(self, *_):
        if not getattr(self, "_setting_pw", False):
            self.pw_hint.configure(text="")

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
        """A technical line: the details box (under Advanced, Show details) and the log file. Never the status line."""
        self.log_text.configure(state="normal")
        self.log_text.insert("end", line.rstrip("\n") + "\n")
        self.log_text.see("end")
        self.log_text.configure(state="disabled")
        append_log(line)

    def set_status(self, text: str):
        """The one sentence the user reads. Clears the phase, so a late progress tick cannot overwrite it."""
        self._phase = ""
        self.status_label.configure(text=text)

    def set_phase(self, text: str):
        """A step the progress bar measures: 'Writing the card' becomes 'Writing the card (43%)...'."""
        self._phase = text
        self.status_label.configure(text=f"{text}...")

    def set_progress(self, pct, text=""):
        self.progress["value"] = max(0, min(100, pct))
        if self._phase:
            self.status_label.configure(text=f"{self._phase} ({self.progress['value']:.0f}%)...")

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
        if self.worker and self.worker.is_alive():
            self.cancel.set()
            self.log("Cancelling...")
            self.set_status("Stopping...")
        else:  # the browser approval is being awaited
            self.cancel_connect()

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
        if not cfg["enrollment_key"]:  # fetched at flash time with the sign-in (FLASH connects first if needed)
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
        if v["image_mode"] == "local":  # --image / FLASHER_IMAGE
            if not Path(v["image_path"]).is_file():
                problems.setdefault("flash", f"Image file not found: {v['image_path']}")
            else:
                try:
                    disk.check_image_magic(v["image_path"])
                except disk.DiskError as e:
                    problems.setdefault("flash", str(e))
        target = self.selected_disk()
        if not v["dry_run"]:  # a dry run never touches the card, so none is needed
            if not is_admin():
                problems.setdefault("flash", "Restart as administrator to write a card (dry run works without).")
            if target is None:
                problems["disk"] = "Choose the SD card to write."
            elif target["size"] == 0:
                problems["disk"] = "The selected reader has no card inserted."
            elif target["size"] > disk.MAX_CARD_BYTES:
                problems["disk"] = f"Refusing to write a disk larger than {disk.human_size(disk.MAX_CARD_BYTES)}."
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
        if self.busy():
            return
        v = self.validate()
        if not v:
            return
        if not v["enrollment_key"] and not self.connected():
            # First use on this computer: approve it in the browser, then the flash continues by itself.
            self.connect(then=self.on_flash)
            return
        if not v["dry_run"]:
            # Rescan so the confirmation names the disk as it is now (cards get swapped, numbers move).
            chosen = v["disk_info"]
            try:
                self._show_disks(disk.list_disks(), None)
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
                                       f"({disk.human_size(d['size'])})\n\nEverything on that card will be erased. "
                                       "Continue?", icon="warning", default=messagebox.NO):
                return
        save_settings(v)
        self.cancel.clear()
        self.flash_btn.configure(state="disabled")
        self.account_btn.configure(state="disabled")  # no Connect/Disconnect under a running flash
        self.cancel_btn.grid()
        self.set_progress(0, "")
        self.set_phase("Preparing")
        self.worker = threading.Thread(target=self._run_flash, args=(v,), daemon=True)
        self.worker.start()

    # ----- worker
    def _run_flash(self, v: dict):
        log = lambda s: self.post(lambda: self.log(s))
        status = lambda s: self.post(lambda: self.set_phase(s))
        try:
            run_flash(v, log, lambda pct, text: self.post(lambda: self.set_progress(pct, text)), self.cancel,
                      dry_run=v["dry_run"], status=status)
            if v["dry_run"]:
                self.post(lambda: self.set_status(DRY_RUN_TEXT))
            else:
                done = DONE_TEXT + f"\n\nDevice id: {v['device_id']}"
                self.post(lambda: self.set_status(DONE_TEXT))
                self.post(lambda: messagebox.showinfo(APP_TITLE, done))
        except (disk.Cancelled, imagefetch.Cancelled) as e:
            msg = f"Cancelled. {e}".rstrip()
            log(msg)
            self.post(lambda: self.set_status(msg))
        except ImageOffline as e:
            msg = str(e)
            log(f"FAILED: {msg}")
            self.post(lambda: (self._show_error("pi_model", msg), self.set_status("Could not get the image.")))
        except console.ConsoleError as e:
            msg = str(e)
            log(f"FAILED: {msg}")
            if e.code == 401:  # the sign-in was revoked on the console: the next FLASH connects again
                token = v.get("operator_token") or ""
                self.post(lambda: (self._token_rejected(token),
                                   self.set_status("The console no longer accepts this computer's sign-in. "
                                                   "Press FLASH to approve it again.")))
            else:
                self.post(lambda: self.set_status(f"Failed: {msg.splitlines()[0]}"))
                self.post(lambda: messagebox.showerror(APP_TITLE, msg))
        except Exception as e:
            msg = str(e)  # bound now: the except variable is gone by the time the Tk thread runs the lambda
            if "[5]" in msg:
                msg += ("\n\nWindows refused to write to the card (access denied). Check the write-protect switch "
                        "on the adapter, close Explorer windows showing the card, then flash again.")
            log(f"FAILED: {msg}")
            self.post(lambda: self.set_status(f"Failed: {msg.splitlines()[0]}"))
            self.post(lambda: messagebox.showerror(APP_TITLE, msg))
        finally:
            self.post(self._finished)

    def _finished(self):
        self.flash_btn.configure(state="normal")
        self.cancel_btn.grid_remove()
        self._show_account()  # Connect/Disconnect come back
        self._password = secrets.token_urlsafe(24)  # never reuse a Pi password across cards


# ---------------------------------------------------------------- flash sequence (no widgets here)

DONE_TEXT = "Done. Put the card in the Pi and turn it on. It shows up on the Devices page in a few minutes."


class ImageOffline(imagefetch.FetchError):
    """An armhf model's 32-bit image could not be fetched: shown under the model row, not in a dialog."""


def card_cfg(v: dict) -> dict:
    """The firstboot config for the form values (validate_cfg's input)."""
    cfg = {k: v[k] for k in ("device_id", "name", "username", "password", "ssid", "wifi_password", "wifi_hidden",
                              "timezone", "keymap", "enrollment_key", "static_ip", "gateway")}
    cfg["ssh"] = True
    cfg["ssh_pubkey"] = v.get("ssh_pubkey") or ""
    cfg["ethernet_only"] = not v["ssid"]  # blank Wi-Fi fields: a wired Pi
    cfg["wifi_country"] = v["wifi_country"].strip().upper()
    cfg["console_url"] = v["console_url"].strip().rstrip("/")
    cfg["token"] = (v.get("token") or "").strip()  # an existing device token bypasses enrollment (no widget)
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


def run_flash(v: dict, log, progress, cancel: threading.Event, dry_run: bool = False, status=lambda s: None):
    """The flash sequence. Contacts the console only for the enrollment key (the Pi enrolls itself on first
    boot); dry_run stops after image resolution, before any disk access. `status` gets the plain-words step the
    progress callbacks measure ("Writing the card"); `log` gets every technical line."""
    d = v["disk_info"]
    cfg = card_cfg(v)
    fetch_key(cfg, v.get("operator_token") or "", log)
    problems = firstboot.validate_cfg(cfg)
    if problems:  # checked before anything is written
        raise ValueError(" ".join(problems))

    # 1. first-boot files
    model = pimodel.get(v.get("pi_model"))
    log(f"Pi model: {model.label} ({model.arch}).")
    log(f"Console {cfg['console_url']}: {console_mode(cfg)}.")
    firstrun = firstboot.render_firstrun(cfg)
    provision = firstboot.render_provision(cfg)
    archive = player_archive()
    log(f"Player files for the card: {len(archive) / 1e3:.0f} kB ({build_info()}).")

    # 2. image
    image, sha256 = obtain_image(v, log, progress, cancel, dry_run, status)
    if cancel.is_set():
        raise disk.Cancelled()
    if dry_run:
        target = f"Disk {d['number']} ({d['name']})" if d else "the selected card (none chosen)"
        log(f"Dry run: would write {disk.source_name(image)} to {target}. Nothing was written.")
        return
    disk.check_image_magic(image)
    size = disk.image_size(image)
    if size > d["size"]:
        raise disk.DiskError(f"{disk.source_name(image)} is larger than the card "
                             f"({disk.human_size(size)} > {disk.human_size(d['size'])}); nothing was written")

    # 3-5. identity check, clear, write, verify
    log(f"Checking disk {d['number']} is still {d['name']} ({disk.human_size(d['size'])}) ...")
    disk.check_disk(d)
    if cancel.is_set():
        raise disk.Cancelled()
    try:
        log(f"Clearing disk {d['number']} (unmount, old partition table) ...")
        disk.clear_disk(d["number"], d.get("unique_id", ""))
        log(f"Writing {disk.source_name(image)} to disk {d['number']} ...")
        status("Writing the card")
        with disk.open_physical_drive(d["number"], expect_size=d["size"]) as drive:
            if cancel.is_set():  # pressed while the card was opened (macOS: during the password prompt)
                raise disk.Cancelled()
            drive.lock(disk.volume_paths(d["number"]))
            start = time.monotonic()

            def on_write(written, consumed, total):
                pct = consumed * 100 / total if total else 0
                rate = written / max(time.monotonic() - start, 1e-6) / 1e6
                progress(pct, f"{written / 1e6:.0f} MB written, {rate:.1f} MB/s")

            written = disk.write_image(image, drive, on_write, cancel, limit=d["size"],
                                       sector=d.get("sector") or disk.SECTOR, expected_sha256=sha256)
            drive.flush()
            # The partition table is still blank, so the OS cannot mount (and scribble on) anything
            # while the card is read back. It is written and checked last by commit_head().
            log(f"Wrote {written / 1e6:.0f} MB. Reading the whole card back to verify ...")
            status("Checking the card")

            def on_verify(checked, consumed, total):
                progress(consumed * 100 / total if total else 0, f"verified {checked / 1e6:.0f} MB")

            if not disk.verify_image(image, drive, on_verify, cancel, skip=disk.DEFER_FIRST_BYTES):
                raise disk.DiskError("read-back verification failed: the card did not store what was written "
                                     "(worn or counterfeit card?)")
            drive.commit_head()
            drive.refresh_partitions()
    except disk.Cancelled:
        raise disk.Cancelled("The card is NOT usable; flash it again.")
    progress(100, "written and verified")

    # 6-7. boot volume and first-boot files
    status("Finishing the card")
    try:
        log("Waiting for the boot partition to mount ...")
        mount = disk.find_boot_volume(d["number"], cancel_event=cancel, log=log)  # 'E:/' or '/Volumes/bootfs'
        boot = Path(mount)
        log(f"Boot partition is {mount}")
        if cancel.is_set():
            raise disk.Cancelled()
        write_firstboot_files(boot, firstrun, provision, archive)
    except disk.Cancelled:
        raise disk.Cancelled("The image is on the card but the first-boot files are NOT; "
                             "the card will not enroll. Flash it again.")
    except PermissionError as e:
        if host.FILES_DENIED_HINT:
            raise disk.DiskError(f"{e}\n\n{host.FILES_DENIED_HINT}") from e
        raise disk.DiskError(f"{e}\n\nThe image was written but the first-boot files were NOT: this card "
                             "will not enroll. Re-insert it and Flash again.") from e
    except Exception as e:
        raise disk.DiskError(f"{e}\n\nThe image was written but the first-boot files were NOT: this card "
                             "will not enroll. Re-insert it and Flash again.") from e
    log("First-boot files written. Ejecting ...")
    try:
        disk.eject(mount)
    except Exception as e:
        log(f"Eject failed ({e}); eject the card yourself before pulling it out.")

    # 8. summary
    log("")
    log("SUMMARY")
    log(f"  Device: {cfg['name'].strip()} ({cfg['device_id']}), hostname {cfg['device_id']}")
    net = "Ethernet" if cfg["ethernet_only"] else f"Wi-Fi {cfg['ssid']} ({cfg['wifi_country']})"
    log(f"  Network: {net}" + (f", static IP {cfg['static_ip']} via {cfg['gateway']}" if cfg["static_ip"] else ", DHCP"))
    log(f"  Login: ssh {cfg['username']}@{cfg['device_id']}.local with the key {sshkey.private_path()} "
        "(password login is off)" if cfg["ssh_pubkey"] else f"  Login: {cfg['username']} (no SSH key on the card)")
    log(f"  Console: {cfg['console_url']} ({console_mode(cfg)})")
    log(f"  Pi model: {model.label} ({model.arch})")
    log(f"  Image: {disk.source_name(image)}" + (" (bundled in this program)" if isinstance(image, bundle.BundledImage)
                                                 else ""))
    log("  The Pi needs internet access on its first boot (apt and pip). Progress is logged on the Pi in")
    log("  /var/log/projection5000-provision.log; firstrun.log and firstrun.ok appear on the boot partition.")
    log("  A card that never booted still carries the enrollment key: keep it safe or rotate the key on the console.")
    log("")
    log(DONE_TEXT)
    log(f"Device id: {cfg['device_id']}")


def obtain_image(v: dict, log, progress, cancel, dry_run: bool = False, status=lambda s: None) -> tuple:
    """Returns (image source, expected_sha256 or ''): a path, or the BundledImage inside this exe.
    The Pi model's arch decides: arm64 models take the bundled image, armhf models the 32-bit download (a
    bundled 64-bit image cannot boot them). A local file is used as given."""
    model = pimodel.get(v.get("pi_model"))
    other = "armhf" if model.arch == "arm64" else "arm64"
    mode = v["image_mode"]
    if mode == "local":
        log(f"Using local image {v['image_path']}")
        if other in Path(v["image_path"]).name.lower():
            log(f"WARNING: that file name says {other}, but {model.label} needs an {model.arch} image.")
        return v["image_path"], ""
    if mode == "bundled" and model.arch == "armhf":
        log(f"{model.label} needs the 32-bit image; the bundled 64-bit image is skipped.")
        mode = "latest"
    if mode == "bundled":
        b = bundle.find_bundle()
        if b is None:
            raise imagefetch.FetchError("this build carries no bundled image; choose another image source")
        log(f"Using bundled image {b.name} ({disk.human_size(b.length)} compressed, sha256 {b.sha256[:12]}...)")
        return b, b.sha256
    bits = "64-bit" if model.arch == "arm64" else "32-bit"
    try:
        log(f"Resolving latest Raspberry Pi OS Lite ({bits}) ...")
        try:
            url, name = imagefetch.resolve_latest(imagefetch.LATEST_URLS[model.arch])
            expected = imagefetch.fetch_sha256(url)
        except imagefetch.FetchError as e:
            # Offline: the image downloaded last time (its sha256 was kept alongside) still serves.
            cached = imagefetch.newest_cached(model.arch)
            if cached is None:
                raise
            dest, expected = cached
            log(f"Could not reach raspberrypi.com ({e}); checking the cached {dest.name} ...")
            if not imagefetch.verify_sha256(dest, expected):
                raise imagefetch.FetchError(f"the cached {dest.name} is corrupt; connect to the internet") from e
            log("Cached image is valid (offline).")
            return str(dest), expected
        dest = imagefetch.cached_path(name)
        if dest.exists():
            log(f"Checking cached {name} ...")
            if imagefetch.verify_sha256(dest, expected):
                log("Cached image is valid.")
                imagefetch.remember_sha256(dest, expected)
                return str(dest), expected
            log("Cached image is stale or corrupt, downloading again.")
        if dry_run:
            log(f"Dry run: would download {url}")
            return str(dest), expected
        size = imagefetch.remote_size(url)
        size = f" ({size / 1e6:.0f} MB)" if size else ""
        if model.arch == "armhf":
            log(f"{model.label} needs the 32-bit image; downloading {name}{size}")
        else:
            log(f"Downloading {name}{size} ...")
        status(f"Getting the {bits} image")

        def on_dl(done, total, rate):
            pct = done * 100 / total if total else 0
            progress(pct, f"downloading {done / 1e6:.0f} MB, {rate / 1e6:.1f} MB/s")

        imagefetch.download(url, dest, on_dl, cancel)
    except imagefetch.FetchError as e:
        if model.arch == "armhf":  # the default flow for these models; say it in plain words under the row
            log(f"Could not fetch the 32-bit image: {e}")
            raise ImageOffline(OFFLINE_TEXT) from e
        raise
    log("Verifying download ...")
    if not imagefetch.verify_sha256(dest, expected):
        dest.unlink(missing_ok=True)
        raise imagefetch.FetchError("downloaded image failed sha256 verification")
    log("Download verified.")
    imagefetch.remember_sha256(dest, expected)  # so the next flash can use it offline
    return str(dest), expected


def write_firstboot_files(boot: Path, firstrun: str, provision: str, archive: bytes = b"") -> None:
    cmdline = boot / "cmdline.txt"
    if not cmdline.is_file():
        raise disk.DiskError(f"cmdline.txt not found on the boot partition {boot}: is this a Raspberry Pi OS image?")
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
        f"https roots: {host.ssl_context().cert_store_stats()['x509_ca']}",
        "pi models (key, image arch, label; the armhf image is downloaded once):", pimodel.table(),
        f"defaults from {host.NAME}: timezone {defaults.timezone()}, keymap {defaults.keymap()}, "
        f"country {defaults.country(firstboot.ISO3166)}, ssh key {sshkey.private_path()}",
        "=== firstrun.sh ===", firstboot.render_firstrun(cfg),
        "=== projection5000-provision.sh ===", firstboot.render_provision(cfg),
        "=== cmdline.txt ===", firstboot.patch_cmdline("console=tty1 root=PARTUUID=x rootfstype=ext4 rootwait\n"),
    ])
    if getattr(sys, "frozen", False):
        # A windowed program has no console: print when launched from one (the host attaches it), and also
        # leave the output next to the program (or in the data folder).
        host.attach_console()
        for out in host.selfcheck_paths():
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


def image_arg(argv, env=None) -> str:
    """Developers only: --image <path> (else the FLASHER_IMAGE environment variable) writes that .img / .img.xz
    instead of the Pi model's image. Empty for everyone else."""
    if "--image" in argv[:-1]:
        return argv[argv.index("--image") + 1].strip()
    return (os.environ if env is None else env).get("FLASHER_IMAGE", "").strip()


def main(argv=None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    if "--selfcheck" in argv:
        return selfcheck()
    dry_run = "--dry-run" in argv
    image = image_arg(argv)
    # A dry run never opens the disk, so it does not need (or ask for) elevation. The elevated copy gets the
    # same arguments, plus --image for a FLASHER_IMAGE it would not inherit.
    carry = list(argv) + (["--image", image] if image and "--image" not in argv else [])
    if not dry_run and not ensure_admin(carry):
        return 1
    host.set_dpi_aware()
    load_fonts()  # before any widget: Tk enumerates the families when it starts
    root = tk.Tk()
    App(root, dry_run=dry_run, image=image)
    root.mainloop()
    return 0


if __name__ == "__main__":
    sys.exit(main())
