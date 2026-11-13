"""Adapt the CB4 post kit to the fixed CB5 job-folder output contract."""
import json
import shutil
import tempfile
from pathlib import Path

from PIL import Image
import soundfile as sf
import numpy as np

from blender_worker.codebuilt import audio as audio_kit

from . import media, run


# Seconds the executor adds before every cue and before the voice (blender_worker/codebuilt/timeline.py LEAD; a test keeps them equal).
LEAD = 0.35


def produce(job_dir, *, fps=run.FPS, lead=LEAD):
    """Finalize <job>/frames, words.json and mix.wav into the four CB5 out artifacts.

    All paths are resolved beneath the explicit absolute job directory. The success report is
    written last, after each required artifact has been checked for non-zero size.
    """
    raw = Path(job_dir)
    if not raw.is_absolute():
        raise media.MediaError("job_dir must be absolute")
    job = raw.resolve()
    frames = media.inside(job, job / "frames")
    words = media.inside(job, job / "words.json")
    audio = media.inside(job, job / "mix.wav")
    out = media.inside(job, job / "out")
    paths = {name: media.inside(out, out / name) for name in
             ("video.mp4", "subtitles.srt", "contact_sheet.png", "report.json")}
    out.mkdir(parents=True, exist_ok=True)
    paths["report.json"].unlink(missing_ok=True)
    for src in (words, audio):
        media.input_file(src)
    # CB5 owns the final audio input: read the staged trusted WAV, build a reproducible local bed,
    # measure against active voice samples, and keep the staged trusted voice unchanged.
    voice, sr = sf.read(str(audio), dtype="float32", always_2d=False)
    duration = len(voice) / sr
    music = audio_kit.synth_music(duration, sr=sr, seed=3, fade_out_s=min(1.2, duration / 2))
    effects = np.zeros(len(music), dtype=float)
    mixed = audio_kit.mix_stems((voice, sr), (music, sr), (effects, sr), sr=int(sr), voice_peak=None)
    audio_raw = out / "audio"
    if audio_raw.is_symlink() or audio_raw.is_junction():
        raise media.MediaError("audio output must not be a link")
    audio_out = media.inside(out, audio_raw)
    for name in ("cb5-mix.wav", "cb5-voice.wav", "cb5-music.wav", "cb5-effects.wav", "cb5-levels.json"):
        target = audio_out / name
        if target.is_symlink() or target.is_junction() or (target.exists() and target.stat().st_nlink > 1):
            raise media.MediaError("audio output must not be a linked file")
        media.inside(audio_out, target)
    audio_paths = audio_kit.write_outputs(mixed, audio_out, name="cb5", channels=1, print_levels=False)
    # A fresh directory cannot alias an existing frames/out junction. Keep intermediates
    # with the job for diagnosis; never recursively delete agent-controlled job contents.
    work = Path(tempfile.mkdtemp(prefix=".cb5-post-", dir=job))
    result = run.finish(frames, words, audio_paths["mix"], work, "render", fps=fps, lead=lead)
    if result.get("ok") is not True:
        raise media.MediaError("CB4 finalizer checks failed")
    shutil.copyfile(result["video"], paths["video.mp4"])
    shutil.copyfile(result["subtitles"], paths["subtitles.srt"])
    # Decode/re-encode image pixels: the CB4 JPEG must not be renamed to .png.
    with Image.open(result["contact_sheet"], formats=["JPEG"]) as sheet:  # the CB4 sheet the host just wrote
        sheet.save(paths["contact_sheet.png"], format="PNG")
    for name in ("video.mp4", "subtitles.srt", "contact_sheet.png"):
        if not paths[name].is_file() or paths[name].stat().st_size <= 0:
            raise media.MediaError(f"required CB5 artifact is empty: {name}")
    report = {
        "version": "codebuilt-cb5-v1", "status": "ok",
        "video": str(paths["video.mp4"]), "subtitles": str(paths["subtitles.srt"]),
        "contact_sheet": str(paths["contact_sheet.png"]),
        "post": {key: value for key, value in result.items() if key not in {"video", "subtitles", "contact_sheet"}},
        "audio": mixed.report,
        "audio_stems": {key: str(value) for key, value in audio_paths.items()},
    }
    paths["report.json"].write_text(json.dumps(report, indent=2), encoding="utf-8")
    if paths["report.json"].stat().st_size <= 0:
        raise media.MediaError("required CB5 artifact is empty: report.json")
    return report
