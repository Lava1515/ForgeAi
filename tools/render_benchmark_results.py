#!/usr/bin/env python3
"""Validate measured benchmark frames and collect timings; PNG check is header-only."""

import argparse
import hashlib
import json
import math
import statistics
import stat
import struct
import sys
from pathlib import Path


PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
WIDTH, HEIGHT = 1080, 1920
REPORT_NAME = "result-validation.json"


class InputError(ValueError):
    pass


def inside(path, parent):
    try:
        path.relative_to(parent)
        return True
    except ValueError:
        return False


def reject_link(path, info):
    if stat.S_ISLNK(info.st_mode) or getattr(info, "st_reparse_tag", 0) or getattr(info, "st_file_attributes", 0) & 0x400:
        raise InputError(f"symlink or reparse point path is not allowed: {path}")


def checked_file(path, job):
    """Require every existing path component to be non-symlink and final file single-link."""
    if not inside(path, job):
        raise InputError(f"path escapes job folder: {path}")
    try:
        relative = path.relative_to(job)
    except ValueError as exc:
        raise InputError(f"path escapes job folder: {path}") from exc
    if ".." in relative.parts:
        raise InputError(f"path escapes job folder: {path}")
    current = job
    for part in relative.parts:
        current = current / part
        try:
            info = current.lstat()
        except OSError as exc:
            raise InputError(f"missing or inaccessible path: {current}") from exc
        reject_link(current, info)
    if not relative.parts or not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        raise InputError(f"expected a regular single-link file: {current}")
    if current.resolve(strict=True) != current:
        raise InputError(f"file path passes through an alias: {current}")
    return current


def png_dimensions(path):
    with path.open("rb") as stream:
        header = stream.read(24)
    if len(header) < 24 or header[:8] != PNG_SIGNATURE or header[12:16] != b"IHDR":
        raise InputError(f"not a nonempty PNG with an IHDR header: {path.name}")
    return struct.unpack(">II", header[16:24])


def run(job_arg, manifest_arg, wall_times):
    jobs_root = Path(__file__).resolve().parent.parent / "output" / "agent-jobs"
    job = Path(job_arg).absolute()
    if ".." in job.parts or job.parent != jobs_root:
        raise InputError("job folder must be a direct child of output/agent-jobs")
    for directory in [jobs_root.parent, jobs_root, job]:
        info = directory.lstat()
        reject_link(directory, info)
        if not stat.S_ISDIR(info.st_mode) or directory.resolve(strict=True) != directory:
            raise InputError("job folder must be an existing canonical directory without aliases")
    manifest_path = Path(manifest_arg)
    if not manifest_path.is_absolute():
        manifest_path = job / manifest_path
    manifest_path = checked_file(manifest_path, job)
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        expected = manifest["expected_frames"]
        files = manifest["frames"]
    except (OSError, json.JSONDecodeError, KeyError, TypeError) as exc:
        raise InputError("manifest requires expected_frames and frames") from exc
    if not isinstance(expected, list) or not expected or any(type(frame) is not int or frame < 0 for frame in expected) or len(set(expected)) != len(expected):
        raise InputError("expected_frames must be unique non-negative integer frame numbers")
    expected_keys = {str(frame) for frame in expected}
    if not isinstance(files, dict) or set(files) != expected_keys:
        raise InputError("manifest frame keys must exactly match expected_frames")

    frames, hashes, seen_paths = [], {}, set()
    valid = True
    for frame in expected:
        value = files[str(frame)]
        if not isinstance(value, str) or not value:
            raise InputError("frame paths must be nonempty strings")
        relative = Path(value)
        if relative.anchor or relative.drive:
            raise InputError(f"frame path must be relative to the job folder: {frame}")
        path = checked_file(job / relative, job)
        if path in seen_paths:
            raise InputError("manifest frames must reference unique file paths")
        seen_paths.add(path)
        dimensions = png_dimensions(path)
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        if dimensions != (WIDTH, HEIGHT):
            valid = False
        hashes.setdefault(digest, []).append(frame)
        frames.append({"frame": frame, "path": relative.as_posix(), "width": dimensions[0],
                       "height": dimensions[1], "sha256": digest,
                       "valid_dimensions": dimensions == (WIDTH, HEIGHT)})

    duplicates = [group for group in hashes.values() if len(group) > 1]
    if any(not math.isfinite(seconds) or seconds <= 0 for seconds in wall_times):
        raise InputError("wall times must be finite positive seconds")
    timing = None
    if valid and wall_times:
        median = statistics.median(wall_times)
        timing = {"repeat_wall_seconds": wall_times, "median_seconds": median,
                  "spread_seconds": max(wall_times) - min(wall_times),
                  "frames_per_second": len(expected) / median}

    report = {
        "validation": {"valid": valid, "expected_frame_count": len(expected),
                       "produced_frame_count": len(frames),
                       "png_check": "signature and IHDR dimensions only; full image decode not performed",
                       "duplicate_content_frames": duplicates},
        "frames": frames,
        "timing": timing,
        "device_proof": "unavailable; not collected or verified by this tool",
        "quality_proof": "unavailable; image review not performed by this tool",
        "recommendation": None,
        "recommendation_status": "excluded; device and visual-quality proof unavailable"
    }
    report_path = job / REPORT_NAME
    if report_path.exists() or report_path.is_symlink():
        checked_file(report_path, job)
    with report_path.open("x", encoding="utf-8") as stream:
        stream.write(json.dumps(report, indent=2) + "\n")
    return valid


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--job-dir", required=True, help="existing output/agent-jobs/<job> folder")
    parser.add_argument("--manifest", required=True, help="manifest path, preferably relative to job folder")
    parser.add_argument("--wall-times", required=True, help="comma-separated measured repeat seconds")
    args = parser.parse_args()
    try:
        times = [float(value) for value in args.wall_times.split(",") if value.strip()]
        valid = run(args.job_dir, args.manifest, times)
    except (InputError, OSError, ValueError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    return 0 if valid else 1


if __name__ == "__main__":
    raise SystemExit(main())
