"""The Wi-Fi networks this PC sees, through netsh (Windows, stdlib only).

Parsing keys on the English labels netsh prints ("SSID n :", "Signal", "Authentication", "State", "Key Content")
and, where it can, on shape instead of words: any "SSID <n> : name" line (kept verbatim by most localized builds),
any "label : NN%" value as the signal, and any indented "label : value" line of "show profiles" as a profile name.
On a non-English Windows the scan may still come back empty or without auth: the flasher then shows a plain
editable box and the operator types the network name. Never log what saved_password returns.

netsh writes UTF-8 to a pipe (whatever the console code page; checked on Windows 11 under the flasher's own
console-less launch), so the output is decoded as UTF-8 first and as the OEM code page only when it is not.
"""
import os
import re
import subprocess

NETSH = os.path.join(os.environ.get("SystemRoot", r"C:\Windows"), "System32", "netsh.exe")
TIMEOUT = 10  # seconds; a scan normally takes 1-3 s
SSID_RE = re.compile(r"^SSID(?: \d+)?$")
PERCENT_RE = re.compile(r"^(\d+)\s*%$")


def _run(*args) -> str:
    """stdout of 'netsh wlan <args>', '' on any failure (missing netsh, non-zero exit, timeout)."""
    try:
        p = subprocess.run([NETSH, "wlan", *args], capture_output=True, timeout=TIMEOUT,
                           creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    except (OSError, subprocess.SubprocessError):
        return ""
    if p.returncode != 0:
        return ""
    return decode(p.stdout)


def decode(raw: bytes) -> str:
    """netsh's pipe output: UTF-8 (Windows 10/11), else the OEM code page (an older build; accented OEM bytes are
    almost never valid UTF-8, so the first try fails loudly rather than silently)."""
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        try:
            return raw.decode("oem", "replace")
        except LookupError:  # not Windows
            return raw.decode("utf-8", "replace")


def _pairs(text: str):
    """(indent, label, value) for every 'label : value' line, split at the first colon (SSIDs may hold colons).
    The value is what follows the one space after the colon, verbatim: an SSID or a saved password may begin
    or end with a space (validate_cfg then says so instead of a silently different name)."""
    for line in text.rstrip("\n").split("\n"):
        line = line.rstrip("\r")
        if ":" not in line:
            continue
        label, _, value = line.partition(":")
        if value.startswith(" "):
            value = value[1:]
        yield len(line) - len(line.lstrip()), label.strip(), value


def parse_networks(text: str) -> list:
    """[{ssid, signal, auth}] from 'netsh wlan show networks mode=bssid': one entry per SSID with the strongest
    signal across its BSSIDs, hidden (blank) SSIDs dropped, strongest first."""
    nets = {}
    cur = None
    for _, label, value in _pairs(text):
        if SSID_RE.match(label):
            cur = nets.setdefault(value, {"ssid": value, "signal": 0, "auth": ""}) if value.strip() else None
        elif cur is None:
            continue
        elif label == "Authentication":
            cur["auth"] = cur["auth"] or value.strip()
        else:
            m = PERCENT_RE.match(value.strip())  # "Signal : 27%" in any language; "150 (58 %)" does not match
            if m:
                cur["signal"] = max(cur["signal"], int(m.group(1)))
    return sorted(nets.values(), key=lambda n: -n["signal"])


def parse_current_ssid(text: str):
    """The connected SSID from 'netsh wlan show interfaces', None when no adapter is connected. One block per
    adapter (each starts with its Name line); netsh prints an SSID line only while associated, so its presence
    is the localized fallback for 'State : connected'."""
    blocks = [[]]
    for _, label, value in _pairs(text):
        if label == "Name" and blocks[-1]:
            blocks.append([])
        blocks[-1].append((label, value))
    for block in blocks:
        ssid = state = None
        for label, value in block:
            if label == "State":
                state = value.strip()
            elif SSID_RE.match(label) and ssid is None:
                ssid = value if value.strip() else None
        if ssid and (state is None or state.lower() == "connected"):
            return ssid
    return None


def parse_saved_password(text: str):
    """The 'Key Content' value of 'netsh wlan show profile name=X key=clear', else None."""
    for _, label, value in _pairs(text):
        if label == "Key Content":
            return value or None
    return None


def parse_profiles(text: str) -> list:
    """Profile names from 'netsh wlan show profiles': every indented 'label : value' line."""
    return [value for indent, _, value in _pairs(text) if indent and value.strip()]


def scan_networks() -> list:
    return parse_networks(_run("show", "networks", "mode=bssid"))


def current_ssid():
    return parse_current_ssid(_run("show", "interfaces"))


def saved_password(ssid: str):
    if not ssid:
        return None
    # No quotes of our own: subprocess quotes the argument when the name has spaces, and netsh rejects a
    # name that still carries quotes after that ("One or more parameters ... not correct").
    return parse_saved_password(_run("show", "profile", f"name={ssid}", "key=clear"))


def saved_profiles() -> list:
    return parse_profiles(_run("show", "profiles"))
