"""Contact sheet of a finished video (CB4 / KAN-913).

The chat's sheet.py tiled preview PNGs. This one reads the finished mp4, so it shows what was encoded: grade, vignette and captions.
Frames are pulled with ffmpeg, evenly spaced across the video, and each tile is labelled with its time.
"""
from pathlib import Path

from PIL import Image, ImageDraw

from .media import probe, run_ffmpeg

TILE_W = 300


def extract_frames(video, out_dir, times, width=TILE_W):
    """One PNG per time (seconds). Returns the paths in order."""
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    paths = []
    for i, t in enumerate(times):
        p = out_dir / f"t{i:03d}.png"
        run_ffmpeg(["-y", "-loglevel", "error", "-ss", f"{max(0.0, t):.3f}", "-i", str(video), "-frames:v", "1", "-vf", f"scale={width}:-2", str(p)])
        if not p.is_file():
            raise RuntimeError(f"no frame at {t:.3f} s in {video}")
        paths.append(p)
    return paths


def contact_sheet(video, out_path, count=12, cols=6):
    """Tile `count` evenly spaced frames (centre of each slice) into one JPEG, `cols` per row. Returns the path."""
    info = probe(video)
    times = [(i + 0.5) * info["duration"] / count for i in range(count)]
    out_path = Path(out_path)
    work = out_path.parent / f"{out_path.stem}_frames"
    frames = extract_frames(video, work, times)
    ims = []
    for f in frames:  # frames ffmpeg just extracted from the host-made video, as PNG
        with Image.open(f, formats=["PNG"]) as opened:
            ims.append(opened.convert("RGB"))
    h = ims[0].height
    rows = (count + cols - 1) // cols
    sheet = Image.new("RGB", (cols * TILE_W, rows * h), "black")
    for i, (im, t) in enumerate(zip(ims, times)):
        im = im.resize((TILE_W, h), Image.LANCZOS)
        ImageDraw.Draw(im).text((6, 4), f"{t:.1f}s", fill="yellow")
        sheet.paste(im, ((i % cols) * TILE_W, (i // cols) * h))
    out_path.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(out_path, quality=88)
    for f in frames:
        f.unlink()
    work.rmdir()
    return out_path
