import subprocess
import sys

import pytest

import wifi

# Captured from 'netsh wlan show networks mode=bssid' (trailing spaces as netsh prints them).
SCAN = """\
Interface name : Wi-Fi
There are 4 networks currently visible.

SSID 1 : Verizon_JVM7TM
    Network type            : Infrastructure
    Authentication          : WPA2-Personal
    Encryption              : CCMP
    BSSID 1                 : 58:96:71:1e:0d:aa
         Signal             : 3%
         Radio type         : 802.11n
         Band               : 2.4 GHz
         Channel            : 11
         Basic rates (Mbps) : 1 2 5.5 11
         Other rates (Mbps) : 6 9 12 18 24 36 48 54

SSID 2 : 2065 S.Hobart #2
    Network type            : Infrastructure
    Authentication          : WPA2-Personal
    Encryption              : CCMP
    BSSID 1                 : 82:2a:a8:ad:ea:15
         Signal             : 9%
         Radio type         : 802.11n
         Band               : 2.4 GHz
         Channel            : 1
         Bss Load:
             Connected Stations:         1
             Channel Utilization:        150 (58 %)
             Medium Available Capacity:  31250 (1000000 us/s)
    BSSID 2                 : f6:9f:c2:72:81:ac
         Signal             : 27%
         Radio type         : 802.11ac
         Band               : 5 GHz
         Channel            : 36
    BSSID 3                 : f6:9f:c2:71:81:ac
         Signal             : 30%
         Radio type         : 802.11n
         Band               : 2.4 GHz
         Channel            : 6

SSID 3 :
    Network type            : Infrastructure
    Authentication          : WPA2-Personal
    Encryption              : CCMP
    BSSID 1                 : 12:34:56:78:9a:bc
         Signal             : 99%

SSID 4 : Cafe: Free WiFi
    Network type            : Infrastructure
    Authentication          : Open
    Encryption              : None
    BSSID 1                 : 22:34:56:78:9a:bc
         Signal             : 60%
"""

EMPTY_SCAN = """\
Interface name : Wi-Fi
There are 0 networks currently visible.

"""

CONNECTED = """\

There is 1 interface on the system:

    Name                   : Wi-Fi
    Description            : RZ616 Wi-Fi 6E 160MHz
    GUID                   : 33743506-4ee8-4517-9fde-57f69134f23f
    Physical address       : bc:f4:d4:82:52:e9
    Interface type         : Primary
    State                  : connected
    SSID                   : 2065 S.Hobart #2
    BSSID                  : f6:9f:c2:72:81:ac
    Network type           : Infrastructure
    Radio type             : 802.11ac
    Authentication         : WPA2-Personal
    Cipher                 : CCMP
    Connection mode        : Auto Connect
    Band                   : 5 GHz
    Channel                : 36
    Receive rate (Mbps)    : 866.7
    Transmit rate (Mbps)   : 866.7
    Signal                 : 27%
    Profile                : 2065 S.Hobart #2

    Hosted network status  : Not available
"""

DISCONNECTED = """\

There is 1 interface on the system:

    Name                   : Wi-Fi
    Description            : RZ616 Wi-Fi 6E 160MHz
    GUID                   : 33743506-4ee8-4517-9fde-57f69134f23f
    Physical address       : bc:f4:d4:82:52:e9
    Interface type         : Primary
    State                  : disconnected
    Radio status           : Hardware On
                             Software On

    Hosted network status  : Not available
"""

PROFILE = """\

Profile Venue on interface Wi-Fi:
=======================================================================

Applied: All User Profile

Profile information
-------------------
    Version                : 1
    Type                   : Wireless LAN
    Name                   : Venue
    Control options        :
        Connection mode    : Connect automatically
        Network broadcast  : Connect only if this network is broadcasting
        AutoSwitch         : Do not switch to other networks
        MAC Randomization  : Disabled

Connectivity settings
---------------------
    Number of SSIDs        : 1
    SSID name              : "Venue"
    Network type           : Infrastructure
    Radio type             : [ Any Radio Type ]
    Vendor extension          : Not present

Security settings
-----------------
    Authentication         : WPA2-Personal
    Cipher                 : CCMP
    Authentication         : WPA2-Personal
    Cipher                 : GCMP
    Security key           : Present
    Key Content            : p4ss: word 1

Cost settings
-------------
    Cost                   : Unrestricted
"""

PROFILES = """\

Profiles on interface Wi-Fi:

Group policy profiles (read only)
---------------------------------
    <None>

User profiles
-------------
    All User Profile     : daddeero
    All User Profile     : ghosts in the wifi
    All User Profile     : ghost in the wifi

"""


def test_parse_networks_dedupes_bssids_drops_hidden_and_sorts_by_signal():
    nets = wifi.parse_networks(SCAN)
    assert nets == [{"ssid": "Cafe: Free WiFi", "signal": 60, "auth": "Open"},
                    {"ssid": "2065 S.Hobart #2", "signal": 30, "auth": "WPA2-Personal"},
                    {"ssid": "Verizon_JVM7TM", "signal": 3, "auth": "WPA2-Personal"}]


def test_parse_networks_empty_and_garbage():
    assert wifi.parse_networks(EMPTY_SCAN) == []
    assert wifi.parse_networks("") == []
    assert wifi.parse_networks("The Wireless AutoConfig Service (wlansvc) is not running.\n") == []


def test_parse_networks_tolerates_localized_labels():
    """A German-ish dump keeps the 'SSID n :' shape and the 'NN%' value; the auth label is not recognised."""
    text = "Schnittstellenname : WLAN\n\nSSID 1 : Buero\n    Netzwerktyp : Infrastruktur\n" \
           "    Authentifizierung : WPA2-Personal\n    BSSID 1 : 00:11:22:33:44:55\n         Signal : 71%\n"
    assert wifi.parse_networks(text) == [{"ssid": "Buero", "signal": 71, "auth": ""}]


def test_parse_current_ssid():
    assert wifi.parse_current_ssid(CONNECTED) == "2065 S.Hobart #2"
    assert wifi.parse_current_ssid(DISCONNECTED) is None
    assert wifi.parse_current_ssid("") is None
    # A localized State value is unknown; the SSID line only exists while associated, so it decides.
    assert wifi.parse_current_ssid("    Status : verbunden\n    SSID : Buero\n") == "Buero"
    assert wifi.parse_current_ssid("    Status : getrennt\n") is None


def test_parse_saved_password_and_profiles():
    assert wifi.parse_saved_password(PROFILE) == "p4ss: word 1"
    assert wifi.parse_saved_password(PROFILE.replace("Key Content            : p4ss: word 1\n", "")) is None
    assert wifi.parse_saved_password("") is None
    assert wifi.parse_profiles(PROFILES) == ["daddeero", "ghosts in the wifi", "ghost in the wifi"]
    assert wifi.parse_profiles("\nProfiles on interface Wi-Fi:\n\nUser profiles\n-------------\n    <None>\n") == []


@pytest.mark.skipif(sys.platform != "win32", reason="the oem codec and CREATE_NO_WINDOW are Windows")
def test_run_wraps_netsh_hidden_with_timeout_and_swallows_errors(monkeypatch):
    calls = []

    class P:
        returncode = 0
        stdout = SCAN.encode("oem", "replace")

    def fake_run(argv, **kw):
        calls.append((argv, kw))
        return P()

    monkeypatch.setattr(wifi.subprocess, "run", fake_run)
    assert [n["ssid"] for n in wifi.scan_networks()][0] == "Cafe: Free WiFi"
    argv, kw = calls[0]
    assert argv == [wifi.NETSH, "wlan", "show", "networks", "mode=bssid"]
    assert argv[0].lower().startswith("c:\\windows\\system32\\")
    assert kw["timeout"] == 10 and kw["capture_output"] is True
    assert kw["creationflags"] == subprocess.CREATE_NO_WINDOW

    P.stdout = PROFILE.encode("oem", "replace")
    assert wifi.saved_password("Venue") == "p4ss: word 1"
    assert calls[-1][0][2:] == ["show", "profile", 'name="Venue"', "key=clear"]
    assert wifi.saved_password("") is None

    P.stdout = CONNECTED.encode("oem", "replace")
    assert wifi.current_ssid() == "2065 S.Hobart #2"
    P.stdout = PROFILES.encode("oem", "replace")
    assert wifi.saved_profiles() == ["daddeero", "ghosts in the wifi", "ghost in the wifi"]

    P.returncode = 1  # e.g. no such profile, wlansvc not running
    assert wifi.scan_networks() == [] and wifi.saved_password("x") is None and wifi.saved_profiles() == []
    P.returncode = 0
    monkeypatch.setattr(wifi.subprocess, "run",
                        lambda *a, **k: (_ for _ in ()).throw(subprocess.TimeoutExpired(a[0], 10)))
    assert wifi.scan_networks() == [] and wifi.current_ssid() is None
    monkeypatch.setattr(wifi.subprocess, "run", lambda *a, **k: (_ for _ in ()).throw(FileNotFoundError("netsh")))
    assert wifi.scan_networks() == [] and wifi.saved_profiles() == []
