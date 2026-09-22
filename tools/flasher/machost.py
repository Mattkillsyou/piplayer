"""What the flasher needs from macOS itself (winhost.py is the Windows twin; sysplat.py picks one).

Folders (~/Library/Application Support/Projection5000), no elevation (authopen asks for the password per
flash, see macdisk.py), the sign-in token in the login keychain (`security`), the bundled fonts registered
for this process through CoreText (ctypes, no pyobjc), the work area under the menu bar, the 0600 SSH key
and where the .app leaves selfcheck.txt. Stdlib only; every subprocess is the `security` tool.
"""
import ctypes
import ctypes.util
import functools
import os
import re
import ssl
import subprocess
import sys
from pathlib import Path

NAME = "macOS"
SIGNIN_FILE = "signin.json"  # in config_dir(), which is the settings folder too: not flasher.json (the form)
FILES_DENIED_HINT = ("macOS did not let the flasher write to the card. Open System Settings, Privacy & Security, "
                     "Files and Folders, allow Projection5000 SD Flasher to access Removable Volumes, then flash again.")
FALLBACK_FONTS = {"display": "Menlo", "mono": "Menlo", "sans": "Helvetica Neue"}
# system_profiler needs no Location permission, so an empty scan just means: nothing in range.
NO_SCAN_HINT = "type the network name"
SEAL_NAME = "the keychain"
SECURITY = "/usr/bin/security"
KEYCHAIN_SERVICE = "Matt Brown's Projection5000"
KEYCHAIN_ACCOUNT = "operator"
MENU_BAR = 25  # px; Tk cannot ask AppKit for the visible frame without pyobjc
TIMEOUT = 60  # s; the keychain may put up an Allow/Deny prompt
# Where macOS keeps the roots it trusts: Apple's own, then whatever an admin added.
SYSTEM_KEYCHAINS = ("/System/Library/Keychains/SystemRootCertificates.keychain", "/Library/Keychains/System.keychain")


class HostError(Exception):
    pass


# ---------------------------------------------------------------- folders

def data_dir() -> Path:
    """~/Library/Application Support/Projection5000: settings, the technical log, cached images, the SSH key."""
    return Path.home() / "Library" / "Application Support" / "Projection5000"


def config_dir() -> Path:
    """Same folder: macOS has no roaming/local split (the token itself is in the keychain, not in a file)."""
    return data_dir()


# ---------------------------------------------------------------- elevation: none needed

def is_admin() -> bool:
    """Always True: the card is opened root-only through authopen, which shows the standard password prompt
    once per flash. Nothing is relaunched."""
    return True


def relaunch_elevated(argv=()) -> bool:
    return False


# ---------------------------------------------------------------- https

@functools.lru_cache(maxsize=None)
def ssl_context() -> ssl.SSLContext:
    """The default context plus the roots this Mac trusts. The Python inside the .app brings its own OpenSSL,
    which looks for a certificate file where the build machine kept one; on any other Mac there is none, so it
    trusts nothing and every https:// URL fails with CERTIFICATE_VERIFY_FAILED. `security` prints the system
    keychains as PEM; one certificate it cannot parse must not take the rest down. Everything in them is trusted,
    including roots macOS itself has marked as not trusted: the flasher only ever talks to the console and
    the Raspberry Pi download site. A certificate added only to the login keychain is not seen."""
    ctx = ssl.create_default_context()
    ctx.set_alpn_protocols(["http/1.1"])  # what http.client would have set on a context of its own
    for keychain in SYSTEM_KEYCHAINS:
        try:
            pem = _security("find-certificate", "-a", "-p", keychain, timeout=30).stdout
        except (OSError, subprocess.SubprocessError):
            continue
        for cert in re.findall(r"-----BEGIN CERTIFICATE-----.*?-----END CERTIFICATE-----", pem, re.S):
            try:
                ctx.load_verify_locations(cadata=cert)
            except ssl.SSLError:
                pass
    return ctx


# ---------------------------------------------------------------- the sign-in token (login keychain)

def _security(*args, timeout: int = TIMEOUT) -> subprocess.CompletedProcess:
    return subprocess.run([SECURITY, *args], capture_output=True, text=True, timeout=timeout,
                          stdin=subprocess.DEVNULL)


def seal_token(token: str) -> dict:
    """Store the token as a generic password in the login keychain (-U replaces an earlier one). The config
    file then carries no secret. Raises HostError when `security` refuses (the caller falls back to plain text
    with a warning)."""
    try:
        r = _security("add-generic-password", "-U", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT, "-w", token)
    except (OSError, subprocess.SubprocessError) as e:
        raise HostError(str(e)) from e
    if r.returncode:
        raise HostError((r.stderr or r.stdout).strip() or f"security exit {r.returncode}")
    return {"token": "", "token_keychain": True}


def open_token(d: dict) -> str:
    """The token from the keychain when the config says it lives there, else the plain-text field; '' when the
    keychain has none or the user denied access."""
    if not d.get("token_keychain"):
        tok = d.get("token")
        return tok.strip() if isinstance(tok, str) else ""
    try:
        r = _security("find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT, "-w")
    except (OSError, subprocess.SubprocessError):
        return ""
    return r.stdout.strip() if r.returncode == 0 else ""


def forget_token(d: dict) -> None:
    """Sign out: delete the keychain item (a missing one is fine)."""
    if not d.get("token_keychain"):
        return
    try:
        _security("delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT)
    except (OSError, subprocess.SubprocessError):
        pass


# ---------------------------------------------------------------- fonts (CoreText, process scope)

kCFStringEncodingUTF8 = 0x08000100
kCFURLPOSIXPathStyle = 0
kCTFontManagerScopeProcess = 1


def _frameworks():
    cf = ctypes.CDLL(ctypes.util.find_library("CoreFoundation") or
                     "/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation")
    ct = ctypes.CDLL(ctypes.util.find_library("CoreText") or
                     "/System/Library/Frameworks/CoreText.framework/CoreText")
    cf.CFStringCreateWithCString.restype = ctypes.c_void_p
    cf.CFStringCreateWithCString.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_uint32]
    cf.CFURLCreateWithFileSystemPath.restype = ctypes.c_void_p
    cf.CFURLCreateWithFileSystemPath.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_long, ctypes.c_bool]
    cf.CFRelease.argtypes = [ctypes.c_void_p]
    ct.CTFontManagerRegisterFontsForURL.restype = ctypes.c_bool
    ct.CTFontManagerRegisterFontsForURL.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.c_void_p]
    return cf, ct


def load_fonts(paths) -> list:
    """Register TTFs for this process only (CTFontManagerRegisterFontsForURL, kCTFontManagerScopeProcess: nothing
    is installed). Returns the names that loaded; a failure only means the fallback families."""
    loaded = []
    try:
        cf, ct = _frameworks()
    except (OSError, AttributeError):
        return loaded
    for path in paths:
        try:
            s = cf.CFStringCreateWithCString(None, os.fsencode(str(path)), kCFStringEncodingUTF8)
            url = cf.CFURLCreateWithFileSystemPath(None, s, kCFURLPOSIXPathStyle, False)
            error = ctypes.c_void_p()
            ok = ct.CTFontManagerRegisterFontsForURL(url, kCTFontManagerScopeProcess, ctypes.byref(error))
            if error.value:
                cf.CFRelease(error.value)
            cf.CFRelease(url)
            cf.CFRelease(s)
            if ok:
                loaded.append(Path(path).name)
        except Exception:
            pass
    return loaded


def work_area(root) -> tuple:
    """(top, bottom): the screen under the menu bar. The Dock is not subtracted (it may be hidden or on a side)."""
    return MENU_BAR, root.winfo_screenheight()


def set_window_icon(root, ico_path) -> None:
    """Nothing: the .app bundle carries the icon (iconbitmap cannot read .ico on macOS)."""


def dark_title_bar(root) -> None:
    """Nothing: macOS draws the title bar in the system appearance."""


def set_dpi_aware() -> None:
    """Nothing: NSHighResolutionCapable in the .app's Info.plist does it."""


# ---------------------------------------------------------------- the SSH key file

def restrict_file(path) -> str:
    """Owner-only (0600), what ssh demands before it uses a private key. Returns '' or a warning."""
    try:
        os.chmod(path, 0o600)
    except OSError as e:
        return f"WARNING: could not make {path} owner-only ({e}); ssh may refuse the key until you do."
    return ""


# ---------------------------------------------------------------- selfcheck output (the .app has no terminal)

def attach_console() -> bool:
    """stdout already works when the .app was started from a terminal; nothing to attach."""
    return sys.stdout is not None


def selfcheck_paths() -> list:
    """Next to the .app bundle (dist/selfcheck.txt for build_mac.sh), else in the data folder."""
    exe = Path(sys.executable)
    beside = exe.parents[3] if exe.parent.name == "MacOS" and len(exe.parents) > 3 else exe.parent
    return [beside / "selfcheck.txt", data_dir() / "selfcheck.txt"]
