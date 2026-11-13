"""ffmpeg location, running and probing for the post kit (CB4 / KAN-913).

Same standard as the Episode finish step (dashboard/server/episode/finish/ffmpeg.js and probe.js), ported to Python because the
post kit runs in Python next to the Blender-built frames:
  - location: FFMPEG_PATH, then imageio_ffmpeg's bundled binary, then PATH. Nothing is downloaded.
  - running: argument list, no shell, timeout, only the tail of stderr kept.
  - probe: `ffmpeg -i` (there is no ffprobe) and the same targets, durations within 0.2 s and fps within 0.5.
"""
import os
import stat
import re
import shutil
import subprocess
from pathlib import Path

TARGETS = {"duration_tolerance": 0.2, "fps_tolerance": 0.5}   # mirrors TARGETS in finish/probe.js
STDERR_TAIL = 4000
DEFAULT_TIMEOUT = 600


class MediaError(RuntimeError):
    pass


def resolve_ffmpeg(env=None):
    env = os.environ if env is None else env
    given = env.get("FFMPEG_PATH")
    if given and os.path.isfile(given):
        return given
    try:
        import imageio_ffmpeg
        found = imageio_ffmpeg.get_ffmpeg_exe()
        if found and os.path.isfile(found):
            return found
    except Exception:
        pass
    found = shutil.which("ffmpeg")
    if found:
        return found
    raise MediaError("ffmpeg not found: set FFMPEG_PATH or install imageio-ffmpeg (nothing is downloaded)")


def run_ffmpeg(args, timeout=DEFAULT_TIMEOUT, ffmpeg=None):
    """Run ffmpeg with an argument list. Returns stderr text; raises MediaError with the stderr tail on failure."""
    if not args or any((not isinstance(a, str)) or "\x00" in a for a in args):
        raise MediaError("invalid ffmpeg argument list")
    try:
        done = subprocess.run([ffmpeg or resolve_ffmpeg(), "-hide_banner", *args], capture_output=True, timeout=timeout, shell=False)
    except subprocess.TimeoutExpired as err:
        raise MediaError(f"ffmpeg timed out after {timeout}s") from err
    tail = done.stderr.decode("utf-8", "replace")[-STDERR_TAIL:]
    if done.returncode != 0:
        raise MediaError(f"ffmpeg failed ({done.returncode}): {tail}")
    return tail


def probe(path, ffmpeg=None):
    """Duration, size, fps and stream kinds of a media file, read from `ffmpeg -i` (which exits 1 with no output file)."""
    done = subprocess.run([ffmpeg or resolve_ffmpeg(), "-hide_banner", "-i", str(path)], capture_output=True, timeout=60, shell=False)
    text = done.stderr.decode("utf-8", "replace")
    dur = re.search(r"Duration:\s*(\d+):(\d\d):(\d\d(?:\.\d+)?)", text)
    if not dur:
        raise MediaError("ffmpeg did not report a duration for the file")
    video = next((ln for ln in text.splitlines() if re.search(r"Stream #\d+:\d+[^\n]*?: Video:", ln) and "attached pic" not in ln), None)
    size = re.search(r",\s(\d{2,5})x(\d{2,5})[\s,\[]", video) if video else None
    fps = (re.search(r"(\d+(?:\.\d+)?) fps", video) or re.search(r"(\d+(?:\.\d+)?) tbr", video)) if video else None
    return {
        "duration": round(int(dur[1]) * 3600 + int(dur[2]) * 60 + float(dur[3]), 3),
        "width": int(size[1]) if size else None, "height": int(size[2]) if size else None,
        "fps": float(fps[1]) if fps else None,
        "has_video": video is not None, "has_audio": bool(re.search(r"Stream #\d+:\d+[^\n]*?: Audio:", text)),
    }


def judge(measured, width, height, fps, duration):
    """Problems (a list of short strings, empty = pass) comparing a probe with what was asked for."""
    problems = []
    if not measured["has_video"]:
        problems.append("no video stream")
    if not measured["has_audio"]:
        problems.append("no audio stream")
    if (measured["width"], measured["height"]) != (width, height):
        problems.append(f"size {measured['width']}x{measured['height']} is not {width}x{height}")
    if measured["fps"] is None or abs(measured["fps"] - fps) > TARGETS["fps_tolerance"]:
        problems.append(f"fps {measured['fps']} is not {fps} within {TARGETS['fps_tolerance']}")
    if abs(measured["duration"] - duration) > TARGETS["duration_tolerance"]:
        problems.append(f"duration {measured['duration']} s is not {duration:.3f} s within {TARGETS['duration_tolerance']}")
    return problems


# ---------- path guards (fix round 1) ----------
_BAD_NAME_CHARS = set('<>:"|?*/' + chr(92))


def safe_name(name):
    """A bare file stem for output files. Rejects separators, '.', '..', absolute names, drive letters, NUL and control characters."""
    if not isinstance(name, str) or not name or name != name.strip():
        raise MediaError("output name must be a non-empty string without surrounding spaces")
    if "\x00" in name or any(ord(c) < 32 for c in name):
        raise MediaError("output name has a NUL or control character")
    if any(c in _BAD_NAME_CHARS for c in name):
        raise MediaError(f"output name {name!r} has a path separator, drive letter or reserved character")
    if name in (".", "..") or name.endswith(".") or len(name) > 100:
        raise MediaError(f"output name {name!r} is not allowed")
    return name


def safe_out_dir(out_dir):
    """The resolved output directory. Rejects NUL, an empty value, '..' parts and a path that exists but is not a directory."""
    text = os.fspath(out_dir)
    if not text or "\x00" in text:
        raise MediaError("output directory is empty or has a NUL")
    path = Path(text)
    if ".." in path.parts:
        raise MediaError("output directory must not contain '..'")
    resolved = path.resolve()
    if resolved.exists() and not resolved.is_dir():
        raise MediaError(f"output directory {text!r} exists and is not a directory")
    return resolved


def inside(root, candidate):
    """`candidate` resolved, which must stay inside `root` (resolved); symlinks and junctions are followed before the check."""
    root, cand = Path(root).resolve(), Path(candidate).resolve()
    if cand != root and root not in cand.parents:
        raise MediaError(f"{candidate} would leave {root}")
    return cand


def output_path(out_dir, name, suffix):
    """out_dir/name+suffix after the name and directory guards, checked to stay inside out_dir."""
    return inside(safe_out_dir(out_dir), safe_out_dir(out_dir) / (safe_name(name) + suffix))


def input_file(path):
    """An existing regular file (not a directory, device or missing path), as a resolved absolute Path."""
    text = os.fspath(path)
    if not text or "\x00" in text:
        raise MediaError("input path is empty or has a NUL")
    resolved = Path(text).resolve()
    try:
        regular = stat.S_ISREG(resolved.stat().st_mode)
    except OSError:
        regular = False
    if not regular:
        raise FileNotFoundError(f"input is not an existing regular file: {text}")
    return resolved
