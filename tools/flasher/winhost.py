"""What the flasher needs from Windows itself (machost.py is the macOS twin; sysplat.py picks one).

Folders (%LOCALAPPDATA% / %APPDATA%), elevation (UAC), the DPAPI-protected sign-in token, the private font
registration (gdi32), the work area, the window icon, the owner-only ACL on the SSH key (icacls) and the
frozen exe's console. Every function is safe to call from a non-elevated process; nothing here touches a disk.
"""
import base64
import ctypes
import os
import ssl
import subprocess
import sys
from pathlib import Path

NAME = "Windows"
SIGNIN_FILE = "flasher.json"  # in config_dir(): the sign-in (%APPDATA%, apart from the settings in %LOCALAPPDATA%)
# What to say when the boot files could not be written for lack of permission ('' : nothing platform-specific).
FILES_DENIED_HINT = ""
# Tk font families used when a bundled face did not register.
FALLBACK_FONTS = {"display": "Consolas", "mono": "Consolas", "sans": "Segoe UI"}
# Shown under the network box when this PC is connected to Wi-Fi but the scan comes back empty:
# Windows 11 hides scan results from desktop apps while Location access is off.
NO_SCAN_HINT = "turn on Location in Windows Settings to list networks"
FR_PRIVATE = 0x10  # gdi32: visible to this process only, never installed
SEAL_NAME = "DPAPI"  # named in the warning when the token cannot be protected


# ---------------------------------------------------------------- folders

def data_dir() -> Path:
    """%LOCALAPPDATA%\\Projection5000: settings, the technical log, cached images."""
    base = os.environ.get("LOCALAPPDATA") or str(Path.home())
    return Path(base) / "Projection5000"


def config_dir() -> Path:
    """%APPDATA%\\Projection5000: the sign-in and the SSH key (roams with the user profile)."""
    base = os.environ.get("APPDATA") or str(Path.home())
    return Path(base) / "Projection5000"


# ---------------------------------------------------------------- elevation

def ssl_context() -> ssl.SSLContext:
    """Python on Windows reads the roots from the Windows certificate store: the default context is enough."""
    ctx = ssl.create_default_context()
    ctx.set_alpn_protocols(["http/1.1"])  # what http.client would have set on a context of its own
    return ctx


def is_admin() -> bool:
    """True when raw disk writes are possible in this process (elevated)."""
    try:
        return bool(ctypes.windll.shell32.IsUserAnAdmin())
    except Exception:
        return False


def relaunch_elevated(argv=()) -> bool:
    """ShellExecuteW 'runas' this program with --elevated plus the original arguments (--image and friends;
    the elevated copy does not inherit this process's environment, so nothing may be left to it).
    False when the UAC prompt was declined."""
    args = " ".join(f'"{a}"' for a in ("--elevated", *argv))
    if getattr(sys, "frozen", False):
        exe, params = sys.executable, args
    else:
        exe, params = sys.executable, f'"{os.path.abspath(sys.argv[0])}" {args}'
    # Values <= 32 are errors (5 = SE_ERR_ACCESSDENIED: the user declined the UAC prompt).
    rc = ctypes.windll.shell32.ShellExecuteW(None, "runas", exe, params, None, 1)
    return rc > 32


# ---------------------------------------------------------------- the sign-in token (DPAPI)

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


def seal_token(token: str) -> dict:
    """The fields that carry the token in the operator config: a base64 DPAPI blob. Raises when DPAPI is
    unavailable (the caller then stores it in plain text with a warning)."""
    return {"token": base64.b64encode(_dpapi(token.encode("utf-8"), protect=True)).decode("ascii"),
            "token_dpapi": True}


def open_token(d: dict) -> str:
    """The token from those fields; '' when it cannot be read (a blob from another account, a damaged file)."""
    tok = d.get("token")
    if not isinstance(tok, str) or not tok:
        return ""
    if d.get("token_dpapi"):
        try:
            tok = _dpapi(base64.b64decode(tok), protect=False).decode("utf-8")
        except Exception:
            return ""
    return tok.strip()


def forget_token(d: dict) -> None:
    """Nothing to do beyond deleting the file: the blob lives in it."""


# ---------------------------------------------------------------- fonts, window, DPI

def load_fonts(paths) -> list:
    """Register TTFs for this process only (AddFontResourceExW FR_PRIVATE). Returns the names that loaded."""
    loaded = []
    for path in paths:
        try:
            if ctypes.windll.gdi32.AddFontResourceExW(str(path), FR_PRIVATE, 0):
                loaded.append(Path(path).name)
        except Exception:
            pass
    return loaded


def work_area(root) -> tuple:
    """(top, bottom) of the work area in px: the screen without the taskbar. The whole screen on failure."""
    try:
        r = (ctypes.c_long * 4)()
        if ctypes.windll.user32.SystemParametersInfoW(0x30, 0, r, 0):  # SPI_GETWORKAREA
            return r[1], r[3]
    except (AttributeError, OSError):
        pass
    return 0, root.winfo_screenheight()


def set_window_icon(root, ico_path) -> None:
    import tkinter as tk
    try:
        root.iconbitmap(str(ico_path))
    except tk.TclError:
        pass


def dark_title_bar(root) -> None:
    """The title bar in the app's black with white text (Windows 11: DWMWA_CAPTION_COLOR / TEXT_COLOR), or at
    least the dark theme (Windows 10 20H1+; attribute 19 on the 1809 builds). Best effort."""
    try:
        root.update_idletasks()
        hwnd = ctypes.windll.user32.GetParent(root.winfo_id())
        dwm = ctypes.windll.dwmapi.DwmSetWindowAttribute
        for attr in (20, 19):  # DWMWA_USE_IMMERSIVE_DARK_MODE, and its pre-20H1 number
            if dwm(hwnd, attr, ctypes.byref(ctypes.c_int(1)), 4) == 0:
                break
        dwm(hwnd, 34, ctypes.byref(ctypes.c_int(0x000000)), 4)  # DWMWA_BORDER_COLOR: black, not the accent
        dwm(hwnd, 35, ctypes.byref(ctypes.c_int(0x000000)), 4)  # DWMWA_CAPTION_COLOR: black (COLORREF)
        dwm(hwnd, 36, ctypes.byref(ctypes.c_int(0xFFFFFF)), 4)  # DWMWA_TEXT_COLOR: white
    except Exception:
        pass


def set_dpi_aware() -> None:
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(1)  # crisp text on high-DPI screens
    except Exception:
        pass


# ---------------------------------------------------------------- the SSH key file

def restrict_file(path) -> str:
    """Owner-only ACL through icacls (the file is created by the elevated flasher, read by the user's ssh.exe).
    Returns '' or a warning; a failed icacls is not fatal (ssh.exe then says which file to fix)."""
    user = os.environ.get("USERNAME") or os.getlogin()
    try:
        r = subprocess.run(["icacls", str(path), "/inheritance:r", "/grant:r", f"{user}:F"], capture_output=True,
                           text=True, timeout=30, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    except (OSError, subprocess.SubprocessError) as e:
        return f"WARNING: could not restrict the ACL of {path} ({e}); ssh may refuse the key until you do."
    if r.returncode:
        return f"WARNING: icacls failed on {path}: {(r.stderr or r.stdout).strip()}"
    return ""


# ---------------------------------------------------------------- the frozen exe's console (--selfcheck)

def attach_console() -> bool:
    """A --windowed exe has no console: attach the parent's when it was started from one (AttachConsole)."""
    try:
        if ctypes.windll.kernel32.AttachConsole(-1):
            sys.stdout = open("CONOUT$", "w", encoding="utf-8")
            return True
    except Exception:
        pass
    return False


def selfcheck_paths() -> list:
    """Where the frozen exe leaves selfcheck.txt: next to the exe, else in the data folder."""
    return [Path(sys.executable).with_name("selfcheck.txt"), data_dir() / "selfcheck.txt"]
