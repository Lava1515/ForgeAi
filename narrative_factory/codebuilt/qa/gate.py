"""The QA gate for a finished code-built video (CB12 / KAN-921).

    result = gate(video, srt=..., stems=..., subject_report=..., repair_round=0, build_tier="sonnet")
    result["passed"]    -> bool
    result["reasons"]   -> named failure codes, in check order, no repeats (empty when passed)
    result["findings"]  -> [{"code", "check", "detail"}] with the numbers behind each reason
    result["checked"] / result["skipped"] -> which checks ran; a check with no input is skipped, never counted as a pass
    result["repair"]    -> what the caller does next (see `repair_plan`); None when passed

This module calls no model and starts nothing but ffmpeg. The repair contract only names the next step; the job runner (CB5) acts on it.
"""
from narrative_factory.codebuilt.post import media
from . import checks, detectors, frames as framing_frames

VERSION = "codebuilt-qa-v1"

# check -> detector used on the sampled frames, and the reason code it raises
FRAME_CHECKS = (
    ("blank_frames", detectors.detect_blank, "frames_blank"),
    ("empty_frames", detectors.detect_empty, "frames_empty"),
    ("near_black", detectors.detect_near_black, "frames_near_black"),
    ("edge_text", detectors.detect_edge_text, "text_touches_edge"),
)

# CB9 (dashboard/server/routes/stepTiers.js, step "build"): tier whose repair round failed -> (trigger name, tier to escalate to)
ESCALATION = {"sonnet": ("qa_failed_after_repair", "opus"), "opus": ("opus_failed", "fable")}


def repair_plan(findings, repair_round, build_tier="sonnet"):
    """One repair round by the same model, then escalate per CB9. `repair_round` = repair rounds already spent on this build tier.

    Returns {"next": "repair_same_model" | "escalate" | "stop_for_human", "tier", "next_tier", "trigger", "failures"}; `failures` is the
    list the repair prompt must show the model, nothing else is added. Calls no model."""
    if build_tier not in ("sonnet", "opus", "fable"):
        raise ValueError(f"unknown build tier {build_tier!r}")
    if not isinstance(repair_round, int) or isinstance(repair_round, bool) or repair_round < 0:
        raise ValueError("repair_round must be a count of rounds already spent, 0 or more")
    failures = [{"code": f["code"], "check": f["check"], "detail": f["detail"]} for f in findings]
    if repair_round == 0:
        return {"next": "repair_same_model", "tier": build_tier, "next_tier": build_tier, "trigger": None, "failures": failures}
    if build_tier not in ESCALATION:
        return {"next": "stop_for_human", "tier": build_tier, "next_tier": None, "trigger": None, "failures": failures}
    trigger, nxt = ESCALATION[build_tier]
    return {"next": "escalate", "tier": build_tier, "next_tier": nxt, "trigger": trigger, "failures": failures}


def _add(findings, check, items):
    findings.extend({"code": i["code"], "check": check, "detail": i["detail"]} for i in items)


def gate(video, *, srt=None, stems=None, subject_report=None, expected=None, repair_round=0, build_tier="sonnet",
         sample_fps=framing_frames.DEFAULT_SAMPLE_FPS, require_stems=False, ffmpeg=None):
    """Run every check that has its input and return the verdict. `expected` overrides width, height, fps and duration."""
    findings, checked, skipped, details = [], [], [], {}
    try:
        info = media.probe(media.input_file(video), ffmpeg=ffmpeg)
    except (media.MediaError, OSError) as err:
        _add(findings, "probe", [checks.finding("probe_unreadable", str(err)[-300:])])
        return _verdict(findings, ["probe"], ["frames", "subtitles", "subject", "loudness"], {}, repair_round, build_tier)
    checked.append("probe")
    details["probe"] = info
    _add(findings, "probe", checks.probe_findings(info, expected))
    if info["has_audio"]:
        _add(findings, "audio", checks.audio_silent_findings(video, ffmpeg=ffmpeg))
        checked.append("audio")

    if info["has_video"]:
        try:
            sampled, times = framing_frames.sample_frames(video, sample_fps=sample_fps, ffmpeg=ffmpeg)
        except (media.MediaError, OSError, ValueError) as err:
            _add(findings, "frames", [checks.finding("frames_unreadable", str(err)[-300:])])
            skipped.append("frames")
        else:
            checked.append("frames")
            step = 1.0 / sample_fps
            for name, detector, code in FRAME_CHECKS:
                result = detector(sampled, step)
                details[name] = result
                if result["fail"]:
                    _add(findings, name, [checks.finding(code, _frame_detail(name, result))])
    else:
        skipped.append("frames")

    if srt is None:
        skipped.append("subtitles")
    else:
        checked.append("subtitles")
        _add(findings, "subtitles", checks.subtitle_findings(srt, info["duration"]))

    if subject_report is None:
        skipped.append("subject")
    else:
        checked.append("subject")
        _add(findings, "subject", checks.subject_findings(checks.load_subject_report(subject_report)))

    if not stems or not ({"music", "effects"} & set(stems)):
        skipped.append("loudness")
        if require_stems:
            _add(findings, "loudness", [checks.finding("stems_missing", "no stems were given, so music and effects levels cannot be measured")])
    else:
        checked.append("loudness")
        _add(findings, "loudness", checks.loudness_findings(stems))
        try:
            details["loudness"] = checks.loudness_levels(stems)
        except ValueError:
            pass
    return _verdict(findings, checked, skipped, details, repair_round, build_tier)


def _frame_detail(name, result):
    spans = ", ".join(f"{a:g}-{b:g} s" for a, b in result["runs"][:6])
    if name == "near_black":
        return f"{result['video_share']:.0%} of the video is mostly black ({spans})"
    if name == "edge_text":
        return f"text reaches the {'/'.join(result['sides'])} edge at {spans}"
    return f"{name.replace('_', ' ')} at {spans} (strongest {result['worst']})"


def _verdict(findings, checked, skipped, details, repair_round, build_tier):
    reasons = list(dict.fromkeys(f["code"] for f in findings))
    passed = not reasons
    return {"version": VERSION, "passed": passed, "reasons": reasons, "findings": findings, "checked": checked, "skipped": skipped,
            "details": details, "repair": None if passed else repair_plan(findings, repair_round, build_tier)}
