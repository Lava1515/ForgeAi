"""Sampling frames from a finished video for the QA gate (CB12 / KAN-921).

One ffmpeg call decodes the video at a low rate and a small size straight into memory (raw RGB over a pipe, no files, no shell).
Reuses the post kit's ffmpeg lookup and path guard.
"""
import subprocess

import numpy as np

from narrative_factory.codebuilt.post import media

DEFAULT_SAMPLE_FPS = 3.0
DEFAULT_WIDTH = 270            # a quarter of 1080; height follows the video's aspect ratio (even number)
MAX_FRAMES = 4000


def sample_frames(video, sample_fps=DEFAULT_SAMPLE_FPS, width=DEFAULT_WIDTH, timeout=600, ffmpeg=None):
    """Returns (array of shape (n, h, w, 3) uint8, times in seconds). Frame i is taken at i / sample_fps."""
    path = media.input_file(video)
    info = media.probe(path, ffmpeg=ffmpeg)
    if not info["has_video"] or not info["width"] or not info["height"]:
        raise media.MediaError("no video stream to sample")
    if not (sample_fps > 0 and width >= 16 and width % 2 == 0):
        raise ValueError("sample_fps must be positive and width an even number of at least 16")
    height = int(round(width * info["height"] / info["width"] / 2)) * 2
    if info["duration"] * sample_fps > MAX_FRAMES:
        raise media.MediaError("too many frames to sample; lower sample_fps")
    cmd = [ffmpeg or media.resolve_ffmpeg(), "-hide_banner", "-loglevel", "error", "-i", str(path), "-an", "-vf",
           f"fps={sample_fps},scale={width}:{height}:flags=area", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]
    try:
        done = subprocess.run(cmd, capture_output=True, timeout=timeout, shell=False)
    except subprocess.TimeoutExpired as err:
        raise media.MediaError(f"ffmpeg timed out after {timeout}s") from err
    if done.returncode != 0:
        raise media.MediaError("ffmpeg failed: " + done.stderr.decode("utf-8", "replace")[-media.STDERR_TAIL:])
    size = width * height * 3
    count = len(done.stdout) // size
    if count == 0:
        raise media.MediaError("no frames decoded")
    arr = np.frombuffer(done.stdout[: count * size], dtype=np.uint8).reshape(count, height, width, 3)
    return arr, [i / sample_fps for i in range(count)]
