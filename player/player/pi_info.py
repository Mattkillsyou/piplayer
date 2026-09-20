"""What kind of Pi this is, reported to the console on every sync as the
pi_model and camera_supported query params. Same rule as pi_caps in
deploy/install-player.sh: the camera bridge (Docker + the arm64-only
wyze-bridge image) needs a 64-bit OS and at least CAMERA_MIN_MEM_KB of RAM."""
import functools
import platform
import sys
from pathlib import Path

MODEL_PATH = Path("/proc/device-tree/model")
MEMINFO_PATH = Path("/proc/meminfo")
CAMERA_MIN_MEM_KB = 900_000


def pi_model(path: Path | None = None) -> str:
    """The board string ("Raspberry Pi 4 Model B Rev 1.5"), NUL stripped, max 64 chars; "" off a Pi."""
    try:
        return (path or MODEL_PATH).read_bytes().replace(b"\0", b"").decode("utf-8", "replace").strip()[:64]
    except OSError:
        return ""


def mem_total_kb(path: Path | None = None) -> int:
    try:
        for line in (path or MEMINFO_PATH).read_text().splitlines():
            if line.startswith("MemTotal:"):
                return int(line.split()[1])
    except (OSError, ValueError, IndexError):
        pass
    return 0


def camera_supported(machine: str | None = None, bits64: bool | None = None, mem_kb: int | None = None) -> bool:
    """arm64 userland (a 64-bit kernel over a 32-bit OS, as on a Pi 4 with the
    armhf image, reports aarch64 too, hence the interpreter-size check) with
    enough RAM."""
    machine = platform.machine() if machine is None else machine
    bits64 = sys.maxsize > 2 ** 32 if bits64 is None else bits64
    mem_kb = mem_total_kb() if mem_kb is None else mem_kb
    return machine == "aarch64" and bits64 and mem_kb >= CAMERA_MIN_MEM_KB


@functools.cache
def sync_params() -> dict[str, str]:
    """Probed once per process (the hardware does not change while running)."""
    return {"pi_model": pi_model(), "camera_supported": "1" if camera_supported() else "0"}
