"""Subtitle file writer and checker for the post kit (CB4 / KAN-913).

Original code written for this repository from a plain behaviour description of the SubRip (.srt) format. `check_srt` reports errors
(the file is broken: bad structure or times, a cue past the end of the video, a cue with no length) and warnings (a human should look:
overlap, a very short hold, text too fast to read).
"""
import math
import re

_STAMP = r"(\d{2,}):([0-5]\d):([0-5]\d),(\d{3})"
TIMING = re.compile(rf"^\s*{_STAMP}\s*-->\s*{_STAMP}\s*$")
_TAGS_AND_SPACE = re.compile(r"<[^>]*>|\s+")


def srt_time(x):
    ms = int(round(max(0.0, x) * 1000))      # round once, in whole milliseconds, so 1.9996 s is 2,000 and never 1,000 ms
    h, rest = divmod(ms, 3600000)
    m, rest = divmod(rest, 60000)
    s, ms = divmod(rest, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def to_srt(cues):
    return "".join(f"{i}\n{srt_time(c['start'])} --> {srt_time(c['end'])}\n{c['text']}\n\n" for i, c in enumerate(cues, 1))


def _seconds(groups):
    h, m, s, ms = map(int, groups)
    return 3600 * h + 60 * m + s + ms / 1000


def parse_srt(text):
    """Split an .srt text into raw cues: a list of (number, index_line, timing_line, text_lines). A cue is a run of non-blank lines."""
    flat = text.lstrip("﻿").replace("\r\n", "\n").replace("\r", "\n")
    raw, run = [], []
    for line in flat.split("\n") + [""]:
        if line.strip():
            run.append(line.strip())
        elif run:
            raw.append(run)
            run = []
    return [(n, r[0], r[1] if len(r) > 1 else "", r[2:]) for n, r in enumerate(raw, 1)]


def check_srt(text, duration=None, max_cps=20.0, min_duration=0.65):
    """Returns {"errors": [...], "warnings": [...], "cues": n}; each item is {"block": cue number, "code": str}."""
    if duration is not None and (not math.isfinite(duration) or duration < 0):
        raise ValueError("Duration must be finite and nonnegative")
    parsed = parse_srt(text)
    if not parsed:
        return {"errors": [{"block": 0, "code": "empty_file"}], "warnings": [], "cues": 0}
    errors, warnings = [], []
    ok = 0
    last_start, latest_end = None, None
    for number, index_line, timing_line, body in parsed:
        match = None
        problem = None
        if not index_line.isdigit() or not body:
            problem = "invalid_structure"
        else:
            if int(index_line) != number:
                errors.append({"block": number, "code": "nonsequential_index"})
            match = TIMING.match(timing_line)
            if match is None:
                problem = "invalid_timestamp"
        if problem:
            errors.append({"block": number, "code": problem})
            continue
        begin, finish = _seconds(match.groups()[:4]), _seconds(match.groups()[4:])
        length = finish - begin
        shown = _TAGS_AND_SPACE.sub("", " ".join(body))
        if not shown:
            errors.append({"block": number, "code": "empty_caption"})
        if length <= 0:
            errors.append({"block": number, "code": "nonpositive_duration"})
        if last_start is not None and begin < last_start:
            errors.append({"block": number, "code": "nonmonotonic_start"})
        if latest_end is not None and begin < latest_end:
            warnings.append({"block": number, "code": "overlap"})
        if duration is not None and finish > duration + 0.001:
            errors.append({"block": number, "code": "exceeds_media"})
        if length > 0:
            if length < min_duration:
                warnings.append({"block": number, "code": "short_hold"})
            speed = len(shown) / length
            if speed > max_cps:
                warnings.append({"block": number, "code": "reading_speed", "characters_per_second": round(speed, 2)})
        last_start = begin
        latest_end = finish if latest_end is None else max(latest_end, finish)
        ok += 1
    return {"errors": errors, "warnings": warnings, "cues": ok}


def check(text, duration=None, max_cps=20.0, min_duration=0.65):
    """Same check as `check_srt`, returned as the tuple (errors, warnings, cue count)."""
    res = check_srt(text, duration, max_cps, min_duration)
    return res["errors"], res["warnings"], res["cues"]
