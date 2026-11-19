"""C3 music-level and observed GPU-sharing regression. codex · gpt-6.1-sol · 2026-11-19."""
import json
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf

from narrative_factory.codebuilt.post import acestep_music, cb5


@pytest.mark.parametrize('source', ['synth', 'acestep', 'invalid_acestep'])
def test_both_music_sources_keep_measured_level(tmp_path, monkeypatch, source):
    from test_post_overlay_run import _fake_cb5_job
    job, _ = _fake_cb5_job(tmp_path, monkeypatch)
    monkeypatch.delenv('FORGEAI_ACE_BED', raising=False)
    if source != 'synth':
        bed = job / 'bed.wav'
        # Stereo, different rate and shorter than narration exercises the real loop/trim path.
        samples = .8 * np.sin(2*np.pi*220*np.arange(2400)/24000)
        sf.write(bed, np.column_stack((samples, samples)), 24000)
        info = job / 'music.json'
        info.write_text(json.dumps({'source': 'acestep'}))
        if source == 'invalid_acestep':
            bed.write_bytes(b'invalid wav')
        monkeypatch.setenv('FORGEAI_ACE_BED', str(bed))
        monkeypatch.setenv('FORGEAI_ACE_REPORT', str(info))
    report = cb5.produce(job)
    voice, rate = sf.read(job / 'out/audio/cb5-voice.wav')
    music, _ = sf.read(job / 'out/audio/cb5-music.wav')
    from blender_worker.codebuilt.audio import rms_dbfs
    delta = rms_dbfs(voice.mean(axis=1)) - rms_dbfs(music.mean(axis=1))
    assert delta == pytest.approx(18, abs=.1)
    assert len(voice) == len(music)
    assert report['audio']['music_source']['source'] == ('acestep' if source == 'acestep' else 'synth')


@pytest.mark.parametrize('compute,stats,processes', [('Processes: 123 C python.exe', '', ''), ('Processes:', '11000, 55', ''), ('Processes:', '11000, 0', '456\n')])
def test_busy_card_never_starts_generation(monkeypatch, compute, stats, processes):
    replies = iter([compute, stats, processes])
    monkeypatch.setattr(acestep_music.subprocess, 'check_output', lambda *a, **k: next(replies))
    assert acestep_music.gpu_free() is False
