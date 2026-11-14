import sys
import wave
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import aligner


def wav(path):
    with wave.open(str(path), 'wb') as f:
        f.setnchannels(1); f.setsampwidth(2); f.setframerate(1000)
        f.writeframes(bytes(6000))


def result(words):
    return SimpleNamespace(segments=[SimpleNamespace(words=[SimpleNamespace(word=t, start=s, end=e) for t, s, e in words])])


def test_accepts_interior_zero_span_words(tmp_path):
    audio = tmp_path / 'x.wav'; wav(audio)
    model = SimpleNamespace(align=lambda *a, **k: result([('the', .1, .1), ('end', .2, .5)]))
    with patch.object(aligner, '_model', return_value=model):
        words = aligner.align_words(audio, 'the end')
    assert words[0]['start'] == words[0]['end'] == .1


def test_recovers_only_terminal_file_boundary_artifact(tmp_path):
    audio = tmp_path / 'x.wav'; wav(audio)
    seen = []
    def align(p, text, language):
        seen.append(text)
        if Path(p) == audio:
            return result([('the', .1, .1), ('end.', .2, .5), ('do', 2.1, 2.3), ('it.', 3., 3.)])
        assert text == 'do it.'
        with wave.open(str(p), 'rb') as crop:
            assert crop.getnframes() == 500
        return result([('do', .1, .25), ('it.', .25, .4)])
    with patch.object(aligner, '_model', return_value=SimpleNamespace(align=align)):
        with patch.object(aligner, '_windows_usable', return_value=False):   # the whole-file path with terminal recovery
            words, source = aligner.words_for_job(audio, 'the end. do it.', ['the end.', 'do it.'], [(0, 1), (2, 2.5)], True, strict=True)
    assert seen == ['the end. do it.', 'do it.']
    assert source == 'aligned'
    assert words[:2] == [{'text': 'the', 'start': .1, 'end': .1}, {'text': 'end.', 'start': .2, 'end': .5}]
    assert words[-1] == {'text': 'it.', 'start': 2.25, 'end': 2.4}
    assert list(tmp_path.iterdir()) == [audio]


def test_strict_terminal_mismatch_raises(tmp_path):
    audio = tmp_path / 'x.wav'; wav(audio)
    def align(p, text, language):
        return result([('it', 3., 3.)]) if Path(p) == audio else result([('wrong', .1, .4)])
    with patch.object(aligner, '_model', return_value=SimpleNamespace(align=align)), patch.object(aligner, 'estimate_word_timings', side_effect=AssertionError('estimated')):
        with pytest.raises(ValueError), patch.object(aligner, '_windows_usable', return_value=False):
            aligner.words_for_job(audio, 'it', ['it'], [(2, 2.5)], True, strict=True)


# 2026-11-14 (job mwg5e6hs-e826b9): one hard sentence must not sink the whole narration.
def test_each_sentence_is_aligned_in_its_own_window(tmp_path):
    audio = tmp_path / 'x.wav'; wav(audio)
    seen = []
    def align(p, text, language):
        assert Path(p) != audio, 'the whole file must not be aligned in one pass'
        seen.append(text)
        if text == 'do it.':
            raise RuntimeError('aligner gave up on this sentence')
        return result([('the', .05, .2), ('end.', .2, .6)])
    with patch.object(aligner, '_model', return_value=SimpleNamespace(align=align)):
        words, source = aligner.words_for_job(audio, 'the end. do it. the end.', ['the end.', 'do it.', 'the end.'], [(0, .9), (1, 1.9), (2, 2.9)], True, strict=True)   # the test wav is 3 s long
    assert source == 'aligned' and seen == ['the end.', 'do it.', 'the end.']
    assert [w['text'] for w in words] == ['the', 'end.', 'do', 'it.', 'the', 'end.']
    assert 0 <= words[0]['start'] < words[1]['end'] <= 0.9
    assert 1.0 <= words[2]['start'] < words[3]['end'] <= 1.9          # the failed sentence stays inside its window
    assert 2.0 <= words[4]['start'] < words[5]['end'] <= 2.9
    assert all(words[i]['start'] >= words[i - 1]['end'] for i in range(1, len(words)))
    assert list(tmp_path.iterdir()) == [audio]


def test_too_many_unplaced_sentences_is_a_failed_alignment(tmp_path):
    audio = tmp_path / 'x.wav'; wav(audio)
    def align(p, text, language):
        raise RuntimeError('no')
    with patch.object(aligner, '_model', return_value=SimpleNamespace(align=align)):
        with pytest.raises(ValueError):
            aligner.words_for_job(audio, 'a b. c d.', ['a b.', 'c d.'], [(0, 1), (2, 2.9)], True, strict=True)
