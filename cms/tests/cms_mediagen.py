"""Synthesize small, unique, ffprobe-valid media files for tests.

Every file gets unique bytes (random pixels / random colour + a metadata tag) so
that uploading it never collides with the CMS's sha256 duplicate check, even
when the same test runs twice against the same database.

- make_png(): pure Python (zlib + struct), no external tools.
- make_mp4(): needs ffmpeg on PATH (it is on the Pi and on the dev box).
"""
import random
import shutil
import struct
import subprocess
import zlib
from pathlib import Path


def have_ffmpeg() -> bool:
    return shutil.which("ffmpeg") is not None


def _png_chunk(tag: bytes, data: bytes) -> bytes:
    body = tag + data
    return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)


def make_png(path, seed=None, size=64) -> Path:
    """Write a valid RGB PNG of random pixels to `path` and return it."""
    path = Path(path)
    rng = random.Random(seed)
    rows = []
    for _ in range(size):
        rows.append(b"\x00" + bytes(rng.getrandbits(8) for _ in range(size * 3)))
    raw = b"".join(rows)
    ihdr = struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0)
    data = (
        b"\x89PNG\r\n\x1a\n"
        + _png_chunk(b"IHDR", ihdr)
        + _png_chunk(b"IDAT", zlib.compress(raw, 6))
        + _png_chunk(b"IEND", b"")
    )
    path.write_bytes(data)
    return path


def make_mp4(path, seed=None, duration=2, size="320x240") -> Path:
    """Write a short valid H.264/MP4 clip of a random solid colour to `path`."""
    path = Path(path)
    if not have_ffmpeg():
        raise RuntimeError("ffmpeg not found on PATH; needed to synthesize test video")
    rng = random.Random(seed)
    colour = "0x%06x" % rng.getrandbits(24)
    tag = "piplayer-test-%08x" % rng.getrandbits(32)
    cmd = [
        "ffmpeg", "-y", "-loglevel", "error", "-nostdin",
        "-f", "lavfi", "-i", f"color=c={colour}:size={size}:rate=10:duration={duration}",
        "-pix_fmt", "yuv420p",
        "-metadata", f"title={tag}",
        str(path),
    ]
    subprocess.run(cmd, check=True, capture_output=True, timeout=60)
    return path


def make_jpeg_bytes(seed=None, junk=2048) -> bytes:
    """Bytes that pass a JPEG magic-number check (FF D8 FF) -- enough for the
    screenshot endpoint, which only validates the magic bytes."""
    rng = random.Random(seed)
    body = bytes(rng.getrandbits(8) for _ in range(junk))
    return b"\xff\xd8\xff\xe0\x00\x10JFIF\x00" + body + b"\xff\xd9"
