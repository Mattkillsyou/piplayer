"""The OS image embedded in the flasher program.

build.ps1 appends the .img.xz and a fixed 256-byte trailer after PyInstaller's onefile archive (the
bootloader ignores trailing bytes); build_mac.sh writes the same bytes (image plus trailer) to
Contents/Resources/bundle.bin inside the .app. At flash time the image is streamed straight out of that file
through a SliceReader, so nothing is downloaded or extracted.

Trailer (last 256 bytes of the file):
    name (utf-8, NUL padded, 128) | sha256 hex (64) | length (8 LE) | offset (8 LE) | reserved (40) | magic (8)
offset/length locate the image bytes inside the same file.
"""
import hashlib
import os
import struct
import sys
from dataclasses import dataclass

TRAILER_MAGIC = b"P5KIMG01"
TRAILER_SIZE = 256
_TRAILER = struct.Struct("<128s64sQQ40s8s")
CHUNK = 8 * 1024 * 1024
assert _TRAILER.size == TRAILER_SIZE


class BundleError(Exception):
    pass


class SliceReader:
    """Read-only file-like confined to [offset, offset + size) of a file."""

    def __init__(self, path, offset: int, size: int):
        self._f = open(path, "rb")
        self._offset = offset
        self.size = size
        self._pos = 0

    def read(self, n: int = -1) -> bytes:
        left = self.size - self._pos
        if n < 0 or n > left:
            n = left
        if n <= 0:
            return b""
        self._f.seek(self._offset + self._pos)
        data = self._f.read(n)
        self._pos += len(data)
        return data

    def seek(self, offset: int, whence: int = os.SEEK_SET) -> int:
        base = {os.SEEK_SET: 0, os.SEEK_CUR: self._pos, os.SEEK_END: self.size}[whence]
        if base + offset < 0:
            raise ValueError("negative seek position")
        self._pos = base + offset  # past the end is allowed, like a real file; reads there return b""
        return self._pos

    def tell(self) -> int:
        return self._pos

    def readable(self) -> bool:
        return True

    def seekable(self) -> bool:
        return True

    def close(self) -> None:
        self._f.close()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()


@dataclass(frozen=True)
class BundledImage:
    path: str
    offset: int
    length: int
    sha256: str
    name: str

    def open(self) -> SliceReader:
        return SliceReader(self.path, self.offset, self.length)


def _pack(name: str, sha256: str, length: int, offset: int) -> bytes:
    raw = name.encode("utf-8")
    if not raw or len(raw) > 128:
        raise BundleError(f"bundle name must be 1-128 utf-8 bytes: {name!r}")
    return _TRAILER.pack(raw, sha256.encode("ascii"), length, offset, b"\0" * 40, TRAILER_MAGIC)


def bundle_paths() -> list:
    """Where a frozen build carries its image: the exe itself (Windows, the trailer appended by build.ps1) or
    Contents/Resources/bundle.bin next to the executable inside a macOS .app (build_mac.sh; a Mach-O with bytes
    appended fails its signature, so the trailer file lives in Resources instead)."""
    exe = sys.executable
    return [exe, os.path.join(os.path.dirname(os.path.dirname(exe)), "Resources", "bundle.bin")]


def find_bundle(path=None):
    """The BundledImage in path (default: this frozen program's own places, see bundle_paths), or None when
    there is no valid trailer."""
    if path is None:
        if not getattr(sys, "frozen", False):
            return None
        return next((b for b in map(find_bundle, bundle_paths()) if b is not None), None)
    try:
        size = os.path.getsize(path)
        if size < TRAILER_SIZE:
            return None
        with open(path, "rb") as f:
            f.seek(size - TRAILER_SIZE)
            raw = f.read(TRAILER_SIZE)
    except OSError:
        return None
    if len(raw) != TRAILER_SIZE or raw[-8:] != TRAILER_MAGIC:
        return None
    name, sha, length, offset, _, _ = _TRAILER.unpack(raw)
    sha = sha.decode("ascii", "replace").lower()
    if len(sha) != 64 or any(c not in "0123456789abcdef" for c in sha):
        return None
    if length == 0 or offset + length > size - TRAILER_SIZE:
        return None
    return BundledImage(os.fspath(path), offset, length, sha, name.rstrip(b"\0").decode("utf-8", "replace"))


def append_bundle(exe_path, image_path, name: str) -> BundledImage:
    """Copy image_path onto the end of exe_path and write the trailer. Refuses a second bundle."""
    if find_bundle(exe_path) is not None:
        raise BundleError(f"{exe_path} already carries a bundled image; strip_bundle it first")
    _pack(name, "0" * 64, 0, 0)  # validate the name before touching the exe
    if os.path.getsize(image_path) == 0:
        raise BundleError(f"{image_path} is empty; refusing to bundle a zero-length image")
    h = hashlib.sha256()
    length = 0
    with open(exe_path, "r+b") as out, open(image_path, "rb") as src:
        out.seek(0, os.SEEK_END)
        offset = out.tell()
        for block in iter(lambda: src.read(CHUNK), b""):
            h.update(block)
            out.write(block)
            length += len(block)
        out.write(_pack(name, h.hexdigest(), length, offset))
    return BundledImage(os.fspath(exe_path), offset, length, h.hexdigest(), name)


def strip_bundle(exe_path) -> bool:
    """Truncate a bundled exe back to its original size. False when nothing was bundled."""
    b = find_bundle(exe_path)
    if b is None:
        return False
    os.truncate(exe_path, b.offset)
    return True
