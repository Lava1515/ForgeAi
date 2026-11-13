import math
import sys
import wave
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import aligner


def wav(path, seconds=3):
    with wave.open(str(path), "wb") as f:
        f.setnchannels(1); f.setsampwidth(2); f.setframerate(1000)
        f.writeframes(b"\0\0" * seconds * 1000)


def test_rejects_zero_span_final_word(tmp_path):
    path = tmp_path / "x.wav"; wav(path)
    result = SimpleNamespace(segments=[SimpleNamespace(words=[
        SimpleNamespace(word="it", start=2.0, end=2.0)])])
    with patch.object(aligner, "_model", return_value=SimpleNamespace(align=lambda *a, **k: result)):
        try:
            aligner.align_words(path, "it")
        except ValueError:
            return
    assert False, "zero duration word was accepted"


def test_strict_recovers_from_measured_sentence_windows(tmp_path):
    path = tmp_path / "x.wav"; wav(path)
    seen = []
    def fake_align(crop, text, language):
        seen.append((Path(crop), text))
        words = [SimpleNamespace(word=t, start=.1 + i*.1, end=.18 + i*.1) for i, t in enumerate(text.split())]
        return SimpleNamespace(segments=[SimpleNamespace(words=words)])
    fake_model = SimpleNamespace(align=fake_align)
    with patch.object(aligner, "_model", return_value=fake_model), patch.object(aligner, "align_words", wraps=aligner.align_words):
        # Full alignment produces the reported out-of-range zero-span final token.
        original = fake_model.align
        def fail_full(p, text, language):
            if text == "known it":
                return SimpleNamespace(segments=[SimpleNamespace(words=[SimpleNamespace(word="known", start=.1, end=.2), SimpleNamespace(word="it", start=3.0, end=3.0)])])
            return original(p, text, language)
        fake_model.align = fail_full
        words, source = aligner.words_for_job(path, "known it", ["known", "it"], [(1.0, 1.5), (2.0, 2.5)], True, strict=True)
    assert source == "aligned"
    assert words == [{"text":"known", "start":1.1, "end":1.18}, {"text":"it", "start":2.1, "end":2.18}]
    assert all(p != path for p, _ in seen)


def test_strict_rejects_malformed_windows_without_estimates(tmp_path):
    path = tmp_path / "x.wav"; wav(path)
    with patch.object(aligner, "align_words", side_effect=ValueError("bad")), patch.object(aligner, "estimate_word_timings", side_effect=AssertionError("estimate called")):
        for spans in [[(0, math.inf)], [(2, 1)]]:
            try:
                aligner.words_for_job(path, "one", ["one"], spans, True, strict=True)
            except ValueError:
                continue
            assert False, "malformed span accepted"
