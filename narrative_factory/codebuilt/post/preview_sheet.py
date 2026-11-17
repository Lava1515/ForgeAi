"""Preview contact sheets for the visual loop (KAN-934), and the probe image for the vision canary.

Runs on the host, after the offline executor container is gone, as `python -I preview_sheet.py sheets <frames dir> <out dir> <CODE>`
or `... canary <nonce> <out.png>`. It reads only files named NNNN.png that the container left in the preview folder, decodes them
as PNG with a pixel cap (verify, then reopen), and writes JPEG sheets of up to 12 tiles each. Every sheet header carries a code
the host draws into the pixels, so a reply that does not echo it did not come from looking at this sheet. Standard library and
Pillow only. Prints one JSON line.
"""
import json
import math
import random
import re
import sys
import warnings
import argparse
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

MAX_IMAGE_PIXELS = 2_000_000          # a half-size 1080x1920 frame is 0.52 MP; anything larger is not a preview frame
MAX_FRAME_BYTES = 4 * 1024 * 1024
MAX_FRAMES = 24
PER_SHEET = 12
COLS = 4
CELL = (270, 480)
HEADER_H = 64
CODE_RE = re.compile(r"^[A-Z0-9]{5}$")
FRAME_RE = re.compile(r"^(\d{4})\.png$")
ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"   # no I, O, 0, 1: the model reads these off a picture
COLORS = {"red": (220, 30, 30), "green": (30, 170, 60), "blue": (30, 60, 220), "yellow": (240, 220, 30)}

Image.MAX_IMAGE_PIXELS = MAX_IMAGE_PIXELS
# `python -I` intentionally ignores the working directory. Load the checked-in post kit from this script's repository root.
sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
from narrative_factory.codebuilt.post import media


class SheetError(Exception):
    """Anything wrong with the input frames or arguments. The message is short and holds no paths."""


def _font(size):
    try:
        return ImageFont.load_default(size=size)
    except TypeError:                      # an old Pillow without the size argument
        return ImageFont.load_default()


def _list_frames(frames_dir):
    frames_dir = Path(frames_dir)
    if not frames_dir.is_dir() or frames_dir.is_symlink():
        raise SheetError("frames folder is missing or a link")
    found = []
    for entry in sorted(frames_dir.iterdir()):
        match = FRAME_RE.match(entry.name)
        st = entry.lstat()
        if not match or not entry.is_file() or entry.is_symlink() or st.st_nlink != 1:
            raise SheetError("unexpected entry in the frames folder")
        if st.st_size > MAX_FRAME_BYTES or st.st_size == 0:
            raise SheetError("a frame file has an unreasonable size")
        found.append((int(match.group(1)), entry))
    found.sort()
    if not found:
        raise SheetError("no frames to show")
    if len(found) > MAX_FRAMES:
        raise SheetError(f"more than {MAX_FRAMES} frames")
    return found


def _open_png(path):
    """Decode one untrusted frame: PNG only, pixel cap, verify then reopen, plain RGB copy."""
    try:
        warnings.simplefilter("error", Image.DecompressionBombWarning)   # a warning is a refusal here, not a log line
        with Image.open(path, formats=["PNG"]) as probe:
            if probe.width * probe.height > MAX_IMAGE_PIXELS:   # Pillow only warns up to twice its own limit
                raise SheetError("a frame is larger than a preview frame can be")
            probe.verify()
        with Image.open(path, formats=["PNG"]) as im:
            return im.convert("RGB")
    except (OSError, ValueError, Image.DecompressionBombError, Image.DecompressionBombWarning, SyntaxError) as error:
        raise SheetError(f"a frame is not a valid PNG ({type(error).__name__})") from None


FLAT_STD = 0.025      # luma standard deviation below this AND
FLAT_RANGE = 0.12     # brightest minus darkest pixel below this: one flat colour (camera inside a wall, sky dome or plate; or nothing lit).
                      # The range is what tells a flat surface from a sparse star field, whose spread is just as low (review of 2026-11-14:
                      # frame 1756 of job mwfoupp9-07ab7d-pv5, stars on black, spread 0.006).
PLAIN_STD = 0.045     # spread below this without being flat: nearly one colour, worth a second look
DARK_MEAN = 0.05      # mean luma below this: almost black
BLOWN_SHARE = 0.25    # more than this share of pixels at luma 0.97 or above: blown out


def frame_stats(im):
    """Measured facts about one preview frame, for the look prompt: mean luma and its spread (0..1), the share of blown pixels and
    a flag: 'flat' (a single flat colour, the mark of a camera inside or against a surface), 'dark', 'blown', 'plain' (nearly one
    colour, advisory) or None."""
    grey = im.convert("L")
    px = list(grey.getdata())            # at tile size, not downsampled: small stars and thin lines must survive
    n = len(px)
    mean = sum(px) / n / 255.0
    std = (sum((p / 255.0 - mean) ** 2 for p in px) / n) ** 0.5
    blown = sum(1 for p in px if p >= 247) / n
    ordered = sorted(px)
    k = max(1, n // 20000)               # ignore the 0.005 percent most extreme pixels at each end (a hot pixel or two), no more: stars are few
    spread_range = (ordered[-k] - ordered[k - 1]) / 255.0
    # 'plain' is advisory: almost one colour but with something in it (a readout on a wall, a soft gradient). The numbers cannot
    # tell that from a legitimate quiet frame, so the reviewer is asked to look; only 'flat' blocks a pass.
    flag = ("flat" if std < FLAT_STD and spread_range < FLAT_RANGE else "dark" if mean < DARK_MEAN
            else "blown" if blown > BLOWN_SHARE else "plain" if std < PLAIN_STD else None)
    return {"luma": round(mean, 3), "spread": round(std, 3), "range": round(spread_range, 3), "blown": round(blown, 3), "flag": flag}


def make_sheets(frames_dir, out_dir, code, cols=COLS, cell=CELL, per_sheet=PER_SHEET, *, words=None,
                overlay_spec=None, anchors_path=None, lead=0.0, nframes=None, fps=30, job_root=None):
    if not isinstance(code, str) or not CODE_RE.match(code):
        raise SheetError("code must be 5 characters A-Z or 0-9")
    frames = _list_frames(frames_dir)
    root = Path(job_root or Path(frames_dir).parent).resolve()
    track = ov = None
    layout_findings = []
    if words is not None:
        from narrative_factory.codebuilt.post import captions
        _, word_list = captions.load_words(media.inside(root, words))
        if isinstance(lead, bool) or not isinstance(lead, (int, float)) or not math.isfinite(lead):
            raise SheetError("lead must be finite")
        with _open_png(frames[0][1]) as first:
            track = captions.Track(word_list, first.width, first.height, lead=lead)
    if overlay_spec is not None:
        if isinstance(nframes, bool) or not isinstance(nframes, int) or nframes < 1:
            raise SheetError("nframes must be a positive whole number with overlay inputs")
        if isinstance(fps, bool) or not isinstance(fps, (int, float)) or not math.isfinite(fps) or fps <= 0:
            raise SheetError("fps must be positive and finite with overlay inputs")
        from narrative_factory.codebuilt.post import anchors_file, overlay
        root = Path(job_root or Path(frames_dir).parent).resolve()
        spec = overlay.load_spec(overlay_spec, video_seconds=nframes / fps, job_root=root)
        marks = anchors_file.load(anchors_path, nframes, job_root=root) if anchors_path else anchors_file.Anchors.empty()
        if any(overlay.names_used(spec).values()) and not anchors_path:
            raise SheetError("overlay.json names anchors or values but anchors.json is missing")
        with _open_png(frames[0][1]) as first:
            ov = overlay.Overlay(spec, marks, first.width, first.height, captions_track=track, fps=fps, nframes=nframes)
        sampled_labels = {i: [0, 0] for i in range(len(spec["labels"]))}
        counter_values = []
        for frame, _ in frames:
            t = frame / fps
            pieces = ov.pieces(frame, t)
            caption_box = ov._caption_box(t)
            for code_name, elements in overlay.frame_findings(pieces, caption_box, ov.safe):
                layout_findings.append({"frame": frame, "code": code_name, "elements": list(elements)})
            visible = {p["id"] for p in pieces}
            for i, item in enumerate(spec["labels"]):
                if item["from"] <= t < item["to"]:
                    sampled_labels[i][0] += 1
                    sampled_labels[i][1] += f"labels[{i}]" not in visible
            counter = spec["counter"]
            if counter and counter["from"] <= t < counter["to"]:
                value = marks.value(frame, counter["value"])
                if value is not None:
                    counter_values.append((frame, value))
        for i, (active, hidden) in sampled_labels.items():
            if active and hidden / active > 0.30:
                layout_findings.append({"frame": -1, "code": "label_hidden", "elements": [f"labels[{i}]"]})
        direction = 0
        for (_, previous), (frame, current) in zip(counter_values, counter_values[1:]):
            step = current - previous
            sign = (step > 0) - (step < 0)
            if sign and direction and sign != direction:
                layout_findings.append({"frame": frame, "code": "counter_reversal", "elements": ["counter"]})
                break
            if sign:
                direction = sign
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    cw, ch = cell
    groups = [frames[i:i + per_sheet] for i in range(0, len(frames), per_sheet)]
    big, small = _font(40), _font(22)
    sheets = []
    for index, group in enumerate(groups, start=1):
        rows = (len(group) + cols - 1) // cols
        sheet = Image.new("RGB", (cols * cw, HEADER_H + rows * ch), (20, 20, 20))
        draw = ImageDraw.Draw(sheet)
        draw.rectangle([0, 0, sheet.width, HEADER_H - 1], fill=(255, 255, 255))
        draw.text((12, 10), f"CODE {code}", fill=(0, 0, 0), font=big)
        draw.text((sheet.width - 190, 20), f"SHEET {index}/{len(groups)}", fill=(0, 0, 0), font=small)
        tiles = []
        for slot, (number, path) in enumerate(group):
            n = (index - 1) * per_sheet + slot + 1
            im = _open_png(path)
            if ov:
                ov.draw(im, number, number / fps)
            if track:
                track.draw(im, number / fps)
            im = im.resize((cw, ch), Image.LANCZOS)
            stats = frame_stats(im)
            td = ImageDraw.Draw(im)
            td.rectangle([0, 0, 120, 26], fill=(0, 0, 0))
            td.text((6, 3), f"T{n}  f{number}", fill=(255, 235, 60), font=small)
            sheet.paste(im, ((slot % cols) * cw, HEADER_H + (slot // cols) * ch))
            tiles.append({"n": n, "frame": number, **stats})
        name = f"sheet_{index}.jpg"
        sheet.save(out_dir / name, format="JPEG", quality=85, optimize=False)
        sheets.append({"file": name, "code": code, "tiles": tiles, "w": sheet.width, "h": sheet.height,
                       "layout_findings": [f for f in layout_findings if (f["frame"] < 0 and index == 1) or f["frame"] in {x["frame"] for x in tiles}]})
    return sheets


def make_canary(nonce, out_path):
    """A 270x480 PNG: a random 5-character code on top and four colour quadrants in a random order, all drawn from the nonce."""
    rng = random.Random(str(nonce))
    code = "".join(rng.choice(ALPHABET) for _ in range(5))
    names = list(COLORS)
    rng.shuffle(names)
    slots = ["top_left", "top_right", "bottom_left", "bottom_right"]
    im = Image.new("RGB", CELL, (255, 255, 255))
    d = ImageDraw.Draw(im)
    w, h = CELL[0] // 2, (CELL[1] - 40) // 2
    for i, (slot, name) in enumerate(zip(slots, names)):
        x, y = (i % 2) * w, 40 + (i // 2) * h
        d.rectangle([x, y, x + w - 1, y + h - 1], fill=COLORS[name])
    d.text((8, 4), code, fill=(0, 0, 0), font=_font(30))
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    im.save(out_path, format="PNG")
    return {"code": code, "quadrants": dict(zip(slots, names))}


def main(argv):
    try:
        if len(argv) >= 5 and argv[1] == "sheets":
            parser = argparse.ArgumentParser(add_help=False)
            parser.add_argument("--words"); parser.add_argument("--overlay"); parser.add_argument("--anchors"); parser.add_argument("--lead", type=float, default=0.0)
            parser.add_argument("--nframes", type=int); parser.add_argument("--fps", type=float, default=30); parser.add_argument("--job-root")
            opts = parser.parse_args(argv[5:])
            result = {"status": "ok", "sheets": make_sheets(argv[2], argv[3], argv[4], words=opts.words,
                overlay_spec=opts.overlay, anchors_path=opts.anchors, lead=opts.lead, nframes=opts.nframes, fps=opts.fps, job_root=opts.job_root)}
        elif len(argv) == 4 and argv[1] == "canary":
            result = {"status": "ok", **make_canary(argv[2], argv[3])}
        else:
            print(json.dumps({"status": "error", "error": "usage: preview_sheet.py sheets <frames dir> <out dir> <CODE> [--words FILE --lead SEC] [--overlay FILE --anchors FILE --nframes N --job-root DIR] | canary <nonce> <out.png>"}))
            return 2
    except (SheetError, media.MediaError, OSError, ValueError, KeyError, TypeError, AttributeError) as error:
        print(json.dumps({"status": "error", "error": str(error)[:200]}))
        return 1
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
