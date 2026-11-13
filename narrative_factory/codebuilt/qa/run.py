"""Command line for the QA gate (CB12 / KAN-921).

    python -m narrative_factory.codebuilt.qa.run --video V.mp4 [--srt V.srt] [--subject shots.json]
        [--voice voice.wav --music music.wav --effects sfx.wav] [--repair-round 0] [--tier sonnet] [--out report.json]

Exit code 0 = passed, 1 = failed. The report is printed (and written to --out) as JSON.
"""
import argparse
import json
from pathlib import Path

from .gate import gate


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--video", required=True)
    ap.add_argument("--srt")
    ap.add_argument("--subject", help="json written by the build: {shots: [{shot, subject_width_fraction, centre?}]}")
    ap.add_argument("--voice")
    ap.add_argument("--music")
    ap.add_argument("--effects")
    ap.add_argument("--repair-round", type=int, default=0)
    ap.add_argument("--tier", default="sonnet")
    ap.add_argument("--require-stems", action="store_true")
    ap.add_argument("--out")
    a = ap.parse_args(argv)
    stems = {k: v for k, v in (("voice", a.voice), ("music", a.music), ("effects", a.effects)) if v} or None
    result = gate(a.video, srt=a.srt, stems=stems, subject_report=a.subject, repair_round=a.repair_round, build_tier=a.tier,
                  require_stems=a.require_stems)
    text = json.dumps(result, indent=2)
    if a.out:
        Path(a.out).write_text(text, encoding="utf-8")
    print(text)
    return 0 if result["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
