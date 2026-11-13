"""The light look for code-built shorts: highlight glow, small saturation lift, vignette (CB4 / KAN-913).

Copied and generalised from the chat's post.py. Order: glow, grade, vignette; captions are drawn after, so they stay clean.
The glow is thresholded on the darkest channel (min of R, G, B), so only near-white highlights bloom and bright saturated colours do not.

Not reused from narrative_factory.look_grade (the editor's ffmpeg LUT + vignette filter): this runs per frame in numpy so the captions
can be drawn on top in the same pass without an extra encode, and its vignette curve is the one the chat shorts were approved with.
"""
import numpy as np
from PIL import Image, ImageFilter

GLOW_FLOOR = 215         # darkest channel must exceed this to glow
GLOW_RAMP = 40           # and reaches full glow 40 levels later
GLOW_BLUR = 9            # px at 1080 wide, on a quarter-size copy
GLOW_GAIN = 0.22
SATURATION = 1.06
VIGNETTE_STRENGTH = 0.55


def glow_layer(img):
    """Float32 (H, W, 3) light to add to `img` (uint8 RGB)."""
    h, w = img.shape[:2]
    sw, sh = max(1, w // 4), max(1, h // 4)
    small = np.asarray(Image.fromarray(img).resize((sw, sh), Image.BILINEAR), dtype=np.float32)
    hi = np.clip((small.min(axis=2, keepdims=True) - GLOW_FLOOR) / GLOW_RAMP, 0, 1) * small
    radius = max(0.5, GLOW_BLUR * w / 1080)
    blurred = Image.fromarray(hi.astype(np.uint8)).filter(ImageFilter.GaussianBlur(radius)).resize((w, h), Image.BILINEAR)
    return np.asarray(blurred, dtype=np.float32) * GLOW_GAIN


def vignette_mask(width, height):
    """Float32 (H, W, 1) multiplier: 1.0 in the middle, about 0.63 in the corners."""
    yy, xx = np.mgrid[0:height, 0:width]
    r2 = ((xx - width / 2) / (width * 0.75)) ** 2 + ((yy - height / 2) / (height * 0.72)) ** 2
    return np.clip(1.0 - VIGNETTE_STRENGTH * np.clip(r2 - 0.25, 0, 1), 0, 1)[..., None].astype(np.float32)


def apply_look(img, vignette):
    """uint8 RGB in, uint8 RGB out."""
    arr = img.astype(np.float32) + glow_layer(img)
    lum = arr.mean(axis=2, keepdims=True)
    arr = lum + (arr - lum) * SATURATION
    return (np.clip(arr, 0, 255) * vignette).astype(np.uint8)
