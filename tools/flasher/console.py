"""Register a device on the Projection5000 console and fetch its token (stdlib urllib + CookieJar)."""
import html
import http.cookiejar
import json
import re
import urllib.error
import urllib.parse
import urllib.request

CSRF_RE = re.compile(r'name="csrf_token"\s+value="([^"]+)"')
LOGIN_ERROR_RE = re.compile(r'<div class="alert error">(.*?)</div>', re.S)
TIMEOUT = 30


class ConsoleError(Exception):
    pass


class Console:
    def __init__(self, base_url: str):
        self.base = base_url.strip().rstrip("/")
        if not self.base.startswith(("http://", "https://")):
            raise ConsoleError("console URL must start with http:// or https://")
        self.jar = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.jar))

    def _open(self, path: str, form: dict = None):
        data = urllib.parse.urlencode(form).encode() if form is not None else None
        req = urllib.request.Request(self.base + path, data=data, headers={"User-Agent": "Projection5000-SD-Flasher"})
        try:
            with self.opener.open(req, timeout=TIMEOUT) as resp:
                return resp.geturl(), resp.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as e:
            raise ConsoleError(f"{path}: {_detail(e)}") from e
        except urllib.error.URLError as e:
            raise ConsoleError(f"cannot reach {self.base}: {e.reason}") from e

    def _csrf(self, path: str) -> str:
        _, body = self._open(path)
        m = CSRF_RE.search(body)
        if not m:
            raise ConsoleError(f"no CSRF token on {path}: is this a Projection5000 console?")
        return m.group(1)

    def login(self, username: str, password: str) -> None:
        csrf = self._csrf("/login")
        url, body = self._open("/login", {"username": username, "password": password, "csrf_token": csrf})
        if urllib.parse.urlparse(url).path.rstrip("/") == "/login":
            m = LOGIN_ERROR_RE.search(body)
            raise ConsoleError(html.unescape(m.group(1).strip()) if m else "login failed")

    def create_device(self, device_id: str, name: str) -> None:
        """POST /devices; an existing device_id (409) is fine, the token is fetched afterwards."""
        csrf = self._csrf("/devices")
        try:
            self._open("/devices", {"device_id": device_id, "name": name, "csrf_token": csrf})
        except ConsoleError as e:
            if getattr(e.__cause__, "code", None) != 409:
                raise

    def device_token(self, device_id: str) -> str:
        _, body = self._open("/devices")
        m = re.search(r"DEVICE_ID=" + re.escape(device_id) + r" \\\nDEVICE_TOKEN=(\S+)", body)
        if not m:
            raise ConsoleError(f"device {device_id} has no visible token (need editor or admin role)")
        return html.unescape(m.group(1).rstrip("\\"))


def _detail(e: urllib.error.HTTPError) -> str:
    body = e.read().decode("utf-8", "replace")
    try:
        d = json.loads(body).get("detail")
        if d:
            return str(d)
    except ValueError:
        pass
    m = LOGIN_ERROR_RE.search(body)
    if m:
        return html.unescape(m.group(1).strip())
    return f"HTTP {e.code} {e.reason}"


def register_device(base_url: str, username: str, password: str, device_id: str, name: str) -> str:
    c = Console(base_url)
    c.login(username, password)
    c.create_device(device_id, name)
    return c.device_token(device_id)
