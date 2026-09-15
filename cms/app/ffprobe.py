import json
import shutil
import subprocess
from pathlib import Path


class FfprobeUnavailable(RuntimeError):
    pass


def have_ffprobe() -> bool:
    return shutil.which("ffprobe") is not None


def probe(path: Path) -> dict:
    """Return {duration_seconds, width, height, codec, nb_frames} or raise.

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

    nb_frames = None
    if video_stream and video_stream.get("nb_frames"):
        try:
            nb_frames = int(video_stream["nb_frames"])
        except (TypeError, ValueError):
            nb_frames = None

    return {
        "duration_seconds": duration,
        "width": (video_stream or {}).get("width"),
        "height": (video_stream or {}).get("height"),
        "codec": (video_stream or {}).get("codec_name"),
        "nb_frames": nb_frames,
        "format_name": fmt.get("format_name"),
    }


def is_still_image(probe_data: dict) -> bool:
    """True when ffprobe demuxed the file as a single picture (png_pipe, image2 for JPEG,
    webp_pipe, bmp_pipe, a one-frame gif) rather than a video container."""
    fmt = probe_data.get("format_name") or ""
    if fmt.endswith("_pipe") or fmt == "image2":
        return True
    return fmt == "gif" and (probe_data.get("nb_frames") or 0) <= 1
