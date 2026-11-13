#!/usr/bin/env python3
"""
Narrative Shorts Pipeline (Standalone / Batch Runner)
Executes end-to-end generation:
Gemini / Claude Script -> Qwen3 TTS Voiceover -> ComfyUI Scene Frames -> FFmpeg NVENC Video Assemble
"""

import re
import time
import json
from pathlib import Path

from config import get_config
from script_generator import ScriptGenerator, script_from_text, mask_prompt
from tts_engine import get_tts_engine, resolve_voice, split_sentences, resolve_tts_seed
from comfy_client import ComfyClient
from assembler import VideoAssembler
from captions import build_ass
from editor import StudioEditor, Laps
from aligner import words_for_job
from logs import get_logger

log = get_logger("pipeline")

BASE_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = BASE_DIR.parent
DATA_DIR = PROJECT_ROOT / "data" / "narrative_shorts"


def slugify(text: str) -> str:
    text = text.lower().strip()
    text = re.sub(r"[^\w\s-]", "", text)
    text = re.sub(r"[\s_-]+", "_", text)
    return text[:40]


class NarrativeShortsPipeline:
    def __init__(self):
        self.cfg = get_config()
        self.script_gen = ScriptGenerator()
        self.tts = get_tts_engine()
        self.comfy = ComfyClient()
        self.assembler = VideoAssembler()

    def run(
        self,
        topic: str,
        custom_script: dict | None = None,
        skip_images: bool = False,
        voice: str | None = None,
        seconds: float = 60,
        captions: bool = True,
        instruct: str | None = None,
        style: str = "stickman",
        dynamic_tone: bool = True,
        psychology_rules: str | None = None,
        genre: str | None = None,
        seed: int | None = None,
        captions_v2: bool = False,
        music_sync_v1: bool = False,
        music_path: str | None = None,
        titles: list | None = None,
        timings_detail: bool = False,
        sfx_phrase_v1: bool = False,
        look_v2: dict | bool | None = None,
        sfx_v2: bool = False,
        music_bed_v1: bool = False,
    ) -> dict:
        laps = Laps(timings_detail)  # KAN-409: wall seconds per substep, returned as timings_detail when on
        active_seed = resolve_tts_seed(seed)
        t_start = time.time()
        timestamp = time.strftime("%Y%m%d_%H%M%S")
        slug = slugify(topic)
        job_id = f"{timestamp}_{slug}"

        job_dir = DATA_DIR / "runs" / job_id
        frames_dir = job_dir / "frames"
        job_dir.mkdir(parents=True, exist_ok=True)
        frames_dir.mkdir(parents=True, exist_ok=True)

        log.info(f"Starting narrative run {job_id}: \"{topic}\" ({seconds:g}s, style {style}, dynamic tone {'on' if dynamic_tone else 'off'}, captions {'on' if captions else 'off'})")
        log.debug(f"Run folder: {job_dir}")
        laps.mark("setup_s")

        # ---------------------------------------------------------
        # STEP 1: SCRIPTWRITING
        # ---------------------------------------------------------
        log.info("Step 1/4: script" + (" (your text, no Gemini call)" if custom_script else " (Gemini)"))
        script_file = job_dir / "script.json"
        script_data = custom_script or self.script_gen.generate_narrative(
            topic, seconds=seconds, style=style, psychology_rules=psychology_rules, genre=genre
        )
        
        with open(script_file, "w", encoding="utf-8") as f:
            json.dump(script_data, f, indent=2)
        
        full_text = script_data.get("full_script", "")
        scenes = script_data.get("scenes", [])
        log.info(f"Script \"{script_data.get('title')}\": {len(full_text.split())} words, {len(scenes)} scenes")
        log.debug(f"Script saved to {script_file}")
        laps.mark("script_s")

        # ---------------------------------------------------------
        # STEP 2: LOCAL TTS VOICEOVER (Qwen3 with Dynamic Story Arc)
        # ---------------------------------------------------------
        clean_voice = resolve_voice(voice)
        log.info(f"Step 2/4: voice-over with {get_tts_engine(clean_voice).get_model_info()['version']} ({clean_voice})")
        audio_file = job_dir / "voiceover.wav"

        # Check for deliveries in script_data scenes or direct via LLM
        deliveries = [sc.get("delivery", "") for sc in scenes if sc.get("delivery")]
        if not deliveries and custom_script:
            all_s = [s.strip() for sc in script_from_text(full_text, style=style)["scenes"] for s in split_sentences(sc["narration"])]
            try:
                deliveries = self.script_gen.direct_script_sentences(all_s, topic=topic, psychology_rules=psychology_rules, genre=genre)
            except Exception as e:
                log.warning(f"Failed to direct script via LLM: {e}. Using the story arc tones.")
        laps.mark("delivery_plan_s")

        # ~10s sentence groups, voiced sentence by sentence with punctuation-sized pauses; the sentence
        # spans give the word timings for captions
        segments = [sc["narration"] for sc in script_from_text(full_text, style=style)["scenes"]]
        laps.note_model(get_tts_engine(clean_voice))
        laps.mark("segment_split_s")
        audio_path, duration, _, sentences = get_tts_engine(clean_voice).generate_segments(
            segments, audio_file, voice=clean_voice, instruct=instruct, dynamic_tone=dynamic_tone,
            deliveries=deliveries or None, seed=active_seed
        )
        laps.mark("tts_s")
        if captions:
            sentence_texts = [s for s, _, _ in sentences]
            words, timing_source = words_for_job(
                audio_path, " ".join(sentence_texts), sentence_texts,
                [(a, b) for _, a, b in sentences], enabled=style == "viral_v1",
            )
            log.info(f"Word timings: {timing_source}")
        else:
            words = []
        laps.mark("align_s")
        log.info(f"Voice-over done: {duration:.1f}s, {len(sentences)} sentences" + (f", {len(deliveries)} voice-directed" if deliveries else ""))

        # ---------------------------------------------------------
        # STEP 3: COMFYUI ANCHOR FRAME GENERATION
        # ---------------------------------------------------------
        log.info(f"Step 3/4: {len(scenes)} scene frames")
        image_paths = []
        comfy_up = self.comfy.is_alive()
        placeholders = len(scenes) if skip_images or not comfy_up else 0
        
        if skip_images or not comfy_up:
            if not comfy_up:
                log.warning("ComfyUI is offline: every scene gets a placeholder frame instead of a generated image.")
            else:
                log.info("Skipping ComfyUI (skip_images): every scene gets a placeholder frame.")
            from comfy_client import generate_fallback_image
            for sc in scenes:
                sc_idx = sc.get("scene_number", len(image_paths) + 1)
                img_path = frames_dir / f"frame_{sc_idx:02d}.png"
                generate_fallback_image(sc.get("narration", topic), img_path, width=768, height=1344)
                image_paths.append(str(img_path))
        else:
            for sc in scenes:
                sc_idx = sc.get("scene_number", len(image_paths) + 1)
                img_path = frames_dir / f"frame_{sc_idx:02d}.png"
                prompt = sc.get("image_prompt", sc.get("narration", topic))
                log.info(f"Frame {sc_idx}/{len(scenes)}: rendering on ComfyUI")
                log.debug(f"Frame {sc_idx} prompt: {mask_prompt(prompt)}")
                try:
                    generated_img = self.comfy.generate_scene_image(prompt, img_path, width=768, height=1344)
                    image_paths.append(str(generated_img))
                except Exception as e:
                    log.warning(f"ComfyUI failed on frame {sc_idx}: {e}. Using a placeholder frame.")
                    placeholders += 1
                    from comfy_client import generate_fallback_image
                    generate_fallback_image(sc.get("narration", topic), img_path, width=768, height=1344)
                    image_paths.append(str(img_path))

        log.info(f"Frames ready: {len(image_paths) - placeholders} generated, {placeholders} placeholder(s)")
        laps.mark("frames_s")

        # ---------------------------------------------------------
        # STEP 4: VIDEO ASSEMBLY & CAPTIONING (NVENC)
        # ---------------------------------------------------------
        log.info("Step 4/4: editing the 9:16 video" + (" with captions" if captions and words else ""))
        video_output = job_dir / f"{slug}_short.mp4"

        # the editor rewrites this file; writing it here keeps the sidecar when the burn is skipped
        captions_path = None
        # flags default off: build_ass and edit then get no extra argument, output is unchanged
        titles = titles or script_data.get("titles")
        flags = {"captions_v2": True, "titles": titles} if captions_v2 else {}
        music = {"music_path": str(music_path), "music_sync_v1": True} if music_sync_v1 and music_path and Path(music_path).is_file() else {}
        if captions and words:
            try:
                ass_path = job_dir / "captions.ass"
                ass_path.write_text(build_ass(words, self.assembler.width, self.assembler.height, title=topic, **flags),
                                    encoding="utf-8")
                captions_path = str(ass_path)
                log.info(f"Captions: {len(words)} words -> {ass_path.name}")
            except Exception as e:
                log.error(f"Caption build failed ({e}); the video will have none.", exc_info=True)

        laps.mark("captions_build_s")
        step = duration / max(1, len(image_paths))
        edit_scenes = [{"kind": "image", "file": str(path), "start": i * step, "end": (i + 1) * step}
                       for i, path in enumerate(image_paths)]
        result = StudioEditor(self.assembler).edit(
            str(audio_file), edit_scenes, words, bool(captions and captions_path), str(video_output), title=topic, **flags, **music,
            **({"timings_detail": True} if timings_detail else {}),
            **({"sfx_phrase_v1": True} if sfx_phrase_v1 else {}),  # KAN-456: the narrative lane has no sfx cues, so this is inert here
            **({"sfx_v2": True} if sfx_v2 else {}),  # KAN-608: same, inert on this lane
            **({"music_bed_v1": True} if music_bed_v1 else {}),  # KAN-610: the editor mixes the bed only when sfx_v2 is on too
            **({"look_v2": look_v2} if look_v2 else {}),
        )
        final_video = result["video_path"]
        laps.mark("edit_s")
        laps.note("editor", result.get("timings_detail"))

        total_time = time.time() - t_start
        log.info(f"Run complete in {total_time:.1f}s: {duration:.1f}s video, {len(scenes)} scenes")
        log.debug(f"Output video: {final_video}")

        out = {
            "status": "success",
            "job_id": job_id,
            "duration": duration,
            "scenes_count": len(scenes),
            "video_path": str(final_video),
            "audio_path": str(audio_file),
            "seed": active_seed,
            "script": script_data,
            "elapsed_seconds": round(total_time, 2)
        }
        if laps.on:
            out["timings_detail"] = laps.finish()
        return out


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="ForgeAI Narrative Shorts Pipeline")
    parser.add_argument("--topic", type=str, default="The Lost Cosmonaut of 1961", help="Short topic/hook")
    parser.add_argument("--voice", type=str, default="ryan", help="Qwen voice (e.g. ryan, aiden, vivian)")
    parser.add_argument("--seconds", type=float, default=60, help="Target voiceover duration in seconds")
    parser.add_argument("--style", type=str, default="stickman", choices=["stickman", "cinematic"], help="Visual style")
    parser.add_argument("--instruct", type=str, default=None, help="Vocal style instruction")
    parser.add_argument("--skip-images", action="store_true", help="Bypass ComfyUI generation (use placeholder stills)")
    parser.add_argument("--no-captions", action="store_true", help="Disable burned-in subtitles")
    args = parser.parse_args()

    pipeline = NarrativeShortsPipeline()
    pipeline.run(
        topic=args.topic,
        voice=args.voice,
        seconds=args.seconds,
        style=args.style,
        instruct=args.instruct,
    )
