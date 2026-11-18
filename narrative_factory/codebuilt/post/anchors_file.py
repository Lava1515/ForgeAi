# codex · gpt-6.1-sol · 2026-11-18 19:41 +0200
# codex · gpt-6.1-sol · 2026-11-18 19:36 +0200
"""Untrusted reader of anchors.json: screen positions the kit saved while it posed each frame (KO1, plan 2026-11-17 contract 2.2).

The job container writes this file, so every byte is untrusted: at most 8 MB, a strict shape, finite numbers only, x and y clamped to
-2..3, frame keys whole numbers inside the frame count. It holds numbers only; text never comes from here (the host's overlay.json
holds all text). A bad file raises AnchorsError with a message that starts with "anchors.json" and names what is wrong.

    {"version": 1, "width": 1080, "height": 1920,
     "frames": {"0": {"p": {"lid": [0.512, 0.431, 1]}, "v": {"depth": 0.0}}}}

Optional per frame, added without changing "front": "o": [names] lists points whose line from the camera is blocked by geometry in that frame
(a projected point behind a surface). A frame without "o" says nothing about occlusion. Readers that do not know "o" must not be fed a file with it.

p: name -> [x, y, front], x left to right and y top to bottom as a share of the frame, front 1 when the point is in front of the camera.
v: name -> one number (the running number of that frame). Either may be absent in a frame.
"""
import bisect
import json
import math
import os
import re
import stat
from pathlib import Path
from . import media

MAX_BYTES = 8 * 1024 * 1024
MAX_POINT_NAMES, MAX_VALUE_NAMES, MAX_POINTS_PER_FRAME = 64, 4, 24
MAX_SIDE = 16384
CLAMP_LO, CLAMP_HI = -2.0, 3.0
NAME = re.compile(r"[a-z][a-z0-9_]{0,23}")
FRAME_KEY = re.compile(r"0|[1-9][0-9]{0,8}")


class AnchorsError(ValueError):
    pass


def _fail(msg):
    raise AnchorsError(f"anchors.json: {msg}")


def _pairs(pairs):
    out = {}
    for k, v in pairs:
        if k in out:
            _fail(f"duplicate key {k[:30]!r}")
        out[k] = v
    return out


def _no_constant(name):
    _fail(f"{name} is not a finite number")


def _number(v, where):
    if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v):
        _fail(f"{where} is not a finite number")
    return float(v)


def _name(k, where):
    if not isinstance(k, str) or not NAME.fullmatch(k):
        _fail(f"{where} name {str(k)[:30]!r} does not match {NAME.pattern}")
    return k


def _keys(obj, allowed, where):
    extra = sorted(set(obj) - set(allowed))
    if extra:
        _fail(f"unknown key {extra[0][:30]!r} in {where}")


class Anchors:
    """Parsed positions. point() returns (x, y, front) or None; value() holds the last known number (or the first, before it)."""

    def __init__(self, width, height, points, values, occluded=None):
        self.width, self.height = width, height
        self._points = points                 # frame -> {name: (x, y, front)}
        self._occluded = occluded or {}       # frame -> {names behind geometry}
        self._values = {}                     # name -> (sorted frames, numbers)
        for name, seq in values.items():
            seq.sort()
            self._values[name] = ([f for f, _ in seq], [v for _, v in seq])

    def occluded(self, frame, name):
        """True when the file says geometry blocks the camera's line to this point in this frame. False also means "not tested"."""
        return name in self._occluded.get(frame, ())

    @classmethod
    def empty(cls, width=1080, height=1920):
        return cls(width, height, {}, {})

    def point(self, frame, name):
        return self._points.get(frame, {}).get(name)

    def value(self, frame, name):
        found = self._values.get(name)
        if not found:
            return None
        frames, nums = found
        i = bisect.bisect_right(frames, frame) - 1
        return nums[max(i, 0)]

    @property
    def point_names(self):
        return {n for pts in self._points.values() for n in pts}

    @property
    def value_names(self):
        return set(self._values)


def parse(raw, nframes):
    """Anchors from the raw bytes of an anchors.json, for a video of `nframes` frames."""
    if not isinstance(raw, (bytes, bytearray)):
        _fail("must be read as bytes")
    if len(raw) > MAX_BYTES:
        _fail("is larger than 8 MB")
    try:
        data = json.loads(bytes(raw).decode("utf-8"), object_pairs_hook=_pairs, parse_constant=_no_constant)
    except AnchorsError:
        raise
    except (UnicodeDecodeError, ValueError, RecursionError) as err:
        _fail(f"is not JSON ({type(err).__name__})")
    if not isinstance(data, dict):
        _fail("top level is not an object")
    _keys(data, ("version", "width", "height", "frames"), "the top level")
    for key in ("version", "width", "height", "frames"):
        if key not in data:
            _fail(f"missing key {key!r}")
    if isinstance(data["version"], bool) or data["version"] != 1:
        _fail("version is not 1")
    for key in ("width", "height"):
        v = data[key]
        if isinstance(v, bool) or not isinstance(v, int) or not 0 < v <= MAX_SIDE:
            _fail(f"{key} is not a whole number from 1 to {MAX_SIDE}")
    frames = data["frames"]
    if not isinstance(frames, dict):
        _fail("frames is not an object")
    points, values, occluded = {}, {}, {}
    point_names = set()
    for key, rec in frames.items():
        if not isinstance(key, str) or not FRAME_KEY.fullmatch(key) or int(key) >= nframes:
            _fail(f"frame key {str(key)[:30]!r} is not a whole number below the frame count {nframes}")
        f = int(key)
        if not isinstance(rec, dict):
            _fail(f"frame {f} is not an object")
        _keys(rec, ("p", "v", "o"), f"frame {f}")
        p, v = rec.get("p", {}), rec.get("v", {})
        if not isinstance(p, dict) or not isinstance(v, dict):
            _fail(f"frame {f} p and v must be objects")
        if len(p) > MAX_POINTS_PER_FRAME:
            _fail(f"frame {f} has more than {MAX_POINTS_PER_FRAME} points")
        pts = {}
        for name, xyz in p.items():
            _name(name, f"frame {f} point")
            if not isinstance(xyz, list) or len(xyz) != 3:
                _fail(f"frame {f} point {name!r} is not [x, y, front]")
            x, y = (min(CLAMP_HI, max(CLAMP_LO, _number(c, f"frame {f} point {name!r} {axis}"))) for c, axis in zip(xyz, "xy"))
            front = xyz[2]
            if isinstance(front, bool) or front not in (0, 1):
                _fail(f"frame {f} point {name!r} front is not 0 or 1")
            pts[name] = (x, y, front == 1)
            point_names.add(name)
        if len(point_names) > MAX_POINT_NAMES:
            _fail(f"has more than {MAX_POINT_NAMES} point names")
        if pts:
            points[f] = pts
        blocked = rec.get("o", [])
        if (not isinstance(blocked, list) or len(blocked) > MAX_POINTS_PER_FRAME or any(not isinstance(n, str) or n not in pts for n in blocked)
                or len(set(blocked)) != len(blocked)):
            _fail(f"frame {f} o must be a list of unique names of the points in that frame")
        if blocked:
            occluded[f] = frozenset(blocked)
        for name, num in v.items():
            _name(name, f"frame {f} value")
            values.setdefault(name, []).append((f, _number(num, f"frame {f} value {name!r}")))
            if len(values) > MAX_VALUE_NAMES:
                _fail(f"has more than {MAX_VALUE_NAMES} value names")
    return Anchors(data["width"], data["height"], points, values, occluded)


def load(path, nframes, *, job_root):
    """Read and check an anchors.json file. The size is checked before a byte is read."""
    text = os.fspath(path)
    if not text or "\x00" in text:
        _fail("path is empty or has a NUL")
    resolved = media.inside(job_root, text)
    try:
        st = resolved.stat()
    except OSError:
        st = None
    if st is None or not stat.S_ISREG(st.st_mode):
        raise FileNotFoundError(f"anchors.json is not an existing regular file: {text}")
    if st.st_size > MAX_BYTES:
        _fail("is larger than 8 MB")
    with open(resolved, "rb") as fh:
        raw = fh.read(MAX_BYTES + 1)
    return parse(raw, nframes)
