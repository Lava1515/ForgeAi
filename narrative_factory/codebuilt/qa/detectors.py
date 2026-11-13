"""Frame detectors for the QA gate (CB12 / KAN-921). Original code; numpy and scipy only (both already used by the audio kit).

Input is an array of sampled frames, shape (n, h, w, 3) uint8, taken `step` seconds apart. Each detector returns
    {"fail": bool, "runs": [[start_s, end_s], ...], "worst": number, ...}
A single bad sample is never a failure: the bad frames must last (see the MIN_* constants), because a one-frame black cut or a pop-in
overlapping the edge is normal. Thresholds were calibrated on the two real earth-stop builds (see docs/codebuilt/qa-kit.md).
"""
import numpy as np
from scipy import ndimage as ndi

# blank / single colour
BLANK_DOMINANT = 0.95        # share of pixels in the most common 32-level colour bin
BLANK_MIN_SECONDS = 0.5
# empty (nothing drawn): almost every 15 px cell is smooth, with caption pixels excluded by the 0.85 share
EMPTY_FLAT_SHARE = 0.85
EMPTY_CELL = 15
EMPTY_CELL_STD = 2.5
EMPTY_MIN_SECONDS = 1.0
# near-black
BLACK_LUMA = 16
BLACK_SHARE = 0.45           # share of the frame below BLACK_LUMA for a frame to count as black
BLACK_MAX_VIDEO_SHARE = 0.25  # more than this share of the video black fails
BLACK_MAX_RUN_SECONDS = 6.0   # or one black stretch longer than this
# text touching the frame edge
TEXT_BRIGHT, TEXT_DARK = 170, 60
TEXT_MAX_HEIGHT_SHARE = 0.10  # a text line is shorter than this share of the frame height; bigger blobs are scenery
TEXT_MIN_LETTERS = 3
TEXT_MIN_SECONDS = 0.6
TEXT_EDGE_PX = 1
TEXT_JOIN = (5, 13)           # rows x columns of the dilation that joins letters and words into one line


def luma(frames):
    f = np.asarray(frames, dtype=np.float32)
    return 0.299 * f[..., 0] + 0.587 * f[..., 1] + 0.114 * f[..., 2]


def _check(frames):
    arr = np.asarray(frames)
    if arr.ndim != 4 or arr.shape[-1] != 3 or arr.shape[0] == 0:
        raise ValueError("frames must be an array of shape (n, h, w, 3) with at least one frame")
    return arr


def runs_of(flags, step, min_seconds):
    """[start, end] seconds of each stretch of True flags lasting at least min_seconds (a sample counts for `step` seconds)."""
    out, start = [], None
    for i, on in enumerate(list(flags) + [False]):
        if on and start is None:
            start = i
        elif not on and start is not None:
            if (i - start) * step >= min_seconds - 1e-9:
                out.append([round(start * step, 3), round(i * step, 3)])
            start = None
    return out


# ---------- per-frame measures ----------
def dominant_share(frames):
    """Per frame, the share of pixels in the most common colour bin (32 levels per channel, 8 bins each)."""
    arr = _check(frames).astype(np.int32) // 32
    key = arr[..., 0] * 64 + arr[..., 1] * 8 + arr[..., 2]
    return np.array([np.bincount(k.ravel()).max() / k.size for k in key])


def black_share(frames):
    return (luma(_check(frames)) < BLACK_LUMA).mean(axis=(1, 2))


def flat_share(frames, cell=EMPTY_CELL, cell_std=EMPTY_CELL_STD):
    """Per frame, the share of cell x cell blocks whose brightness barely varies."""
    L = luma(_check(frames))
    n, h, w = L.shape
    hh, ww = h // cell * cell, w // cell * cell
    blocks = L[:, :hh, :ww].reshape(n, hh // cell, cell, ww // cell, cell).transpose(0, 1, 3, 2, 4).reshape(n, -1, cell * cell)
    return (blocks.std(axis=2) < cell_std).mean(axis=1)


# ---------- detectors ----------
def detect_blank(frames, step):
    """Single-colour frames (one colour fills almost everything) lasting at least BLANK_MIN_SECONDS."""
    share = dominant_share(frames)
    runs = runs_of(share >= BLANK_DOMINANT, step, BLANK_MIN_SECONDS)
    return {"fail": bool(runs), "runs": runs, "worst": round(float(share.max()), 3)}


def detect_empty(frames, step):
    """Frames where almost nothing is drawn (a flat wall or sky) for at least EMPTY_MIN_SECONDS."""
    share = flat_share(frames)
    runs = runs_of(share >= EMPTY_FLAT_SHARE, step, EMPTY_MIN_SECONDS)
    return {"fail": bool(runs), "runs": runs, "worst": round(float(share.max()), 3)}


def detect_near_black(frames, step):
    """Too much of the video is mostly black: more than BLACK_MAX_VIDEO_SHARE of the samples, or one stretch over BLACK_MAX_RUN_SECONDS."""
    share = black_share(frames)
    flags = share >= BLACK_SHARE
    video_share = float(flags.mean())
    long_runs = runs_of(flags, step, BLACK_MAX_RUN_SECONDS)
    all_runs = runs_of(flags, step, step)
    return {"fail": bool(video_share > BLACK_MAX_VIDEO_SHARE or long_runs), "runs": all_runs,
            "video_share": round(video_share, 3), "worst": round(float(share.max()), 3)}


def edge_text(frame, edge_px=TEXT_EDGE_PX):
    """Text-like blobs in one frame that reach the frame edge: a list of {"sides", "box", "letters"}.

    Text is found as bright pixels with a dark outline within 2 px, packed densely; nearby pieces are merged into lines. A line counts when
    it is short (a text line, not scenery), has at least TEXT_MIN_LETTERS separate glyph pieces and its box reaches the edge."""
    L = luma(np.asarray(frame)[None])[0]
    h, w = L.shape
    near_dark = ndi.binary_dilation(L <= TEXT_DARK, structure=np.ones((5, 5), bool))
    ink = (L >= TEXT_BRIGHT) & near_dark
    dense = ink & (ndi.uniform_filter(ink.astype(float), 7) >= 0.22)
    lines, count = ndi.label(ndi.binary_dilation(dense, structure=np.ones(TEXT_JOIN, bool)))
    found = []
    for i, box in enumerate(ndi.find_objects(lines), 1):
        y0, y1, x0, x1 = box[0].start, box[0].stop, box[1].start, box[1].stop
        sides = [name for name, hit in (("left", x0 < edge_px), ("right", x1 > w - edge_px),
                                        ("top", y0 < edge_px), ("bottom", y1 > h - edge_px)) if hit]
        if not sides or (y1 - y0) > TEXT_MAX_HEIGHT_SHARE * h:
            continue
        pieces, _ = ndi.label(dense[box] & (lines[box] == i))
        letters = int((np.bincount(pieces.ravel())[1:] >= 3).sum())
        if letters >= TEXT_MIN_LETTERS:
            found.append({"sides": sides, "box": [x0, y0, x1, y1], "letters": letters})
    return found


def detect_edge_text(frames, step):
    """Text lines touching or running past the frame edge for at least TEXT_MIN_SECONDS."""
    per_frame = [edge_text(f) for f in _check(frames)]
    runs = runs_of([bool(p) for p in per_frame], step, TEXT_MIN_SECONDS)
    sides = sorted({s for p in per_frame for b in p for s in b["sides"]})
    return {"fail": bool(runs), "runs": runs, "sides": sides, "worst": max((len(p) for p in per_frame), default=0)}
