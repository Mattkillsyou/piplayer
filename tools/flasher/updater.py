"""Keep the flasher up to date: ask the console what the newest build is, fetch it, hand it to the host.

No Tk in here (flasher.py drives it from a background thread, winhost / machost install what comes out).
The console answers GET /api/flasher/latest with {"version", "windows", "mac_arm64", "mac_intel", "notes"};
the assets themselves live on GitHub, so a download may hop to github.com once. Nothing outside the console's
own host and GitHub is ever fetched, and nothing is run that did not come from there.

VERSION below is the one source of truth for the program's version: version.txt (the PyInstaller resource
Explorer shows) and installer.iss (AppVersion) repeat it and tests/test_updater.py checks all three agree.
"""
import json
import re
import urllib.parse
import urllib.request
from pathlib import Path

import console
import imagefetch
from sysplat import host

VERSION = "0.7.3"
CHECK_EVERY = 7 * 24 * 3600  # seconds; the owner's "check for updates weekly"
PATH = "/api/flasher/latest"
KEYS = ("version", "windows", "mac_arm64", "mac_intel", "notes")
STATE_KEYS = ("last_check", "last_seen_version", "downloaded", "downloaded_version")
DOTTED = re.compile(r"\d+(\.\d+)*$")
TIMEOUT, DOWNLOAD_TIMEOUT = 10, 60
CHUNK = 1024 * 1024
# The Windows installer is about 531 MB: anything far outside that is not an installer, so it is not written.
MIN_BYTES, MAX_BYTES = 50 * 1024 ** 2, 2 * 1024 ** 3
GITHUB_HOSTS = ("github.com", "objects.githubusercontent.com")  # where the release assets are served from


# ---------------------------------------------------------------- versions

def _parts(v) -> tuple:
    try:
        return tuple(int(p) for p in str(v).strip().split("."))
    except ValueError:
        return ()


def newer(a: str, b: str) -> bool:
    """True when version a is newer than version b, compared number by number: 0.10.0 is newer than 0.9.0,
    which a string compare gets backwards. Anything that is not a dotted number is newer than nothing."""
    pa, pb = _parts(a), _parts(b)
    return bool(pa and pb and pa > pb)


# ---------------------------------------------------------------- state (its own file, next to the settings)

def state_path() -> Path:
    """update.json in the data folder: the settings file keeps its shape, this one keeps the update's."""
    return imagefetch.app_dir() / "update.json"


def load_state() -> dict:
    try:
        s = json.loads(state_path().read_text("utf-8"))
    except (OSError, ValueError):
        return {}
    return {k: v for k, v in s.items() if k in STATE_KEYS} if isinstance(s, dict) else {}


def save_state(state: dict) -> None:
    """Never raises: a full or read-only profile must not stop the flasher (like save_settings)."""
    try:
        state_path().parent.mkdir(parents=True, exist_ok=True)
        state_path().write_text(json.dumps({k: state[k] for k in STATE_KEYS if k in state}, indent=2), "utf-8")
    except OSError:
        pass


def due(state: dict, now: float) -> bool:
    """True when the last check was more than CHECK_EVERY ago, or there has never been one."""
    try:
        last = float(state.get("last_check") or 0)
    except (TypeError, ValueError):
        return True
    return now - last >= CHECK_EVERY


# ---------------------------------------------------------------- what the console says is newest

def latest(console_url: str) -> dict:
    """GET /api/flasher/latest (no sign-in: the console answers the same to everyone). ConsoleError when it
    answers something that is not the documented shape, or when the console is plain http: what comes back
    decides which file is run as administrator, so it has to be a reply nobody on the way can rewrite."""
    base = console._base(console_url)
    if not base.lower().startswith("https://"):
        raise console.ConsoleError(f"refusing to check for updates over {base}: https only")
    r = console._request(base, PATH, timeout=TIMEOUT)
    out = {k: str(r.get(k) or "").strip() for k in KEYS}
    if not DOTTED.match(out["version"]):
        raise console.ConsoleError(f"{PATH}: no version in the answer ({console.NOT_A_CONSOLE})")
    return out


# ---------------------------------------------------------------- fetching the installer

def _check(url: str, console_url: str) -> None:
    """https only, and only the console's own host or GitHub (where the release assets are served from)."""
    u = urllib.parse.urlsplit(url or "")
    if u.scheme != "https":
        raise console.ConsoleError(f"refusing {url or '(nothing)'}: updates are only fetched over https")
    allowed = (urllib.parse.urlsplit(console_url).hostname or "", *GITHUB_HOSTS)
    if (u.hostname or "").lower() not in [a.lower() for a in allowed if a]:
        raise console.ConsoleError(f"refusing {url}: {u.hostname} is not the console or GitHub")


class _Redirect(urllib.request.HTTPRedirectHandler):
    """The asset URL on the console redirects to GitHub, which redirects again to its object store: follow
    that, but only ever to a host _check allows, and not for ever."""
    max_redirections = 5

    def __init__(self, console_url: str):
        self.console_url = console_url

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        _check(newurl, self.console_url)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def _open(url: str, console_url: str):
    """The response for url, following only the redirects _check allows."""
    _check(url, console_url)
    opener = urllib.request.build_opener(_Redirect(console_url),
                                         urllib.request.HTTPSHandler(context=host.ssl_context()))
    req = urllib.request.Request(url, headers={"User-Agent": console.HEADERS["User-Agent"]})
    return opener.open(req, timeout=DOWNLOAD_TIMEOUT)


def updates_dir() -> Path:
    """The one folder a downloaded installer may live in, writable by administrators only (host.updates_dir).
    The file in it is run with administrator rights, so a folder the logged-in user could write to would hand
    every process running as that user an easy way in."""
    return host.updates_dir()


def download_path(url: str) -> Path:
    """Where a downloaded installer waits for the next quiet moment: <updates folder>/<its file name>. Only
    the file name of the URL is used (never a path from it), so nothing can be written outside that folder."""
    return updates_dir() / (Path(urllib.parse.urlsplit(url).path).name or "update")


def installer_ok(path) -> bool:
    """True when path is a file directly inside the updates folder: what the state file remembers is a hint,
    never a reason to run something from anywhere on the disk."""
    try:
        p = Path(path).resolve(strict=True)
        return p.is_file() and p.parent == updates_dir().resolve()
    except OSError:
        return False


def prune(keep: Path) -> None:
    """Drop the installers of earlier updates (half a gigabyte each), keeping the one just downloaded. A file
    Windows still has open simply stays. Only ever the updates folder, never wherever else a caller wrote."""
    d = updates_dir()
    if Path(keep).parent != d:
        return
    for old in d.iterdir():
        if old != Path(keep):
            try:
                old.unlink()
            except OSError:
                pass


def download(url: str, dest, console_url: str, progress=None, cancel=None) -> Path:
    """Stream url to dest through dest.part, renaming only once the whole Content-Length has arrived: a failed
    or partial download leaves nothing that looks finished. progress(done, total)."""
    dest, part = Path(dest), Path(str(dest) + ".part")
    resp = _open(url, console_url)
    total = int(resp.headers.get("Content-Length") or 0)
    if not MIN_BYTES <= total <= MAX_BYTES:
        resp.close()
        raise console.ConsoleError(f"refusing {url}: {total} bytes is not an installer")
    done = 0
    try:
        with resp, open(part, "wb") as out:
            while True:
                if cancel is not None and cancel.is_set():
                    raise console.ConsoleError("update download cancelled")
                buf = resp.read(CHUNK)
                if not buf:
                    break
                out.write(buf)
                done += len(buf)
                if progress:
                    progress(done, total)
        if done != total:
            raise console.ConsoleError(f"{url}: download truncated ({done} of {total} bytes)")
        part.replace(dest)
        prune(dest)  # only once the new one has landed whole
    except BaseException:
        part.unlink(missing_ok=True)
        raise
    return dest
