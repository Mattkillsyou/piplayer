"""The Wi-Fi networks this Mac sees (wifi.py is the Windows twin; sysplat.py picks one).

`system_profiler SPAirPortDataType -json` lists the networks in range and the current one without any
Location permission; it takes a few seconds, so the flasher calls it from a thread and one answer serves both
scan_networks() and current_ssid() (a short cache). The saved password comes from the login keychain through
`security find-generic-password` (macOS puts up its own Allow/Deny prompt; a refusal just means no password).
Never log what saved_password returns.
"""
import json
import re
import subprocess
import time

SYSTEM_PROFILER = "/usr/sbin/system_profiler"
SECURITY = "/usr/bin/security"
NETWORKSETUP = "/usr/sbin/networksetup"
TIMEOUT = 60  # s; system_profiler normally takes 2-8 s
CACHE_SECONDS = 10
RSSI_RE = re.compile(r"(-?\d+)\s*dBm")
SECURITY_NAMES = {"none": "Open", "wep": "WEP", "wpa_personal": "WPA-Personal", "wpa2_personal": "WPA2-Personal",
                  "wpa3_personal": "WPA3-Personal", "wpa2_enterprise": "WPA2-Enterprise",
                  "wpa3_enterprise": "WPA3-Enterprise"}

_cache = {"at": 0.0, "data": None}


def _run(argv, timeout: int = TIMEOUT) -> str:
    """stdout of argv, '' on any failure (missing tool, non-zero exit, timeout)."""
    try:
        p = subprocess.run(argv, capture_output=True, timeout=timeout, stdin=subprocess.DEVNULL)
    except (OSError, subprocess.SubprocessError):
        return ""
    if p.returncode != 0:
        return ""
    return p.stdout.decode("utf-8", "replace")


def signal_percent(text) -> int:
    """'-55 dBm / -92 dBm' -> 90: the usual 2 * (RSSI + 100), clamped to 0-100."""
    m = RSSI_RE.search(str(text or ""))
    if not m:
        return 0
    return max(0, min(100, 2 * (int(m.group(1)) + 100)))


def _auth(mode) -> str:
    key = str(mode or "").replace("spairport_security_mode_", "")
    return SECURITY_NAMES.get(key, key.replace("_", "-").upper() if key else "")


def _interfaces(text: str) -> list:
    try:
        data = json.loads(text or "{}")
    except ValueError:
        return []
    out = []
    for section in data.get("SPAirPortDataType") or []:
        out.extend(i for i in section.get("spairport_airport_interfaces") or [] if isinstance(i, dict))
    return out


def parse_networks(text: str) -> list:
    """[{ssid, signal, auth}] from the system_profiler JSON: one entry per SSID with the strongest signal, the
    current network included, hidden (blank) SSIDs dropped, strongest first."""
    nets = {}
    for iface in _interfaces(text):
        seen = list(iface.get("spairport_airport_other_local_wireless_networks") or [])
        cur = iface.get("spairport_current_network_information")
        if isinstance(cur, dict):
            seen.append(cur)
        for n in seen:
            ssid = str(n.get("_name") or "").strip()
            if not ssid or ssid.startswith("<"):  # "<redacted>": the name was not given to us
                continue
            e = nets.setdefault(ssid, {"ssid": ssid, "signal": 0, "auth": ""})
            e["signal"] = max(e["signal"], signal_percent(n.get("spairport_signal_noise")))
            e["auth"] = e["auth"] or _auth(n.get("spairport_security_mode"))
    return sorted(nets.values(), key=lambda n: -n["signal"])


def parse_current_ssid(text: str):
    """The connected SSID, None when no interface is connected."""
    for iface in _interfaces(text):
        cur = iface.get("spairport_current_network_information")
        status = str(iface.get("spairport_status_information") or "")
        if isinstance(cur, dict) and (not status or status.endswith("connected")):
            ssid = str(cur.get("_name") or "").strip()
            if ssid and not ssid.startswith("<"):
                return ssid
    return None


def _profile() -> str:
    """The system_profiler JSON, cached for CACHE_SECONDS (the GUI asks for the list and the current network
    back to back)."""
    now = time.monotonic()
    if _cache["data"] is None or now - _cache["at"] > CACHE_SECONDS:
        _cache["data"] = _run([SYSTEM_PROFILER, "SPAirPortDataType", "-json"])
        _cache["at"] = now
    return _cache["data"]


def scan_networks() -> list:
    return parse_networks(_profile())


def current_ssid():
    return parse_current_ssid(_profile())


def saved_password(ssid: str):
    """The keychain's 'AirPort network password' for ssid, None when there is none or access was denied."""
    if not ssid:
        return None
    out = _run([SECURITY, "find-generic-password", "-D", "AirPort network password", "-a", ssid, "-w"],
               timeout=180)  # the Allow/Deny prompt waits for the user
    return out.rstrip("\n") or None


def _wifi_device() -> str:
    """The Wi-Fi port's device name (en0 usually) from networksetup, '' when there is none."""
    port = ""
    for line in _run([NETWORKSETUP, "-listallhardwareports"], timeout=15).splitlines():
        label, _, value = line.partition(":")
        if label.strip() == "Hardware Port":
            port = value.strip()
        elif label.strip() == "Device" and port in ("Wi-Fi", "AirPort"):
            return value.strip()
    return ""


def saved_profiles() -> list:
    """The remembered networks (networksetup -listpreferredwirelessnetworks), strongest preference first."""
    dev = _wifi_device()
    if not dev:
        return []
    lines = _run([NETWORKSETUP, "-listpreferredwirelessnetworks", dev], timeout=15).splitlines()
    return [ln.strip() for ln in lines[1:] if ln.strip()]  # the first line is the heading
