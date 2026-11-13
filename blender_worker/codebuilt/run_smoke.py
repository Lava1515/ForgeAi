"""Launcher for the 3-shot smoke render (KAN-910). Runs Blender, then builds the contact sheet.

  python -m blender_worker.codebuilt.run_smoke --job-dir <abs job folder> [--blender <abs blender.exe>]

Writes frames to <job-dir>/frames, the sheet to <job-dir>/smoke_sheet.jpg and the report to
<job-dir>/smoke_report.json. Run it under the GPU queue (gpu.lock); it does not take the lock itself.
"""
import argparse
import json
import os
import subprocess
import sys

from .paths import require_abs, require_job_dir
from .sheet import contact_sheet

DEFAULT_BLENDER = "C:/Program Files/Blender Foundation/Blender 5.2/blender.exe"
SCENE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "smoke_scene.py")


def build_command(blender, job_dir, scale=25, samples=8, qa=False):
    """argv for one Blender run of the smoke scene. All paths absolute."""
    blender, job_dir = require_abs(blender), require_job_dir(job_dir)
    cmd = [blender, "-b", "--factory-startup", "-P", SCENE, "--",
           "--out", os.path.join(job_dir, "frames"), "--scale", str(scale), "--samples", str(samples),
           "--blend-out", os.path.join(job_dir, "smoke.blend")]
    if qa:
        cmd.append("--qa")
    return cmd


def job_env(job_dir):
    """Environment with TEMP and TMP inside the job folder."""
    tmp = os.path.join(require_job_dir(job_dir), "tmp")
    os.makedirs(tmp, exist_ok=True)
    env = dict(os.environ)
    env["TEMP"] = env["TMP"] = tmp
    return env


def run(job_dir, blender=DEFAULT_BLENDER, timeout=1800):
    job_dir = require_job_dir(job_dir)
    os.makedirs(job_dir, exist_ok=True)
    env = job_env(job_dir)
    report = {"blender": blender, "job_dir": job_dir}
    for label, qa in (("qa", True), ("render", False)):
        p = subprocess.run(build_command(blender, job_dir, qa=qa), env=env, capture_output=True, text=True, timeout=timeout)
        report[label] = {"returncode": p.returncode, "tail": (p.stdout or "")[-1500:] + (p.stderr or "")[-800:]}
        if p.returncode != 0:
            break
    else:
        frames = os.path.join(job_dir, "frames")
        sheet = os.path.join(job_dir, "smoke_sheet.jpg")
        report["frames"] = len([f for f in os.listdir(frames) if f.endswith(".png")])
        report["sheet_frames"] = contact_sheet(frames, sheet, cols=6, limit=18)
        report["sheet"] = sheet
    with open(os.path.join(job_dir, "smoke_report.json"), "w", encoding="utf-8") as fh:
        json.dump(report, fh, indent=2)
    print(json.dumps({k: v for k, v in report.items() if k not in ("qa", "render")}, indent=2))
    return 0 if "sheet" in report else 1


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--job-dir", required=True)
    ap.add_argument("--blender", default=DEFAULT_BLENDER)
    a = ap.parse_args()
    sys.exit(run(a.job_dir, a.blender))
