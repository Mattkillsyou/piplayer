"""Download and cache Raspberry Pi OS images (stdlib urllib only)."""
import hashlib
import shutil
import time
import urllib.parse
import urllib.request
from pathlib import Path

from sysplat import host

LATEST_URLS = {"arm64": "https://downloads.raspberrypi.com/raspios_lite_arm64_latest",
               "armhf": "https://downloads.raspberrypi.com/raspios_lite_armhf_latest"}
LATEST_URL = LATEST_URLS["arm64"]
USER_AGENT = "Projection5000-SD-Flasher/1.0"


class Cancelled(Exception):
    pass


class FetchError(Exception):
    pass


def _request(url: str) -> urllib.request.Request:
    return urllib.request.Request(url, headers={"User-Agent": USER_AGENT})


def app_dir() -> Path:
    """The data folder: %LOCALAPPDATA%\\Projection5000 or ~/Library/Application Support/Projection5000."""
    return host.data_dir()


def cached_path(filename: str) -> Path:
    d = app_dir() / "images"
    d.mkdir(parents=True, exist_ok=True)
    return d / Path(filename).name


def remember_sha256(path, expected: str) -> None:
    """Keep the published sha256 next to a verified download (<name>.sha256), so the image can be checked and
    used again without the network. Never raises."""
    try:
        Path(path).with_name(Path(path).name + ".sha256").write_text(f"{expected.strip().lower()}  {Path(path).name}\n")
    except OSError:
        pass


def newest_cached(arch: str):
    """(path, sha256) of the newest cached Raspberry Pi OS image for arch ('arm64' / 'armhf') that has its
    sha256 alongside, else None. Newest by the date in the official file name (2026-09-15-raspios-...)."""
    d = app_dir() / "images"
    try:
        files = sorted(p for p in d.iterdir() if p.suffix == ".xz" and f"_{arch}" in p.name.replace("-", "_"))
    except OSError:
        return None
    for p in reversed(files):
        try:
            sha = p.with_name(p.name + ".sha256").read_text().split()[0].lower()
        except (OSError, IndexError):
            continue
        if len(sha) == 64:
            return p, sha
    return None


def _open(req, timeout: int):
    return urllib.request.urlopen(req, timeout=timeout, context=host.ssl_context())


def resolve_latest(url: str = LATEST_URL) -> tuple:
    """Follow redirects and return (final_url, filename). The redirect must stay on the same origin:
    the .sha256 is fetched from the final URL too, so a hop to another host or to http:// would let
    that host vouch for its own image."""
    try:
        with _open(_request(url), timeout=30) as resp:
            final = resp.geturl()
    except Exception as e:
        raise FetchError(f"cannot resolve {url}: {e}") from e
    want, got = urllib.parse.urlsplit(url), urllib.parse.urlsplit(final)
    if (got.scheme, got.netloc) != (want.scheme, want.netloc):
        raise FetchError(f"{url} redirected off its origin to {final}; refusing")
    name = Path(urllib.parse.urlparse(final).path).name
    if not name:
        raise FetchError(f"no filename in {final}")
    return final, name


def remote_size(url: str):
    """Content-Length of url (HEAD), or None when the server does not say: only for a log line."""
    try:
        with _open(urllib.request.Request(url, headers={"User-Agent": USER_AGENT}, method="HEAD"), timeout=30) as resp:
            return int(resp.headers.get("Content-Length") or 0) or None
    except Exception:
        return None


def fetch_sha256(url: str) -> str:
    """Read '<hex>  <filename>' from <url>.sha256."""
    try:
        with _open(_request(url + ".sha256"), timeout=30) as resp:
            text = resp.read(4096).decode("utf-8", "replace")
    except Exception as e:
        raise FetchError(f"cannot fetch checksum: {e}") from e
    parts = text.split()
    if not parts or len(parts[0]) != 64:
        raise FetchError(f"unexpected checksum file: {text.strip()[:80]!r}")
    return parts[0].lower()


def download(url: str, dest, progress_cb=None, cancel_event=None) -> Path:
    """Stream url to dest (via dest.part). progress_cb(done, total_or_None, bytes_per_sec)."""
    dest = Path(dest)
    part = dest.with_name(dest.name + ".part")
    try:
        resp = _open(_request(url), timeout=60)
    except Exception as e:
        raise FetchError(f"download failed: {e}") from e
    total = resp.headers.get("Content-Length")
    total = int(total) if total else None
    done = 0
    start = time.monotonic()
    try:
        with resp, open(part, "wb") as out:
            while True:
                if cancel_event is not None and cancel_event.is_set():
                    raise Cancelled()
                try:
                    buf = resp.read(1024 * 1024)
                except (OSError, ValueError) as e:  # a reset or stalled connection mid-download
                    raise FetchError(f"download interrupted after {done / 1e6:.0f} MB: {e}") from e
                if not buf:
                    break
                out.write(buf)
                done += len(buf)
                if progress_cb:
                    rate = done / max(time.monotonic() - start, 1e-6)
                    progress_cb(done, total, rate)
        if total is not None and done != total:
            raise FetchError(f"download truncated: {done} of {total} bytes")
        shutil.move(str(part), str(dest))
    except BaseException:
        part.unlink(missing_ok=True)
        raise
    return dest


def sha256_file(path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(4 * 1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def verify_sha256(path, expected: str) -> bool:
    return sha256_file(path) == expected.strip().lower()
