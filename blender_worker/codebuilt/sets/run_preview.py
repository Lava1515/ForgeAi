"""Launcher for the set preview sheets (KAN-911). Runs Blender once per set, then builds the sheet.

  python -m blender_worker.codebuilt.sets.run_preview --job-dir <abs job folder> [--blender <abs blender.exe>]
         [--sets city_street globe ...] [--dry-run]

Writes frames to <job-dir>/frames (<set>_<angle>.png), the contact sheet to <job-dir>/sets_sheet.jpg
(one row per set, three angles per row), and <job-dir>/sets_report.json with the exposure check of every
frame. Run it under the GPU queue (gpu.lock); it does not take the lock itself. --dry-run prints the
commands and touches nothing.

Exposure gate (provisional, see README.md): mean luma of a frame 0.06..0.70 and at most 10 percent of its
pixels at or above luma 0.98. A frame outside the gate is reported 'dark', 'bright' or 'clipped'.
"""
import argparse
import json
import os
import subprocess
import sys

from ..paths import require_abs, require_job_dir
from ..run_smoke import DEFAULT_BLENDER, job_env
from ..sheet import contact_sheet
from . import registry

SCENE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "preview_scene.py")
LUMA_MIN, LUMA_MAX, CLIP_MAX = 0.06, 0.70, 0.10


def build_command(blender, job_dir, set_name, scale=25, samples=None, origin=(0.0, 0.0, 0.0)):
    """argv for one Blender run of one set's preview. All paths absolute, inside the job folder."""
    blender, job_dir = require_abs(blender), require_job_dir(job_dir)
    registry.get(set_name)
    cmd = [blender, "-b", "--factory-startup", "-P", SCENE, "--", "--set", set_name,
           "--out", os.path.join(job_dir, "frames"), "--scale", str(scale),
           "--origin", *[repr(float(v)) for v in origin],
           "--blend-out", os.path.join(job_dir, "blend", set_name + ".blend")]
    if samples:
        cmd += ["--samples", str(samples)]
    return cmd


def exposure_verdict(mean, clipped):
    """'ok', 'dark', 'bright' or 'clipped' from a frame's mean luma (0..1) and clipped fraction."""
    if mean < LUMA_MIN:
        return "dark"
    if mean > LUMA_MAX:
        return "bright"
    if clipped > CLIP_MAX:
        return "clipped"
    return "ok"


def frame_stats(path):
    """(mean luma, fraction of pixels at luma >= 0.98) of a PNG. Needs Pillow."""
    from PIL import Image
    im = Image.open(require_abs(path)).convert("L")
    hist = im.histogram()
    n = float(sum(hist))
    mean = sum(i * h for i, h in enumerate(hist)) / n / 255.0
    clipped = sum(hist[250:]) / n
    return round(mean, 4), round(clipped, 4)


def check_frames(frames_dir, names=None):
    """Exposure rows [{frame, mean, clipped, verdict}] for each angle of the named sets (default all)."""
    rows = []
    for s in registry.SPECS:
        if names and s.name not in names:
            continue
        for ang in s.angles:
            fp = os.path.join(frames_dir, f"{s.name}_{ang.name}.png")
            if not os.path.exists(fp):
                rows.append(dict(frame=os.path.basename(fp), mean=None, clipped=None, verdict="missing"))
                continue
            mean, clipped = frame_stats(fp)
            rows.append(dict(frame=os.path.basename(fp), mean=mean, clipped=clipped, verdict=exposure_verdict(mean, clipped)))
    return rows


def run(job_dir, blender=DEFAULT_BLENDER, sets=None, timeout=1800, dry_run=False):
    job_dir = require_job_dir(job_dir)
    names = list(sets) if sets else registry.names()
    cmds = [build_command(blender, job_dir, n) for n in names]
    if dry_run:
        print(json.dumps(cmds, indent=2))
        return 0
    os.makedirs(os.path.join(job_dir, "blend"), exist_ok=True)
    env = job_env(job_dir)
    report = {"blender": blender, "job_dir": job_dir, "runs": {}}
    failed = False
    for n, cmd in zip(names, cmds):
        p = subprocess.run(cmd, env=env, capture_output=True, text=True, timeout=timeout)
        report["runs"][n] = {"returncode": p.returncode, "tail": (p.stdout or "")[-1200:] + (p.stderr or "")[-600:]}
        failed = failed or p.returncode != 0
    frames = os.path.join(job_dir, "frames")
    if os.path.isdir(frames) and any(f.endswith(".png") for f in os.listdir(frames)):
        sheet = os.path.join(job_dir, "sets_sheet.jpg")
        report["sheet_frames"] = contact_sheet(frames, sheet, cols=3, cell_w=320)
        report["sheet"] = sheet
        report["exposure"] = check_frames(frames, names)
        failed = failed or any(r["verdict"] != "ok" for r in report["exposure"])
    with open(os.path.join(job_dir, "sets_report.json"), "w", encoding="utf-8") as fh:
        json.dump(report, fh, indent=2)
    print(json.dumps({k: v for k, v in report.items() if k != "runs"}, indent=2))
    return 1 if failed else 0


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--job-dir", required=True)
    ap.add_argument("--blender", default=DEFAULT_BLENDER)
    ap.add_argument("--sets", nargs="+")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    sys.exit(run(a.job_dir, a.blender, a.sets, dry_run=a.dry_run))
