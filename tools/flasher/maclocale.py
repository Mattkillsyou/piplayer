"""Defaults for the card taken from this Mac: timezone (IANA), keyboard layout, Wi-Fi country
(winlocale.py is the Windows twin; sysplat.py picks one).

Every function has the same safe fallback as on Windows (America/Los_Angeles, us, US) and never raises; the
Advanced section of the flasher lets the operator override the time zone.
"""
import os
import re
import subprocess

DEFAULTS = "/usr/bin/defaults"
LOCALTIME = "/etc/localtime"
ZONEINFO = "zoneinfo/"  # /etc/localtime -> /var/db/timezone/zoneinfo/Area/City
TIMEZONE_RE = re.compile(r"UTC|[A-Za-z_]+(/[A-Za-z0-9_+-]+){1,2}")
# com.apple.keylayout.<Name> -> Pi OS keymap (raspi-config / imager_custom set_keymap).
LAYOUT_KEYMAP = {"us": "us", "abc": "us", "usextended": "us", "usinternational-pc": "us", "australian": "us",
                 "british": "gb", "british-pc": "gb", "irish": "ie", "irishextended": "ie",
                 "german": "de", "austrian": "at", "swissgerman": "ch", "swissfrench": "ch",
                 "french": "fr", "french-pc": "fr", "french-numerical": "fr",
                 "canadian": "us", "canadian-csa": "ca", "canadianfrench": "ca", "canadianfrench-pc": "ca",
                 "canadian-french": "ca", "canadianfrench-csa": "ca",  # Apple's "Canadian" is Canadian English
                 "belgian": "be", "latinamerican": "latam",
                 "spanish": "es", "spanish-iso": "es", "italian": "it", "italian-pro": "it", "dutch": "nl",
                 "swedish": "se", "swedish-pro": "se", "norwegian": "no", "danish": "dk", "finnish": "fi",
                 "portuguese": "pt", "brazilian": "br", "brazilian-pro": "br", "polish": "pl", "polishpro": "pl",
                 "czech": "cz", "czech-qwerty": "cz", "russian": "ru", "russian-pc": "ru", "hungarian": "hu",
                 "turkish": "tr", "turkish-qwerty-pc": "tr"}
DEFAULT_TIMEZONE = "America/Los_Angeles"
DEFAULT_KEYMAP = "us"
DEFAULT_COUNTRY = "US"


def _defaults(*args) -> str:
    """stdout of `defaults read ...`, '' on any failure (a missing key exits 1)."""
    try:
        p = subprocess.run([DEFAULTS, "read", *args], capture_output=True, timeout=15, stdin=subprocess.DEVNULL)
    except (OSError, subprocess.SubprocessError):
        return ""
    return p.stdout.decode("utf-8", "replace").strip() if p.returncode == 0 else ""


def localtime_target() -> str:
    """Where /etc/localtime points ('' when it is not a link or unreadable)."""
    try:
        return os.readlink(LOCALTIME)
    except OSError:
        return ""


def timezone(target: str = None) -> str:
    """The IANA name from the /etc/localtime link (…/zoneinfo/America/Los_Angeles), else the default."""
    t = localtime_target() if target is None else target
    name = t.split(ZONEINFO, 1)[1] if ZONEINFO in t else ""
    return name if TIMEZONE_RE.fullmatch(name) else DEFAULT_TIMEZONE


def keyboard_layout_id() -> str:
    """The current keyboard layout's input source id (com.apple.keylayout.British), '' when unavailable."""
    return _defaults("com.apple.HIToolbox", "AppleCurrentKeyboardLayoutInputSourceID")


def keymap(layout_id: str = None) -> str:
    lid = keyboard_layout_id() if layout_id is None else layout_id
    name = lid.rsplit(".", 1)[-1].strip().lower() if lid else ""
    return LAYOUT_KEYMAP.get(name, DEFAULT_KEYMAP)


def apple_locale() -> str:
    """`defaults read -g AppleLocale`: en_US, en_GB, de_DE, zh-Hant_TW ... ('' when unavailable)."""
    return _defaults("-g", "AppleLocale")


def country(valid=None, locale: str = None) -> str:
    """ISO 3166 alpha-2 from the AppleLocale region, DEFAULT_COUNTRY when unknown or not in `valid`."""
    loc = (apple_locale() if locale is None else locale).split("@", 1)[0]
    code = loc.rsplit("_", 1)[1].strip().upper() if "_" in loc else ""
    if len(code) != 2 or not code.isalpha() or (valid is not None and code not in valid):
        return DEFAULT_COUNTRY
    return code
