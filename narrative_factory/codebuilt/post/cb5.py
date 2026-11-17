"""Adapt the CB4 post kit to the fixed CB5 job-folder output contract."""
import json
import math
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
MIX_SR = 44100


def _word_cues(word_data, duration):
    """Build sparse, deterministic effects cues at the aligned word start times.

    The finalizer delays the complete mixed stem by LEAD, so these times must stay
    in the original voice timeline; adding LEAD here would shift cues twice.
    """
    cues = []
    for item in word_data.get("words", []):
        if not isinstance(item, dict):
            continue
        token = str(item.get("w", "")).strip()
        punctuation = str(item.get("punct", ""))
        try:
            start = float(item.get("s"))
        except (TypeError, ValueError):
            continue
        if not token or not math.isfinite(start) or not 0 <= start < duration:
            continue
        core = token.strip(".,;:!?…—–-)]}\"'”’")
        marks = punctuation or token.rstrip("\"'”’)]}")
        if any(char.isdigit() for char in core):
            cues.append(("pop", start, 0.45))
        elif any(char in ",;:.!?…" for char in marks):
            cues.append(("whoosh", start, 0.16))
    return cues


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
    # KO1: a job whose format has the overlay flag carries the host's inputs/overlay.json; the kit wrote work/anchors.json.
    # Both are resolved inside the job (a link out of it fails here); run.finish reads them with their strict readers.
    spec = media.inside(job, job / "inputs" / "overlay.json")
    marks = media.inside(job, job / "work" / "anchors.json")
    overlay_args = {"overlay_spec": spec, "anchors": marks if marks.exists() else None, "job_root": job} if spec.exists() else {}
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
    word_data = json.loads(words.read_text(encoding="utf-8"))
    # The voice is recorded at 24 kHz. Music and effects synthesized at that rate lose everything above 12 kHz and sounded
    # dull and distant (review of 2026-11-14), so the bed is made and mixed at MIX_SR; the mixer resamples the voice.
    # The bed is chosen from the narration text: the same video always gets the same music, different videos differ.
    choice = audio_kit.music_choice(" ".join(str(w.get("w", "")) for w in word_data.get("words", []) if isinstance(w, dict)))
    music = audio_kit.synth_music(duration, sr=MIX_SR, seed=choice["seed"], bpm=choice["bpm"],
                                  progression=audio_kit.PROGRESSIONS[choice["progression"]], fade_out_s=min(1.2, duration / 2))
    word_events = _word_cues(word_data, duration)
    effects = audio_kit.synth_effects(word_events, duration, sr=MIX_SR, seed=3)
    mixed = audio_kit.mix_stems((voice, sr), (music, MIX_SR), (effects, MIX_SR), sr=MIX_SR, voice_peak=None)
    mixed.report["music_choice"] = choice
    audio_raw = out / "audio"
    if audio_raw.is_symlink() or audio_raw.is_junction():
        raise media.MediaError("audio output must not be a link")
    audio_out = media.inside(out, audio_raw)
    for name in ("cb5-mix.wav", "cb5-voice.wav", "cb5-music.wav", "cb5-effects.wav", "cb5-levels.json"):
        target = audio_out / name
        if target.is_symlink() or target.is_junction() or (target.exists() and target.stat().st_nlink > 1):
            raise media.MediaError("audio output must not be a linked file")
        media.inside(audio_out, target)
    audio_paths = audio_kit.write_outputs(mixed, audio_out, name="cb5", channels=2, print_levels=False)
    # A fresh directory cannot alias an existing frames/out junction. Keep intermediates
    # with the job for diagnosis; never recursively delete agent-controlled job contents.
    work = Path(tempfile.mkdtemp(prefix=".cb5-post-", dir=job))
    result = run.finish(frames, words, audio_paths["mix"], work, "render", fps=fps, lead=lead, **overlay_args)
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
