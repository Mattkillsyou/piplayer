"""Defaults for the card taken from this Windows PC: timezone (IANA), keyboard layout, Wi-Fi country.

Every function has a safe fallback (America/Los_Angeles, us, US) and never raises; the Advanced section of
the flasher lets the operator override all three.
"""
import ctypes

# Windows time zone key names (tzutil /g) -> IANA, the zones this product is likely to meet. Anything else
# falls back to the default; tzdata is not shipped with the Windows Python, so there is no full table to ask.
WINDOWS_TZ = {
    "Pacific Standard Time": "America/Los_Angeles", "Mountain Standard Time": "America/Denver",
    "US Mountain Standard Time": "America/Phoenix", "Central Standard Time": "America/Chicago",
    "Eastern Standard Time": "America/New_York", "Alaskan Standard Time": "America/Anchorage",
    "Hawaiian Standard Time": "Pacific/Honolulu", "Atlantic Standard Time": "America/Halifax",
    "Newfoundland Standard Time": "America/St_Johns", "Canada Central Standard Time": "America/Regina",
    "Central Standard Time (Mexico)": "America/Mexico_City", "E. South America Standard Time": "America/Sao_Paulo",
    "Argentina Standard Time": "America/Argentina/Buenos_Aires", "SA Pacific Standard Time": "America/Bogota",
    "GMT Standard Time": "Europe/London", "Greenwich Standard Time": "Atlantic/Reykjavik",
    "W. Europe Standard Time": "Europe/Berlin", "Romance Standard Time": "Europe/Paris",
    "Central Europe Standard Time": "Europe/Budapest", "Central European Standard Time": "Europe/Warsaw",
    "E. Europe Standard Time": "Europe/Chisinau", "FLE Standard Time": "Europe/Kiev",
    "GTB Standard Time": "Europe/Bucharest", "Russian Standard Time": "Europe/Moscow",
    "Turkey Standard Time": "Europe/Istanbul", "Israel Standard Time": "Asia/Jerusalem",
    "Arabian Standard Time": "Asia/Dubai", "India Standard Time": "Asia/Kolkata",
    "SE Asia Standard Time": "Asia/Bangkok", "Singapore Standard Time": "Asia/Singapore",
    "China Standard Time": "Asia/Shanghai", "Taipei Standard Time": "Asia/Taipei",
    "Korea Standard Time": "Asia/Seoul", "Tokyo Standard Time": "Asia/Tokyo",
    "AUS Eastern Standard Time": "Australia/Sydney", "E. Australia Standard Time": "Australia/Brisbane",
    "Cen. Australia Standard Time": "Australia/Adelaide", "AUS Central Standard Time": "Australia/Darwin",
    "W. Australia Standard Time": "Australia/Perth", "New Zealand Standard Time": "Pacific/Auckland",
    "South Africa Standard Time": "Africa/Johannesburg", "Egypt Standard Time": "Africa/Cairo",
    "UTC": "UTC", "Coordinated Universal Time": "UTC",
}
# Windows primary language id (low byte of the keyboard layout's language) -> Pi OS keymap; LANGID_KEYMAP picks
# the sublanguage's layout first (gb/ie/br/ch/at/be, French Canada, Latin America). Spanish outside Spain is
# the "Latin American" keyboard (latam), not Spain's; English (Canada) is the plain US keyboard.
LANG_KEYMAP = {0x07: "de", 0x0c: "fr", 0x0a: "latam", 0x10: "it", 0x13: "nl", 0x1d: "se", 0x14: "no", 0x06: "dk",
               0x0b: "fi", 0x16: "pt", 0x11: "jp", 0x15: "pl", 0x05: "cz", 0x19: "ru", 0x0e: "hu", 0x1f: "tr"}
LANGID_KEYMAP = {0x0809: "gb", 0x1809: "ie", 0x0416: "br", 0x0807: "ch", 0x100c: "ch", 0x0c07: "at", 0x0c0c: "ca",
                 0x0813: "be", 0x080c: "be", 0x0c0a: "es", 0x040a: "es"}
DEFAULT_TIMEZONE = "America/Los_Angeles"
DEFAULT_KEYMAP = "us"
DEFAULT_COUNTRY = "US"


def windows_timezone_name() -> str:
    """The registry's TimeZoneKeyName (what tzutil /g prints), '' when unreadable."""
    try:
        import winreg
        with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, r"SYSTEM\CurrentControlSet\Control\TimeZoneInformation") as k:
            return str(winreg.QueryValueEx(k, "TimeZoneKeyName")[0]).strip("\0 ")
    except Exception:
        return ""


def timezone(name: str = None) -> str:
    return WINDOWS_TZ.get(windows_timezone_name() if name is None else name, DEFAULT_TIMEZONE)


def input_langid() -> int:
    """LANGID of the current keyboard layout (0 when unavailable): the HKL's high word when it is a plain
    language id (a German keyboard under an English Windows is 0x04070409), the low word otherwise."""
    try:
        hkl = ctypes.windll.user32.GetKeyboardLayout(0) & 0xFFFFFFFF
    except Exception:
        return 0
    high = (hkl >> 16) & 0xFFFF
    return high if 0 < high < 0xE000 else hkl & 0xFFFF  # 0xE0xx: an IME, 0xF0xx: a special layout


def keymap(langid: int = None) -> str:
    langid = input_langid() if langid is None else langid
    return LANGID_KEYMAP.get(langid) or LANG_KEYMAP.get(langid & 0xFF, DEFAULT_KEYMAP)


def country(valid=None) -> str:
    """ISO 3166 alpha-2 of the Windows region (GetUserDefaultGeoName), DEFAULT_COUNTRY when unknown or not
    in `valid`."""
    try:
        buf = ctypes.create_unicode_buffer(8)
        n = ctypes.windll.kernel32.GetUserDefaultGeoName(buf, len(buf))
        code = buf.value.strip().upper() if n else ""
    except Exception:
        code = ""
    if len(code) != 2 or (valid is not None and code not in valid):
        return DEFAULT_COUNTRY
    return code
