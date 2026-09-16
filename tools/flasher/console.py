"""Talk to a Projection5000 console (stdlib urllib, no session).

The flasher itself never enrolls: the Pi does that on first boot. enroll() mirrors what the rendered
projection5000-provision.sh does and is used by the tests; check_health() backs the GUI's "Test connection";
fetch_enrollment() trades the operator's API token for the console's current enrollment key.
"""
import json
import urllib.error
import urllib.request

TIMEOUT = 30
NOT_A_CONSOLE = "is this a Projection5000 console?"
HEADERS = {"User-Agent": "Projection5000-SD-Flasher", "Content-Type": "application/json"}


class ConsoleError(Exception):
    pass


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
        raise ConsoleError(f"{path}: {_detail(e)}{hint}") from e
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


def _detail(e: urllib.error.HTTPError) -> str:
    try:
        d = json.loads(e.read().decode("utf-8", "replace")).get("detail")
        if d:
            return str(d)
    except (ValueError, AttributeError):
        pass
    return f"HTTP {e.code} {e.reason}"


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
