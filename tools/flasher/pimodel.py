"""The Raspberry Pi models the flasher can make a card for: one table, newest first, the Pi 1 B+ last.

arch decides the image: arm64 models boot the bundled 64-bit Raspberry Pi OS Lite, armhf models (no 64-bit
kernel: Pi 1, Pi 2 v1.1, Zero, Zero W) need the 32-bit image, downloaded once. camera and ram_mb (the lowest
variant) are what the Pi side checks too: the Wyze camera bridge needs arm64 and at least 1 GB.
"""
from collections import namedtuple

Model = namedtuple("Model", "key label arch hint camera ram_mb")

DOWNLOAD_MB = 530  # the armhf image today (557,524,176 bytes); the log shows the real size when it downloads

MODELS = (
    Model("pi5", "Raspberry Pi 5 / 500", "arm64",
          "Best pick. 4K video, camera, remote access.", True, 2048),
    Model("pi4", "Raspberry Pi 4 / 400", "arm64",
          "1080p video, camera, remote access.", True, 1024),
    Model("pi3", "Raspberry Pi 3 (B, B+, A+)", "arm64",
          "1080p video, camera, remote access. Slower updates.", True, 512),
    Model("zero2", "Raspberry Pi Zero 2 W", "arm64",
          "1080p video, remote access. No camera (512 MB is not enough for the camera bridge).", False, 512),
    Model("pi2v12", "Raspberry Pi 2 Model B V1.2", "arm64",
          "Same chip as the Pi 3. 1080p video, camera, remote access. Board print says V1.2.", True, 1024),
    Model("pi2", "Raspberry Pi 2 Model B V1.1", "armhf",
          f"32-bit image, downloaded once (about {DOWNLOAD_MB} MB). 1080p may stutter. No camera. "
          "Board print says V1.1 (the common one).", False, 1024),
    Model("zero", "Raspberry Pi Zero / Zero W", "armhf",
          "32-bit image, downloaded once. Slow: 720p at best. No camera. "
          "Zero (no W) needs a USB Wi-Fi or Ethernet adapter.", False, 512),
    Model("pi1bplus", "Raspberry Pi 1 Model B+ / A+", "armhf",
          "32-bit image, downloaded once. Slow: 720p at best. No camera. Wi-Fi needs a USB adapter.", False, 256),
)
DEFAULT = "pi5"
BY_KEY = {m.key: m for m in MODELS}
LABELS = [m.label for m in MODELS]


def get(key) -> Model:
    """The model for a key; anything unknown (a hand-edited flasher.json) is the default, silently."""
    return BY_KEY.get(key, BY_KEY[DEFAULT])


def by_label(label: str) -> Model:
    return next((m for m in MODELS if m.label == label), BY_KEY[DEFAULT])


def table() -> str:
    """One line per model for --selfcheck."""
    return "\n".join(f"  {m.key:<9} {m.arch}  {m.label}" for m in MODELS)
