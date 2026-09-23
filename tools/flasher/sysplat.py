"""The platform layer, chosen once by sys.platform.

flasher.py, imagefetch.py, sshkey.py and updater.py import these four names and never branch on the
platform themselves:

    disk      raw card access and enumeration   windisk.py   / macdisk.py
    wifi      networks and saved passwords      wifi.py      / macwifi.py
    defaults  time zone, keymap, country        winlocale.py / maclocale.py
    host      folders, token store, fonts, ...  winhost.py   / machost.py

Each pair exposes the same function names. The Windows modules are the originals; the macOS ones reuse the
shared streaming engine in windisk.py (write_image, verify_image, the deferred first MiB).
"""
import sys

if sys.platform == "darwin":
    import macdisk as disk
    import machost as host
    import maclocale as defaults
    import macwifi as wifi
else:
    import wifi
    import windisk as disk
    import winhost as host
    import winlocale as defaults

__all__ = ["defaults", "disk", "host", "wifi"]
