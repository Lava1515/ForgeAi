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

from . import anchors_file, captions, media, overlay, run


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


def overlay_cues(spec, anchors, duration, fps, lead):
    """Video-clock cues for overlay premixes; voice lead is applied in mix_stems only.

    Preserve entire spec windows, including before lead and after voice end.
    """
    for name, value in (("duration", duration), ("fps", fps), ("lead", lead)):
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
            raise ValueError(f"{name} must be a finite number")
    if duration <= 0 or not 0 < fps <= 240 or lead < 0:
        raise ValueError("duration must be positive, fps in (0, 240], lead non-negative")
    if (duration + lead) * fps > 216000:
        raise ValueError("overlay audio exceeds 216000 frame budget")
    cues = []
    for items, kind, gain in ((spec["labels"], "ping", .5), (spec["big"], "boom", .5),
                              ([spec["tag"]] if spec["tag"] else [], "whoosh", .16)):
        cues.extend((kind, item["from"], gain) for item in items)
    counter = spec["counter"]
    if counter:
        if anchors is None or counter["value"] not in anchors.value_names:
            raise anchors_file.AnchorsError("anchors.json: missing counter value " + counter["value"])
        start, end = counter["from"], counter["to"]
        if math.ceil(end * fps) > 216000:
            raise ValueError("counter exceeds 216000 frame budget")
        times = [start] + [f / fps for f in range(math.floor(start * fps) + 1, math.ceil(end * fps))] + [end]
        values = [anchors.value(math.floor(t * fps), counter["value"]) for t in times]
        low, high = min(values), max(values)
        scale = max(abs(low), abs(high)) or 1
        def pitch(v):
            return 660.0 if high == low else 440.0 + ((v/scale-low/scale)/(high/scale-low/scale))*440.0
        freqs = [(t-start, pitch(v)) for t, v in zip(times, values)]
        cues.append(("tone", start, 1, {"f0": freqs[0][1], "f1": freqs[-1][1],
                                       "d": end-start, "freqs": freqs}))
    return sorted(cues, key=lambda event: event[1])


MAX_BLOCKING_REPORTED = 20


class OverlayLayoutBlocked(media.MediaError):
    """The validated overlay has blocking full-frame layout findings; nothing was encoded.

    `blocking` is a bounded copy of the findings (code, element ids, frame range) and `total` their real count.
    """

    def __init__(self, blocking):
        self.blocking = [
            {"code": str(item.get("code", ""))[:40], "elements": [str(e)[:40] for e in item.get("elements", [])][:4],
             "first_frame": item.get("first_frame"), "last_frame": item.get("last_frame"), "frames": item.get("frames")}
            for item in list(blocking)[:MAX_BLOCKING_REPORTED] if isinstance(item, dict)]
        self.total = len(blocking)
        super().__init__("overlay_layout_blocked")


def check_layout(frames, words, spec, marks, job, *, fps, lead):
    """Run the overlay layout check on every frame, without drawing, before any audio premix or encode (about 0.2 s for 1,469 frames).

    It builds the same Overlay run.finish builds (same captions track, same frame count) and raises OverlayLayoutBlocked on a blocking
    finding. run.finish is not changed: it keeps its own check and its ok-false report for every other caller.
    """
    files = run._frames(frames)
    with run.open_frame(files[0]) as first:
        width, height = first.width, first.height
    _, word_list = captions.load_words(media.input_file(words))
    track = captions.Track(word_list, width, height, lead=lead)
    parsed = overlay.load_spec(spec, video_seconds=len(files) / fps, job_root=job)
    if marks is not None:
        anchors = anchors_file.load(marks, len(files), job_root=job)
    elif any(overlay.names_used(parsed).values()):
        raise media.MediaError("overlay.json names anchors or running numbers but anchors.json is missing")
    else:
        anchors = anchors_file.Anchors.empty(width, height)
    report = overlay.Overlay(parsed, anchors, width, height, captions_track=track, fps=fps, nframes=len(files)).layout_report()
    if not report["ok"]:
        raise OverlayLayoutBlocked(report.get("blocking", []))


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
    if spec.exists():
        # Before the audio premix and the encode: a blocking layout is refused here, by name, in a fraction of a second.
        try:
            check_layout(frames, words, spec, overlay_args["anchors"], job, fps=fps, lead=lead)
        except OverlayLayoutBlocked as error:
            # A named refusal, not a bare failure: the report says why, and the frames stay for a post-only retry with a corrected overlay.
            failed = {"version": "codebuilt-cb5-v1", "status": "failed", "error": {
                "code": "overlay_layout_blocked", "message": "overlay layout has blocking findings",
                "blocking": error.blocking, "blocking_total": error.total}}
            paths["report.json"].write_text(json.dumps(failed, indent=2), encoding="utf-8")
            raise
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
    mix_args = {}
    if spec.exists():
        # Reject bad clocks before division or any frame-scaled work.
        overlay_cues({"labels": [], "big": [], "tag": None, "counter": None}, None, duration, fps, lead)
        nframes = len(run._frames(frames))
        if nframes > 216000:
            raise ValueError("overlay audio exceeds 216000 frame budget")
        parsed_spec = overlay.load_spec(spec, nframes / fps, job_root=job)
        parsed_anchors = anchors_file.load(marks, nframes, job_root=job) if marks.exists() else None
        if any(overlay.names_used(parsed_spec).values()) and parsed_anchors is None:
            raise media.MediaError("anchors.json is missing for overlay audio")
        if parsed_anchors is not None:
            names = overlay.names_used(parsed_spec)
            missing = (names["points"] - parsed_anchors.point_names) | (names["values"] - parsed_anchors.value_names)
            if missing:
                raise media.MediaError("anchors.json: missing referenced names: " + ", ".join(sorted(missing)))
        # Overlay-only premix uses video time. Legacy synthesis/mux remain untouched.
        events = overlay_cues(parsed_spec, parsed_anchors, duration, fps, lead)
        word_events = [(e[0], e[1] + lead, *e[2:]) for e in word_events]
        word_events.extend(e for e in events if e[0] != "tone")
        duration = max(duration + lead, nframes / fps)
        music = np.pad(music, (int(round(lead * MIX_SR)), 0))
        tone = audio_kit.synth_effects([e for e in events if e[0] == "tone"], duration, sr=MIX_SR)
        mix_args = {"voice_offset_s": lead, "tone": (tone, MIX_SR)}
        overlay_args["audio_lead"] = 0.0
    effects = audio_kit.synth_effects(word_events, duration, sr=MIX_SR, seed=3)
    mixed = audio_kit.mix_stems((voice, sr), (music, MIX_SR), (effects, MIX_SR),
                                sr=MIX_SR, voice_peak=None, **mix_args)
    mixed.report["music_choice"] = choice
    audio_raw = out / "audio"
    if audio_raw.is_symlink() or audio_raw.is_junction():
        raise media.MediaError("audio output must not be a link")
    audio_out = media.inside(out, audio_raw)
    for name in ("cb5-mix.wav", "cb5-voice.wav", "cb5-music.wav", "cb5-effects.wav", "cb5-tone.wav", "cb5-levels.json"):
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
