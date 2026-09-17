import firstboot
import winlocale


def test_timezone_mapping_and_fallback():
    assert winlocale.timezone("Pacific Standard Time") == "America/Los_Angeles"
    assert winlocale.timezone("GMT Standard Time") == "Europe/London"
    assert winlocale.timezone("AUS Eastern Standard Time") == "Australia/Sydney"
    assert winlocale.timezone("UTC") == "UTC"
    assert winlocale.timezone("Mars Standard Time") == winlocale.DEFAULT_TIMEZONE
    assert winlocale.timezone("") == winlocale.DEFAULT_TIMEZONE
    # Every mapped zone passes the card rule.
    for tz in winlocale.WINDOWS_TZ.values():
        assert firstboot.TIMEZONE_RE.fullmatch(tz), tz


def test_keymap_from_input_locale():
    assert winlocale.keymap(0x0409) == "us"  # en-US
    assert winlocale.keymap(0x0809) == "gb"  # en-GB
    assert winlocale.keymap(0x1809) == "ie"
    assert winlocale.keymap(0x0407) == "de" and winlocale.keymap(0x0c07) == "at" and winlocale.keymap(0x0807) == "ch"
    assert winlocale.keymap(0x040c) == "fr" and winlocale.keymap(0x0c0a) == "es" and winlocale.keymap(0x0416) == "br"
    assert winlocale.keymap(0x0411) == "jp" and winlocale.keymap(0x0000) == "us" and winlocale.keymap(0x1234) == "us"
    for km in list(winlocale.LANG_KEYMAP.values()) + list(winlocale.LANGID_KEYMAP.values()):
        assert firstboot.KEYMAP_RE.fullmatch(km), km


def test_live_values_are_valid_for_the_card(monkeypatch):
    """Whatever this PC reports, the defaults pass validate_cfg (fallbacks otherwise)."""
    cfg = firstboot.sample_config()
    cfg.update(timezone=winlocale.timezone(), keymap=winlocale.keymap(), wifi_country=winlocale.country(firstboot.ISO3166))
    assert firstboot.validate_cfg(cfg) == []
    # Unknown or unreadable region: the default; a region outside `valid` too.
    monkeypatch.setattr(winlocale.ctypes, "windll", None)
    assert winlocale.country() == winlocale.DEFAULT_COUNTRY and winlocale.keymap() == winlocale.DEFAULT_KEYMAP

    class Geo:
        code = "XX"

        class kernel32:
            @staticmethod
            def GetUserDefaultGeoName(buf, n):
                buf.value = Geo.code
                return len(Geo.code) + 1

    monkeypatch.setattr(winlocale.ctypes, "windll", Geo)
    assert winlocale.country() == "XX" and winlocale.country(firstboot.ISO3166) == winlocale.DEFAULT_COUNTRY
    Geo.code = "gb"
    assert winlocale.country(firstboot.ISO3166) == "GB"
    Geo.code = "001"  # "World" region
    assert winlocale.country() == winlocale.DEFAULT_COUNTRY
    monkeypatch.setattr(winlocale, "input_langid", lambda: 0x0809)
    assert winlocale.keymap() == "gb"
    monkeypatch.setattr(winlocale, "windows_timezone_name", lambda: "Tokyo Standard Time")
    assert winlocale.timezone() == "Asia/Tokyo"
