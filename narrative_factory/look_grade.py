"""KAN-507 look_v2: the editor's optional grade, as ffmpeg filters. Order: 3D LUT, soft vignette, fine grain.
The editor puts these before the caption burn, so captions stay clean.

The only LUT sources: a .cube path the policy supplies, or a cube this module generates by maths (build_cube).
No downloaded or hosted LUT files (KAN-504 audit).

Policy (job/policy key look_v2): True for the defaults (vignette on, grain 2, no LUT), or a dict:
  lut       path to a .cube file (must exist)
  grade     dict of build_cube parameters: contrast, saturation, shadow_tint, highlight_tint (cube written next to the edit)
  vignette  bool, default True
  grain     0..3, ffmpeg noise strength in percent (default 2); under 4 by rule
"""

from pathlib import Path

GRAIN_MAX = 3  # ffmpeg's noise strength is an integer percent; the ticket's ceiling is under 4
GRAIN_DEFAULT = 2
VIGNETTE_ANGLE = 0.5  # radians; ffmpeg's default is pi/5 (0.63), a little under that keeps it soft
LUMA = (0.2126, 0.7152, 0.0722)  # Rec.709
GENERATED_CUBE = "grade.cube"


def build_cube(path, size=17, contrast=1.0, saturation=1.0, shadow_tint=(0.0, 0.0, 0.0), highlight_tint=(0.0, 0.0, 0.0)):
    """Writes a 3D LUT (.cube, red index fastest) from three maths steps per grid point: contrast about mid grey,
    saturation about the pixel's luma, then a tint added in the shadows and one in the highlights (weight luma-squared).
    Identity at the defaults. Returns the path."""
    if not 2 <= size <= 65:
        raise ValueError("cube size must be 2..65")
    rows = []
    for b in range(size):
        for g in range(size):
            for r in range(size):
                rgb = [c / (size - 1) for c in (r, g, b)]
                rgb = [(c - 0.5) * contrast + 0.5 for c in rgb]
                luma = sum(w * c for w, c in zip(LUMA, rgb))
                rgb = [luma + (c - luma) * saturation for c in rgb]
                luma = min(1.0, max(0.0, sum(w * c for w, c in zip(LUMA, rgb))))
                lo, hi = (1 - luma) ** 2, luma ** 2
                rgb = [min(1.0, max(0.0, c + lo * s + hi * h)) for c, s, h in zip(rgb, shadow_tint, highlight_tint)]
                rows.append("{:.6f} {:.6f} {:.6f}".format(*rgb))
    Path(path).write_text("TITLE \"forge parametric grade\"\nLUT_3D_SIZE {}\n{}\n".format(size, "\n".join(rows)), encoding="utf-8")
    return str(path)


def validate_lut(path):
    """The resolved path of an existing .cube file; anything else raises ValueError."""
    if not isinstance(path, (str, Path)) or not str(path).strip():
        raise ValueError("look_v2 lut must be a path")
    p = Path(path)
    if p.suffix.lower() != ".cube":
        raise ValueError(f"look_v2 lut must be a .cube file: {path}")
    if not p.is_file():
        raise ValueError(f"look_v2 lut does not exist: {path}")
    if "'" in str(p):  # the path goes inside single quotes in the filtergraph
        raise ValueError(f"look_v2 lut path may not contain an apostrophe: {path}")
    return p.resolve()


def parse(look_v2):
    """Validated policy dict, or None when look_v2 is off (None, False, empty)."""
    if not look_v2:
        return None
    raw = {} if look_v2 is True else look_v2
    if not isinstance(raw, dict):
        raise ValueError("look_v2 must be true or an object")
    if raw.get("lut") and raw.get("grade"):
        raise ValueError("look_v2 takes a lut or a grade, not both")
    grain = raw.get("grain", GRAIN_DEFAULT)
    if isinstance(grain, bool) or not isinstance(grain, int) or not 0 <= grain <= GRAIN_MAX:
        raise ValueError(f"look_v2 grain must be an integer 0..{GRAIN_MAX} (percent, under 4)")
    grade = raw.get("grade")
    if grade is not None and (not isinstance(grade, dict) or set(grade) - {"size", "contrast", "saturation", "shadow_tint", "highlight_tint"}):
        raise ValueError("look_v2 grade must be an object of build_cube parameters")
    return {"lut": validate_lut(raw["lut"]) if raw.get("lut") else None, "grade": grade or None,
            "vignette": bool(raw.get("vignette", True)), "grain": grain}


def filters(policy, work):
    """The ffmpeg video filters for a parse()d policy, in order. A grade is written to work/grade.cube and read from the cwd."""
    chain = []
    if policy["lut"]:
        chain.append("lut3d=file='{}'".format(policy["lut"].as_posix().replace(":", "\\:")))
    elif policy["grade"]:
        build_cube(Path(work) / GENERATED_CUBE, **policy["grade"])
        chain.append(f"lut3d=file={GENERATED_CUBE}")
    if policy["vignette"]:
        chain.append(f"vignette=angle={VIGNETTE_ANGLE}")
    if policy["grain"]:
        chain.append(f"noise=alls={policy['grain']}:allf=t+u")
    return chain
