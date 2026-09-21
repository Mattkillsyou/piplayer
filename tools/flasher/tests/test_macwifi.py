"""The macOS Wi-Fi layer on any OS: a sample `system_profiler SPAirPortDataType -json` with two networks in range
and a current one, the keychain password lookup and the preferred-network list, all with subprocess faked."""
import json
import subprocess

import macwifi

PROFILE = {
    "SPAirPortDataType": [{
        "spairport_airport_interfaces": [{
            "_name": "en0",
            "spairport_airport_other_local_wireless_networks": [
                {"_name": "Cafe: Free WiFi", "spairport_network_channel": "6 (2GHz, 20MHz)",
                 "spairport_network_phymode": "802.11", "spairport_network_type": "spairport_network_type_station",
                 "spairport_security_mode": "spairport_security_mode_none", "spairport_signal_noise": "-70 dBm / -92 dBm"},
                {"_name": "Venue", "spairport_network_channel": "36 (5GHz, 80MHz)",
                 "spairport_security_mode": "spairport_security_mode_wpa2_personal",
                 "spairport_signal_noise": "-58 dBm / -90 dBm"},
                {"_name": "Venue", "spairport_network_channel": "1 (2GHz, 20MHz)",  # the same SSID on another band
                 "spairport_security_mode": "spairport_security_mode_wpa2_personal",
                 "spairport_signal_noise": "-81 dBm / -92 dBm"},
                {"_name": "", "spairport_security_mode": "spairport_security_mode_wpa2_personal",
                 "spairport_signal_noise": "-40 dBm / -92 dBm"},  # hidden
            ],
            "spairport_current_network_information": {
                "_name": "Home", "spairport_network_channel": "44 (5GHz, 80MHz)", "spairport_network_rate": 866,
                "spairport_security_mode": "spairport_security_mode_wpa3_personal",
                "spairport_signal_noise": "-52 dBm / -91 dBm"},
            "spairport_status_information": "spairport_status_connected",
            "spairport_wireless_country_code": "US",
        }],
        "spairport_software_information": {"spairport_corewlan_version": "17.0"},
    }]
}
DISCONNECTED = {"SPAirPortDataType": [{"spairport_airport_interfaces": [{
    "_name": "en0", "spairport_status_information": "spairport_status_off"}]}]}


def test_parse_networks_merges_bands_drops_hidden_and_sorts_by_signal():
    nets = macwifi.parse_networks(json.dumps(PROFILE))
    assert nets == [{"ssid": "Home", "signal": 96, "auth": "WPA3-Personal"},  # the current network is in the list
                    {"ssid": "Venue", "signal": 84, "auth": "WPA2-Personal"},
                    {"ssid": "Cafe: Free WiFi", "signal": 60, "auth": "Open"}]
    assert macwifi.parse_networks(json.dumps(DISCONNECTED)) == []
    assert macwifi.parse_networks("") == [] and macwifi.parse_networks("not json") == []
    assert macwifi.signal_percent("-100 dBm / -95 dBm") == 0 and macwifi.signal_percent("-30 dBm") == 100
    assert macwifi.signal_percent(None) == 0 and macwifi.signal_percent("strong") == 0


def test_parse_current_ssid():
    assert macwifi.parse_current_ssid(json.dumps(PROFILE)) == "Home"
    assert macwifi.parse_current_ssid(json.dumps(DISCONNECTED)) is None
    assert macwifi.parse_current_ssid("") is None
    # macOS 14+ may redact the name when the app has no Location permission: then it is simply unknown.
    redacted = json.loads(json.dumps(PROFILE))
    redacted["SPAirPortDataType"][0]["spairport_airport_interfaces"][0]["spairport_current_network_information"]["_name"] = "<redacted>"
    assert macwifi.parse_current_ssid(json.dumps(redacted)) is None
    assert [n["ssid"] for n in macwifi.parse_networks(json.dumps(redacted))] == ["Venue", "Cafe: Free WiFi"]


def test_one_system_profiler_run_serves_the_scan_and_the_current_network(monkeypatch):
    calls = []

    def fake_run(argv, **kw):
        calls.append(argv)
        assert kw["stdin"] is subprocess.DEVNULL and kw["capture_output"] is True
        if argv[0] == macwifi.SYSTEM_PROFILER:
            assert argv[1:] == ["SPAirPortDataType", "-json"] and kw["timeout"] == macwifi.TIMEOUT
            return subprocess.CompletedProcess(argv, 0, json.dumps(PROFILE).encode(), b"")
        if argv[0] == macwifi.SECURITY:
            assert argv[1:] == ["find-generic-password", "-D", "AirPort network password", "-a", "Venue", "-w"]
            assert kw["timeout"] >= 60  # the Allow/Deny prompt waits for the user
            return subprocess.CompletedProcess(argv, 0, b"p4ss: word 1\n", b"")
        if argv[0] == macwifi.NETWORKSETUP:
            if argv[1] == "-listallhardwareports":
                return subprocess.CompletedProcess(argv, 0, b"\nHardware Port: Ethernet\nDevice: en5\nEthernet Address: "
                                                   b"aa\n\nHardware Port: Wi-Fi\nDevice: en0\nEthernet Address: bb\n", b"")
            assert argv[1:] == ["-listpreferredwirelessnetworks", "en0"]
            return subprocess.CompletedProcess(argv, 0, b"Preferred networks on en0:\n\tHome\n\tVenue\n", b"")
        raise AssertionError(argv)

    monkeypatch.setattr(macwifi.subprocess, "run", fake_run)
    macwifi._cache.update(at=0.0, data=None)
    assert [n["ssid"] for n in macwifi.scan_networks()] == ["Home", "Venue", "Cafe: Free WiFi"]
    assert macwifi.current_ssid() == "Home"
    assert sum(1 for c in calls if c[0] == macwifi.SYSTEM_PROFILER) == 1  # cached: the GUI asks twice in a row
    macwifi._cache["at"] -= macwifi.CACHE_SECONDS + 1
    macwifi.scan_networks()
    assert sum(1 for c in calls if c[0] == macwifi.SYSTEM_PROFILER) == 2  # stale: asked again
    assert macwifi.saved_password("Venue") == "p4ss: word 1"
    assert macwifi.saved_password("") is None
    assert macwifi.saved_profiles() == ["Home", "Venue"]
    # Denied in the keychain prompt, no such item, a tool that is missing or hangs: no password, no crash.
    monkeypatch.setattr(macwifi.subprocess, "run",
                        lambda argv, **kw: subprocess.CompletedProcess(argv, 44, b"", b"could not be found"))
    assert macwifi.saved_password("Venue") is None and macwifi.saved_profiles() == []
    monkeypatch.setattr(macwifi.subprocess, "run",
                        lambda argv, **kw: (_ for _ in ()).throw(subprocess.TimeoutExpired(argv, 1)))
    macwifi._cache.update(at=0.0, data=None)
    assert macwifi.scan_networks() == [] and macwifi.current_ssid() is None and macwifi.saved_password("x") is None
    monkeypatch.setattr(macwifi.subprocess, "run", lambda argv, **kw: (_ for _ in ()).throw(FileNotFoundError(argv[0])))
    macwifi._cache.update(at=0.0, data=None)
    assert macwifi.scan_networks() == []
