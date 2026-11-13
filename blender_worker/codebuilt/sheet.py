"""Contact sheet of frames (needs Pillow; run outside Blender)."""
import glob
import os

from .paths import require_abs


def sheet_layout(count, cols, w, src_w, src_h):
    """(cell_w, cell_h, rows, sheet_w, sheet_h) for count frames."""
    h = int(w * src_h / src_w)
    rows = (count + cols - 1) // cols
    return w, h, rows, cols * w, rows * h


def pick_evenly(files, limit):
    """At most limit files spread evenly, keeping the first and the last."""
    if limit <= 0 or len(files) <= limit:
        return list(files)
    if limit == 1:
        return [files[0]]
    return [files[round(i * (len(files) - 1) / (limit - 1))] for i in range(limit)]


def contact_sheet(src_dir, out_path, cols=6, cell_w=300, limit=0):
    """Tile the PNGs in src_dir into one labelled jpg. Returns the number of frames used."""
    from PIL import Image, ImageDraw
    src_dir, out_path = require_abs(src_dir), require_abs(out_path)
    files = pick_evenly(sorted(glob.glob(os.path.join(src_dir, "*.png"))), limit)
    if not files:
        raise FileNotFoundError(f"no png frames in {src_dir}")
    ims = [Image.open(f).convert("RGB") for f in files]
    w, h, _rows, W, H = sheet_layout(len(ims), cols, cell_w, ims[0].width, ims[0].height)
    sheet = Image.new("RGB", (W, H), "black")
    for i, (f, im) in enumerate(zip(files, ims)):
        im = im.resize((w, h), Image.LANCZOS)
        ImageDraw.Draw(im).text((6, 4), os.path.basename(f)[:-4], fill="yellow")
        sheet.paste(im, ((i % cols) * w, (i // cols) * h))
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    sheet.save(out_path, quality=88)
    return len(ims)


if __name__ == "__main__":
    import sys
    n = contact_sheet(sys.argv[1], sys.argv[2], int(sys.argv[3]) if len(sys.argv) > 3 else 6)
    print(sys.argv[2], n)
