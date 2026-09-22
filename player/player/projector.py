"""Projector power: switch the projector on/off over a Broadlink RM4 (IR
packets learned from the projector's remote) or HDMI-CEC (cec-ctl, package
v4l-utils), on demand (commands projector-on / projector-off / ir-learn:<name>)
or automatically from the manifest's `projector` block:

    {"mode": "manual"|"auto", "want": "on"|"off", "control": "none"|"broadlink"|"cec",
     "codes": {"power_on": <b64>, "power_off": <b64>, ...}, "host": "<RM4 ip, optional>"}

The console decides `want` (playlist active / schedule about to start -> on,
idle for a while -> off); the player only applies a transition when `want`
changes (a toggle-code remote is adopted, not re-sent, after a restart),
retries it once at the time and again every five minutes while it keeps
failing, and reports the outcome as the sync params
`projector_state` (on/off/unknown, best effort: the last transition that
succeeded) and `projector_error`. `broadlink` is imported lazily so a player
without the package (or with control none/cec) never needs it."""
import base64
import json
import logging
import subprocess
import time

log = logging.getLogger("piplayer.projector")

LEARN_TIMEOUT_SECONDS = 30
DISCOVER_TIMEOUT_SECONDS = 5
CEC_DEVICE = "/dev/cec0"
CEC_TIMEOUT_SECONDS = 15
ERROR_MAX_LEN = 200
# auto mode: a transition that failed (blaster still joining Wi-Fi after a power cut, projector
# unwired) is tried again this often until it succeeds or `want` changes
RETRY_COOLDOWN_SECONDS = 300

# --- Broadlink RM4 ---


def _rm(host: str | None):
    """An authenticated RM device: `host` when given, else the first IR-capable
    device discovered on the LAN. Raises RuntimeError when none answers."""
    import broadlink   # lazy: optional dependency

    if host:
        dev = broadlink.hello(host, timeout=DISCOVER_TIMEOUT_SECONDS)
    else:
        found = [d for d in broadlink.discover(timeout=DISCOVER_TIMEOUT_SECONDS) if hasattr(d, "send_data")]
        if not found:
            raise RuntimeError("no Broadlink RM found on the LAN (set the RM4 host on the console)")
        dev = found[0]
    if not dev.auth():
        raise RuntimeError(f"Broadlink auth failed for {host or dev.host[0]}")   # dev.host is (ip, port)
    return dev


def send_code(code_b64: str, host: str | None = None) -> None:
    try:
        packet = base64.b64decode(code_b64, validate=True)
    except (ValueError, TypeError) as e:
        raise RuntimeError(f"bad IR code: {e}") from None
    if not packet:
        raise RuntimeError("bad IR code: empty")
    _rm(host).send_data(packet)


def learn_code(host: str | None = None, timeout: float = LEARN_TIMEOUT_SECONDS, sleep=time.sleep) -> str:
    """Put the RM into learning mode and poll for the packet the operator's
    remote sends within `timeout` seconds. Returns the packet base64."""
    import broadlink.exceptions   # lazy, see _rm

    dev = _rm(host)
    dev.enter_learning()
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        sleep(1)
        try:
            packet = dev.check_data()
        except (broadlink.exceptions.ReadError, broadlink.exceptions.StorageError):
            continue   # nothing received yet (some RM firmware answers -5 "storage full" meanwhile)
        if packet:
            return base64.b64encode(bytes(packet)).decode()
    raise RuntimeError(f"nothing learned in {int(timeout)} s (press the remote at the RM4)")


# --- HDMI-CEC ---

def _cec(*args: str) -> None:
    res = subprocess.run(["cec-ctl", "-d", CEC_DEVICE, *args], capture_output=True, text=True,
                         timeout=CEC_TIMEOUT_SECONDS)
    if res.returncode != 0:
        raise RuntimeError(f"cec-ctl {' '.join(args)} failed: rc={res.returncode} {res.stderr.strip()[:120]}")


def cec_power(want: str) -> None:
    # claim a playback logical address first: a fresh adapter is unregistered and
    # the projector ignores standby from an unregistered source
    _cec("--playback", "-S")
    _cec("--to", "0", "--image-view-on" if want == "on" else "--standby")


# --- the device-side state ---

class Projector:
    """What the daemon knows about the projector: the manifest's `projector`
    block (set every cycle), the last reported state/error and the `want`
    last applied (auto mode acts on change only)."""

    def __init__(self):
        self.block: dict = {}       # manifest `projector` block as of the last sync
        self.state = "unknown"      # sync param projector_state
        self.error = ""             # sync param projector_error
        self.applied_want: str | None = None
        self.retry_at: float | None = None   # monotonic time of the next attempt after a failed transition

    def set_block(self, block) -> None:
        self.block = block if isinstance(block, dict) else {}

    def _host(self):
        return self.block.get("host") or self.block.get("broadlink_host") or None

    def power(self, want: str) -> str:
        """Switch to `want` ("on"/"off") with the block's control/codes/host;
        retried once. Returns the command-result text."""
        control = str(self.block.get("control") or "none")
        try:
            if control == "broadlink":
                code = (self.block.get("codes") or {}).get(f"power_{want}")
                if not code:
                    raise RuntimeError(f"no power_{want} code learned yet")
                send = lambda: send_code(str(code), self._host())  # noqa: E731
            elif control == "cec":
                send = lambda: cec_power(want)  # noqa: E731
            else:
                raise RuntimeError("projector control is none")
            try:
                send()
            except Exception as e:  # noqa: BLE001 - one retry, whatever the transport said
                log.warning("projector %s failed (%s); retrying once", want, e)
                send()
        except Exception as e:  # noqa: BLE001 - subprocess/socket/auth errors all end up as the sync error
            self.state, self.error = "unknown", f"projector {want}: {e}"[:ERROR_MAX_LEN]
            log.warning("%s", self.error)
            return f"projector-{want} failed: {e}"[:300]
        self.state, self.error = want, ""
        return f"projector {want} sent via {control}"

    def learn(self, name: str) -> str:
        """ir-learn:<name>: the learned packet as {"learned": name, "code": <b64>}
        (JSON in the command result; the console stores it under `name`)."""
        try:
            code = learn_code(self._host())
        except Exception as e:  # noqa: BLE001
            return f"ir-learn {name} failed: {e}"[:300]
        return json.dumps({"learned": name, "code": code})

    def maybe_apply(self) -> bool:
        """Auto mode: apply the block's `want` when it differs from the one
        applied last, and retry a failed transition every RETRY_COOLDOWN_SECONDS.
        Returns True when a transition was attempted."""
        block = self.block
        if block.get("mode") != "auto" or block.get("control") not in ("broadlink", "cec"):
            return False
        want = block.get("want")
        if want not in ("on", "off"):
            return False
        if want == self.applied_want and not (self.retry_at and time.monotonic() >= self.retry_at):
            return False
        codes = block.get("codes") or {}
        if (self.applied_want is None and block.get("control") == "broadlink"
                and codes.get("power_on") == codes.get("power_off")):
            # Fresh process (reboot, nightly update, crash) with a single-button toggle
            # remote: the projector is presumably already where `want` says, and a blind
            # send would flip it. Adopt the state; the next change of `want` sends.
            self.applied_want = want
            log.info("projector auto: adopting want=%s after a restart, nothing sent (toggle code)", want)
            return False
        self.applied_want, self.retry_at = want, None
        log.info("projector auto: %s -> %s", self.state, want)
        self.power(want)
        if self.error:
            # blaster unreachable or the send failed: try again after the cooldown
            # (the error stays visible on the console meanwhile)
            self.retry_at = time.monotonic() + RETRY_COOLDOWN_SECONDS
        return True
