#!/usr/bin/env python3
"""
TTS for ForgeAI: Qwen3-TTS 1.7B CustomVoice (local, CUDA), with an optional style instruction (instruct).
Voices: "qwen:<speaker>" / plain "<speaker>" for Qwen's 9 built-in speakers.
Supports dynamic story arc tones and inline emotion tags ([whisper], [urgent], [curious], etc.).
"""

import gc
import hashlib
import io
import json
import os
import re
import threading
import time
from pathlib import Path
import numpy as np
import soundfile as sf

from config import get_config
from logs import get_logger
from story_tone import (
    compute_story_arc_tones,
    parse_inline_tags,
    TimedSentence,
)

DEFAULT_QWEN_MODEL = "Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice"
QWEN_SPEAKERS = ["aiden", "dylan", "eric", "ono_anna", "ryan", "serena", "sohee", "uncle_fu", "vivian"]
DEFAULT_SPEAKER = "ryan"
# Used when no style is given: without it Qwen acts out the script's drama (yelling, moaning).
DEFAULT_INSTRUCT = "calm, natural narrator speaking at a normal conversational level, clear and even, no exaggerated emotion"
# Default low temperature ensures steady narrator delivery and prevents theatrical melodrama/slowdown.
DEFAULT_TEMPERATURE = 0.65
DEFAULT_TTS_SEED = 0


# Delivery: every sentence is voiced on its own, trimmed, and followed by a pause sized by how it ends.
# Qwen's own pauses vary run to run; ours are exact, so cuts and captions can land in them.
PAUSES = (("...", 0.7), ("…", 0.7), ("?", 0.45), ("!", 0.3), ("—", 0.4), (":", 0.4), (".", 0.35))
DEFAULT_PAUSE = 0.25  # a sentence with no closing punctuation
HOOK_BEAT = 0.2  # extra beat after the opening line so the hook lands
CUT_BREATH = 0.15  # extra breath at scene boundaries, where the picture cuts
OUTRO_HOLD = 0.9  # silence after the last word, so the ending lands instead of cutting dead

# Pace gate (pace_gate_v1, default off): a sentence read outside the band is voiced again with the next attempt seed.
PACE_MIN_WPS, PACE_MAX_WPS, PACE_TARGET_WPS = 1.5, 4.2, 2.6  # words per second
PACE_HOOK_MAX_S = 3.0  # the opening line must land within this
PACE_TRIES = 3  # extra takes per sentence beyond the first
CODEC_FRAMES_PER_S = 12  # Qwen3-TTS-12Hz nominal frame rate; tokens per second to verify on the container

# One GPU, two tenants: ComfyUI and Qwen take turns. Requests come in on ThreadingHTTPServer threads.
_GPU_LOCK = threading.Lock()
log = get_logger("tts")


def derive_tts_seed(
    text: str,
    speaker: str,
    instruct: str = "",
    temperature: float = DEFAULT_TEMPERATURE,
    model_id: str = DEFAULT_QWEN_MODEL,
    base_seed: int | None = None,
    attempt: int = 0,
) -> int:
    """
    Derives a deterministic 32-bit integer seed from stable SHA-256 hash of:
    sentence/script text + speaker + instruct/style + temperature + model id.
    attempt > 0 is a pace-gate re-sample; attempt 0 is the seed it always was.
    """
    clean_text = (text or "").strip()
    clean_speaker = (speaker or "").strip().lower()
    clean_instruct = (instruct or "").strip()
    temp_str = f"{float(temperature):.4f}"
    clean_model = (model_id or "").strip()
    payload = f"{clean_text}::{clean_speaker}::{clean_instruct}::{temp_str}::{clean_model}"
    if base_seed is not None:
        payload += f"::base_seed={int(base_seed)}"
    if attempt:
        payload += f"::attempt={int(attempt)}"
    digest = hashlib.sha256(payload.encode("utf-8")).hexdigest()
    return int(digest[:8], 16)


def _pace_ok(words: int, seconds: float, hook: bool) -> bool:
    wps = words / seconds if seconds > 0 else 0.0
    return PACE_MIN_WPS <= wps <= PACE_MAX_WPS and not (hook and seconds > PACE_HOOK_MAX_S)


def _pace_key(words: int, seconds: float, hook: bool) -> tuple:
    """Sort key for takes: an over-long hook loses; otherwise the take nearest the target pace wins."""
    wps = words / seconds if seconds > 0 else 0.0
    return (hook and seconds > PACE_HOOK_MAX_S, abs(wps - PACE_TARGET_WPS))


def resolve_tts_seed(seed: int | None = None) -> int:
    """Resolve the request seed, legacy environment override, or stable default."""
    if seed is not None:
        try:
            return int(seed)
        except (ValueError, TypeError):
            pass
    if os.environ.get("TTS_SEED"):
        try:
            return int(os.environ["TTS_SEED"])
        except (ValueError, TypeError):
            pass
    return DEFAULT_TTS_SEED


def _free_comfy_vram():
    from comfy_client import ComfyClient
    return ComfyClient().free_vram()


def split_sentences(text: str) -> list[str]:
    return [s for s in re.split(r"(?<=[.!?…])\s+", " ".join(text.split())) if s]


def pause_after(sentence: str) -> float:
    """Silence (s) after a sentence: "..." is a dramatic beat, "?" lets the question land, "!" stays punchy."""
    end = sentence.rstrip("\"')”’")
    return next((pause for mark, pause in PAUSES if end.endswith(mark)), DEFAULT_PAUSE)


def trim_silence(samples: np.ndarray, rate: int, threshold: float = 0.01, pad: float = 0.03) -> np.ndarray:
    """Cut leading/trailing near-silence down to `pad` seconds so the pauses we add are the real ones."""
    loud = np.flatnonzero(np.abs(samples) > threshold)
    if not loud.size:
        return samples
    p = int(pad * rate)
    return samples[max(0, loud[0] - p): loud[-1] + p + 1]


def _smooth_edges(samples: np.ndarray, rate: int, ramp_ms: float = 5.0) -> np.ndarray:
    """Applies a smooth micro-fade to chunk boundaries to eliminate any DC offset pops."""
    ramp_len = int((ramp_ms / 1000.0) * rate)
    if len(samples) <= ramp_len * 2 or ramp_len <= 0:
        return samples
    ramp_in = 0.5 * (1.0 - np.cos(np.linspace(0, np.pi, ramp_len, dtype=np.float32)))
    ramp_out = 0.5 * (1.0 + np.cos(np.linspace(0, np.pi, ramp_len, dtype=np.float32)))
    out = samples.copy()
    out[:ramp_len] *= ramp_in
    out[-ramp_len:] *= ramp_out
    return out


def _normalize_audio(audio: np.ndarray, target_peak: float = 0.89) -> np.ndarray:
    """Normalizes audio to target peak to ensure consistent broadcast loudness."""
    max_val = float(np.max(np.abs(audio))) if audio.size else 0.0
    if max_val > 0.001:
        return audio * (target_peak / max_val)
    return audio


def resolve_voice(voice: str | None) -> str:
    """'qwen:Ryan' / 'Ryan' -> 'ryan'. Unknown ids (old 'af_heart', a removed clone voice) use the default."""
    raw = (voice or "").strip().lower()
    name = raw.removeprefix("qwen:")
    if name in QWEN_SPEAKERS:
        return name
    if name:
        log.warning(f"Unknown voice '{voice}', using '{DEFAULT_SPEAKER}'.")
    return DEFAULT_SPEAKER


class Qwen3Engine:
    def __init__(self, model_name: str | None = None):
        qwen_cfg = get_config().get("tts", {}).get("qwen3", {})
        self.model_name = model_name or qwen_cfg.get("model", DEFAULT_QWEN_MODEL)
        self.device = qwen_cfg.get("device", "cuda:0")
        self.dtype_str = qwen_cfg.get("dtype", "bfloat16")
        self.temperature = float(qwen_cfg.get("temperature", DEFAULT_TEMPERATURE))
        self._model = None
        self.before_load = _free_comfy_vram

    def _get_instance(self):
        if self._model is None:
            import torch
            from qwen_tts import Qwen3TTSModel

            dtype = getattr(torch, self.dtype_str, torch.bfloat16)
            device = self.device if torch.cuda.is_available() and "cuda" in self.device else "cpu"
            if device == "cpu":
                dtype = torch.float32
                log.warning(f"CUDA unavailable: loading Qwen3-TTS on CPU, voice-overs will be very slow.")
            log.info(f"Loading Qwen3-TTS ({self.model_name}) on {device}...")
            started = time.time()
            self._model = Qwen3TTSModel.from_pretrained(self.model_name, device_map=device, dtype=dtype, attn_implementation="sdpa")
            log.info(f"Qwen3-TTS loaded in {time.time() - started:.1f}s.")
        return self._model

    def unload(self):
        """Drop the model from VRAM so ComfyUI gets the whole card back. Reloads from disk cache next call."""
        if self._model is not None:
            log.debug("Unloading Qwen3-TTS to give ComfyUI the VRAM back.")
        self._model = None
        gc.collect()
        try:
            import torch
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        except ImportError:
            pass
        try:
            # glibc keeps freed load buffers in its heap; hand them back so the idle container shrinks
            import ctypes
            ctypes.CDLL("libc.so.6").malloc_trim(0)
        except OSError:
            pass

    def get_available_voices(self) -> list[str]:
        return QWEN_SPEAKERS

    def get_model_info(self) -> dict:
        """Metadata on the active model, its parameter count/version, and instruction-following capability."""
        is_0b6 = "0.6B" in self.model_name or "0b6" in self.model_name
        version_label = "0.6B-CustomVoice" if is_0b6 else ("1.7B-CustomVoice" if "1.7B" in self.model_name or "1b7" in self.model_name else self.model_name)
        return {
            "model_name": self.model_name,
            "version": version_label,
            "supports_instruct": not is_0b6,
            "device": self.device,
            "dtype": self.dtype_str,
        }

    def _call_generate(self, model, **kwargs):
        """Forward generation kwargs, falling back to basic args for test stubs lacking **kwargs."""
        try:
            return model.generate_custom_voice(**kwargs)
        except TypeError as e:
            if "unexpected keyword argument" in str(e):
                base_kwargs = {k: v for k, v in kwargs.items() if k in ("text", "language", "speaker", "instruct")}
                return model.generate_custom_voice(**base_kwargs)
            raise

    def generate_segments(self, texts, output_path, voice=None, instruct=None, dynamic_tone=None, deliveries=None, seed=None, pace_gate=False):
        """See _generate_segments. Frees ComfyUI's VRAM first and unloads Qwen after, one request at a time."""
        if not _GPU_LOCK.acquire(blocking=False):
            log.info("Waiting for the GPU: another voice-over is running.")
            _GPU_LOCK.acquire()
        try:
            try:
                # free_vram returns False instead of raising when ComfyUI is offline (then it holds no VRAM anyway)
                log.debug("ComfyUI freed its VRAM." if self.before_load() else "ComfyUI did not free VRAM (offline?).")
            except Exception as e:
                log.warning(f"Could not free ComfyUI VRAM ({e}); Qwen3-TTS may run out of GPU memory.")
            try:
                return self._generate_segments(texts, output_path, voice=voice, instruct=instruct, dynamic_tone=dynamic_tone, deliveries=deliveries, seed=seed, pace_gate=pace_gate)
            finally:
                self.unload()
        finally:
            _GPU_LOCK.release()

    def _synthesize(self, flat, instructs, temperatures, speaker, sentence_seeds=None, explicit_seed=None, pace_gate=False):
        """Voice each sentence in an isolated RNG stream; returns (trimmed samples, sample rate)."""
        model = self._get_instance()
        rate = 24000
        voiced = []

        for idx, (sentence, sentence_instruct, temperature) in enumerate(zip(flat, instructs, temperatures)):
            sentence_seed = sentence_seeds[idx] if sentence_seeds else derive_tts_seed(
                sentence, speaker, sentence_instruct, temperature, self.model_name,
                base_seed=explicit_seed if explicit_seed is not None else DEFAULT_TTS_SEED,
            )
            log.info(f"TTS: sentence {idx + 1} of {len(flat)} (seed {sentence_seed})...")
            chunk_started = time.time()

            words_count = len(sentence.split())
            if pace_gate:  # twice the expected read: 2.6 words per second at 12 frames per second
                max_tokens = max(128, int(2 * words_count / PACE_TARGET_WPS * CODEC_FRAMES_PER_S))
            else:
                max_tokens = max(128, int(words_count * 40))
            import torch
            devices = list(range(torch.cuda.device_count())) if torch.cuda.is_available() else []
            with torch.random.fork_rng(devices=devices):
                torch.manual_seed(sentence_seed)
                if devices:
                    torch.cuda.manual_seed_all(sentence_seed)
                wavs, sample_rates = self._call_generate(
                    model,
                    text=[sentence],
                    language=["English"],
                    speaker=[speaker],
                    instruct=[sentence_instruct],
                    temperature=temperature,
                    subtalker_temperature=temperature,
                    max_new_tokens=max_tokens,
                )
            rate = sample_rates[0] if isinstance(sample_rates, (list, tuple)) else sample_rates
            log.debug(f"TTS sentence took {time.time() - chunk_started:.1f}s (max_new_tokens {max_tokens}, temp {temperature:.2f}).")

            wav = wavs[0] if isinstance(wavs, (list, tuple)) else wavs
            samples = wav.detach().cpu().numpy() if hasattr(wav, "detach") else np.array(wav)
            trimmed = trim_silence(samples.squeeze().astype(np.float32), rate)
            # Apply micro-fade smoothing to eliminate clicks.
            voiced.append(_smooth_edges(trimmed, rate))
        return voiced, rate

    def _pace_gate(self, flat, instructs, temperatures, speaker, voiced, rate, sentence_seeds, explicit_seed):
        """Voices again each sentence read outside the pace band; keeps the take nearest PACE_TARGET_WPS.
        Returns (voiced, sentence_seeds) with the seed of the kept take.
        ponytail: no atempo last resort (no ffmpeg in this module); a take still off pace is kept and logged, not stretched. Add atempo (<=1.12) if the logs show it."""
        voiced, seeds = list(voiced), list(sentence_seeds)
        for i, sentence in enumerate(flat):
            words, hook = len(sentence.split()), i == 0
            takes = [(voiced[i], seeds[i])]
            if not _pace_ok(words, len(voiced[i]) / rate, hook):
                for attempt in range(1, PACE_TRIES + 1):
                    seed = derive_tts_seed(sentence, speaker, instructs[i], temperatures[i], self.model_name,
                                           base_seed=explicit_seed, attempt=attempt)
                    retake, _ = self._synthesize([sentence], [instructs[i]], [temperatures[i]], speaker,
                                                 sentence_seeds=[seed], explicit_seed=explicit_seed, pace_gate=True)
                    takes.append((retake[0], seed))
            best, seed = min(takes, key=lambda take: _pace_key(words, len(take[0]) / rate, hook))
            if not _pace_ok(words, len(best) / rate, hook):
                log.warning(f"Sentence {i + 1} stays off pace after {PACE_TRIES} re-samples ({len(best) / rate:.2f}s for {words} words); not stretched.")
            voiced[i], seeds[i] = best, seed
        return voiced, seeds

    def _generate_segments(
        self,
        texts: list[str],
        output_path: Path | str,
        voice: str | None = None,
        instruct: str | list[str] | None = None,
        dynamic_tone: bool | None = None,
        deliveries: list[str] | None = None,
        seed: int | None = None,
        pace_gate: bool = False,
    ) -> tuple[str, float, list[tuple[float, float]], list[TimedSentence]]:
        """
        Voices sentences independently and joins them with punctuation-sized pauses.
        Dynamically adjusts voice tone: inline tags, then deliveries[i] (the planner's direction for texts[i],
        applied to each of its sentences), then the fixed story arc.
        Returns (path, total_seconds, spans, sentences): spans[i] is (start, end) of texts[i];
        sentences is [(sentence, start, end)] for caption timing.
        """
        output_path = Path(output_path).resolve()
        output_path.parent.mkdir(parents=True, exist_ok=True)
        speaker = resolve_voice(voice)

        # Resolve explicit seed from argument or env
        explicit_seed = resolve_tts_seed(seed)

        scene_parts = [split_sentences(text) or [text] for text in texts]
        flat_raw = [s for parts in scene_parts for s in parts]
        if deliveries and len(deliveries) == len(flat_raw):
            flat_dirs = deliveries
        else:
            flat_dirs = [(deliveries[i] if deliveries and i < len(deliveries) else None) for i, parts in enumerate(scene_parts) for _ in parts]

        has_tags = any(parse_inline_tags(s)[1] is not None for s in flat_raw)
        is_dynamic = bool(dynamic_tone is True or (dynamic_tone is None and (has_tags or any(flat_dirs))))

        if is_dynamic:
            tone_specs = compute_story_arc_tones(
                flat_raw,
                base_instruct=instruct if isinstance(instruct, str) else None,
                dynamic=True,
                directions=flat_dirs,
            )
            flat = [spec[0] for spec in tone_specs]
            instructs = [spec[1] for spec in tone_specs]
            temperatures = [spec[2] for spec in tone_specs]
        else:
            style = instruct if isinstance(instruct, str) and instruct else DEFAULT_INSTRUCT
            flat = [parse_inline_tags(s)[0] for s in flat_raw]
            instructs = [style] * len(flat)
            temperatures = [self.temperature] * len(flat)

        sentence_seeds = []
        for idx, (sent, inst, temp) in enumerate(zip(flat, instructs, temperatures)):
            s_seed = derive_tts_seed(sent, speaker, inst, temp, self.model_name, base_seed=explicit_seed)
            sentence_seeds.append(s_seed)

        primary_seed = explicit_seed

        log.info(f"Voicing {len(flat)} sentences in {len(texts)} scene(s) as {speaker} (seed {primary_seed}), "
                 + (f"dynamic tone ({sum(1 for d in flat_dirs if d)} directed by the planner/LLM, rest by story arc)" if is_dynamic else "steady tone"))
        for i, (sentence, tone, temp) in enumerate(zip(flat, instructs, temperatures), 1):
            log.debug(f"Sentence {i}/{len(flat)} [temp {temp:.2f}] tone \"{tone}\": {sentence}")

        clean_scene_parts = []
        spec_idx = 0
        for parts in scene_parts:
            clean_scene_parts.append(flat[spec_idx: spec_idx + len(parts)])
            spec_idx += len(parts)

        voiced, rate = self._synthesize(flat, instructs, temperatures, speaker, sentence_seeds=sentence_seeds, explicit_seed=explicit_seed, pace_gate=pace_gate)
        if pace_gate:
            voiced, sentence_seeds = self._pace_gate(flat, instructs, temperatures, speaker, voiced, rate, sentence_seeds, explicit_seed)

        pieces, spans, sentences, t, pause = [], [], [], 0.0, None
        voiced_idx = 0
        for parts in clean_scene_parts:
            scene_start = None
            for j, sentence in enumerate(parts):
                if pause is not None:
                    silence = np.zeros(int(round(pause * rate)), dtype=np.float32)
                    pieces.append(silence)
                    t += len(silence) / rate

                samples = voiced[voiced_idx]
                current_tone = instructs[voiced_idx] if voiced_idx < len(instructs) else ""
                sent_seed = sentence_seeds[voiced_idx] if voiced_idx < len(sentence_seeds) else primary_seed
                voiced_idx += 1

                duration = len(samples) / rate
                scene_start = t if scene_start is None else scene_start
                timed_item = TimedSentence(sentence, round(t, 3), round(t + duration, 3), tone=current_tone)
                timed_item.seed = sent_seed
                sentences.append(timed_item)
                pieces.append(samples)
                t += duration
                pause = pause_after(sentence) + (HOOK_BEAT if len(sentences) == 1 else 0) + (CUT_BREATH if j == len(parts) - 1 else 0)

            spans.append((round(scene_start, 3), round(t, 3)))

        # The last sentence was trimmed and its pause never played (pauses land before the next line).
        # editor.scene_frames tiles scenes to the full audio, so the closing picture holds over this.
        if pieces:
            pieces.append(np.zeros(int(round(OUTRO_HOLD * rate)), dtype=np.float32))
            t += OUTRO_HOLD

        full_audio = np.concatenate(pieces) if pieces else np.zeros(0, dtype=np.float32)
        # Apply peak loudness normalization
        normalized_audio = _normalize_audio(full_audio)
        sf.write(str(output_path), normalized_audio, rate)

        # Record tts.json output alongside audio for 8.x checks
        tts_json_path = output_path.parent / "tts.json"
        try:
            existing_data = {}
            if tts_json_path.exists():
                try:
                    existing_data = json.loads(tts_json_path.read_text(encoding="utf-8"))
                except Exception:
                    existing_data = {}
            existing_data.update({
                "duration": round(t, 3),
                "voice": speaker,
                "seed": primary_seed,
                "file": str(output_path),
                "scenes": [{"start": s, "end": e} for s, e in spans],
                "sentences": [
                    {
                        "text": s[0],
                        "start": s[1],
                        "end": s[2],
                        "tone": getattr(s, "tone", ""),
                        "seed": getattr(s, "seed", None),
                    }
                    for s in sentences
                ],
            })
            tts_json_path.write_text(json.dumps(existing_data, indent=2), encoding="utf-8")
        except Exception as e:
            log.warning(f"Could not write tts.json: {e}")

        log.info(f"Voice-over written: {t:.1f}s, {len(sentences)} sentences.")
        log.debug(f"Voice-over file: {output_path}")
        return str(output_path), round(t, 3), spans, sentences


_ENGINES: dict[type, Qwen3Engine] = {}


def get_tts_engine(voice: str | None = None) -> Qwen3Engine:
    """The shared Qwen3 engine. It loads per voice-over and is unloaded after (see generate_segments)."""
    cls = Qwen3Engine
    if cls not in _ENGINES:
        _ENGINES[cls] = cls()
    return _ENGINES[cls]
