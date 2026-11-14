"""Compare independent frame 0 and the diagnostic frame N (not frame N-1).

Original code, codex · gpt-6.1-sol · 2026-11-14. Pixel units are 8-bit RGB.
Thresholds are deliberately tight: mean absolute error <= 1 code value and
99th-percentile per-pixel maximum-channel error <= 8. The local Blender proof
and a displaced-subject control calibrate these in the lane D report.
"""
import numpy as np
from PIL import Image

MAE_LIMIT = 1.0
P99_LIMIT = 8.0


def check_seam(first, following):
    with Image.open(first, formats=["PNG"]) as im:
        a = np.asarray(im.convert("RGB"), dtype=np.float32)
    with Image.open(following, formats=["PNG"]) as im:
        b = np.asarray(im.convert("RGB"), dtype=np.float32)
    if a.shape != b.shape:
        raise ValueError("seam frames must have identical dimensions")
    delta = np.abs(a - b)
    mae, p99 = float(delta.mean()), float(np.percentile(delta.max(axis=2), 99))
    tile_max = max(float(delta[y:y+64, x:x+64].mean())
                   for y in range(0, a.shape[0], 64) for x in range(0, a.shape[1], 64))
    return {"tile_max_rgb_255": tile_max, "tile_limit": 2.0,
            "passed": mae <= MAE_LIMIT and p99 <= P99_LIMIT and tile_max <= 2.0, "mae_rgb_255": mae,
            "p99_max_channel_255": p99, "mae_limit": MAE_LIMIT, "p99_limit": P99_LIMIT,
            "compared": ["frame_0", "frame_N_after_last"], "width": a.shape[1], "height": a.shape[0]}
