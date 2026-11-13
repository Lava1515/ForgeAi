#!/usr/bin/env python3
"""
FFmpeg setup for the editor (editor.py): the binary, NVENC detection and codec settings, audio duration,
and the Ken Burns motion filter that keeps stills moving in a 1080x1920 (9:16) short.
"""

import math
import shutil
import subprocess
from pathlib import Path
from typing import Optional

import soundfile as sf

from config import get_config
from logs import get_logger

log = get_logger("assembler")

BASE_DIR = Path(__file__).resolve().parent


def get_ffmpeg_binary() -> str:
    """Find FFmpeg binary path, preferring imageio-ffmpeg or system PATH."""
    try:
        import imageio_ffmpeg
        exe = imageio_ffmpeg.get_ffmpeg_exe()
        if exe and Path(exe).exists():
            return exe
    except Exception:
        pass

    sys_ffmpeg = shutil.which("ffmpeg")
    if sys_ffmpeg:
        return sys_ffmpeg
    raise RuntimeError("FFmpeg executable not found. Install imageio-ffmpeg or add ffmpeg to PATH.")


def check_nvenc_support(ffmpeg_exe: str) -> bool:
    """Check if NVIDIA NVENC hardware encoder is available on this system."""
    try:
        res = subprocess.run([ffmpeg_exe, "-encoders"], capture_output=True, text=True, check=True)
        return "h264_nvenc" in res.stdout
    except Exception:
        return False


def get_audio_duration(audio_path: Path | str) -> float:
    """Get precise duration of audio file in seconds."""
    try:
        info = sf.info(str(audio_path))
        return float(info.duration)
    except Exception:
        ffmpeg_exe = get_ffmpeg_binary()
        ffprobe_exe = str(Path(ffmpeg_exe).parent / "ffprobe.exe")
        if not Path(ffprobe_exe).exists():
            ffprobe_exe = shutil.which("ffprobe") or "ffprobe"
        cmd = [
            ffprobe_exe, "-v", "error", "-show_entries",
            "format=duration", "-of", "default=noprint_wrappers=1:nokey=1",
            str(audio_path)
        ]
        res = subprocess.run(cmd, capture_output=True, text=True, check=True)
        return float(res.stdout.strip())


class VideoAssembler:
    def __init__(self, config_dict: Optional[dict] = None):
        cfg = config_dict or get_config()
        self.width = cfg.get("video", {}).get("width", 1080)
        self.height = cfg.get("video", {}).get("height", 1920)
        self.fps = cfg.get("video", {}).get("fps", 24)
        self.audio_bitrate = cfg.get("video", {}).get("audio_bitrate", "192k")
        self.ffmpeg_exe = get_ffmpeg_binary()
        self.has_nvenc = check_nvenc_support(self.ffmpeg_exe)
        
        pref_codec = cfg.get("video", {}).get("video_codec", "h264_nvenc")
        if pref_codec == "h264_nvenc" and self.has_nvenc:
            self.video_codec = "h264_nvenc"
            # constant quality: stills with slow motion need far less than a fixed 8 Mbps; 12M caps busy MiniMax clips
            self.codec_opts = ["-preset", "p4", "-tune", "hq", "-rc", "vbr", "-cq", "21", "-b:v", "0", "-maxrate", "12M", "-bufsize", "24M"]
            self.intermediate_opts = ["-preset", "p1", "-rc", "vbr", "-cq", "18", "-b:v", "0"]  # re-encoded by the caption pass
        else:
            self.video_codec = "libx264"
            self.codec_opts = ["-preset", "medium", "-crf", "18"]
            self.intermediate_opts = ["-preset", "veryfast", "-crf", "16"]

    def clip_codec_opts(self, fast: bool = False) -> list[str]:
        """Intermediate clips that will be re-encoded during caption burn can use the fastest preset."""
        return list(self.intermediate_opts if fast else self.codec_opts)

    def _build_ken_burns_filter(self, scene_index: int, duration_sec: float,
                                punch_sec: float = 0.25) -> tuple[str, int]:
        """
        Camera-like motion for a still, so it never reads as a frozen photo. Cycles 4 moves:
          0: push in   1: pull out   2: pan left -> right   3: pan right -> left
        On top of each: eased (smoothstep) speed, a 6% punch that settles in the first `punch_sec` after the cut,
        a slow handheld drift and tilt, and light film grain. The still is upscaled 2x first so zoompan's
        whole-pixel steps don't show as jitter. `punch_sec` shrinks to 2 frames behind a hard cut (KAN-198).
        """
        fps = self.fps
        frames_count = max(24, int(math.ceil(duration_sec * fps)))
        last = max(1, frames_count - 1)

        base_w, base_h = self.width * 2, self.height * 2
        base_scale = f"scale={base_w}:{base_h}:force_original_aspect_ratio=increase,crop={base_w}:{base_h}"

        p = f"min(on/{last},1)"
        ease = f"({p})*({p})*(3-2*({p}))"
        punch = f"(1+0.06*pow(max(0,1-on/{max(1, round(fps * punch_sec))}),2))"
        z0, zr = 1.05, 0.22  # zoom never drops to 1.0, so the drift always has room

        motion_type = scene_index % 4
        if motion_type == 0:
            zoom_expr, x_frac = f"({z0}+{zr}*{ease})*{punch}", "0.5"
        elif motion_type == 1:
            zoom_expr, x_frac = f"({z0 + zr:.2f}-{zr}*{ease})*{punch}", "0.5"
        elif motion_type == 2:
            zoom_expr, x_frac = f"1.2*{punch}", ease
        else:
            zoom_expr, x_frac = f"1.2*{punch}", f"(1-{ease})"

        # handheld drift: ~4 px at output size, two slow unrelated sine periods so it never looks like a loop
        drift_x = f"iw*0.004*sin(on*2*PI/{fps * 3.7:.1f})"
        drift_y = f"ih*0.003*sin(on*2*PI/{fps * 5.3:.1f}+1.3)"
        x_expr = f"(iw-iw/zoom)*{x_frac}+{drift_x}"
        y_expr = f"(ih-ih/zoom)*0.5+{drift_y}"

        # render 2% oversize, tilt up to ~0.3 degrees, crop back: the tilt never shows its corners
        over_w, over_h = (int(self.width * 1.02) // 2) * 2, (int(self.height * 1.02) // 2) * 2
        kb_filter = (
            f"{base_scale},"
            f"zoompan=z='{zoom_expr}':x='{x_expr}':y='{y_expr}':d={frames_count}:s={over_w}x{over_h}:fps={fps},"
            f"rotate='0.005*sin(2*PI*t/4.7)':ow=iw:oh=ih,"
            f"crop={self.width}:{self.height},"
            f"noise=alls=5:allf=t"
        )
        return kb_filter, frames_count
