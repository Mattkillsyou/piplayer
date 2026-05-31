import json
import shutil
import subprocess
from pathlib import Path


class FfprobeUnavailable(RuntimeError):
    pass


def have_ffprobe() -> bool:
    return shutil.which("ffprobe") is not None


def probe(path: Path) -> dict:
    """Return {duration_seconds, width, height, codec} or raise.

    Returns best-effort values; missing fields are None. Raises FfprobeUnavailable
    if ffprobe isn't installed."""
    if not have_ffprobe():
        raise FfprobeUnavailable("ffprobe not found on PATH")

    cmd = [
        "ffprobe",
        "-v", "error",
        "-print_format", "json",
        "-show_format",
        "-show_streams",
        str(path),
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
    if result.returncode != 0:
        raise RuntimeError(f"ffprobe failed: {result.stderr.strip()[:200]}")

    data = json.loads(result.stdout)
    video_stream = next(
        (s for s in data.get("streams", []) if s.get("codec_type") == "video"),
        None,
    )
    duration = None
    fmt = data.get("format", {})
    if fmt.get("duration"):
        try:
            duration = float(fmt["duration"])
        except (TypeError, ValueError):
            duration = None

    return {
        "duration_seconds": duration,
        "width": (video_stream or {}).get("width"),
        "height": (video_stream or {}).get("height"),
        "codec": (video_stream or {}).get("codec_name"),
    }
