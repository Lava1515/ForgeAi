#!/usr/bin/env python3
"""
Voice Steadiness Checker (KAN-180)
Pure function + dependency-free CLI tool to verify voice steadiness across rendered clips.
Given per-sentence loudness dBFS and words/second (or computed from wav + tts.json),
flags sentences quieter than (mean - tolerance_db) or slower than (ratio * median_pace).
"""

from __future__ import annotations

import argparse
import json
import math
import statistics
import struct
import sys
import wave
from pathlib import Path
from typing import Any, Dict, List, Sequence, Tuple


def calculate_rms_dbfs(samples: Sequence[int], max_val: float = 32768.0) -> float:
    """Computes RMS loudness in dBFS relative to full scale for 16-bit PCM samples."""
    if not samples:
        return -100.0
    sum_sq = sum(float(s) * float(s) for s in samples)
    mean_sq = sum_sq / len(samples)
    if mean_sq <= 0:
        return -100.0
    rms = math.sqrt(mean_sq)
    return 20.0 * math.log10(rms / max_val)


def check_voice_steadiness(
    sentences: List[Dict[str, Any]],
    loudness_tolerance_db: float = 3.0,
    pace_tolerance_ratio: float = 0.7,
) -> Dict[str, Any]:
    """
    Pure function: evaluates per-sentence loudness and pace against group statistics.
    Flags sentences:
      - quieter than (mean_loudness - loudness_tolerance_db)
      - slower than (pace_tolerance_ratio * median_pace)
    Skips sentences with no samples or shorter than ~0.3s from loudness statistics (no -100 dBFS skew).
    Skips the pace check below 4 words.
    """
    if not sentences:
        return {
            "mean_loudness_db": 0.0,
            "loudness_threshold_db": 0.0,
            "median_pace_wps": 0.0,
            "pace_threshold_wps": 0.0,
            "total_sentences": 0,
            "flagged_sentences": [],
            "is_steady": True,
        }

    def _get_word_count(s: Dict[str, Any]) -> int:
        if "word_count" in s and s["word_count"] is not None:
            return int(s["word_count"])
        text = str(s.get("text", "")).strip()
        return len(text.split()) if text else 0

    def _is_loudness_valid(s: Dict[str, Any]) -> bool:
        if "loudness_db" not in s or s["loudness_db"] is None:
            return False
        if s.get("has_samples") is False:
            return False
        if float(s.get("duration", 1.0)) < 0.3:
            return False
        if float(s["loudness_db"]) <= -99.0:
            return False
        return True

    valid_loudness = [float(s["loudness_db"]) for s in sentences if _is_loudness_valid(s)]
    mean_loudness = statistics.mean(valid_loudness) if valid_loudness else -20.0
    loudness_threshold = mean_loudness - loudness_tolerance_db

    valid_paces = [
        float(s["words_per_second"])
        for s in sentences
        if "words_per_second" in s and s["words_per_second"] is not None and _get_word_count(s) >= 4
    ]
    median_pace = statistics.median(valid_paces) if valid_paces else 2.0
    pace_threshold = median_pace * pace_tolerance_ratio

    flagged: List[Dict[str, Any]] = []
    for s in sentences:
        flags = []
        s_loudness = float(s.get("loudness_db", mean_loudness))
        s_pace = float(s.get("words_per_second", median_pace))

        if _is_loudness_valid(s) and s_loudness < loudness_threshold:
            flags.append("quieter")

        word_count = _get_word_count(s)
        if word_count >= 4 and s_pace < pace_threshold:
            flags.append("slower")

        if flags:
            flagged.append({
                "index": s.get("index", 0),
                "text": s.get("text", ""),
                "loudness_db": round(s_loudness, 2),
                "words_per_second": round(s_pace, 2),
                "flags": flags,
                "delta_db_from_mean": round(s_loudness - mean_loudness, 2),
                "pace_ratio_to_median": round(s_pace / max(0.001, median_pace), 2),
            })

    return {
        "mean_loudness_db": round(mean_loudness, 2),
        "loudness_threshold_db": round(loudness_threshold, 2),
        "median_pace_wps": round(median_pace, 2),
        "pace_threshold_wps": round(pace_threshold, 2),
        "total_sentences": len(sentences),
        "flagged_sentences": flagged,
        "is_steady": len(flagged) == 0,
    }


def analyze_rendered_clip(
    wav_path: str | Path,
    tts_json_path: str | Path,
    loudness_tolerance_db: float = 3.0,
    pace_tolerance_ratio: float = 0.7,
) -> Dict[str, Any]:
    """
    Reads a rendered voiceover.wav and tts.json, measures sentence-level loudness and pace,
    and runs check_voice_steadiness.
    """
    wav_file = Path(wav_path)
    tts_file = Path(tts_json_path)

    if not wav_file.exists():
        raise FileNotFoundError(f"WAV file not found: {wav_file}")
    if not tts_file.exists():
        raise FileNotFoundError(f"TTS JSON file not found: {tts_file}")

    with open(tts_file, "r", encoding="utf-8") as f:
        tts_data = json.load(f)

    words_data = tts_data.get("words", []) if isinstance(tts_data.get("words"), list) else []

    # Support either "sentences" or "scenes" in tts.json
    sentence_spans: List[Dict[str, Any]] = []
    if "sentences" in tts_data and isinstance(tts_data["sentences"], list):
        for idx, item in enumerate(tts_data["sentences"]):
            sentence_spans.append({
                "index": idx,
                "text": str(item.get("text", "")).strip(),
                "start": float(item.get("start", 0.0)),
                "end": float(item.get("end", 0.0)),
            })
    elif "scenes" in tts_data and isinstance(tts_data["scenes"], list):
        for idx, item in enumerate(tts_data["scenes"]):
            sentence_spans.append({
                "index": idx,
                "text": str(item.get("text", "")).strip(),
                "start": float(item.get("start", 0.0)),
                "end": float(item.get("end", 0.0)),
            })

    with wave.open(str(wav_file), "rb") as wf:
        nchannels = wf.getnchannels()
        sampwidth = wf.getsampwidth()
        framerate = wf.getframerate()
        nframes = wf.getnframes()
        raw_frames = wf.readframes(nframes)

    # Unpack samples according to sample width (standard 16-bit PCM expected)
    if sampwidth == 2:
        total_samples = len(raw_frames) // 2
        all_samples = struct.unpack(f"<{total_samples}h", raw_frames)
        # If stereo, select channel 0
        if nchannels > 1:
            all_samples = all_samples[::nchannels]
    else:
        raise ValueError(f"Unsupported sample width: {sampwidth} (expected 16-bit PCM)")

    measured_sentences: List[Dict[str, Any]] = []
    for s in sentence_spans:
        start_frame = max(0, int(s["start"] * framerate))
        end_frame = min(len(all_samples), int(s["end"] * framerate))
        chunk_samples = all_samples[start_frame:end_frame]
        duration = max(0.001, s["end"] - s["start"])

        text = s["text"]
        if not text and words_data:
            matching_words = [
                w for w in words_data
                if s["start"] <= float(w.get("start", 0.0)) < s["end"]
            ]
            word_count = len(matching_words)
            text = " ".join(str(w.get("text", "")).strip() for w in matching_words if str(w.get("text", "")).strip())
        else:
            word_count = len(text.split()) if text else 0

        pace_wps = word_count / duration if word_count > 0 else 0.0
        has_samples = len(chunk_samples) > 0
        loudness_db = calculate_rms_dbfs(chunk_samples) if has_samples else -100.0

        measured_sentences.append({
            "index": s["index"],
            "text": text,
            "start": s["start"],
            "end": s["end"],
            "loudness_db": loudness_db,
            "words_per_second": pace_wps,
            "word_count": word_count,
            "duration": round(duration, 2),
            "has_samples": has_samples,
        })

    steadiness_result = check_voice_steadiness(
        measured_sentences,
        loudness_tolerance_db=loudness_tolerance_db,
        pace_tolerance_ratio=pace_tolerance_ratio,
    )
    steadiness_result["sentences"] = measured_sentences
    steadiness_result["wav_file"] = str(wav_file)
    steadiness_result["tts_json_file"] = str(tts_file)
    return steadiness_result


def main() -> int:
    parser = argparse.ArgumentParser(description="Check voice steadiness on a rendered clip (wav + tts.json).")
    parser.add_argument("wav", help="Path to voiceover.wav")
    parser.add_argument("tts_json", help="Path to tts.json")
    parser.add_argument("--loudness-tolerance", type=float, default=3.0, help="Max dB quieter than mean before flagging (default 3.0)")
    parser.add_argument("--pace-tolerance", type=float, default=0.7, help="Min ratio of median pace before flagging (default 0.7)")
    parser.add_argument("--json", action="store_true", help="Output full JSON result")

    args = parser.parse_args()

    try:
        result = analyze_rendered_clip(
            args.wav,
            args.tts_json,
            loudness_tolerance_db=args.loudness_tolerance,
            pace_tolerance_ratio=args.pace_tolerance,
        )
    except Exception as e:
        print(f"Error analyzing clip: {e}", file=sys.stderr)
        return 1

    if args.json:
        print(json.dumps(result, indent=2))
        return 0 if result["is_steady"] else 2

    # Human-readable summary
    print("=" * 60)
    print(" VOICE STEADINESS REPORT")
    print("=" * 60)
    print(f"File:         {result['wav_file']}")
    print(f"Total Spans:  {result['total_sentences']}")
    print(f"Mean Loudness:{result['mean_loudness_db']:>7.2f} dBFS (threshold: < {result['loudness_threshold_db']:.2f})")
    print(f"Median Pace:  {result['median_pace_wps']:>7.2f} wps  (threshold: < {result['pace_threshold_wps']:.2f})")
    print("-" * 60)

    if result["is_steady"]:
        print("RESULT: PASS - All spans within loudness and pace tolerances.")
        return 0

    print(f"RESULT: FAIL - {len(result['flagged_sentences'])} span(s) flagged:")
    for f in result["flagged_sentences"]:
        flags_str = ", ".join(f["flags"]).upper()
        print(f"  Span #{f['index']} [{flags_str}]:")
        if f["text"]:
            print(f"    Text: \"{f['text']}\"")
        if "quieter" in f["flags"]:
            print(f"    Loudness: {f['loudness_db']:.2f} dBFS ({f['delta_db_from_mean']:+.2f} dB from mean)")
        if "slower" in f["flags"]:
            print(f"    Pace:     {f['words_per_second']:.2f} wps ({f['pace_ratio_to_median']:.2f}x of median)")
    return 2


if __name__ == "__main__":
    sys.exit(main())
