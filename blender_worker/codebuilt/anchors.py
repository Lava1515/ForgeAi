# codex · gpt-6.1-sol · 2026-11-18 19:41 +0200
# codex · gpt-6.1-sol · 2026-11-18 19:36 +0200
"""Capture named world points and values for the host's screen-space overlay."""
import json
import math
import os
import re
import tempfile
from numbers import Real


NAME_RE = re.compile(r"^[a-z][a-z0-9_]{0,23}$")
MAX_POINTS = 64
MAX_VALUES = 4
MAX_POINTS_PER_FRAME = 24

_frame = None
_points = {}
_values = {}
_point_names = set()
_value_names = set()
_frames = {}
_usage = {"point": False, "value": False}
_width = None
_height = None


class AnchorError(ValueError):
    """An anchor or anchor file violates the screen-position contract."""


def _name(name, kind):
    if not isinstance(name, str) or not NAME_RE.fullmatch(name):
        raise AnchorError(f"{kind} name must match ^[a-z][a-z0-9_]{{0,23}}$")


def _number(value, what):
    if isinstance(value, bool) or not isinstance(value, Real):
        raise AnchorError(f"{what} must be a finite number")
    try:
        number = float(value)
    except (OverflowError, TypeError, ValueError) as error:
        raise AnchorError(f"{what} must be a finite number") from error
    if not math.isfinite(number):
        raise AnchorError(f"{what} must be a finite number")
    return number


def _point(point):
    try:
        coords = tuple(point)
    except TypeError as error:
        raise AnchorError("point must contain three world coordinates") from error
    if len(coords) != 3:
        raise AnchorError("point must contain three world coordinates")
    return tuple(_number(v, "point coordinate") for v in coords)


def reset(width, height, existing=None):
    """Start one render call, retaining validated prior entries when resuming."""
    global _frame, _points, _values, _point_names, _value_names, _frames, _width, _height
    if isinstance(width, bool) or not isinstance(width, int) or width < 1:
        raise AnchorError("width must be a positive integer")
    if isinstance(height, bool) or not isinstance(height, int) or height < 1:
        raise AnchorError("height must be a positive integer")
    _frame, _points, _values = None, {}, {}
    _point_names, _value_names = set(), set()
    _frames, _width, _height = {}, width, height
    if existing is not None:
        _load(existing)


def _load(path):
    global _frames, _point_names, _value_names
    try:
        with open(path, "r", encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, ValueError) as error:
        raise AnchorError(f"cannot read existing anchors file: {error}") from error
    if (not isinstance(data, dict) or set(data) != {"version", "width", "height", "frames"}
            or data["version"] != 1 or isinstance(data["version"], bool)
            or isinstance(data["width"], bool) or not isinstance(data["width"], int)
            or isinstance(data["height"], bool) or not isinstance(data["height"], int)
            or data["width"] != _width or data["height"] != _height
            or not isinstance(data["frames"], dict)):
        raise AnchorError("existing anchors file has an invalid header or frame map")
    frames = {}
    for key, row in data["frames"].items():
        if not isinstance(key, str) or not key.isdecimal() or str(int(key)) != key:
            raise AnchorError(f"invalid existing frame key {key!r}")
        if (not isinstance(row, dict) or not {"p", "v"} <= set(row) <= {"p", "v", "o"}
                or not isinstance(row["p"], dict) or not isinstance(row["v"], dict)):
            raise AnchorError(f"invalid existing frame {key}")
        if len(row["p"]) > MAX_POINTS_PER_FRAME:
            raise AnchorError(f"too many points in existing frame {key}")
        clean = {"p": {}, "v": {}}
        for name, coords in row["p"].items():
            _name(name, "point")
            if name not in _point_names and len(_point_names) >= MAX_POINTS:
                raise AnchorError(f"too many point names (maximum {MAX_POINTS})")
            if not isinstance(coords, list) or len(coords) != 3:
                raise AnchorError(f"invalid point {name!r} in existing frame {key}")
            clean["p"][name] = [_number(v, f"point {name}") for v in coords]
            if clean["p"][name][2] not in (0.0, 1.0):
                raise AnchorError(f"point {name!r} front flag must be 0 or 1")
            _point_names.add(name)
        for name, value_ in row["v"].items():
            _name(name, "value")
            if name not in _value_names and len(_value_names) >= MAX_VALUES:
                raise AnchorError(f"too many value names (maximum {MAX_VALUES})")
            clean["v"][name] = _number(value_, f"value {name}")
            _value_names.add(name)
        if "o" in row:
            occluded = row["o"]
            if (not isinstance(occluded, list) or any(not isinstance(n, str) or n not in clean["p"] for n in occluded)
                    or len(set(occluded)) != len(occluded)):
                raise AnchorError(f"invalid occluded list in existing frame {key}")
            if occluded:
                clean["o"] = sorted(occluded)
        frames[key] = clean
    _frames = frames


def begin(frame):
    """Clear the per-frame buffer before a shot function poses this frame."""
    global _frame, _points, _values
    if isinstance(frame, bool) or not isinstance(frame, int) or frame < 0:
        raise AnchorError("frame must be a non-negative integer")
    _frame, _points, _values = frame, {}, {}


def mark(name, point):
    """Record a named world-space point; calls outside renderloop are ignored (for QA poses)."""
    _name(name, "point")
    point = _point(point)
    if _frame is None:
        _usage["point"] = True
        return
    if name not in _point_names and len(_point_names) >= MAX_POINTS:
        raise AnchorError(f"too many point names (maximum {MAX_POINTS})")
    if name not in _points and len(_points) >= MAX_POINTS_PER_FRAME:
        raise AnchorError(f"too many points in frame {_frame} (maximum {MAX_POINTS_PER_FRAME})")
    _point_names.add(name)
    _points[name] = point


def value(name, number):
    """Record a running numeric value; calls outside renderloop are ignored (for QA poses)."""
    _name(name, "value")
    number = _number(number, "value")
    if _frame is None:
        _usage["value"] = True
        return
    if name not in _value_names and len(_value_names) >= MAX_VALUES:
        raise AnchorError(f"too many value names (maximum {MAX_VALUES})")
    _value_names.add(name)
    _values[name] = number


def has_marks():
    """Whether any point or value has been registered in this render call."""
    return bool(_point_names or _value_names)


def usage():
    """Report API use independently of captured frame data (including QA probes)."""
    used = dict(_usage)
    _usage.update(point=False, value=False)
    return used


def has_points():
    """Whether the active frame currently has points that need projection."""
    return bool(_points)


def has_frame(frame):
    return str(frame) in _frames


def discard_missing_frames(existing_png_frames):
    """Drop resume records whose rendered PNG is absent."""
    keep = {str(frame) for frame in existing_png_frames}
    for key in list(_frames):
        if key not in keep:
            del _frames[key]
    _point_names.clear()
    _point_names.update(name for row in _frames.values() for name in row["p"])
    _value_names.clear()
    _value_names.update(name for row in _frames.values() for name in row["v"])


def capture(frame, project, occluded=None):
    """Project buffered points into contract coordinates and store the frame.

    occluded: optional callable(point) -> bool, asked only for points in front of the camera and inside the frame. A true answer means
    geometry stands between the camera and the point; the name is then listed under the optional frame key "o" (never repurposing the
    front flag, which stays the sign of the camera depth). No callable, or no occluded point: the frame has no "o" key."""
    global _frame
    if _frame != frame:
        raise AnchorError(f"capture frame {frame} does not match active frame {_frame}")
    if not callable(project) and _points:
        raise AnchorError("project must be callable when points are marked")
    projected = {}
    for name, point in _points.items():
        try:
            result = tuple(project(point))
        except Exception as error:
            raise AnchorError(f"cannot project point {name!r}: {error}") from error
        if len(result) != 3:
            raise AnchorError(f"projector for point {name!r} must return x, y, depth")
        x, y, depth = (_number(v, f"projected point {name}") for v in result)
        projected[name] = [x, y, 1 if depth > 0 else 0]
    blocked = []
    if callable(occluded):
        for name, point in _points.items():
            x, y, front = projected[name]
            if front and 0.0 <= x <= 1.0 and 0.0 <= y <= 1.0:
                try:
                    hit = occluded(point)
                except Exception as error:
                    raise AnchorError(f"cannot test occlusion of point {name!r}: {error}") from error
                if hit is True:
                    blocked.append(name)
    if projected or _values:
        _frames[str(frame)] = {"p": projected, "v": dict(_values), **({"o": sorted(blocked)} if blocked else {})}
    else:
        _frames.pop(str(frame), None)
    _frame = None
    return _frames.get(str(frame))


def document():
    """Return the stable contract 2.2 JSON shape."""
    if _width is None or _height is None:
        raise AnchorError("reset(width, height) must be called before document")
    return {"version": 1, "width": _width, "height": _height,
            "frames": {key: _frames[key] for key in sorted(_frames, key=int)}}


def write(path):
    """Atomically replace the anchors file; return False when there are no marks."""
    if not has_marks():
        return False
    path = os.fspath(path)
    directory = os.path.dirname(path) or "."
    os.makedirs(directory, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".anchors-", suffix=".tmp", dir=directory)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(document(), handle, separators=(",", ":"), allow_nan=False)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(tmp, 0o644)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except FileNotFoundError:
            pass
        raise
    return True
