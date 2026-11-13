"""Studio editor: timed scenes (Ken Burns stills, clips, title cards) + voice-over + burned-in captions -> 9:16 mp4."""

import hashlib
import json
import os
import shutil
import subprocess
import time
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

from assembler import VideoAssembler, get_audio_duration
from captions import build_ass
from loudness import audio_filter, tight_end_cap
from sfx import mix as mix_sfx
import music_sync
import look_grade
from logs import get_logger

log = get_logger("editor")

PROJECT_ROOT = Path(__file__).resolve().parent.parent  # the same root as pipeline.PROJECT_ROOT (pipeline imports this module, so it cannot be imported here)


def _sha256_file(path):
    if not Path(path).is_file():
        return None
    digest = hashlib.sha256()
    with open(path, "rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()

class Laps:
    """KAN-409: wall seconds between consecutive marks, by substep name (timings_detail). Off, every call does nothing.
    The marks tile the run, so their sum is the run's total_s less the gap after the last mark."""
    def __init__(self, on=False):
        self.on = bool(on)
        self.out = {}
        self.start = self.last = time.perf_counter()

    def mark(self, key):
        """Adds the seconds since the previous mark to out[key]; returns them."""
        if not self.on:
            return 0.0
        now = time.perf_counter()
        spent, self.last = now - self.last, now
        self.out[key] = self.out.get(key, 0.0) + spent
        return spent

    def note(self, key, value):
        if self.on:
            self.out[key] = value

    def note_model(self, engine):
        """Cold or warm start: only engines that keep a `_model` (Qwen3) know whether it was already loaded."""
        if self.on and hasattr(engine, "_model"):
            self.out["tts_model_loaded_before"] = engine._model is not None

    def finish(self):
        self.out["total_s"] = time.perf_counter() - self.start
        return self.out


MOTIONS = {"zoom_in": 0, "zoom_out": 1, "pan_right": 2, "pan_left": 3}
CUT_LEAD = 0.1  # seconds a cut lands before the next line (editors cut in the pause, not on the word)
FADE_DURATION = 0.25  # seconds for take-transition dip to black (0.25s out + 0.25s in)
HARDCUT_PUNCH_FRAMES = 2  # viral_v1: a 2-frame zoom punch (~50 ms at 24 fps) snaps the cut, no dip to black
CARD_FONT = "/usr/share/fonts/opentype/montserrat/Montserrat-ExtraBold.otf"
COVER_SECONDS = 0.5  # cover.jpg: the hook title frame, title still on screen

PRESCHOOL_SCENE_SECONDS = 3.5  # one preschool scene: one Wan clip, exactly 84 frames at 24 fps
PRESCHOOL_COVER_SECONDS = 1.0  # the preschool cover: 1.0 s into the FIRST scene, with no text on it
COVER_B_SECONDS = 2.5  # cover_B.jpg: mid-hook, after the 1.5 s title clears and the frame differs


def nobed_path(output_path):
    """KAN-610: the voice-only sibling of an output, named from that output (video.mp4 -> video_nobed.mp4), so two outputs in one folder never share it."""
    p = Path(output_path)
    return p.with_name(f"{p.stem}_nobed{p.suffix}")


def bed_plan(sfx_v2, music_bed_v1, sync):
    """KAN-610: (on, reason). The bed is on only when asked, under sfx_v2, and no music_sync mix already owns the audio; a refused request says why."""
    if not music_bed_v1:
        return False, None
    if not sfx_v2:
        return False, "needs sfx_v2"
    if sync:
        return False, "music_sync_v1 owns the audio"
    return True, None


def hero_splice_cmd(ffmpeg_exe, base, hero, start_frame, frames, total_frames, w, h, fps, out):
    """KAN-730: the ffmpeg argv (never run here) that lays `hero` over base frames [start_frame, start_frame + frames) and keeps
    the rest of `base`: head + hero + tail joined, picture only (-an, no audio input), exactly total_frames long, `out` last."""
    fit = f"scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h},setsar=1,fps={fps}"
    end = start_frame + frames
    cut = lambda a, b: f"trim=start_frame={a}:end_frame={b},setpts=PTS-STARTPTS"
    spans = [(label, a, b) for label, a, b in (("head", 0, start_frame), ("tail", end, total_frames)) if b > a]
    base_in = f"[0:v]{fit},tpad=stop_mode=clone:stop_duration={total_frames / fps + 1:.3f}"  # a short base holds its last frame, as render_scene does
    graph = []
    if len(spans) == 2:
        graph.append(f"{base_in},split=2[b0][b1]")
        graph += [f"[b{k}]{cut(a, b)}[{label}]" for k, (label, a, b) in enumerate(spans)]
    elif spans:
        label, a, b = spans[0]
        graph.append(f"{base_in},{cut(a, b)}[{label}]")
    graph.append(f"[1:v]{fit},tpad=stop_mode=clone:stop_duration={frames / fps + 1:.3f},{cut(0, frames)}[hero]")
    order = [f"[{label}]" for label, _, _ in spans if label == "head"] + ["[hero]"] + [f"[{label}]" for label, _, _ in spans if label == "tail"]
    graph.append(f"{''.join(order)}concat=n={len(order)}:v=1:a=0[v]")
    return [ffmpeg_exe, "-y", "-loglevel", "error", "-i", str(base), "-i", str(hero), "-filter_complex", ";".join(graph),
            "-map", "[v]", "-an", "-frames:v", str(total_frames), str(out)]


def valid_hero(scene, n):
    """KAN-730: (resolved file, start_frame, frames) when a clip scene carries a usable hero for its n frames, else None.
    The file must exist inside the repo output/ or data/ folder (the server's music_path check); the frame counts are plain ints."""
    hero = scene.get("hero") if scene["kind"] == "clip" else None
    if not isinstance(hero, dict):
        return None
    file, start, count = hero.get("file"), hero.get("start_frame"), hero.get("frames")
    if (not isinstance(file, str) or not file.strip()
            or not all(isinstance(v, int) and not isinstance(v, bool) for v in (start, count))
            or start < 0 or count < 1 or start + count > n):
        return None
    r = Path(os.path.realpath(file))
    if not r.is_file() or not any(r.is_relative_to(os.path.realpath(PROJECT_ROOT / d)) for d in ("output", "data")):
        return None
    return str(r), start, count


def make_card(text: str, path, width: int = 768, height: int = 1344) -> str:
    """Dark title card with the scene's words; stands in when an image render fails."""
    img = Image.new("RGB", (width, height), (14, 13, 12))
    draw = ImageDraw.Draw(img)
    try:
        font = ImageFont.truetype(CARD_FONT, 56)
    except OSError:
        font = ImageFont.load_default()
    lines, line = [], ""
    for word in text.split():
        trial = f"{line} {word}".strip()
        if draw.textlength(trial, font=font) > width * 0.8 and line:
            lines.append(line)
            line = word
        else:
            line = trial
    lines.append(line)
    y = height / 2 - len(lines) * 36
    for ln in lines:
        draw.text(((width - draw.textlength(ln, font=font)) / 2, y), ln, font=font, fill=(237, 233, 227))
        y += 72
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    img.save(path)
    return str(path)


class StudioEditor:
    def __init__(self, assembler: VideoAssembler | None = None):
        self.asm = assembler or VideoAssembler()

    def scene_frames(self, scenes, audio_duration, cut_fn=None, cut_frames=None):
        """
        Scenes tile the whole audio. Each cut lands CUT_LEAD seconds before the next line starts, inside the
        pause, so the new picture is already up when the voice comes in (never before the previous line ends).
        Frame counts come from cumulative boundaries: no drift.
        """
        fps = self.asm.fps
        if cut_frames is not None:  # KAN-603 cue_table_v1: the cut frames were rounded once from absolute times upstream; they are used as given
            marks = [0] + list(cut_frames) + [round(audio_duration * fps)]
            return [max(1, b - a) for a, b in zip(marks, marks[1:])]
        cuts = [max(prev.get("end", 0.0), s["start"] - CUT_LEAD) for prev, s in zip(scenes, scenes[1:])]
        if cut_fn:  # music_sync_v1: float seconds in, float seconds out; frames are still rounded once, below
            cuts = cut_fn(cuts)
        bounds = [0.0] + cuts + [audio_duration]
        marks = [round(b * fps) for b in bounds]
        return [max(1, b - a) for a, b in zip(marks, marks[1:])]

    def _run(self, cmd, video_args, tail, what, cwd=None):
        """Run ffmpeg with the preferred codec; on failure retry with libx264 and raise with ffmpeg's stderr."""
        log.debug(" ".join(map(str, [*cmd, *video_args, *tail])))
        res = subprocess.run([*cmd, *video_args, *tail], cwd=cwd, capture_output=True, text=True)
        if res.returncode == 0:
            return
        log.warning(f"ffmpeg {what} failed with {self.asm.video_codec}, retrying with libx264 (CPU): {res.stderr.strip()[-300:]}")
        res = subprocess.run([*cmd, "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p", *tail],
                             cwd=cwd, capture_output=True, text=True)  # NVENC unavailable or busy -> CPU
        if res.returncode != 0:
            raise RuntimeError(f"ffmpeg {what} failed: {res.stderr[-500:]}")

    def _splice_hero(self, scene, hero, n, out_path):
        """KAN-730: the scene's clip with the hero frames laid over it, or None (logged) when the splice fails: the take is never lost."""
        file, start, count = hero
        cmd = hero_splice_cmd(self.asm.ffmpeg_exe, scene["file"], file, start, count, n, self.asm.width, self.asm.height, self.asm.fps, out_path)
        try:
            self._run(cmd[:-1], ["-c:v", self.asm.video_codec, *self.asm.intermediate_opts, "-pix_fmt", "yuv420p"], cmd[-1:], "hero splice")
        except Exception as exc:
            log.warning(f"Hero splice failed, keeping the base clip: {exc}")
            return None
        return out_path

    def _encode(self, args, out_path, final=True):
        opts = self.asm.codec_opts if final else self.asm.intermediate_opts
        self._run([self.asm.ffmpeg_exe, "-y", "-loglevel", "error", *args],
                  ["-c:v", self.asm.video_codec, *opts, "-pix_fmt", "yuv420p"], [str(out_path)], "scene encode")

    def _build_fade_filters(self, frames, fps, fade_in, fade_out):
        if not fade_in and not fade_out:
            return []
        fades = []
        fade_frames = max(1, round(FADE_DURATION * fps))
        if fade_in and fade_out:
            fade_in_len = min(fade_frames, frames // 2)
            fade_out_len = min(fade_frames, frames // 2)
        else:
            fade_in_len = min(fade_frames, frames)
            fade_out_len = min(fade_frames, frames)
        if fade_in and fade_in_len > 0:
            fades.append(f"fade=t=in:s=0:n={fade_in_len}")
        if fade_out and fade_out_len > 0:
            s = frames - fade_out_len
            n = max(1, fade_out_len - 1)
            fades.append(f"fade=t=out:s={s}:n={n}")
        return fades

    def render_scene(self, scene, index, frames, out_path, final=True, fade_in=False, fade_out=False, hard_cuts=False):
        w, h, fps = self.asm.width, self.asm.height, self.asm.fps
        if hard_cuts:  # viral_v1: the scene 'fade' flag still loads, it just no longer dips to black
            fade_in = fade_out = False
        else:
            fade_in = fade_in or bool(scene.get("fade"))
            fade_out = fade_out or bool(scene.get("fade_out"))
        if scene["kind"] == "clip":
            vf = (f"scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h},fps={fps},"
                  f"tpad=stop_mode=clone:stop_duration={frames / fps + 1:.3f}")
            fades = self._build_fade_filters(frames, fps, fade_in, fade_out)
            if fades:
                vf = f"{vf}," + ",".join(fades)
            self._encode(["-i", scene["file"], "-vf", vf, "-frames:v", str(frames), "-an"], out_path, final)
            return
        source = scene.get("file")
        if scene["kind"] == "card" or not source:
            source = make_card(scene.get("text", ""), Path(out_path).with_suffix(".png"))
        # the Ken Burns builder sizes zoompan from a duration; -frames:v pins the exact count
        punch = {"punch_sec": HARDCUT_PUNCH_FRAMES / fps} if hard_cuts else {}
        vf, _ = self.asm._build_ken_burns_filter(MOTIONS.get(scene.get("motion"), index % 4),
                                                 max(frames / fps - 1e-6, 1 / fps), **punch)
        fades = self._build_fade_filters(frames, fps, fade_in, fade_out)
        if fades:
            vf = f"{vf}," + ",".join(fades)
        self._encode(["-i", source, "-vf", vf, "-frames:v", str(frames), "-an"], out_path, final)

    def edit(self, audio_path, scenes, words, captions, output_path, title=None, sfx=None, tight_end=False, style=None, stats=None, cover=False,
             music_path=None, music_sync_v1=False, captions_v2=False, titles=None, timings_detail=False, sfx_phrase_v1=False,
             look_v2=None, caption_tail_v1=False, label_windows=None, cut_frames=None, sfx_v2=False, cover_pick_v1=False,
             stat_cards=False, caption_style=None, captions_chunk3_v1=False, music_bed_v1=False, hero_pass_v1=False):
        grade_policy = look_grade.parse(look_v2)  # KAN-507: None when off; an invalid LUT path raises before any encoding
        laps = Laps(timings_detail)
        audio_path = str(Path(audio_path).resolve())
        output_path = Path(output_path).resolve()
        output_path.parent.mkdir(parents=True, exist_ok=True)
        duration = get_audio_duration(audio_path)
        laps.mark("audio_probe_s")
        hard_cuts = tight_end  # one viral_v1 switch: it caps the end and cuts hard instead of dipping to black
        has_ass = bool((captions and words) or (style == "viral_v1" and stats) or (stat_cards and stats))
        cap = tight_end_cap(words, duration) if tight_end else None
        sync = music_sync_v1 and music_path  # music follows the narration: cuts snap to the beat, music ducks under the voice
        frames = (self.scene_frames(scenes, duration, music_sync.cut_snapper(music_path, words, scenes, duration)) if sync
                  else self.scene_frames(scenes, duration, cut_frames=cut_frames) if cut_frames is not None else self.scene_frames(scenes, duration))
        laps.mark("cut_plan_s")
        kinds = {k: sum(1 for s in scenes if s["kind"] == k) for k in ("clip", "image", "card")}
        log.info(f"Editing {len(scenes)} scenes ({kinds['clip']} clips, {kinds['image']} images, {kinds['card']} title cards) "
                 f"over {duration:.1f}s of voice-over, captions {'on' if captions and words else 'off'}.")

        work = output_path.parent / f"_edit_{int(time.time() * 1000)}"
        work.mkdir(parents=True, exist_ok=True)
        try:
            parts = []
            each_scene = []
            hero_windows = []  # KAN-730: (start s, end s) of each spliced hero in the FINAL video
            for i, (scene, n) in enumerate(zip(scenes, frames)):
                part = work / f"scene_{i:03d}.mp4"
                log.info(f"Encoding scene {i + 1}/{len(scenes)} ({scene['kind']}, {n / self.asm.fps:.1f}s)...")
                fade_in = bool(scene.get("fade"))
                fade_out = i + 1 < len(scenes) and bool(scenes[i + 1].get("fade"))
                hero = valid_hero(scene, n) if hero_pass_v1 is True else None
                if hero and (spliced := self._splice_hero(scene, hero, n, work / f"scene_{i:03d}_hero.mp4")):
                    scene = {**scene, "file": str(spliced)}
                    first = sum(frames[:i]) + hero[1]
                    hero_windows.append((first / self.asm.fps, (first + hero[2]) / self.asm.fps))
                self.render_scene(scene, i, n, part, final=not (has_ass or grade_policy), fade_in=fade_in,
                                  fade_out=fade_out, hard_cuts=hard_cuts)
                parts.append(part)
                each_scene.append(laps.mark("scene_encode_total_s"))
            (work / "list.txt").write_text("".join(f"file '{p.as_posix()}'\n" for p in parts), encoding="utf-8")

            laps.mark("concat_list_s")
            laps.note("scene_encode_s", each_scene)

            if sfx:  # 3D cutaway videos: code-made effects under the voice; the voice file itself is untouched
                # KAN-456: the phrase switch is passed only when on, so flag-off calls to sfx.mix are exactly as before
                audio_path = mix_sfx(audio_path, sfx, work / "mix.wav", drone_fade=not tight_end, **({"sfx_phrase_v1": True} if sfx_phrase_v1 else {}),
                                     **({"sfx_v2": True} if sfx_v2 else {}))  # KAN-608: passed only when on
            laps.mark("sfx_mix_s")

            bed_on, bed_reason = bed_plan(sfx_v2, music_bed_v1, sync)  # KAN-610: optional, off by default; a refused request is logged, never dropped silently
            if bed_reason:
                log.warning(f"Music bed not mixed: {bed_reason}.")
                nobed_path(output_path).unlink(missing_ok=True)  # a refused bed leaves no second file from an earlier run
            if sync:
                audio_path = music_sync.mix_music_under_voice(audio_path, music_path, work / "music_mix.wav", words)
            elif bed_on:
                voice_only = audio_path  # the voice and sfx mix alone: video_nobed.mp4 is muxed from it
                payoff = min(duration, max((float(w["end"]) for w in words), default=duration))  # the swell ends at the last spoken word
                audio_path = music_sync.mix_bed_under_voice(audio_path, work / "bed_mix.wav", words, payoff)
            laps.mark("music_mix_s")

            loudness = audio_filter(self.asm.ffmpeg_exe, audio_path)
            laps.mark("loudness_s")
            captions_path = None
            args = ["-f", "concat", "-safe", "0", "-i", "list.txt", "-i", audio_path]
            if has_ass:
                video_end = duration if cap is None else cap
                (work / "captions.ass").write_text(build_ass(words if captions else [], self.asm.width, self.asm.height,
                                                               title if captions else None, style=style, stats=stats,
                                                               captions_v2=captions_v2, titles=titles if captions else None,
                                                               stat_cards=stat_cards, caption_style=caption_style,
                                                               captions_chunk3_v1=captions_chunk3_v1,
                                                               **({"caption_tail_v1": True, "tail_end": video_end, "suppress": label_windows or []}
                                                                  if caption_tail_v1 else {})), encoding="utf-8")
            # the grade comes first so captions are burned on top of it, never graded
            vf = ",".join([*(look_grade.filters(grade_policy, work) if grade_policy else []),
                           *(["subtitles=captions.ass"] if has_ass else [])])  # relative path: no drive-letter/colon escaping in the filter
            if vf:
                args += ["-vf", vf]
            laps.mark("captions_build_s")
            final = [self.asm.ffmpeg_exe, "-y", "-loglevel", "error", *args]
            if loudness:
                final += ["-af", loudness]
            cap_opts = ["-t", f"{cap:.3f}"] if cap is not None else []
            tail = [*cap_opts, "-c:a", "aac", "-b:a", self.asm.audio_bitrate, "-ar", "44100", "-shortest", "-movflags", "+faststart", str(output_path)]
            video = ["-c:v", self.asm.video_codec, *self.asm.codec_opts, "-pix_fmt", "yuv420p"] if vf else ["-c:v", "copy"]
            log.info("Final pass: joining scenes, voice-over" + (" and burning in captions..." if has_ass else "..."))
            self._run(final, video, tail, "final edit", cwd=work)
            laps.mark("final_pass_s")
            if bed_on:  # KAN-610: both mixes ship; the picture is copied and only the audio is re-muxed (no second video encode)
                nobed_out = nobed_path(output_path)
                # ponytail: the sibling is overwritten with -y like the main output; only a job whose own output is named <stem>_nobed<suffix> would collide
                nobed_loud = audio_filter(self.asm.ffmpeg_exe, voice_only)
                self._run([self.asm.ffmpeg_exe, "-y", "-loglevel", "error", "-i", str(output_path), "-i", voice_only,
                           *(["-af", nobed_loud] if nobed_loud else [])],
                          ["-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "aac", "-b:a", self.asm.audio_bitrate, "-ar", "44100",
                           "-shortest", "-movflags", "+faststart"], [str(nobed_out)], "nobed edit")
            captions_used = has_ass
            out_duration = duration if cap is None else cap
            if has_ass:
                captions_path = output_path.parent / "captions.ass"
                shutil.copyfile(work / "captions.ass", captions_path)
                captions_path = str(captions_path)
            laps.mark("captions_copy_s")
            want_cover = bool(title or cover)
            cover_file = self.save_cover(output_path) if want_cover and not cover_pick_v1 else None
            if cover_file:
                self.save_cover_variants(output_path)
            elif want_cover and cover_pick_v1:
                cover_file = self.save_cover_variants(output_path, cover_pick_v1=True, **({"hero_window": hero_windows} if hero_windows else {}))
            laps.mark("cover_s")
            log.info(f"Edit done: {out_duration:.1f}s video" + ("" if cover_file or not want_cover else " (cover.jpg failed)") + ".")
            caption_input_hashes = {
                "audio_sha256": _sha256_file(audio_path),
                "words_sha256": hashlib.sha256(json.dumps(words, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest(),
            }
            laps.mark("input_hash_s")
            result = {"video_path": str(output_path), "captions_path": captions_path, "captions_used": captions_used,
                      "caption_input_hashes": caption_input_hashes, "cover_path": cover_file, "duration": out_duration}
            if laps.on:
                result["timings_detail"] = laps.finish()
            return result
        finally:
            shutil.rmtree(work, ignore_errors=True)

    def edit_preschool(self, clips, audio_path, output_path, fps=24, cover=True, clip_seconds=PRESCHOOL_SCENE_SECONDS):
        """Preschool assembly (KAN-232): each scene trimmed to one fixed clip length, cover-scaled,
        hard-cut joined over a ready kids audio bed. No captions, no title card, no fades: the
        future viewers of these shorts can see but not read; cuts stay silent so the bed carries it."""
        output_path = Path(output_path).resolve()
        output_path.parent.mkdir(parents=True, exist_ok=True)
        if clip_seconds not in (3.5, 5.0, 7.5, 10.0):
            raise ValueError("clip_seconds must be 3.5, 5.0, 7.5 or 10.0")
        frames_per_scene = round(clip_seconds * fps)
        duration = frames_per_scene * len(clips) / fps
        w, h = self.asm.width, self.asm.height
        # Cover-scale (fill 9:16, centre-crop): preschool scenes never letterbox.
        vf = (f"scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h},"
              f"fps={fps},tpad=stop_mode=clone:stop_duration={frames_per_scene / fps + 1:.3f}")
        work = output_path.parent / f"_edit_{int(time.time() * 1000)}"
        work.mkdir(parents=True, exist_ok=True)
        try:
            parts = []
            for i, clip in enumerate(clips):
                part = work / f"scene_{i:03d}.mp4"
                self._encode(["-i", str(Path(clip)), "-vf", vf, "-frames:v", str(frames_per_scene), "-an"],
                             part, final=True)
                parts.append(part)
            (work / "list.txt").write_text("".join(f"file '{p.as_posix()}'\n" for p in parts), encoding="utf-8")
            final = [self.asm.ffmpeg_exe, "-y", "-loglevel", "error",
                     "-f", "concat", "-safe", "0", "-i", "list.txt", "-i", str(Path(audio_path))]
            tail = ["-c:a", "aac", "-b:a", self.asm.audio_bitrate, "-ar", "44100", "-shortest",
                    "-movflags", "+faststart", str(output_path)]
            self._run(final, ["-c:v", "copy"], tail, "preschool edit", cwd=work)
            cover_file = (self._grab_frame(output_path, output_path.parent / "cover.jpg", PRESCHOOL_COVER_SECONDS)
                          if cover else None)
            return {"video_path": str(output_path), "cover_path": cover_file, "duration": duration, "fps": fps}
        finally:
            shutil.rmtree(work, ignore_errors=True)

    def _grab_frame(self, video_path, frame_path, seconds):
        """One frame at `seconds` as a high-quality jpg; the same ffmpeg call for cover.jpg and its variants."""
        cmd = [self.asm.ffmpeg_exe, "-y", "-loglevel", "error", "-ss", str(seconds), "-i", str(video_path),
               "-frames:v", "1", "-q:v", "2", str(frame_path)]
        return str(frame_path) if subprocess.run(cmd, capture_output=True).returncode == 0 else None

    def save_cover(self, video_path):
        """cover.jpg from the title frame (0.5 s in), to pick as the Short's thumbnail. Best effort."""
        return self._grab_frame(video_path, Path(video_path).parent / "cover.jpg", COVER_SECONDS)

    def save_cover_variants(self, video_path, cover_pick_v1=False, hero_window=None):
        """cover_B.jpg (a mid-hook frame) + thumbnails.json beside cover.jpg, so the queue can offer both. Best effort."""
        folder = Path(video_path).parent
        scores = None
        if cover_pick_v1:
            samples = []
            for i in range(8):
                frame_path = folder / f"_cover_sample_{i}.jpg"
                if self._grab_frame(video_path, frame_path, 3.0 * i / 7):
                    try:
                        with Image.open(frame_path) as frame:
                            samples.append((self.score_cover_frame(frame), i, frame.copy()))
                    finally:
                        frame_path.unlink(missing_ok=True)
            if not samples:
                return self.save_cover(video_path)
            samples.sort(key=lambda row: (row[0], -row[1]), reverse=True)
            files = []
            for rank, (score, _, frame) in enumerate(samples[:2]):
                name = "cover.jpg" if rank == 0 else "cover_B.jpg"
                frame.convert("RGB").save(folder / name, quality=95)
                files.append(name)
            if "cover_B.jpg" not in files:
                (folder / "cover_B.jpg").unlink(missing_ok=True)
            scores = [{"sample": i, "score": round(score, 4)} for score, i, _ in sorted(samples, key=lambda row: row[1])]
            for row in scores:  # KAN-730: hero_window = [(start s, end s)]; a sample is a hero frame when its time falls inside one
                if any(a <= 3.0 * row["sample"] / 7 < b for a, b in hero_window or ()):
                    row["hero"] = True
            manifest = {"thumbnails": [{"variant": "A" if i == 0 else "B", "file": name}
                                        for i, name in enumerate(files)],
                        "selected": "A", "scores": scores}
            (folder / "thumbnails.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
            return str(folder / "cover.jpg")
        variant = self._grab_frame(video_path, folder / "cover_B.jpg", COVER_B_SECONDS)
        if not variant:
            log.warning("Thumbnail variant B failed; cover.jpg stays the only variant.")
            return None
        manifest = {"thumbnails": [{"variant": "A", "file": "cover.jpg"}, {"variant": "B", "file": "cover_B.jpg"}],
                    "selected": "A"}
        (folder / "thumbnails.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
        return str(folder / "thumbnails.json")


    @staticmethod
    def score_cover_frame(frame):
        """Score brightness and frame-only subject share; the border estimates the background."""
        import numpy as np
        grey = np.asarray(frame.convert("L"), dtype=np.float32)
        if grey.size == 0:
            return 0.0
        border = np.concatenate((grey[0], grey[-1], grey[:, 0], grey[:, -1]))
        subject_share = float((np.abs(grey - float(np.median(border))) > 18).mean())
        luma = float(grey.mean())
        brightness = max(0.0, min(1.0, luma / 100.0))
        return brightness * (0.6 + 0.4 * max(0.0, min(1.0, subject_share / 0.25)))

    def burn_captions(self, video_path, words, output_path, style=None):
        """Burns punch captions onto an assembled video, normalising its audio; captions.ass is kept beside the output."""
        video_path = str(Path(video_path).resolve())
        output_path = Path(output_path).resolve()
        output_path.parent.mkdir(parents=True, exist_ok=True)
        loudness = audio_filter(self.asm.ffmpeg_exe, video_path)
        work = output_path.parent / f"_captions_{int(time.time() * 1000)}"
        work.mkdir(parents=True, exist_ok=True)
        try:
            (work / "captions.ass").write_text(build_ass(words, self.asm.width, self.asm.height, style=style), encoding="utf-8")
            cmd = [self.asm.ffmpeg_exe, "-y", "-loglevel", "error", "-i", video_path, "-vf", "subtitles=captions.ass"]
            if loudness:
                cmd += ["-af", loudness]
            self._run(
                cmd,
                ["-c:v", self.asm.video_codec, *self.asm.codec_opts, "-pix_fmt", "yuv420p"],
                ["-c:a", "aac", "-b:a", self.asm.audio_bitrate, "-ar", "44100", "-movflags", "+faststart", str(output_path)],
                "caption burn",
                cwd=work,
            )
            shutil.copyfile(work / "captions.ass", output_path.parent / "captions.ass")
            return str(output_path)
        finally:
            shutil.rmtree(work, ignore_errors=True)

    def remux_voiceover(self, video_path, audio_path, output_path, words=None, captions=False, title=None, style=None):
        """
        Replaces voice-over audio on an existing video, aligning duration to the audio track.
        If video is shorter than audio, pads the last frame using tpad.
        If video is longer than audio, trims to shortest.
        Writes/updates captions.ass beside output_path if words are provided.
        """
        video_path = str(Path(video_path).resolve())
        audio_path = str(Path(audio_path).resolve())
        output_path = Path(output_path).resolve()
        output_path.parent.mkdir(parents=True, exist_ok=True)

        audio_dur = get_audio_duration(audio_path)
        video_dur = get_audio_duration(video_path)
        loudness = audio_filter(self.asm.ffmpeg_exe, audio_path)
        loud_af = ["-af", loudness] if loudness else []

        work = output_path.parent / f"_remux_{int(time.time() * 1000)}"
        work.mkdir(parents=True, exist_ok=True)
        temp_out = work / "remuxed.mp4"
        try:
            captions_path = None
            if captions and words:
                (work / "captions.ass").write_text(build_ass(words, self.asm.width, self.asm.height, title, style=style), encoding="utf-8")
                captions_path = output_path.parent / "captions.ass"
                shutil.copyfile(work / "captions.ass", captions_path)
                captions_path = str(captions_path)
            elif words:
                (output_path.parent / "captions.ass").write_text(build_ass(words, self.asm.width, self.asm.height, title, style=style), encoding="utf-8")
                captions_path = str(output_path.parent / "captions.ass")

            diff = audio_dur - video_dur
            if diff > 0.05:
                # Video is shorter than audio: hold the last frame to cover the audio
                pad_filter = f"[0:v:0]tpad=stop_mode=clone:stop_duration={diff + 0.1:.3f}[v]"
                filters = [pad_filter]
                v_map = "[v]"
                if captions and words:
                    filters.append(f"[{v_map}]subtitles=captions.ass[vcap]")
                    v_map = "[vcap]"
                filter_str = ";".join(filters)
                cmd = [self.asm.ffmpeg_exe, "-y", "-loglevel", "error", "-i", video_path, "-i", audio_path, "-filter_complex", filter_str, "-map", v_map, "-map", "1:a:0", *loud_af]
                video_opts = ["-c:v", self.asm.video_codec, *self.asm.codec_opts, "-pix_fmt", "yuv420p"]
                tail = ["-c:a", "aac", "-b:a", self.asm.audio_bitrate, "-ar", "44100", "-shortest", "-movflags", "+faststart", str(temp_out)]
                self._run(cmd, video_opts, tail, "remux voiceover with pad", cwd=work)
            elif captions and words:
                # Burn updated captions if explicitly requested
                cmd = [self.asm.ffmpeg_exe, "-y", "-loglevel", "error", "-i", video_path, "-i", audio_path, "-vf", "subtitles=captions.ass", "-map", "0:v:0", "-map", "1:a:0", *loud_af]
                video_opts = ["-c:v", self.asm.video_codec, *self.asm.codec_opts, "-pix_fmt", "yuv420p"]
                tail = ["-c:a", "aac", "-b:a", self.asm.audio_bitrate, "-ar", "44100", "-shortest", "-movflags", "+faststart", str(temp_out)]
                self._run(cmd, video_opts, tail, "remux voiceover with captions", cwd=work)
            else:
                # Fast remux: stream copy video, encode new audio, cut to shortest
                cmd = [
                    self.asm.ffmpeg_exe, "-y", "-loglevel", "error",
                    "-i", video_path,
                    "-i", audio_path,
                    "-map", "0:v:0", "-map", "1:a:0",
                    "-c:v", "copy",
                    "-c:a", "aac", "-b:a", self.asm.audio_bitrate, "-ar", "44100",
                    *loud_af,
                    "-shortest",
                    "-movflags", "+faststart",
                    str(temp_out)
                ]
                res = subprocess.run(cmd, capture_output=True, text=True, cwd=work)
                if res.returncode != 0:
                    log.warning(f"Fast stream copy failed ({res.stderr.strip()}); re-encoding video...")
                    cmd = [self.asm.ffmpeg_exe, "-y", "-loglevel", "error", "-i", video_path, "-i", audio_path, "-map", "0:v:0", "-map", "1:a:0", *loud_af]
                    video_opts = ["-c:v", self.asm.video_codec, *self.asm.codec_opts, "-pix_fmt", "yuv420p"]
                    tail = ["-c:a", "aac", "-b:a", self.asm.audio_bitrate, "-ar", "44100", "-shortest", "-movflags", "+faststart", str(temp_out)]
                    self._run(cmd, video_opts, tail, "remux voiceover reencode", cwd=work)

            shutil.move(str(temp_out), str(output_path))
            cover = self.save_cover(output_path) if title else None
            return {
                "video_path": str(output_path),
                "captions_path": captions_path,
                "cover_path": cover,
                "duration": audio_dur
            }
        finally:
            shutil.rmtree(work, ignore_errors=True)
