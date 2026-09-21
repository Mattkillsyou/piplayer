"""The macOS locale defaults on any OS: the /etc/localtime link, the keyboard layout id, AppleLocale, and the
same fallbacks as Windows (America/Los_Angeles, us, US)."""
import subprocess

import firstboot
import maclocale


def test_timezone_from_the_localtime_link():
    assert maclocale.timezone("/var/db/timezone/zoneinfo/America/Los_Angeles") == "America/Los_Angeles"
    assert maclocale.timezone("/usr/share/zoneinfo/Europe/London") == "Europe/London"
    assert maclocale.timezone("/var/db/timezone/zoneinfo/America/Argentina/Buenos_Aires") == "America/Argentina/Buenos_Aires"
    assert maclocale.timezone("/var/db/timezone/zoneinfo/UTC") == "UTC"
    assert maclocale.timezone("") == maclocale.DEFAULT_TIMEZONE
    assert maclocale.timezone("/etc/localtime") == maclocale.DEFAULT_TIMEZONE  # not a link into zoneinfo
    assert maclocale.timezone("/var/db/timezone/zoneinfo/../../evil") == maclocale.DEFAULT_TIMEZONE
    assert maclocale.DEFAULT_TIMEZONE == "America/Los_Angeles"


def test_keymap_from_the_layout_id():
    assert maclocale.keymap("com.apple.keylayout.US") == "us"
    assert maclocale.keymap("com.apple.keylayout.ABC") == "us"
    assert maclocale.keymap("com.apple.keylayout.British") == "gb"
    assert maclocale.keymap("com.apple.keylayout.German") == "de"
    assert maclocale.keymap("com.apple.keylayout.SwissGerman") == "ch"
    assert maclocale.keymap("com.apple.keylayout.French-PC") == "fr"
    assert maclocale.keymap("com.apple.keylayout.Spanish-ISO") == "es"
    assert maclocale.keymap("com.apple.keylayout.Brazilian") == "br"
    assert maclocale.keymap("com.apple.inputmethod.Kotoeri.RomajiTyping.Japanese") == "us"  # an input method, not a layout
    assert maclocale.keymap("") == "us" and maclocale.keymap("com.apple.keylayout.Dvorak") == "us"
    for km in maclocale.LAYOUT_KEYMAP.values():
        assert firstboot.KEYMAP_RE.fullmatch(km), km


def test_country_from_apple_locale():
    assert maclocale.country(locale="en_US") == "US"
    assert maclocale.country(locale="en_GB") == "GB"
    assert maclocale.country(locale="de_DE@currency=EUR") == "DE"
    assert maclocale.country(locale="zh-Hant_TW") == "TW"
    assert maclocale.country(locale="en") == "US"  # no region
    assert maclocale.country(locale="") == "US"
    assert maclocale.country(locale="en_150") == "US"  # a UN M.49 region, not a country
    assert maclocale.country(firstboot.ISO3166, locale="en_XX") == "US"
    assert maclocale.country(firstboot.ISO3166, locale="fr_CA") == "CA"


def test_live_values_are_valid_for_the_card(monkeypatch):
    """Whatever the Mac reports (or nothing at all), the defaults pass validate_cfg."""
    calls = []

    def fake_run(argv, **kw):
        calls.append(argv)
        assert argv[:2] == [maclocale.DEFAULTS, "read"] and kw["stdin"] is subprocess.DEVNULL
        if argv[2:] == ["-g", "AppleLocale"]:
            return subprocess.CompletedProcess(argv, 0, b"en_GB\n", b"")
        if argv[2:] == ["com.apple.HIToolbox", "AppleCurrentKeyboardLayoutInputSourceID"]:
            return subprocess.CompletedProcess(argv, 0, b"com.apple.keylayout.British\n", b"")
        return subprocess.CompletedProcess(argv, 1, b"", b"does not exist")

    monkeypatch.setattr(maclocale.subprocess, "run", fake_run)
    monkeypatch.setattr(maclocale, "localtime_target", lambda: "/var/db/timezone/zoneinfo/Europe/London")
    assert (maclocale.timezone(), maclocale.keymap(), maclocale.country(firstboot.ISO3166)) == ("Europe/London", "gb", "GB")
    cfg = firstboot.sample_config()
    cfg.update(timezone=maclocale.timezone(), keymap=maclocale.keymap(), wifi_country=maclocale.country(firstboot.ISO3166))
    assert firstboot.validate_cfg(cfg) == []
    # Nothing readable (a missing key exits 1, a missing tool raises): the fallbacks, never an exception.
    monkeypatch.setattr(maclocale.subprocess, "run", lambda argv, **kw: subprocess.CompletedProcess(argv, 1, b"", b""))
    monkeypatch.setattr(maclocale, "localtime_target", lambda: "")
    assert (maclocale.timezone(), maclocale.keymap(), maclocale.country()) == ("America/Los_Angeles", "us", "US")
    monkeypatch.setattr(maclocale.subprocess, "run", lambda argv, **kw: (_ for _ in ()).throw(FileNotFoundError("defaults")))
    assert (maclocale.keymap(), maclocale.country()) == ("us", "US")
    monkeypatch.setattr(maclocale, "LOCALTIME", "/definitely/not/a/link")
    assert maclocale.localtime_target() == "" and maclocale.timezone() == "America/Los_Angeles"
