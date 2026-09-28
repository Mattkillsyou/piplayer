"""Videos on a USB stick: what a projector plays while it cannot reach the website (no internet).

install-player.sh's udev rule mounts every USB stick read-only under USB_ROOT (systemd-mount, so
pulling a stick out cannot corrupt it). The daemon switches to the stick after a minute without
the website and back to the website's playlist once it answers again.
"""
from __future__ import annotations

import os
from pathlib import Path

USB_ROOT = Path("/media/projector-usb")
VIDEO = frozenset({".mp4", ".m4v", ".mov", ".mkv", ".avi", ".webm", ".mpg", ".mpeg", ".ts", ".gif"})
IMAGE = frozenset({".jpg", ".jpeg", ".png", ".bmp", ".webp"})
IMAGE_SECONDS = 10


def mounts(root: Path | None = None) -> list[Path]:
    """The sticks mounted now (an empty folder left behind by one pulled out is not a mount)."""
    root = USB_ROOT if root is None else root
    try:
        return sorted(p for p in root.iterdir() if os.path.ismount(p))
    except OSError:
        return []


def playlist(root: Path | None = None) -> list[tuple[Path, dict]]:
    """(path, mpv options) for every video and picture in the top folder of each stick, by name, as
    videolooper plays a stick. Hidden files and the "._" copies a Mac leaves are skipped."""
    out: list[tuple[Path, dict]] = []
    for stick in mounts(root):
        try:
            files = sorted((p for p in stick.iterdir() if p.is_file()), key=lambda p: p.name.lower())
        except OSError:
            continue
        for p in files:
            ext = p.suffix.lower()
            if p.name.startswith("."):
                continue
            if ext in VIDEO:
                out.append((p, {}))
            elif ext in IMAGE:
                out.append((p, {"image-display-duration": str(IMAGE_SECONDS)}))
    return out
