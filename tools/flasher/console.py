"""Talk to a Projection5000 console (stdlib urllib, no session).

The flasher itself never enrolls: the Pi does that on first boot. enroll() mirrors what the rendered
projection5000-provision.sh does and is used by the tests; check_health() backs the GUI's "Test connection";
fetch_enrollment() trades the operator's API token for the console's current enrollment key;
request_device_code() / poll_device_token() are the flasher's half of the browser sign-in
(POST /api/operator/device-code, GET /authorize in the browser, POST /api/operator/device-token).
"""
import json
import urllib.error
import urllib.request

TIMEOUT = 30
NOT_A_CONSOLE = "is this a Projection5000 console?"
HEADERS = {"User-Agent": "Projection5000-SD-Flasher", "Content-Type": "application/json"}


class ConsoleError(Exception):
    code = None  # HTTP status when the console answered with one
    body = {}  # the parsed JSON error body, when there was one


class Pending(ConsoleError):
    """The device code is not approved yet (HTTP 428): poll again."""


def _base(console_url: str) -> str:
    base = console_url.strip().rstrip("/")
    if not base.startswith(("http://", "https://")):
        raise ConsoleError("console URL must start with http:// or https://")
    return base


def _request(base: str, path: str, body: dict = None, headers: dict = None) -> dict:
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(base + path, data=data, headers={**HEADERS, **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            raw = resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        hint = f" ({NOT_A_CONSOLE})" if e.code == 404 else ""
        body = _body(e)
        err = (Pending if e.code == 428 else ConsoleError)(f"{path}: {_detail(e, body)}{hint}")
        err.code, err.body = e.code, body
        raise err from e
    except urllib.error.URLError as e:
        raise ConsoleError(f"cannot reach {base}{path}: {e.reason}") from e
    except OSError as e:  # a timeout while waiting for headers or body is a bare TimeoutError
        raise ConsoleError(f"cannot reach {base}{path}: {e}") from e
    try:
        parsed = json.loads(raw)
    except ValueError:
        raise ConsoleError(f"{path}: not a JSON response ({NOT_A_CONSOLE})")
    if not isinstance(parsed, dict):
        raise ConsoleError(f"{path}: unexpected response ({NOT_A_CONSOLE})")
    return parsed


def _body(e: urllib.error.HTTPError) -> dict:
    try:
        parsed = json.loads(e.read().decode("utf-8", "replace"))
    except (ValueError, AttributeError):
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _detail(e: urllib.error.HTTPError, body: dict) -> str:
    # The cloud's device-code endpoints answer with {status} and no detail (428 pending, 410 denied/expired).
    d = body.get("detail") or body.get("status")
    return str(d) if d else f"HTTP {e.code} {e.reason}"


def check_health(console_url: str) -> None:
    """GET /api/health; raises ConsoleError with the reason when the console is not usable."""
    base = _base(console_url)
    if not _request(base, "/api/health").get("ok"):
        raise ConsoleError(f"/api/health did not answer ok ({NOT_A_CONSOLE})")


def enroll(console_url: str, key: str, device_id: str, name: str) -> tuple:
    """POST /api/enroll. Returns (token, cms_url); the console keeps the token of an existing device_id."""
    base = _base(console_url)
    r = _request(base, "/api/enroll", {"key": key, "device_id": device_id.strip().lower(), "name": name})
    token = r.get("token")
    if not isinstance(token, str) or not token:
        raise ConsoleError("/api/enroll: response carries no token")
    return token, str(r.get("cms_url") or base)


def fetch_enrollment(console_url: str, token: str) -> dict:
    """GET /api/operator/enrollment with `Authorization: Bearer <operator token>`. Returns the console's answer
    ({console_url, enrollment_key, groups: [{id, name}], playlists: [{id, name}], timezone, wyze_configured, ...});
    ConsoleError
    on a rejected token (401) or a malformed answer. Never enrolls and never sends anything but the token."""
    base = _base(console_url)
    r = _request(base, "/api/operator/enrollment", headers={"Authorization": f"Bearer {token.strip()}"})
    key = r.get("enrollment_key")
    if not isinstance(key, str) or not key.strip():
        raise ConsoleError("/api/operator/enrollment: response carries no enrollment_key")
    r["enrollment_key"] = key.strip()
    if not isinstance(r.get("console_url"), str) or not r["console_url"]:
        r["console_url"] = base
    for k in ("groups", "playlists"):
        items = r.get(k) if isinstance(r.get(k), list) else []
        r[k] = [g for g in items if isinstance(g, dict) and isinstance(g.get("name"), str)]
    r["wyze_configured"] = bool(r.get("wyze_configured"))  # the provision script's --with-wyze
    return r


def request_device_code(console_url: str, hostname: str) -> dict:
    """POST /api/operator/device-code (no auth). Returns {device_code, user_code, verification_url, expires_in,
    interval}; the browser opens verification_url?code=<user_code> and the operator approves there."""
    base = _base(console_url)
    r = _request(base, "/api/operator/device-code", {"hostname": hostname})
    for k in ("device_code", "user_code", "verification_url"):
        if not isinstance(r.get(k), str) or not r[k]:
            raise ConsoleError(f"/api/operator/device-code: response carries no {k} ({NOT_A_CONSOLE})")
    r["expires_in"] = int(r.get("expires_in") or 600)
    r["interval"] = max(1, int(r.get("interval") or 3))
    return r


def display_code(user_code: str) -> str:
    """The 6-char user code as the console shows it (XXXX-XX); anything else is shown as sent."""
    c = user_code.strip()
    return f"{c[:4]}-{c[4:]}" if len(c) == 6 and c.isalnum() else c


GONE = {"denied": "denied on the console", "expired": "the code expired (click Sign in again)"}


def poll_device_token(console_url: str, device_code: str) -> dict:
    """POST /api/operator/device-token {device_code}. Returns {token, username} once approved (one shot);
    raises Pending (428) while the operator has not approved yet, ConsoleError on 410 (the cloud answers
    {status: "denied" | "expired"} with no detail; the message says which)."""
    base = _base(console_url)
    try:
        r = _request(base, "/api/operator/device-token", {"device_code": device_code})
    except ConsoleError as e:
        if e.code == 410:
            gone = ConsoleError(GONE.get(e.body.get("status"), GONE["expired"]))
            gone.code, gone.body = e.code, e.body
            raise gone from e
        raise
    if not isinstance(r.get("token"), str) or not r["token"].strip():
        raise ConsoleError("/api/operator/device-token: response carries no token")
    return {"token": r["token"].strip(), "username": str(r.get("username") or "")}
