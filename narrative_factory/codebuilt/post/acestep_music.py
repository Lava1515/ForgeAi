"""C3 host music worker, tested ACE-Step install only. codex · gpt-6.1-sol · 2026-11-19.

Started under the dashboard GPU lease with a 120-second process timeout. No installs or downloads.
"""
import json
import hashlib
import math
import os
from pathlib import Path
import re
import subprocess
import sys
import time

import numpy as np
import soundfile as sf
from scipy.signal import resample_poly

INSTALL = Path('C:/code/ForgeAi/output/agent-jobs/tools-tests-1119')
COMMIT = 'ca1e85fe9430179831e6bc6be790c332190a3866'


def mood_for(text):
    words = set(re.findall(r'[a-z]+', text.lower()))
    if words & {'danger', 'deadly', 'war', 'disaster', 'crash', 'fear', 'death', 'collapse'}:
        return 'tension', 'low strings, deep pulse, sparse percussion', 112
    if words & {'happy', 'joy', 'fun', 'play', 'celebrate'}:
        return 'bright', 'warm piano, gentle plucked strings, light pulse', 104
    return 'wonder', 'soft felt piano, warm synth pad, light pulse, no drums', 100


MIN_FREE_MB = 8500


def card_block(apps, free_mb, render_pids=''):
    """Why the card cannot take the music model now, or None. The dashboard's lease already keeps Forge jobs off the card, so this only
    looks for an outside compute or render job and for memory. claude-pro | claude-fable-5-2 | 2026-11-20: the old test also refused
    above 10 percent card use, which an ordinary desktop (browser, chat apps) reaches by itself; all three videos of run-mwow3a91-f47cff
    fell back to the synth on it. Unknown is busy. Limit: an outside tool that shows as C+G under another name is caught only by the
    memory test, once it has loaded a model."""
    # On WDDM the process table lists every desktop app as C+G. A plain C row is a compute job.
    if 'Processes:' not in apps:
        return 'card_unknown'
    if re.search(r'\sC\s', apps) or re.search(r'(?:python|blender|render|ollama|comfy|llama|stable.?diffusion).*\.exe', apps, re.I) or str(render_pids).strip():
        return 'card_busy'
    if free_mb < MIN_FREE_MB:
        return 'card_memory'
    return None


def gpu_block():
    """card_block on the live card."""
    apps = subprocess.check_output(['nvidia-smi'], timeout=10, text=True)
    stats = subprocess.check_output(['nvidia-smi', '--query-gpu=memory.free', '--format=csv,noheader,nounits'], timeout=10, text=True)
    free = int(stats.strip().splitlines()[0].strip())
    procs = ''
    if os.name == 'nt':
        procs = subprocess.check_output(['powershell', '-NoProfile', '-NonInteractive', '-Command',
            "Get-Process -Name '*blender*','*render*' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id; exit 0"], timeout=10, text=True)
    return card_block(apps, free, procs)


def fit_bed(samples, source_sr, duration, sr=44100):
    """Fold to mono, resample, loop with a short crossfade if needed, trim and fade edges."""
    x = np.asarray(samples, dtype=float)
    if x.ndim == 2:
        x = x.mean(axis=1)
    if not x.size or not np.isfinite(x).all() or np.max(np.abs(x)) < 1e-6:
        raise ValueError('empty, silent or invalid music')
    divisor = math.gcd(source_sr, sr)
    x = resample_poly(x, sr // divisor, source_sr // divisor)
    n = int(duration * sr)
    original = x.copy()
    while len(x) < n:
        overlap = min(int(.05 * sr), len(original) // 4)
        if overlap:
            ramp = np.linspace(0, 1, overlap)
            x = np.concatenate((x[:-overlap], x[-overlap:] * (1-ramp) + original[:overlap] * ramp, original[overlap:]))
        else:
            x = np.concatenate((x, original))
    x = x[:n].copy()
    fade = min(int(1.2 * sr), n // 2)
    if fade:
        x[:fade] *= np.linspace(0, 1, fade)
        x[-fade:] *= np.linspace(1, 0, fade)
    return x


def generate(job, work):
    start = time.monotonic()
    repo = INSTALL / 'ace-step'
    head = subprocess.check_output(['git', '-C', str(repo), 'rev-parse', 'HEAD'], text=True, timeout=10).strip()
    if head != COMMIT:
        raise RuntimeError('pin_mismatch')
    blocked = gpu_block()
    if blocked:
        raise RuntimeError(blocked)     # the host reads this word from generation.log (acestepMusic.js)
    # Keep every runtime cache/output in this job; weights and code are read from the approved install.
    for key in ('HF_HOME', 'TORCH_HOME', 'XDG_CACHE_HOME', 'TRITON_CACHE_DIR', 'MPLCONFIGDIR'):
        os.environ[key] = str(work / key.lower())
    os.environ.update(HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1', PYTHONDONTWRITEBYTECODE='1',
                      ACESTEP_CHECKPOINTS_DIR=str(INSTALL / 'ace-checkpoints'))
    sys.dont_write_bytecode = True
    sys.path.append(str(repo))
    from acestep.handler import AceStepHandler
    from acestep.llm_inference import LLMHandler
    from acestep.inference import GenerationParams, GenerationConfig, generate_music
    from acestep.model_downloader import check_main_model_exists, check_model_exists
    checkpoints = INSTALL / 'ace-checkpoints'
    if not check_main_model_exists(checkpoints) or not check_model_exists('acestep-v15-turbo', checkpoints):
        raise RuntimeError('missing approved weights; downloads disabled')
    voice = sf.info(job / 'mix.wav')
    duration = voice.frames / voice.samplerate
    words = json.loads((job / 'words.json').read_text(encoding='utf-8'))
    text = ' '.join(str(w.get('w', '')) for w in words.get('words', []))
    mood, instruments, bpm = mood_for(text)
    seed = int.from_bytes(hashlib.sha256(text.encode('utf-8')).digest()[:4], 'big') % (2**31)
    dit = AceStepHandler()
    # Upstream normally syncs model Python into the shared checkpoints; runtime must only write in this job.
    dit._sync_model_code_if_needed = lambda *args: None
    status, ok = dit.initialize_service(project_root=str(repo), config_path='acestep-v15-turbo', device='cuda')
    if not ok:
        raise RuntimeError(status)
    generation_start = time.monotonic()
    result = generate_music(dit, LLMHandler(), GenerationParams(
        caption=f'instrumental documentary underscore, {mood}, {instruments}, no vocals',
        lyrics='[Instrumental]', instrumental=True, bpm=bpm, duration=max(10, min(duration, 120)), thinking=False, seed=seed),
        GenerationConfig(batch_size=1, audio_format='wav'), save_dir=str(work))
    if not result.success or not result.audios:
        raise RuntimeError('ACE-Step generation failed')
    samples, rate = sf.read(result.audios[0]['path'], dtype='float32')
    sf.write(work / 'bed.wav', fit_bed(samples, rate, duration), 44100, subtype='FLOAT')
    report = {'source': 'acestep', 'mood': mood, 'duration_s': duration,
              'generation_s': round(time.monotonic()-generation_start, 3),
              'total_s': round(time.monotonic()-start, 3), 'commit': COMMIT}
    (work / 'music.json').write_text(json.dumps(report, indent=2), encoding='utf-8')


if __name__ == '__main__':
    generate(Path(sys.argv[1]).resolve(), Path(sys.argv[2]).resolve())
