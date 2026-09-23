"""Talk to a Projection5000 console (stdlib urllib, no session).

The flasher itself never enrolls: the Pi does that on first boot. enroll() mirrors what the rendered
projection5000-provision.sh does and is used by the tests; check_health() backs the GUI's "Test connection";
login() is the in-app sign-in (POST /api/operator/login: username and password for an operator token), me() checks
a stored token (GET /api/operator/me) and register_device() creates or re-registers a projector under the
signed-in account (POST /api/operator/devices) and answers with the device token that goes on the card.
"""
import functools
import http.client
import json
import urllib.error
import urllib.request

from sysplat import host

TIMEOUT = 30
NOT_A_CONSOLE = "is this a Projection5000 console?"
HEADERS = {"User-Agent": "Projection5000-SD-Flasher", "Content-Type": "application/json"}


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """The API endpoints never redirect; following one would re-send the operator token to wherever it points
    (another host, plain http) and turn a POST into a GET. A 3xx is an error like any other."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


@functools.lru_cache(maxsize=None)
def _opener() -> urllib.request.OpenerDirector:
    return urllib.request.build_opener(_NoRedirect, urllib.request.HTTPSHandler(context=host.ssl_context()))


class ConsoleError(Exception):
    code = None  # HTTP status when the console answered with one
    body = {}  # the parsed JSON error body, when there was one

    def plain(self) -> str:
        """The console's own words (the JSON detail) for the screen; str() keeps the path for the log."""
        return str(self.body.get("detail") or self)


def _base(console_url: str) -> str:
    base = console_url.strip().rstrip("/")
    if not base.startswith(("http://", "https://")):
        raise ConsoleError("console URL must start with http:// or https://")
    return base


def _request(base: str, path: str, body: dict = None, headers: dict = None, timeout: int = None) -> dict:
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(base + path, data=data, headers={**HEADERS, **(headers or {})})
    try:
        # TIMEOUT is read here, not in the signature: the tests turn it down on the module.
        with _opener().open(req, timeout=TIMEOUT if timeout is None else timeout) as resp:
            raw = resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        hint = f" ({NOT_A_CONSOLE})" if e.code in (404, 301, 302, 303, 307, 308) else ""
        body = _body(e)
        err = ConsoleError(f"{path}: {_detail(e, body)}{hint}")
        err.code, err.body = e.code, body
        raise err from e
    except urllib.error.URLError as e:
        raise ConsoleError(f"cannot reach {base}{path}: {e.reason}") from e
    except (OSError, ValueError, http.client.HTTPException) as e:
        # a bare TimeoutError while waiting for headers, an IncompleteRead, a malformed status line ...
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
    d = body.get("detail")
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


def _bearer(token: str) -> dict:
    return {"Authorization": f"Bearer {token.strip()}"}


def login(console_url: str, username: str, password: str, hostname: str) -> dict:
    """POST /api/operator/login (no auth) with the console username and password; returns {token, username, role}.
    ConsoleError with the console's words on 401 (wrong username or password), 403 (a view-only account: no
    token is minted) and 429 (too many failed attempts; the detail says how long to wait)."""
    base = _base(console_url)
    r = _request(base, "/api/operator/login", {"username": username.strip(), "password": password,
                                                "hostname": hostname})
    if not isinstance(r.get("token"), str) or not r["token"].strip():
        raise ConsoleError("/api/operator/login: response carries no token")
    return {"token": r["token"].strip(), "username": str(r.get("username") or username.strip()),
            "role": str(r.get("role") or "")}


def me(console_url: str, token: str) -> dict:
    """GET /api/operator/me with `Authorization: Bearer <operator token>`. Returns the console's answer
    ({username, role, console_url, timezone, wyze_configured, groups: [{id, name}], playlists: [{id, name}]});
    ConsoleError on a rejected token (401), a view-only account (403) or a malformed answer."""
    base = _base(console_url)
    r = _request(base, "/api/operator/me", headers=_bearer(token))
    if not isinstance(r.get("console_url"), str) or not r["console_url"]:
        r["console_url"] = base
    r["username"] = str(r.get("username") or "")
    for k in ("groups", "playlists"):
        items = r.get(k) if isinstance(r.get(k), list) else []
        r[k] = [g for g in items if isinstance(g, dict) and isinstance(g.get("name"), str)]
    r["wyze_configured"] = bool(r.get("wyze_configured"))  # the provision script's --with-wyze
    return r


def register_device(console_url: str, token: str, device_id: str, name: str, pi_model: str = "") -> dict:
    """POST /api/operator/devices: the projector joins the signed-in account (a new id) or is re-registered
    (an id this account already owns; the console mints a fresh device token either way). Returns
    {device_id, token, cms_url, owner, created}; ConsoleError on 401 (sign in again), 403 (view-only), 409
    (the id belongs to another account) or a malformed answer."""
    base = _base(console_url)
    r = _request(base, "/api/operator/devices", {"device_id": device_id.strip().lower(), "name": name,
                                                  "pi_model": pi_model}, headers=_bearer(token))
    tok = r.get("token")
    if not isinstance(tok, str) or not tok.strip():
        raise ConsoleError("/api/operator/devices: response carries no token")
    return {"device_id": str(r.get("device_id") or device_id.strip().lower()), "token": tok.strip(),
            "cms_url": str(r.get("cms_url") or base), "owner": str(r.get("owner") or ""),
            "created": bool(r.get("created"))}
