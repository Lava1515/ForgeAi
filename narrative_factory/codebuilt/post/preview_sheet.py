"""Preview contact sheets for the visual loop (KAN-934), and the probe image for the vision canary.

Runs on the host, after the offline executor container is gone, as `python -I preview_sheet.py sheets <frames dir> <out dir> <CODE>`
or `... canary <nonce> <out.png>`. It reads only files named NNNN.png that the container left in the preview folder, decodes them
as PNG with a pixel cap (verify, then reopen), and writes JPEG sheets of up to 12 tiles each. Every sheet header carries a code
the host draws into the pixels, so a reply that does not echo it did not come from looking at this sheet. Standard library and
Pillow only. Prints one JSON line.
"""
import json
import random
import re
import sys
import warnings
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


def make_sheets(frames_dir, out_dir, code, cols=COLS, cell=CELL, per_sheet=PER_SHEET):
    if not isinstance(code, str) or not CODE_RE.match(code):
        raise SheetError("code must be 5 characters A-Z or 0-9")
    frames = _list_frames(frames_dir)
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
            im = _open_png(path).resize((cw, ch), Image.LANCZOS)
            td = ImageDraw.Draw(im)
            td.rectangle([0, 0, 120, 26], fill=(0, 0, 0))
            td.text((6, 3), f"T{n}  f{number}", fill=(255, 235, 60), font=small)
            sheet.paste(im, ((slot % cols) * cw, HEADER_H + (slot // cols) * ch))
            tiles.append({"n": n, "frame": number})
        name = f"sheet_{index}.jpg"
        sheet.save(out_dir / name, format="JPEG", quality=85, optimize=False)
        sheets.append({"file": name, "code": code, "tiles": tiles, "w": sheet.width, "h": sheet.height})
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
        if len(argv) == 5 and argv[1] == "sheets":
            result = {"status": "ok", "sheets": make_sheets(argv[2], argv[3], argv[4])}
        elif len(argv) == 4 and argv[1] == "canary":
            result = {"status": "ok", **make_canary(argv[2], argv[3])}
        else:
            print(json.dumps({"status": "error", "error": "usage: preview_sheet.py sheets <frames dir> <out dir> <CODE> | canary <nonce> <out.png>"}))
            return 2
    except (SheetError, OSError) as error:
        print(json.dumps({"status": "error", "error": str(error)[:200]}))
        return 1
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
