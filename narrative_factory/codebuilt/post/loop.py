"""Loop format finalization through the shared post kit. codex · gpt-6.1-sol · 2026-11-14."""
import json
import shutil
import subprocess
import tempfile

import numpy as np
import soundfile as sf
from PIL import Image

from blender_worker.codebuilt import audio
from narrative_factory.codebuilt.qa.loop_seam import check_seam
from . import media, run


def check_motion(files, fps=30):
    """Does the rendered loop move, all the way round? Mean absolute error on 8-bit RGB, frames reduced to 180 px wide.

    range: the largest distance of any frame from frame 0 (a still picture gives 0).
    pace: the distance between frames `window` apart (a sixth of a second), around the seam; its median is the loop's own usual pace.
    A frame is still when its pace is under a tenth of that median, so a slow turn at the end of a swing is not a freeze, and a
    gentle or a 20 second loop is measured against itself. Refused: no range, no usual pace (most of the loop stands still), or
    one still run longer than a sixth of the loop (and at least a third of a second)."""
    def read(file):
        with Image.open(file) as im:
            im = im.convert('RGB')
            w = min(180, im.width)
            return np.asarray(im.resize((w, max(1, round(im.height * w / im.width))), Image.BOX), dtype=np.int16)
    frames = [read(f) for f in files]
    n = len(frames)
    window = max(1, fps // 6)
    dist = lambda a, b: float(np.abs(a - b).mean())
    span = max((dist(frames[0], f) for f in frames[1:]), default=0.0)
    pace = [dist(frames[i], frames[(i + window) % n]) for i in range(n)]
    usual = float(np.median(pace)) if pace else 0.0
    still = longest = 0
    for value in pace + pace:                         # twice round, so a still run across the seam is counted whole
        still = still + 1 if value < 0.1 * usual or value == 0 else 0
        longest = max(longest, still)
    longest = min(longest, n)
    limit = max(fps / 3, n / 6)
    return {'passed': span >= 0.3 and usual >= 0.02 and longest <= limit,
            'range_from_frame0_rgb_255': span, 'usual_pace_rgb_255': usual, 'pace_window_frames': window,
            'longest_still_frames': longest, 'range_floor': 0.3, 'pace_floor': 0.02, 'max_still_frames': limit}


def produce_loop(job, fps=30):
    pack = json.loads((job / 'inputs' / 'pathpack.json').read_text(encoding='utf-8'))
    n = pack['loop']['nframes']
    if type(n) is not int or not 6 <= n / fps <= 20 or pack['loop']['fps'] != fps or pack['loop']['duration'] != n / fps:
        raise media.MediaError('loop must be 6 to 20 seconds at the contracted frame rate')
    frames = media.inside(job, job / 'frames')
    files = run._frames(frames)
    if [p.name for p in files] != [f'{i:04d}.png' for i in range(n + 1)]:
        raise media.MediaError('loop needs frames 0 through N including the independent seam endpoint')
    out = media.inside(job, job / 'out')
    out.mkdir(exist_ok=True)
    report_file = media.inside(out, out / 'report.json')
    report_file.unlink(missing_ok=True)
    seam = check_seam(files[0], files[-1])
    # Persist the measured number even on failure; never leave a previous success receipt.
    report = {'version': 'codebuilt-cb5-v1', 'video_type': 'loop', 'status': 'failed', 'seam': seam}
    report_file.write_text(json.dumps(report, indent=2), encoding='utf-8')
    if not seam['passed']:
        raise media.MediaError(f"loop seam failed: MAE {seam['mae_rgb_255']:.6f}, p99 {seam['p99_max_channel_255']:.6f}")
    motion = check_motion(files[:-1], fps)
    report['motion'] = motion
    report_file.write_text(json.dumps(report, indent=2), encoding='utf-8')
    if not motion['passed']:
        raise media.MediaError('loop motion gate failed: ' + json.dumps(motion))
    audio_out = media.inside(out, out / 'audio')
    audio_out.mkdir(exist_ok=True)
    wav = media.inside(audio_out, audio_out / 'loop.wav')
    samples = audio.synth_loop(n / fps, sr=44100, topic=pack.get('topic', (job / 'inputs' / 'brief.md').read_text(encoding='utf-8')))
    jump = float(abs(samples[0] - samples[-1]))
    step = float(np.max(np.abs(np.diff(samples))))
    audio_check = {'source': 'blender_worker/codebuilt/audio.py:synth_loop', 'sr': 44100,
                   'seam_step': jump, 'max_interior_step': step, 'passed': jump <= step + 1e-8,
                   'basis': 'periodic Fourier synthesis; seam step no larger than an ordinary adjacent-sample step'}
    if not audio_check['passed']:
        raise media.MediaError('synthesized sound does not close continuously')
    sf.write(str(wav), samples, 44100, subtype='PCM_16')
    work = tempfile.mkdtemp(prefix='.loop-post-', dir=job)
    result = run.finish(frames, None, wav, work, 'render', lead=0, fps=fps, video_type='loop')
    duration = result['probe']['duration']
    if not result['ok'] or not 6 <= duration <= 20:
        raise media.MediaError('loop post or length check failed')
    video = media.inside(out, out / 'video.mp4')
    sheet = media.inside(out, out / 'contact_sheet.png')
    shutil.copyfile(result['video'], video)
    # Check the delivered AAC too: periodic source samples alone do not prove
    # that a lossy encoder preserved the quiet seam. Ignore AAC's padded tail.
    decoded = subprocess.run([media.resolve_ffmpeg(), '-hide_banner', '-loglevel', 'error', '-i', str(video),
                              '-vn', '-ac', '1', '-ar', '44100', '-f', 'f32le', '-'],
                             capture_output=True, timeout=120, check=True)
    pcm = np.frombuffer(decoded.stdout, dtype='<f4')[:len(samples)]
    if len(pcm) != len(samples) or not np.isfinite(pcm).all():
        raise media.MediaError('encoded loop audio has missing or invalid samples')
    encoded_jump = float(abs(pcm[0] - pcm[-1]))
    encoded_step = float(np.max(np.abs(np.diff(pcm))))
    audio_check['encoded_seam'] = {'seam_step': encoded_jump, 'max_interior_step': encoded_step,
                                   'passed': encoded_jump <= encoded_step + 1 / 32768}
    if not audio_check['encoded_seam']['passed']:
        report['audio'] = audio_check
        report_file.write_text(json.dumps(report, indent=2), encoding='utf-8')
        raise media.MediaError('encoded audio seam exceeds an ordinary sample step plus one PCM16 code value')
    with Image.open(result['contact_sheet'], formats=['JPEG']) as im:
        im.save(sheet, format='PNG')
    report.update(status='ok', video=str(video), subtitles=None, contact_sheet=str(sheet),
                  post={k: v for k, v in result.items() if k not in {'video', 'subtitles', 'contact_sheet'}},
                  audio=audio_check, audio_stems={'mix': str(wav)}, duration_seconds=duration,
                  length_check={'min_s': 6, 'max_s': 20, 'actual_s': duration, 'within_tolerance': True})
    report_file.write_text(json.dumps(report, indent=2), encoding='utf-8')
    return report
