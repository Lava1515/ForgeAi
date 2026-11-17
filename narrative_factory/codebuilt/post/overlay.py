"""Text drawn after the render, at screen positions the kit saved (KO1, plan 2026-11-17, contracts 2.2 and 2.3).

Two parts:
  - the reader of overlay.json (`parse_spec`, `load_spec`, `validate_spec`). The host owns this file: the model writes it, the host's
    JavaScript validator (KB1, overlaySpec.js) checks it and stores it as <job>/inputs/overlay.json. This reader keeps the same rules;
    both are tested on tests/fixtures/overlay (see its README.md for the rules and error codes).
  - `Overlay`: draws six elements on a graded frame (counter, label with pointer, measure bar, fill bar, big number, title tag) and
    checks the layout of every frame without drawing (`layout_report`).

All text comes from overlay.json. anchors.json (anchors_file.py) only gives positions and running numbers.
The Kola short's src/overlay.py (output/agent-jobs/deepest-hole-short-2112) was the worked example; nothing about holes, depth or any
subject is written here. Fonts: Impact and Arial Bold, the two the `windows-fonts` licence entry names; on a machine without them the
caption kit's open fallbacks are used.
"""
import json
import math
import os
import re
import stat
from decimal import Decimal, ROUND_HALF_UP, localcontext
from pathlib import Path

from PIL import Image, ImageDraw

from . import captions, media

# ---------------------------------------------------------------- the spec (contract 2.3)

MAX_SPEC_BYTES = 65536
NAME = re.compile(r"[a-z][a-z0-9_]{0,23}")
TEXT = re.compile(r"[A-Za-z0-9 .,%°×\-+/:'()]+")
TEXT_MAX, SUB_MAX = 28, 40
FORMATS = ("int", "int_commas", "one_decimal", "two_decimals", "year", "times")
SIDES = ("left", "right", "auto")
LIMITS = {"labels": 12, "measures": 4, "bars": 2, "big": 3}
SPEC_ERROR_CODES = ("too_large", "not_json", "not_object", "unknown_key", "missing_key", "bad_version", "bad_type", "too_many",
                    "bad_name", "bad_text", "text_length", "bad_number", "bad_format", "bad_side", "bad_time", "bad_range", "same_anchor")
# element -> (required fields, optional fields), each field -> its kind
SCHEMA = {
    "counter": ({"value": "name", "format": "format", "from": "num", "to": "num"}, {"unit": "text", "label": "text"}),
    "labels": ({"anchor": "name", "title": "text", "from": "num", "to": "num"}, {"value": "text", "side": "side"}),
    "measures": ({"a": "name", "b": "name", "text": "text", "from": "num", "to": "num"}, {}),
    "bars": ({"value": "name", "min": "num", "max": "num", "from": "num", "to": "num"}, {"label": "text"}),
    "big": ({"text": "text", "from": "num", "to": "num"}, {"sub": "sub"}),
    "tag": ({"text": "text", "from": "num", "to": "num"}, {}),
}
SINGLE = ("counter", "tag")


class SpecError(ValueError):
    """A broken overlay.json. `code` is one of SPEC_ERROR_CODES, `where` the path such as labels[0].title ("" for the file)."""

    def __init__(self, code, where, msg=""):
        super().__init__(f"overlay.json: {code} at {where or 'top level'}{': ' + msg if msg else ''}")
        self.code, self.where = code, where


def _field(kind, value, where):
    if kind == "name":
        if not isinstance(value, str):
            raise SpecError("bad_type", where, "a name must be a string")
        if not NAME.fullmatch(value):
            raise SpecError("bad_name", where)
        return value
    if kind in ("text", "sub"):
        if not isinstance(value, str):
            raise SpecError("bad_type", where, "text must be a string")
        if not TEXT.fullmatch(value) or not value.strip():
            raise SpecError("bad_text", where)
        if len(value) > (SUB_MAX if kind == "sub" else TEXT_MAX):
            raise SpecError("text_length", where)
        return value
    if kind == "num":
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
            raise SpecError("bad_number", where)
        return float(value)
    if kind == "format":
        if not isinstance(value, str) or value not in FORMATS:
            raise SpecError("bad_format", where)
        return value
    if kind == "side":
        if not isinstance(value, str) or value not in SIDES:
            raise SpecError("bad_side", where)
        return value
    raise AssertionError(kind)


def _element(key, obj, where, video_seconds):
    if not isinstance(obj, dict):
        raise SpecError("bad_type", where, "must be an object")
    required, optional = SCHEMA[key]
    for k in obj:
        if k not in required and k not in optional:
            raise SpecError("unknown_key", f"{where}.{k}")
    for k in required:
        if k not in obj:
            raise SpecError("missing_key", f"{where}.{k}")
    out = {k: _field(kind, obj[k], f"{where}.{k}") for k, kind in {**required, **optional}.items() if k in obj}
    if out["from"] < 0 or out["from"] >= out["to"] or (video_seconds is not None and out["to"] > video_seconds):
        raise SpecError("bad_time", where)
    if key == "bars" and out["min"] >= out["max"]:
        raise SpecError("bad_range", where)
    if key == "measures" and out["a"] == out["b"]:
        raise SpecError("same_anchor", where)
    if key == "labels":
        out.setdefault("side", "auto")
    return out


def validate_spec(data, video_seconds=None):
    """A parsed overlay.json checked against contract 2.3. Returns a normalised copy: every list present, counter/tag None if absent.

    video_seconds: the video length; None skips only the `to <= video length` check.
    """
    if not isinstance(data, dict):
        raise SpecError("not_object", "")
    for k in data:
        if k != "version" and k not in SCHEMA:
            raise SpecError("unknown_key", k)
    if "version" not in data:
        raise SpecError("missing_key", "version")
    v = data["version"]
    if isinstance(v, bool) or not isinstance(v, (int, float)) or v != 1:
        raise SpecError("bad_version", "version")
    out = {"version": 1}
    for key in SCHEMA:
        if key in SINGLE:
            out[key] = _element(key, data[key], key, video_seconds) if key in data else None
            continue
        items = data.get(key, [])
        if not isinstance(items, list):
            raise SpecError("bad_type", key, "must be an array")
        if len(items) > LIMITS[key]:
            raise SpecError("too_many", key)
        out[key] = [_element(key, item, f"{key}[{i}]", video_seconds) for i, item in enumerate(items)]
    return out


def _no_constant(name):
    raise SpecError("not_json", "", f"{name} is not JSON")


def parse_spec(raw, video_seconds=None):
    """overlay.json from its raw text (bytes or str): size, JSON, then validate_spec."""
    if isinstance(raw, str):
        raw = raw.encode("utf-8")
    if len(raw) > MAX_SPEC_BYTES:
        raise SpecError("too_large", "")
    try:
        data = json.loads(bytes(raw).decode("utf-8"), parse_constant=_no_constant)
    except SpecError:
        raise
    except (UnicodeDecodeError, ValueError, RecursionError) as err:
        raise SpecError("not_json", "", type(err).__name__) from None
    return validate_spec(data, video_seconds)


def load_spec(path, video_seconds=None, *, job_root):
    """Read and check the host-owned overlay.json. The size is checked before a byte is read."""
    text = os.fspath(path)
    if not text or "\x00" in text:
        raise SpecError("not_json", "", "path is empty or has a NUL")
    resolved = media.inside(job_root, text)
    try:
        st = resolved.stat()
    except OSError:
        st = None
    if st is None or not stat.S_ISREG(st.st_mode):
        raise FileNotFoundError(f"overlay.json is not an existing regular file: {text}")
    if st.st_size > MAX_SPEC_BYTES:
        raise SpecError("too_large", "")
    with open(resolved, "rb") as fh:
        return parse_spec(fh.read(MAX_SPEC_BYTES + 1), video_seconds)


def names_used(spec):
    """The anchor names (points) and running-number names (values) the spec needs from anchors.json."""
    points = {lab["anchor"] for lab in spec["labels"]} | {m[k] for m in spec["measures"] for k in ("a", "b")}
    values = {b["value"] for b in spec["bars"]} | ({spec["counter"]["value"]} if spec["counter"] else set())
    return {"points": points, "values": values}


def _half_up(x, places):
    number = Decimal(repr(float(x)))
    with localcontext() as ctx:
        ctx.prec = max(28, number.adjusted() + places + 3)
        return number.quantize(Decimal(1).scaleb(-places), rounding=ROUND_HALF_UP)


def format_value(x, fmt):
    """A running number as text, by a named format (the model never supplies a format string)."""
    if fmt in ("int", "year"):
        return f"{_half_up(x, 0):f}"
    if fmt == "int_commas":
        return f"{int(_half_up(x, 0)):,}"
    if fmt == "one_decimal":
        return f"{_half_up(x, 1):f}"
    if fmt == "two_decimals":
        return f"{_half_up(x, 2):f}"
    if fmt == "times":
        text = f"{_half_up(x, 1):f}"
        return (text[:-2] if text.endswith(".0") else text) + "×"
    raise ValueError(f"unknown format {fmt!r}")


# ---------------------------------------------------------------- drawing

BASE_W, BASE_H = captions.BASE_W, captions.BASE_H
YELLOW, WHITE, BLACK = (255, 214, 10), (255, 255, 255), (0, 0, 0)
HUD_FONTS = (r"C:\Windows\Fonts\arialbd.ttf", "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
             "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", "/Library/Fonts/Arial Bold.ttf")
BIG_FONTS = (r"C:\Windows\Fonts\impact.ttf",) + HUD_FONTS
FADE_IN, FADE_OUT = 0.25, 0.2
LABEL_POP, BIG_POP, MEASURE_GROW = 0.22, 0.25, 0.35
HIDDEN_SHARE = 0.30        # a label hidden for more of its window than this is a finding
BLOCKING = ("outside_safe_zone", "overlap", "caption_overlap")


def _smooth(a, b, x):
    if b <= a:
        return 1.0 if x >= b else 0.0
    s = min(1.0, max(0.0, (x - a) / (b - a)))
    return s * s * (3 - 2 * s)


def _ease_out_back(x):
    x = min(1.0, max(0.0, x))
    return 1 + 2.70158 * (x - 1) ** 3 + 1.70158 * (x - 1) ** 2


def _window_alpha(el, t):
    return _smooth(el["from"], el["from"] + FADE_IN, t) * (1 - _smooth(el["to"] - FADE_OUT, el["to"], t))


def _on(el, t):
    return el["from"] <= t < el["to"]


def _intersects(a, b):
    return min(a[0] + a[2], b[0] + b[2]) - max(a[0], b[0]) > 0 and min(a[1] + a[3], b[1] + b[3]) - max(a[1], b[1]) > 0


def _inside(box, safe):
    x, y, w, h = box
    return x >= safe[0] and y >= safe[1] and x + w <= safe[2] and y + h <= safe[3]


def frame_findings(pieces, caption_box, safe):
    """Blocking layout problems of one frame: (code, element ids). Pieces fully faded out are skipped."""
    shown = []
    for piece in pieces:
        if piece.get("alpha", 1.0) <= 0:
            continue
        p = dict(piece)
        x, y, w, h = p["box"]
        scale = p.get("scale", 1.0)
        p["box"] = (x + w * (1 - scale) / 2, y + h * (1 - scale) / 2, w * scale, h * scale)
        shown.append(p)
    out = [("outside_safe_zone", (p["id"],)) for p in shown if not _inside(p["box"], safe)]
    if caption_box is not None:
        out += [("caption_overlap", (p["id"],)) for p in shown if _intersects(p["box"], caption_box)]
    for i, a in enumerate(shown):
        for b in shown[i + 1:]:
            if _intersects(a["box"], b["box"]):
                out.append(("overlap", (a["id"], b["id"])))
    return out


class _Fonts:
    def __init__(self):
        self._cache = {}

    def get(self, files, px):
        key = (files, px)
        if key not in self._cache:
            self._cache[key] = captions.load_font(max(6, px), files)
        return self._cache[key]


def _block(fonts, rows, pad, radius, fill, align, min_w, gap, max_w, scale):
    """RGBA sprite of stacked text rows, optionally on a rounded pill. rows: (text, font files, px at 1080, colour, stroke at 1080).

    Built at the frame's scale. A row wider than max_w shrinks on its own (the other rows keep their size) and the sprite is built
    again, so text stays sharp and a long title does not make its small second line unreadable.
    """
    k = scale
    ks = [scale] * len(rows)
    px_pad, py_pad, g = round(pad[0] * k), round(pad[1] * k), round(gap * k)
    room = max(1, max_w - 2 * px_pad)
    for _ in range(6):
        built = []
        for (text, files, px, colour, stroke), kr in zip(rows, ks):
            font = fonts.get(files, round(px * kr))
            sw = max(0, round(stroke * kr))
            top, bottom = font.getbbox("0Ag", anchor="lt")[1], font.getbbox("0Ag", anchor="lt")[3]
            built.append((text, font, colour, sw, font.getlength(text) + 2 * sw, bottom - top + 2 * sw, top))
        if all(b[4] <= room for b in built) or min(ks) < scale * 0.2:
            break
        ks = [kr * room / b[4] * 0.995 if b[4] > room else kr for kr, b in zip(ks, built)]
    w = min(max_w, max(round(min_w * k), math.ceil(max(b[4] for b in built)) + 2 * px_pad))
    h = sum(b[5] for b in built) + g * (len(built) - 1) + 2 * py_pad
    im = Image.new("RGBA", (max(1, w), max(1, h)), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    if fill is not None:
        d.rounded_rectangle((0, 0, w - 1, h - 1), radius=round(radius * k), fill=fill)
    y = py_pad
    for text, font, colour, sw, tw, th, top in built:
        x = px_pad + sw if align == "left" else (w - tw) / 2 + sw
        d.text((x, y + sw - top), text, font=font, fill=colour + (255,), anchor="lt", stroke_width=sw, stroke_fill=BLACK + (255,))
        y += th + g
    return im


def _put(layer, sprite, box, alpha, scale=1.0):
    """Paste a sprite centred on its box, scaled and faded, clipped to the layer."""
    if alpha <= 0:
        return
    if abs(scale - 1.0) > 1e-3:
        sprite = sprite.resize((max(1, round(sprite.width * scale)), max(1, round(sprite.height * scale))), Image.LANCZOS)
    if alpha < 1:
        sprite = sprite.copy()
        sprite.putalpha(sprite.getchannel("A").point(lambda v: int(v * alpha)))
    x = round(box[0] + box[2] / 2 - sprite.width / 2)
    y = round(box[1] + box[3] / 2 - sprite.height / 2)
    cx0, cy0 = max(0, -x), max(0, -y)
    cx1, cy1 = min(sprite.width, layer.width - x), min(sprite.height, layer.height - y)
    if cx1 <= cx0 or cy1 <= cy0:
        return
    layer.alpha_composite(sprite.crop((cx0, cy0, cx1, cy1)), dest=(x + cx0, y + cy0))


class Overlay:
    """Draws overlay.json on graded frames. `anchors` is an anchors_file.Anchors; `captions_track` the post step's captions.Track.

    draw(image, frame, t) paints onto a PIL RGB image in place (captions are drawn after it, by the caller, so they stay on top).
    pieces(frame, t) is the layout of one frame without drawing; layout_report() runs the layout checks on every frame.
    """

    def __init__(self, spec, anchors, width, height, captions_track=None, fps=30, nframes=None):
        self.spec, self.anchors, self.width, self.height = spec, anchors, width, height
        required = names_used(spec)
        missing = (required["points"] - anchors.point_names) | (required["values"] - anchors.value_names)
        if missing:
            raise media.MediaError("anchors.json: missing referenced names: " + ", ".join(sorted(missing)))
        self.track, self.fps, self.nframes = captions_track, fps, nframes
        self.s, self.sy = width / BASE_W, height / BASE_H
        self.safe = captions.safe_zone(width, height)
        self._fonts = _Fonts()
        self._sprites = {}
        self._caption_boxes = {}
        nbars = len(spec["bars"])
        self.reserve_left = round(56 * self.s) if nbars >= 1 else 0
        self.reserve_right = round(56 * self.s) if nbars >= 2 else 0
        self._stack = self._stack_tops()

    # ---- sprites
    def _sprite(self, key, build):
        if key not in self._sprites:
            if len(self._sprites) > 4000:
                self._sprites.clear()
            self._sprites[key] = build()
        return self._sprites[key]

    def _safe_w(self):
        return self.safe[2] - self.safe[0]

    def _counter_sprite(self, text):
        c = self.spec["counter"]
        rows = ([(c["label"], HUD_FONTS, 46, (190, 205, 225), 0)] if c.get("label") else []) + [(text, HUD_FONTS, 124, WHITE, 4)]
        return self._sprite(("counter", text), lambda: _block(self._fonts, rows, (56, 22), 34, (0, 0, 0, 150), "center", 660, 10,
                                                              self._safe_w(), self.s))

    def _tag_sprite(self):
        tag = self.spec["tag"]
        return self._sprite(("tag",), lambda: _block(self._fonts, [(tag["text"], HUD_FONTS, 64, WHITE, 0)], (36, 20), 22,
                                                     (200, 30, 20, 235), "center", 0, 0, self._safe_w(), self.s))

    def _big_sprite(self, i):
        b = self.spec["big"][i]
        rows = [(b["text"], BIG_FONTS, 240, YELLOW, 12)] + ([(b["sub"], HUD_FONTS, 58, WHITE, 6)] if b.get("sub") else [])
        max_w = self._safe_w() - self.reserve_left - self.reserve_right
        return self._sprite(("big", i), lambda: _block(self._fonts, rows, (0, 0), 0, None, "center", 0, 14, max_w, self.s))

    def _label_sprite(self, i):
        lab = self.spec["labels"][i]
        rows = [(lab["title"], HUD_FONTS, 48, WHITE, 0)] + ([(lab["value"], HUD_FONTS, 88, YELLOW, 0)] if lab.get("value") else [])
        max_w = self._safe_w() - self.reserve_left - self.reserve_right
        return self._sprite(("label", i), lambda: _block(self._fonts, rows, (28, 20), 26, (0, 0, 0, 185), "left", 0, 14, max_w, self.s))

    def _measure_sprite(self, i):
        m = self.spec["measures"][i]
        return self._sprite(("measure", i), lambda: _block(self._fonts, [(m["text"], HUD_FONTS, 80, YELLOW, 8)], (0, 0), 0, None,
                                                           "center", 0, 0, self._safe_w(), self.s))

    def _bar_label_sprite(self, i):
        b = self.spec["bars"][i]
        return self._sprite(("bar", i), lambda: _block(self._fonts, [(b["label"], HUD_FONTS, 34, WHITE, 3)], (0, 0), 0, None,
                                                       "center", 0, 0, self._safe_w() // 3, self.s))

    # ---- fixed places
    def _stack_tops(self):
        """Top y of the tag, the counter and each big number. Each sits below every earlier one whose window overlaps its own,
        decided once from the windows, so nothing jumps when another element fades."""
        order = []
        if self.spec["tag"]:
            order.append(("tag", self.spec["tag"], self._tag_sprite().height))
        if self.spec["counter"]:
            order.append(("counter", self.spec["counter"], self._counter_sprite("0").height))
        for i, b in enumerate(self.spec["big"]):
            order.append((f"big[{i}]", b, self._big_sprite(i).height))
        tops, gap = {}, round(16 * self.sy)
        for j, (ident, el, h) in enumerate(order):
            top = self.safe[1] + round(12 * self.sy)
            for ident2, el2, h2 in order[:j]:
                if el2["from"] < el["to"] and el["from"] < el2["to"]:
                    top = max(top, tops[ident2] + h2 + gap)
            if ident.startswith("big"):
                top = max(top, round(0.2 * self.height))
            tops[ident] = min(top, self.safe[3] - h)
        return tops

    def _caption_box(self, t):
        if self.track is None:
            return None
        hit = self.track.at(t)
        if hit is None:
            return None
        ci, act, _ = hit
        if (ci, act) not in self._caption_boxes:
            self._caption_boxes[(ci, act)] = captions.place(self.track.chunks[ci], act, self.track.font, self.width, self.height,
                                                            captions.POP)
        return self._caption_boxes[(ci, act)]

    def _visible_point(self, frame, name):
        pt = self.anchors.point(frame, name)
        if pt is None or not pt[2] or not (0.0 <= pt[0] <= 1.0 and 0.0 <= pt[1] <= 1.0):
            return None
        return pt[0] * self.width, pt[1] * self.height

    def text_of(self, piece):
        return piece.get("text")

    # ---- layout of one frame
    def pieces(self, frame, t):
        """Every element on screen at (frame, t): kind, id, box (x, y, w, h) at full size, alpha, scale and what draw() needs."""
        spec, out = self.spec, []
        cx = self.width / 2
        tag = spec["tag"]
        if tag and _on(tag, t):
            sp = self._tag_sprite()
            out.append({"kind": "tag", "id": "tag", "sprite": sp, "alpha": _window_alpha(tag, t), "scale": 1.0,
                        "box": (round(cx - sp.width / 2), self._stack["tag"], sp.width, sp.height), "text": tag["text"]})
        c = spec["counter"]
        if c and _on(c, t):
            v = self.anchors.value(frame, c["value"])
            if v is not None:
                text = format_value(v, c["format"]) + (f" {c['unit']}" if c.get("unit") else "")
                sp = self._counter_sprite(text)
                out.append({"kind": "counter", "id": "counter", "sprite": sp, "alpha": 1.0, "scale": 1.0,
                            "box": (round(cx - sp.width / 2), self._stack["counter"], sp.width, sp.height), "text": text})
        for i, b in enumerate(spec["big"]):
            if _on(b, t):
                sp = self._big_sprite(i)
                pop = min(1.0, 0.6 + 0.4 * _ease_out_back((t - b["from"]) / BIG_POP))
                out.append({"kind": "big", "id": f"big[{i}]", "sprite": sp, "scale": pop,
                            "alpha": _smooth(b["from"], b["from"] + 0.08, t) * (1 - _smooth(b["to"] - FADE_OUT, b["to"], t)),
                            "box": (round(cx - sp.width / 2), self._stack[f"big[{i}]"], sp.width, sp.height), "text": b["text"]})
        for i, b in enumerate(spec["bars"]):
            if _on(b, t):
                out.append(self._bar_piece(i, b, frame, t))
        obstacles = [p["box"] for p in out]
        cap = self._caption_box(t)
        if cap is not None:
            obstacles.append(cap)
        for i, m in enumerate(spec["measures"]):
            if _on(m, t):
                piece = self._measure_piece(i, m, frame, t)
                if piece:
                    out.append(piece)
                    obstacles.append(piece["box"])
        for i, lab in enumerate(spec["labels"]):
            if _on(lab, t):
                piece = self._label_piece(i, lab, frame, t, obstacles)
                if piece:
                    out.append(piece)
                    obstacles.append(piece["box"])
        return out

    def _bar_piece(self, i, b, frame, t):
        s, sy = self.s, self.sy
        pill_w = round(40 * s)
        x = self.safe[0] if i == 0 else self.safe[2] - pill_w
        y0, y1 = round(520 * sy), round(1180 * sy)
        v = self.anchors.value(frame, b["value"])
        fill = 0.0 if v is None else min(1.0, max(0.0, (v - b["min"]) / (b["max"] - b["min"])))
        top, label_box = y0, None
        x_left, right = x, x + pill_w
        if b.get("label"):
            sp = self._bar_label_sprite(i)
            top = y0 - round(14 * sy) - sp.height
            lx = x if i == 0 else x + pill_w - sp.width          # the left bar's label starts at its edge, the right one ends there
            label_box = (lx, top, sp.width, sp.height)
            x_left, right = min(x_left, lx), max(right, lx + sp.width)
        return {"kind": "bar", "id": f"bars[{i}]", "alpha": _window_alpha(b, t), "scale": 1.0, "fill": fill,
                "bar": (x, y0, pill_w, y1 - y0), "label_box": label_box, "box": (x_left, top, right - x_left, y1 - top)}

    def _measure_piece(self, i, m, frame, t):
        a, b = self._visible_point(frame, m["a"]), self._visible_point(frame, m["b"])
        if a is None or b is None:
            return None
        sp = self._measure_sprite(i)
        mx, my = (a[0] + b[0]) / 2, (a[1] + b[1]) / 2
        L, T, R, B = self.safe
        if abs(b[0] - a[0]) >= abs(b[1] - a[1]):
            x, y = mx - sp.width / 2, min(a[1], b[1]) - 46 * self.s - sp.height
        else:
            x, y = mx + 30 * self.s, my - sp.height / 2
            if x + sp.width > R:
                x = mx - 30 * self.s - sp.width
        x = min(max(x, L), R - sp.width)
        y = min(max(y, T), B - sp.height)
        grow = _smooth(m["from"], m["from"] + MEASURE_GROW, t)
        return {"kind": "measure", "id": f"measures[{i}]", "sprite": sp, "alpha": _window_alpha(m, t), "scale": 1.0, "grow": grow,
                "line": (a, b), "box": (round(x), round(y), sp.width, sp.height), "text": m["text"]}

    def _label_piece(self, i, lab, frame, t, obstacles):
        at = self._visible_point(frame, lab["anchor"])
        if at is None:
            return None
        ax, ay = at
        sp = self._label_sprite(i)
        w, h = sp.size
        L, T, R, B = self.safe
        g = round(28 * self.s)
        xs = {"left": L + self.reserve_left, "right": R - self.reserve_right - w}
        pref = lab["side"] if lab["side"] != "auto" else ("left" if ax > self.width / 2 else "right")
        sides = [pref] if lab["side"] != "auto" else [pref, "right" if pref == "left" else "left"]
        cands = [(xs[side], y) for side in sides for y in (round(ay - g - h), round(ay + g))]
        box = None
        for x, y in cands:
            c = (x, y, w, h)
            if _inside(c, self.safe) and not any(_intersects(c, o) for o in obstacles):
                box = c
                break
        if box is None:
            # No free place inside the safe zone: the label waits for a frame where it fits instead of covering other text. These
            # frames count as hidden, so a label that is crowded out too long shows up as a label_hidden finding.
            return None
        px = min(max(ax, box[0]), box[0] + w)
        py = box[1] + h if box[1] + h <= ay else (box[1] if box[1] >= ay else ay)
        alpha = _smooth(lab["from"], lab["from"] + 0.12, t) * (1 - _smooth(lab["to"] - FADE_OUT, lab["to"], t))
        scale = min(1.0, 0.6 + 0.4 * _ease_out_back((t - lab["from"]) / LABEL_POP))
        return {"kind": "label", "id": f"labels[{i}]", "sprite": sp, "alpha": alpha, "scale": scale, "box": box,
                "pointer": ((ax, ay), (px, py)), "text": lab["title"]}

    # ---- drawing
    def draw(self, image, frame, t):
        """Paint the overlay of (frame, t) onto `image` (PIL RGB) in place. Returns the pieces drawn."""
        pieces = self.pieces(frame, t)
        if not pieces:
            return pieces
        layer = Image.new("RGBA", image.size, (0, 0, 0, 0))
        d = ImageDraw.Draw(layer)
        s = self.s
        for p in pieces:
            a = p["alpha"]
            if a <= 0:
                continue
            k = p["kind"]
            if k == "bar":
                x, y, w, h = p["bar"]
                d.rounded_rectangle((x, y - round(6 * s), x + w, y + h + round(6 * s)), radius=round(18 * s),
                                    fill=(0, 0, 0, int(150 * a)))
                inner_x, inner_w = x + round(6 * s), w - round(12 * s)
                filled = int(h * p["fill"])
                for j in range(filled):
                    gcol = j / max(1, h)
                    col = (int(60 + 195 * gcol), int(170 - 120 * gcol), int(255 - 225 * gcol), int(255 * a))
                    d.line((inner_x, y + h - j, inner_x + inner_w, y + h - j), fill=col)
                if p["label_box"] is not None:
                    _put(layer, self._bar_label_sprite(int(p["id"][5:-1])), p["label_box"], a)
            elif k == "measure":
                (x0, y0), (x1, y1) = p["line"]
                xc, yc = (x0 + x1) / 2, (y0 + y1) / 2
                g = p["grow"]
                if g > 0:
                    ex0, ey0 = xc + (x0 - xc) * g, yc + (y0 - yc) * g
                    ex1, ey1 = xc + (x1 - xc) * g, yc + (y1 - yc) * g
                    col = YELLOW + (int(255 * a),)
                    lw = max(2, round(9 * s))
                    d.line((ex0, ey0, ex1, ey1), fill=BLACK + (int(160 * a),), width=lw + max(2, round(6 * s)))
                    d.line((ex0, ey0, ex1, ey1), fill=col, width=lw)
                    length = math.hypot(x1 - x0, y1 - y0) or 1.0
                    nx, ny = -(y1 - y0) / length, (x1 - x0) / length
                    tick = 34 * s
                    for ex, ey in ((ex0, ey0), (ex1, ey1)):
                        d.line((ex - nx * tick, ey - ny * tick, ex + nx * tick, ey + ny * tick), fill=col, width=lw)
                _put(layer, p["sprite"], p["box"], a * _smooth(0.3, 1.0, g))
            elif k == "label":
                (ax, ay), (px, py) = p["pointer"]
                lw = max(2, round(4 * s))
                d.line((ax, ay, px, py), fill=WHITE + (int(200 * a),), width=lw)
                r = 14 * s
                d.ellipse((ax - r, ay - r, ax + r, ay + r), fill=YELLOW + (int(255 * a),), outline=BLACK + (int(255 * a),),
                          width=max(1, round(4 * s)))
                _put(layer, p["sprite"], p["box"], a, p["scale"])
            else:
                _put(layer, p["sprite"], p["box"], a, p["scale"])
        image.paste(layer, (0, 0), layer)
        return pieces

    # ---- checks
    def element_counts(self):
        spec = self.spec
        return {"counter": int(spec["counter"] is not None), "labels": len(spec["labels"]), "measures": len(spec["measures"]),
                "bars": len(spec["bars"]), "big": len(spec["big"]), "tag": int(spec["tag"] is not None)}

    def layout_report(self, nframes=None):
        """Layout checks on every frame, without drawing.

        Blocking: an element outside the safe zone, two elements overlapping, an element overlapping the caption box.
        Findings only: a label hidden for more than 30% of its window, a counter that goes down and up again (or up and down).
        """
        n = nframes if nframes is not None else self.nframes
        if n is None:
            raise ValueError("layout_report needs the frame count")
        groups, label_frames, label_hidden = {}, {}, {}
        counter = self.spec["counter"]
        values = []
        for f in range(n):
            t = f / self.fps
            pieces = self.pieces(f, t)
            ids = {p["id"] for p in pieces}
            for code, elements in frame_findings(pieces, self._caption_box(t), self.safe):
                g = groups.setdefault((code, elements), {"code": code, "elements": list(elements), "first_frame": f,
                                                         "last_frame": f, "frames": 0})
                g["last_frame"], g["frames"] = f, g["frames"] + 1
            for i, lab in enumerate(self.spec["labels"]):
                if _on(lab, t):
                    label_frames[i] = label_frames.get(i, 0) + 1
                    if f"labels[{i}]" not in ids:
                        label_hidden[i] = label_hidden.get(i, 0) + 1
            if counter and _on(counter, t):
                v = self.anchors.value(f, counter["value"])
                if v is not None:
                    values.append((f, v))
        blocking = [g for (code, _), g in groups.items() if code in BLOCKING]
        findings = []
        for i, total in sorted(label_frames.items()):
            share = label_hidden.get(i, 0) / total
            if share > HIDDEN_SHARE:
                findings.append({"code": "label_hidden", "elements": [f"labels[{i}]"], "share": round(share, 3), "frames": total})
        rev = _reversal(values)
        if rev is not None:
            findings.append({"code": "counter_reversal", "elements": ["counter"], "first_frame": rev})
        return {"version": 1, "frames_checked": n, "ok": not blocking, "blocking": blocking, "findings": findings}


def _reversal(values):
    """The first frame where a running number turns back (down then up, or up then down), or None."""
    if len(values) < 3:
        return None
    nums = [v for _, v in values]
    eps = 1e-9 * max(1.0, max(nums) - min(nums))
    direction = 0
    for (f, v), (_, prev) in zip(values[1:], values[:-1]):
        step = v - prev
        if abs(step) <= eps:
            continue
        sign = 1 if step > 0 else -1
        if direction and sign != direction:
            return f
        direction = sign
    return None
