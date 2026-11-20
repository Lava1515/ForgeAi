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


# claude-pro | claude-fable-5-2 | 2026-11-20: card use by desktop apps no longer refuses (run-mwow3a91-f47cff: 3 of 3 fell back on it).
@pytest.mark.parametrize('apps,free_mb,render_pids,expected', [
    ('Processes: 123 C python.exe', 11000, '', 'card_busy'),
    ('Processes:', 11000, '456\n', 'card_busy'),
    ('Processes:', 4000, '', 'card_memory'),
    ('', 11000, '', 'card_unknown'),
    ('Processes: 14348 C+G msedge.exe  26376 C+G Discord.exe', 9600, '', None),
])
def test_card_block_reasons(apps, free_mb, render_pids, expected):
    assert acestep_music.card_block(apps, free_mb, render_pids) == expected


def test_busy_card_never_starts_generation(monkeypatch):
    replies = iter(['Processes: 123 C python.exe', '11000', ''])
    monkeypatch.setattr(acestep_music.subprocess, 'check_output', lambda *a, **k: next(replies))
    assert acestep_music.gpu_block() == 'card_busy'
