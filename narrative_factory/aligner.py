"""Lazy CPU forced alignment for narration word timestamps."""

from functools import lru_cache
import math
import os
import tempfile
import wave

from captions import estimate_word_timings

# tiny is enough for forced alignment of a known script and fits the 8 GB WSL cap
# (bump to 'base' if drift shows up in the live KAN-185 run).
ALIGN_MODEL = os.environ.get("FORGE_ALIGN_MODEL", "tiny")


def _normalize_token(text: str) -> str:
    return "".join(c for c in text if c.isalnum()).lower()


@lru_cache(maxsize=1)
def _model():
    import stable_whisper

    return stable_whisper.load_model(ALIGN_MODEL, device="cpu")


def align_words(wav_path, text):
    """Return stable-ts word spans for text, validating them against the WAV duration."""
    if not text or not text.strip():
        return []
    with wave.open(str(wav_path), "rb") as audio:
        duration = audio.getnframes() / audio.getframerate()
    result = _model().align(str(wav_path), text, language="en")
    segments = result.segments if hasattr(result, "segments") else result["segments"]
    words = []
    for segment in segments:
        segment_words = segment.words if hasattr(segment, "words") else segment.get("words", [])
        for word in segment_words:
            if isinstance(word, dict):
                token, start, end = word["word"], word["start"], word["end"]
            else:
                token, start, end = word.word, word.start, word.end
            start, end = float(start), float(end)
            if not token.strip() or not math.isfinite(start) or not math.isfinite(end) or start < 0 or end < start or end > duration + 0.5:
                raise ValueError("aligner returned an invalid word span")
            start = round(max(0.0, min(start, duration)), 3)
            end = round(max(0.0, min(end, duration)), 3)
            words.append({"text": token.strip(), "start": start, "end": end})
    if not words:
        raise ValueError("aligner returned no words")

    prev_end = 0.0
    for i in range(len(words)):
        w = words[i]
        start = max(w["start"], prev_end)
        next_start = words[i + 1]["start"] if i + 1 < len(words) else duration
        end = max(start, min(w["end"], next_start))
        w["start"] = round(start, 3)
        w["end"] = round(end, 3)
        prev_end = w["end"]

    script_words = text.split()
    if len(words) != len(script_words):
        raise ValueError("aligner word count does not match the script")
    if [_normalize_token(w["text"]) for w in words] != [_normalize_token(sw) for sw in script_words]:
        raise ValueError("aligner word sequence does not match the script")

    return [
        {"text": sw, "start": w["start"], "end": w["end"]}
        for sw, w in zip(script_words, words)
    ]


def align_lines(wav_path, lines):
    """Return line start/end spans from stable-ts word alignment, or None on failure."""
    try:
        if not lines or any(not isinstance(line, str) or not line.strip() for line in lines):
            return None
        words = align_words(wav_path, " ".join(lines))
        spans = []
        word_index = 0
        for line in lines:
            line_words = line.split()
            aligned = words[word_index:word_index + len(line_words)]
            if len(aligned) != len(line_words):
                return None
            spans.append({"text": line, "start": aligned[0]["start"], "end": aligned[-1]["end"]})
            word_index += len(line_words)
        if word_index != len(words):
            return None
        return spans
    except Exception:
        return None


def drift_report(aligned, estimated):
    """Summarize mean start/end and largest boundary drift in seconds."""
    pairs = [(a, e) for a, e in zip(aligned, estimated) if a["text"] == e["text"]]
    if not pairs:
        return {"words": 0, "mean_start_drift": 0.0, "mean_end_drift": 0.0, "max_boundary_drift": 0.0}
    starts = [abs(a["start"] - e["start"]) for a, e in pairs]
    ends = [abs(a["end"] - e["end"]) for a, e in pairs]
    return {
        "words": len(pairs),
        "mean_start_drift": round(sum(starts) / len(starts), 3),
        "mean_end_drift": round(sum(ends) / len(ends), 3),
        "max_boundary_drift": round(max(starts + ends), 3),
    }


def words_for_job(wav_path, text, sentence_texts, spans, enabled, strict=False):
    """Use alignment when requested; otherwise preserve the existing estimates. strict (KAN-603): a failed alignment raises instead of falling back."""
    if not text or not text.strip():
        return [], "estimated"
    if enabled:
        try:
            words = align_words(wav_path, text)
            if strict:
                words = _recover_terminal(wav_path, text, sentence_texts, spans, words)
            return words, "aligned"
        except Exception:
            if strict:
                raise
    return estimate_word_timings(sentence_texts, spans), "estimated"


def _recover_terminal(wav_path, text, sentence_texts, spans, words):
    """Recover only a terminal alignment in dead air using the measured final TTS window."""
    if (not sentence_texts or len(sentence_texts) != len(spans)
            or any(not isinstance(s, str) or not s.strip() for s in sentence_texts)
            or ' '.join(sentence_texts).split() != text.split()):
        raise ValueError('measured sentence windows do not match script')
    with wave.open(str(wav_path), 'rb') as src:
        rate, frames = src.getframerate(), src.getnframes()
        duration = frames / rate
        start, end = map(float, spans[-1])
        if not math.isfinite(start) or not math.isfinite(end) or not 0 <= start < end <= duration + .001:
            raise ValueError('invalid terminal sentence window')
        if words[-1]['end'] <= end + .02 and not (words[-1]['start'] == words[-1]['end'] and words[-1]['end'] >= duration - .02):
            return words
        count = len(sentence_texts[-1].split())
        first, last = round(start * rate), min(frames, round(end * rate))
        if first >= last:
            raise ValueError('empty terminal sentence window')
        params = src.getparams()
        src.setpos(first)
        audio = src.readframes(last - first)
    with tempfile.TemporaryDirectory(dir=os.path.dirname(os.path.abspath(wav_path))) as scratch:
        crop_path = os.path.join(scratch, 'terminal.wav')
        with wave.open(crop_path, 'wb') as crop:
            crop.setparams(params)
            crop.writeframes(audio)
        aligned = align_words(crop_path, sentence_texts[-1])
    expected = sentence_texts[-1].split()
    if len(aligned) != count or [_normalize_token(w['text']) for w in aligned] != [_normalize_token(t) for t in expected]:
        raise ValueError('terminal word sequence mismatch')
    if aligned[-1]['end'] <= aligned[-1]['start'] or any(w['end'] > (last - first) / rate + .001 for w in aligned):
        raise ValueError('terminal alignment is outside measured audio')
    offset = first / rate
    recovered = [{'text': token, 'start': round(offset + w['start'], 3), 'end': round(offset + w['end'], 3)} for token, w in zip(expected, aligned)]
    result = words[:-count] + recovered
    if len(result) != len(words) or any(result[i]['start'] < result[i-1]['end'] for i in range(1, len(result))):
        raise ValueError('terminal alignment overlaps preceding words')
    return result
