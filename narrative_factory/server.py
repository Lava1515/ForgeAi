#!/usr/bin/env python3
"""
Narrative Factory Local Webhook & API Server
HTTP API for the dashboard (and n8n): the full narrative pipeline and the Studio's timed voice-over,
standalone voiceover generator, images and edit (Qwen3 TTS, ComfyUI, FFmpeg NVENC).
Default Port: 5050
Supports running locally or remotely (e.g. on a friend's GPU PC) with audio streaming, base64 transfer,
and customizable bind host/port.
"""

import argparse
import base64
import hmac
import hashlib
import json
import os
import time
import wave
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from pathlib import Path
from urllib.parse import urlparse, parse_qs, quote

import logs

from comfy_client import minimax_h3_enabled, MINIMAX_H3_DISABLED_MESSAGE
from pipeline import NarrativeShortsPipeline, DATA_DIR, PROJECT_ROOT
from script_generator import script_from_text
from aligner import align_words, words_for_job
from editor import StudioEditor, Laps, PRESCHOOL_SCENE_SECONDS
from sfx import build_kids_bed
from tts_engine import get_tts_engine, resolve_voice, split_sentences

PORT = 5050
HOST = os.environ.get("HOST", "127.0.0.1")  # bind wider only via --host / HOST env, and always set TTS_TOKEN then
log = logs.get_logger("server")

_pipeline = None


def _timed_words(file_path, sentences, style):
    sentence_texts = [sentence[0] for sentence in sentences]
    words, source = words_for_job(
        file_path, " ".join(sentence_texts), sentence_texts,
        [(sentence[1], sentence[2]) for sentence in sentences],
        enabled=style == "viral_v1",
    )
    log.info("Word timings: %s", source)
    return words


def _coverage(words, text, source):
    """Share of the script words that carry a real onset from alignment (0 when the timings are estimates)."""
    total = len(text.split())
    if source not in ("aligned", "manual_verified") or not total:
        return 0.0
    ok = sum(1 for w in words if isinstance(w.get("start"), (int, float)) and isinstance(w.get("end"), (int, float)) and w["end"] >= w["start"])
    return round(min(ok, total) / total, 4)


def _timed_words_result(file_path, sentences, style, align_required=False):
    """Return word timings with provenance tied to exact audio and narration bytes."""
    sentence_texts = [sentence[0] for sentence in sentences]
    text = " ".join(sentence_texts)
    words, source = words_for_job(
        file_path, text, sentence_texts,
        [(sentence[1], sentence[2]) for sentence in sentences],
        enabled=style == "viral_v1" or align_required,
        **({"strict": True} if align_required else {}),  # KAN-603: cue_table_v1 sends align_required; no silent estimate fallback
    )
    audio_hash = hashlib.sha256(Path(file_path).read_bytes()).hexdigest()
    text_hash = hashlib.sha256(text.encode("utf-8")).hexdigest()
    candidate = Path(str(file_path) + ".timing.json")
    if candidate.is_file():
        try:
            manifest = json.loads(candidate.read_text(encoding="utf-8"))
            if (manifest.get("reviewed") is True
                    and manifest.get("audio_sha256") == audio_hash
                    and manifest.get("timing_text_sha256") == text_hash
                    and isinstance(manifest.get("words"), list)):
                words, source = manifest["words"], "manual_verified"
        except (OSError, ValueError, TypeError):
            pass
    log.info("Word timings: %s", source)
    return {"words": words, "word_timing_source": source,
            "audio_sha256": audio_hash, "timing_text_sha256": text_hash,
            **({"word_timing_coverage": _coverage(words, text, source)} if align_required else {})}


# KAN-830: /api/align takes audio the caller already has (base64) and returns word timings for the given text.
ALIGN_MAX_AUDIO_BYTES = 100 * 1024 * 1024
ALIGN_MAX_B64_CHARS = 4 * ((ALIGN_MAX_AUDIO_BYTES + 2) // 3)
ALIGN_MAX_TEXT_CHARS = 200_000
ALIGN_MAX_BODY_BYTES = ALIGN_MAX_B64_CHARS + 2 * ALIGN_MAX_TEXT_CHARS + 4096  # JSON overhead; a text char may take 6 bytes escaped
ALIGN_MAX_SECONDS = 600


def _align_request(body):
    """Returns (http status, json body). Messages are generic: no path, no exception text."""
    if not isinstance(body, dict):
        return 400, {"error": "Invalid request"}
    audio_b64, text, lang = body.get("audio_b64"), body.get("text"), body.get("lang")
    if not isinstance(audio_b64, str) or not audio_b64 or not isinstance(text, str) or not text.strip():
        return 400, {"error": "Provide 'audio_b64' and 'text'"}
    if lang is not None and lang != "en":
        return 400, {"error": "Unsupported language"}
    if len(text) > ALIGN_MAX_TEXT_CHARS:
        return 413, {"error": "Text is too large"}
    if len(audio_b64) > ALIGN_MAX_B64_CHARS:  # checked on the string, before anything is decoded
        return 413, {"error": "Audio is too large"}
    try:
        audio = base64.b64decode(audio_b64, validate=True)
    except Exception:
        return 400, {"error": "Audio could not be read"}
    if len(audio) > ALIGN_MAX_AUDIO_BYTES:
        return 413, {"error": "Audio is too large"}
    run_dir = DATA_DIR / "runs" / f"align_{time.time_ns()}_{os.getpid()}"
    wav_path = run_dir / "audio.wav"
    try:
        run_dir.mkdir(parents=True, exist_ok=False)
        wav_path.write_bytes(audio)
        try:
            with wave.open(str(wav_path), "rb") as probe:
                seconds = probe.getnframes() / probe.getframerate()
        except Exception:
            return 400, {"error": "Audio could not be read"}
        if seconds > ALIGN_MAX_SECONDS:
            return 400, {"error": "Audio is too long"}
        try:
            words = align_words(str(wav_path), text)
        except Exception:
            log.exception("align failed")
            return 422, {"error": "Alignment failed"}
        return 200, {
            "status": "success", "words": words, "word_timing_source": "aligned",
            "audio_sha256": hashlib.sha256(audio).hexdigest(),
            "timing_text_sha256": hashlib.sha256(text.encode("utf-8")).hexdigest(),
            "word_timing_coverage": _coverage(words, text, "aligned"),
            "duration": round(seconds, 3),
        }
    except Exception:
        log.exception("align request failed")
        return 500, {"error": "Alignment failed"}
    finally:
        try:
            wav_path.unlink()
            run_dir.rmdir()
        except OSError:
            pass


def get_engines():
    global _pipeline
    if _pipeline is None:
        _pipeline = NarrativeShortsPipeline()
    p = _pipeline
    return p, p.tts, p.comfy, p.assembler, p.script_gen


def _sanitize_output_path(output_path: str | None, run_id: str, default_filename: str = "voiceover.wav") -> str:
    """Ensure output directory is writable on this machine; fallback to DATA_DIR/runs if remote/inaccessible."""
    if output_path:
        try:
            p = Path(output_path)
            p.parent.mkdir(parents=True, exist_ok=True)
            return str(p)
        except Exception as e:
            log.warning(f"Inaccessible or foreign output_path '{output_path}': {e}. Using server DATA_DIR.")

    run_dir = DATA_DIR / "runs" / run_id
    run_dir.mkdir(parents=True, exist_ok=True)
    return str(run_dir / default_filename)


def _inside_data_dir(p) -> Path | None:
    """Resolved path if it lies inside DATA_DIR, else None."""
    r = Path(os.path.realpath(p))
    return r if r.is_relative_to(os.path.realpath(DATA_DIR)) else None


def _inside_project_data(p) -> Path | None:
    """Resolved path if it lies anywhere under the shared project data directory."""
    r = Path(os.path.realpath(p))
    data_root = PROJECT_ROOT / "data"
    return r if r.is_relative_to(os.path.realpath(data_root)) else None


def _valid_cut_frames(cuts, n_scenes):
    """KAN-603: one ascending whole-frame cut per scene boundary, or the editor keeps its own cuts."""
    return (isinstance(cuts, list) and len(cuts) == n_scenes - 1
            and all(isinstance(c, int) and not isinstance(c, bool) and c > 0 for c in cuts)
            and all(a < b for a, b in zip(cuts, cuts[1:])))


def _render_flags(body: dict):
    """KAN-398: optional captions_v2 / music_sync_v1 / sfx_phrase_v1 / sfx_v2 (exactly true), titles ([{text, start}]) and music_path from a request body.
    Returns (kwargs, error). Absent or malformed values are left out, so a plain request calls the editor as before;
    a music_path must be a file inside the repo's output/ or data/ folder (the bed is never picked automatically)."""
    out = {}
    if body.get("caption_style") == "box_sentence":
        out["caption_style"] = "box_sentence"
    for key in ("captions_v2", "caption_tail_v1", "captions_chunk3_v1", "music_sync_v1", "sfx_phrase_v1", "sfx_v2", "music_bed_v1", "timings_detail", "cover_pick_v1", "stat_cards", "hero_pass_v1"):  # timings_detail (KAN-409): adds a timings_detail key to the reply
        if body.get(key) is True:
            out[key] = True
    titles = body.get("titles")
    if (isinstance(titles, list) and 0 < len(titles) <= 12 and all(
            isinstance(t, dict) and isinstance(t.get("text"), str) and t["text"].strip()
            and isinstance(t.get("start"), (int, float)) and not isinstance(t["start"], bool) and t["start"] >= 0 for t in titles)):
        out["titles"] = [{"text": t["text"], "start": t["start"]} for t in titles]
    music = body.get("music_path")
    if isinstance(music, str) and music.strip():
        r = Path(os.path.realpath(music))
        if not r.is_file() or not any(r.is_relative_to(os.path.realpath(PROJECT_ROOT / d)) for d in ("output", "data")):
            return {}, f"music_path must be an existing file inside the repo output/ or data/ folder: {music}"
        out["music_path"] = str(r)
    look = body.get("look_v2")
    if look is True:
        out["look_v2"] = True
    elif isinstance(look, dict) and look:
        unknown = set(look) - {"mood", "lut", "vignette", "grain", "grade"}
        if unknown:
            return {}, f"unknown keys in look_v2: {sorted(unknown)}"
        if "mood" in look:
            mood = look["mood"]
            if not isinstance(mood, str) or mood not in ("default", "punchy", "calm", "dramatic"):
                return {}, f"look_v2 mood must be one of default, punchy, calm, dramatic: {mood}"
        if "grain" in look:
            grain = look["grain"]
            if isinstance(grain, bool) or not isinstance(grain, int) or not 0 <= grain <= 3:
                return {}, f"look_v2 grain must be an integer 0..3: {grain}"
        if "vignette" in look:
            vignette = look["vignette"]
            if not isinstance(vignette, bool) and not (isinstance(vignette, (int, float)) and not isinstance(vignette, bool) and 0 <= vignette <= 1):
                return {}, f"look_v2 vignette must be a boolean or number in [0, 1]: {vignette}"
        lut = look.get("lut")
        if lut is not None:
            if not isinstance(lut, str) or not lut.strip():
                return {}, f"look_v2 lut must be a path: {lut}"
            if not lut.lower().endswith(".cube"):
                return {}, f"look_v2 lut must be a .cube file: {lut}"
            if "'" in lut:
                return {}, f"look_v2 lut path may not contain an apostrophe: {lut}"
            r = Path(os.path.realpath(lut))
            if not r.is_file() or not any(r.is_relative_to(os.path.realpath(PROJECT_ROOT / d)) for d in ("output", "data")):
                return {}, f"look_v2 lut must be an existing file inside the repo output/ or data/ folder: {lut}"
            look = {**look, "lut": str(r)}
        out["look_v2"] = look
    return out, None


def _stage_inputs(body: dict, temp_dir: Path):
    """Resolve video/audio inputs: base64 payloads are written under temp_dir; bare paths must be inside DATA_DIR.
    Returns (video_path, audio_path, error)."""
    out = []
    for key, name in (("video", "input_video.mp4"), ("audio", "input_audio.wav")):
        b64, given = body.get(f"{key}_base64"), body.get(f"{key}_path")
        if b64:
            temp_dir.mkdir(parents=True, exist_ok=True)
            f = temp_dir / name
            f.write_bytes(base64.b64decode(b64))
            out.append(str(f))
        elif given and not _inside_data_dir(given):
            return None, None, f"Path outside the data directory: {given}"
        else:
            out.append(given)
    return out[0], out[1], None


def _encode_audio_file(file_path: str):
    """Returns (audio_url, audio_base64) for an audio file."""
    p = Path(file_path)
    if not p.exists() or not p.is_file():
        return None, None
    try:
        data = p.read_bytes()
        b64 = base64.b64encode(data).decode("ascii")
        try:
            rel = os.path.relpath(str(p), str(DATA_DIR)).replace("\\", "/")
        except Exception:
            rel = p.name
        return f"/api/audio?file={quote(rel)}", b64
    except Exception as e:
        log.warning(f"Failed to read/encode audio '{file_path}': {e}")
        return None, None


class RequestHandler(BaseHTTPRequestHandler):
    def _send_json(self, data: dict, status_code: int = 200):
        body = json.dumps(data, indent=2).encode("utf-8")
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format, *args):
        # http.server's per-request access line; skip the dashboard's polling endpoints so they don't flood the log
        if not self.path.startswith(("/api/logs", "/status", "/health")):
            log.debug("%s %s", self.address_string(), format % args)

    def do_OPTIONS(self):
        self.send_response(204)  # no CORS: the dashboard calls the worker server-side
        self.end_headers()

    def _is_loopback(self) -> bool:
        """True if server is bound to loopback and caller client is loopback."""
        loopback_hosts = {"127.0.0.1", "localhost", "::1"}
        if HOST not in loopback_hosts:
            return False
        client_ip = self.client_address[0] if (hasattr(self, "client_address") and self.client_address) else "127.0.0.1"
        if client_ip.startswith("::ffff:"):
            client_ip = client_ip[7:]
        return client_ip in loopback_hosts

    def do_GET(self):
        if not self._is_loopback() and not self._authorized():
            return self._send_json({"error": "Unauthorized: send X-TTS-Token matching the worker's TTS_TOKEN"}, 401)
        url = urlparse(self.path)
        if url.path == "/api/logs":
            after = int((parse_qs(url.query).get("after") or ["0"])[0] or 0)
            return self._send_json(logs.since(after))

        if url.path == "/api/audio":
            query = parse_qs(url.query)
            req_file = (query.get("file") or query.get("path") or [""])[0]
            if not req_file:
                return self._send_json({"error": "Missing 'file' parameter"}, 400)

            # Confined to DATA_DIR (relative names or absolute paths inside it)
            target = _inside_data_dir(DATA_DIR / req_file)
            if not target or not target.is_file():
                return self._send_json({"error": f"Audio file not found: {req_file}"}, 404)

            try:
                audio_bytes = target.read_bytes()
                self.send_response(200)
                self.send_header("Content-Type", "audio/wav")
                self.send_header("Content-Length", str(len(audio_bytes)))
                self.end_headers()
                self.wfile.write(audio_bytes)
                return
            except Exception as e:
                log.exception(f"Error serving audio file: {e}")
                return self._send_json({"error": str(e)}, 500)

        if url.path == "/api/video":
            query = parse_qs(url.query)
            req_file = (query.get("file") or query.get("path") or [""])[0]
            if not req_file:
                return self._send_json({"error": "Missing 'file' parameter"}, 400)

            # Confined to DATA_DIR (relative names or absolute paths inside it)
            target = _inside_data_dir(DATA_DIR / req_file)
            if not target or not target.is_file():
                return self._send_json({"error": f"Video file not found: {req_file}"}, 404)

            try:
                video_bytes = target.read_bytes()
                self.send_response(200)
                self.send_header("Content-Type", "video/mp4")
                self.send_header("Content-Length", str(len(video_bytes)))
                self.end_headers()
                self.wfile.write(video_bytes)
                return
            except Exception as e:
                log.exception(f"Error serving video file: {e}")
                return self._send_json({"error": str(e)}, 500)

        if self.path in ["/", "/health", "/status"]:
            pipeline, tts, comfy, assembler, _ = get_engines()
            model_info = tts.get_model_info() if hasattr(tts, "get_model_info") else {}
            gpu_device_name = "CPU"
            cuda_available = False
            try:
                import torch
                cuda_available = torch.cuda.is_available()
                if cuda_available:
                    gpu_device_name = torch.cuda.get_device_name(0)
            except Exception:
                pass

            status_data = {
                "service": "Narrative Shorts Factory API",
                "status": "online",
                "port": PORT,
                "host": self.headers.get("Host", f"{HOST}:{PORT}"),
                "comfyui_online": comfy.is_alive(),
                "nvenc_accelerated": assembler.has_nvenc,
                "video_codec": assembler.video_codec,
                "tts_engine": "qwen3",
                "tts_model": model_info.get("model_name", getattr(tts, "model_name", "Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice")),
                "tts_version": model_info.get("version", "1.7B-CustomVoice"),
                "tts_instruct_supported": model_info.get("supports_instruct", True),
                "tts_device": model_info.get("device", "cuda:0" if cuda_available else "cpu"),
                "device_name": gpu_device_name,
                "cuda_available": cuda_available,
                "voices": tts.get_available_voices(),
            }
            self._send_json(status_data)
        else:
            self._send_json({"error": "Endpoint not found"}, status_code=404)

    def _authorized(self) -> bool:
        """Shared-secret check; fails closed when TTS_TOKEN is not configured."""
        token = os.environ.get("TTS_TOKEN", "")
        return bool(token) and hmac.compare_digest(self.headers.get("X-TTS-Token", ""), token)

    def do_POST(self):
        if not self._authorized():
            return self._send_json({"error": "Unauthorized: send X-TTS-Token matching the worker's TTS_TOKEN"}, 401)
        content_len = int(self.headers.get("Content-Length", 0))
        if self.path == "/api/align" and content_len > ALIGN_MAX_BODY_BYTES:  # KAN-830: refuse before reading the body
            return self._send_json({"error": "Audio is too large"}, 413)
        post_data = self.rfile.read(content_len).decode("utf-8")
        try:
            body = json.loads(post_data) if post_data else {}
        except Exception:
            body = {}

        if self.path == "/api/align":  # KAN-830: needs no engines, so it answers before get_engines()
            status, answer = _align_request(body)
            return self._send_json(answer, status)

        logs.run_id.set(body.get("run_id"))
        started = time.time()
        log.info("POST %s started", self.path)
        log.debug("POST %s body: %s", self.path, json.dumps({k: (v if len(str(v)) < 200 else f"{str(v)[:200]}... ({len(str(v))} chars)") for k, v in body.items()}))
        pipeline, tts, comfy, assembler, script_gen = get_engines()

        try:
            # 1. Run Full End-to-End Pipeline
            if self.path == "/api/run-pipeline":
                topic = body.get("topic")
                text = (body.get("script") or "").strip()
                if not topic and not text:
                    return self._send_json({"error": "Provide 'topic' or 'script' in request body"}, 400)
                custom = script_from_text(text, title=topic) if text else None
                flags, err = _render_flags(body)
                if err:
                    return self._send_json({"error": err}, 400)
                res = pipeline.run(
                    topic or custom["title"],
                    custom_script=custom,
                    voice=body.get("voice"),
                    skip_images=body.get("skip_images", False),
                    seconds=body.get("seconds", 60),
                    captions=bool(body.get("captions", True)),
                    instruct=body.get("instruct"),
                    style=body.get("style", "stickman"),
                    dynamic_tone=body.get("dynamic_tone", True),
                    psychology_rules=body.get("psychology_rules"),
                    genre=body.get("genre"),
                    seed=body.get("seed"),
                    **flags,
                )
                return self._send_json(res)

            # 2. Direct simple TTS
            elif self.path == "/api/tts":
                text = body.get("text")
                raw_out = body.get("output_path")
                if not text:
                    return self._send_json({"error": "Provide 'text'"}, 400)
                run_id = body.get("run_id") or f"tts_{int(time.time()*1000)}"
                output_path = _sanitize_output_path(raw_out, run_id)
                clean_voice = resolve_voice(body.get("voice"))
                tts = get_tts_engine(clean_voice)
                file_path, duration, spans, sentences = tts.generate_segments(
                    [text],
                    output_path,
                    voice=clean_voice,
                    instruct=body.get("instruct"),
                    dynamic_tone=body.get("dynamic_tone", False),
                    seed=body.get("seed"),
                )
                model_info = tts.get_model_info() if hasattr(tts, "get_model_info") else {}
                audio_url, audio_b64 = _encode_audio_file(file_path)
                active_seed = getattr(sentences[0], "seed", None) if sentences else body.get("seed")
                return self._send_json({
                    "status": "success",
                    "file": file_path,
                    "audio_url": audio_url,
                    "audio_base64": audio_b64,
                    "duration": duration,
                    "voice": clean_voice,
                    "seed": active_seed,
                    "model": model_info.get("version", "1.7B-CustomVoice"),
                    "model_name": model_info.get("model_name", "Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice"),
                    "scenes": [{"start": s, "end": e} for s, e in spans],
                    "sentences": [
                        {"text": s[0], "start": s[1], "end": s[2], "tone": getattr(s, "tone", ""), "seed": getattr(s, "seed", None)}
                        for s in sentences
                    ],
                    "words": _timed_words(file_path, sentences, body.get("style")),
                })

            # 3. Studio TTS: timed segments with word timings, story tone, and scene-boundary breaths
            elif self.path == "/api/tts-timed":
                scenes = body.get("scenes")
                if not isinstance(scenes, list) or not scenes or not all(isinstance(s, str) and s.strip() for s in scenes):
                    return self._send_json({"error": "Provide 'scenes' as a list of non-empty strings"}, 400)

                run_id = body.get("run_id") or f"tts_{int(time.time()*1000)}"
                output_path = _sanitize_output_path(body.get("output_path"), run_id)

                clean_voice = resolve_voice(body.get("voice"))
                dynamic_tone = body.get("dynamic_tone", True)
                deliveries = body.get("deliveries")
                deliveries = [str(d or "")[:200] for d in deliveries] if isinstance(deliveries, list) else None
                laps = Laps(body.get("timings_detail") is True)
                tts = get_tts_engine(clean_voice)
                laps.note_model(tts)  # only Qwen3 keeps its model between calls
                laps.mark("setup_s")
                file_path, duration, spans, sentences = tts.generate_segments(
                    scenes,
                    output_path,
                    voice=clean_voice,
                    instruct=body.get("instruct"),
                    dynamic_tone=dynamic_tone,
                    deliveries=deliveries,
                    seed=body.get("seed"),
                    pace_gate=body.get("pace_gate_v1") is True,  # KAN-591
                )
                laps.mark("tts_s")
                model_info = tts.get_model_info() if hasattr(tts, "get_model_info") else {}
                audio_url, audio_b64 = _encode_audio_file(file_path)
                laps.mark("audio_encode_s")
                active_seed = getattr(sentences[0], "seed", None) if sentences else body.get("seed")
                timed = (_timed_words_result(file_path, sentences, body.get("style"), align_required=body.get("align_required") is True) if body.get("timing_metadata") is True
                         else {"words": _timed_words(file_path, sentences, body.get("style"))})
                laps.mark("align_s")
                return self._send_json({
                    "status": "success",
                    "file": file_path,
                    "audio_url": audio_url,
                    "audio_base64": audio_b64,
                    "duration": duration,
                    "voice": clean_voice,
                    "seed": active_seed,
                    "model": model_info.get("version", "1.7B-CustomVoice"),
                    "model_name": model_info.get("model_name", "Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice"),
                    "scenes": [{"start": s, "end": e} for s, e in spans],
                    "sentences": [
                        {"text": s[0], "start": s[1], "end": s[2], "tone": getattr(s, "tone", ""), "seed": getattr(s, "seed", None)}
                        for s in sentences
                    ],
                    **timed,
                    **({"timings_detail": laps.finish()} if laps.on else {}),
                })

            # 4. Standalone Voiceover generation (only audio, with story-adaptive tone and cognitive psychology rules)
            elif self.path == "/api/voiceover":
                topic = body.get("topic")
                text = (body.get("text") or body.get("script") or "").strip()
                seconds = float(body.get("seconds", 60))
                raw_out = body.get("output_path")
                clean_voice = resolve_voice(body.get("voice"))
                dynamic_tone = body.get("dynamic_tone", True)
                instruct = body.get("instruct")
                psychology_rules = body.get("psychology_rules")
                run_id = body.get("run_id") or f"voiceover_{int(time.time()*1000)}"
                output_path = _sanitize_output_path(raw_out, run_id)

                # If no direct script supplied, ask script generator to craft one based on topic
                if not text:
                    if not topic:
                        return self._send_json({"error": "Provide 'topic' or 'text' for voiceover synthesis"}, 400)
                    log.info(f"Generating narrative voiceover script for topic: '{topic}' (~{seconds:.0f}s)...")
                    script_data = script_gen.generate_script(topic, target_seconds=seconds)
                    text = script_data.get("full_script") or " ".join(s.get("text", "") for s in script_data.get("scenes", []))

                else:
                    script_data = script_from_text(text, title=topic or "Custom Voiceover")

                # Chunk script by sentences for punctuation-aware flow
                sentences_raw = split_sentences(text)
                if not sentences_raw:
                    sentences_raw = [text]

                log.info(f"Synthesizing voiceover: {len(sentences_raw)} sentences with voice '{clean_voice}', dynamic_tone={dynamic_tone}")
                tts = get_tts_engine(clean_voice)
                file_path, duration, spans, sentences = tts.generate_segments(
                    sentences_raw,
                    output_path,
                    voice=clean_voice,
                    instruct=instruct,
                    dynamic_tone=dynamic_tone,
                    psychology_rules=psychology_rules,
                    seed=body.get("seed"),
                )

                model_info = tts.get_model_info() if hasattr(tts, "get_model_info") else {}
                words = _timed_words(file_path, sentences, body.get("style"))
                audio_url, audio_b64 = _encode_audio_file(file_path)
                active_seed = getattr(sentences[0], "seed", None) if sentences else body.get("seed")

                return self._send_json({
                    "status": "success",
                    "file": file_path,
                    "audio_url": audio_url,
                    "audio_base64": audio_b64,
                    "duration": duration,
                    "voice": clean_voice,
                    "seed": active_seed,
                    "model": model_info.get("version", "1.7B-CustomVoice"),
                    "model_name": model_info.get("model_name", "Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice"),
                    "script": script_data,
                    "sentences": [
                        {"text": s[0], "start": s[1], "end": s[2], "tone": getattr(s, "tone", ""), "seed": getattr(s, "seed", None)}
                        for s in sentences
                    ],
                    "words": words,
                })

            # 5. Script Generator directly
            elif self.path == "/api/script":
                topic = body.get("topic")
                style = body.get("style", "cinematic")
                seconds = float(body.get("seconds", 60))
                if not topic:
                    return self._send_json({"error": "Provide 'topic' in request body"}, 400)
                try:
                    script_data = script_gen.generate_script(topic, target_seconds=seconds, style=style)
                except Exception as e:
                    log.warning(f"Script generation failed ({e}); returning the topic itself as a one-line script.")
                    script_data = script_from_text(topic, title=topic, style=style)
                return self._send_json({"status": "success", "script": script_data})

            # 6. Studio: one portrait ComfyUI image
            elif self.path == "/api/image":
                prompt = body.get("prompt")
                output_path = body.get("output_path")
                if not prompt or not output_path:
                    return self._send_json({"error": "Provide 'prompt' and 'output_path'"}, 400)
                backend = body.get("backend")
                ALLOWED_IMAGE_BACKENDS = ("klein4b", "still")
                if backend is not None and backend not in ALLOWED_IMAGE_BACKENDS:
                    return self._send_json({"error": f"Unsupported image backend: '{backend}'"}, 400)

                ref_path = body.get("reference_path") or body.get("reference_image")
                if backend == "klein4b" and not ref_path:
                    return self._send_json({"error": "Klein 4B reference workflow requires 'reference_path' or 'reference_image'"}, 400)
                width = body.get("width", 768)
                height = body.get("height", 1344)
                if backend == "klein4b" and any(
                    isinstance(size, bool) or not isinstance(size, int) or size <= 0 or size > 2048 or size % 16
                    for size in (width, height)
                ):
                    return self._send_json({"error": "Klein 4B width and height must be positive multiples of 16 no greater than 2048"}, 400)
                if not comfy.is_alive():
                    return self._send_json({"status": "error", "error": f"ComfyUI is offline at {comfy.server_url}"}, 503)

                result = comfy.generate_scene_image(
                    prompt,
                    output_path,
                    width=int(width),
                    height=int(height),
                    reference_image=ref_path,
                    seed=body.get("seed"),
                    backend=backend,
                    return_metadata=True,
                )
                return self._send_json({
                    "status": "success",
                    **result,
                })

            # 7. Preschool: generate a still and a Wan 2.2 5B clip.
            elif self.path == "/api/preschool-clip":
                still_prompt = body.get("still_prompt")
                motion_prompt = body.get("motion_prompt")
                raw_out = body.get("output_path")
                use_still = body.get("use_still", True)
                backend = body.get("backend", "wan")
                if backend not in ("wan", "wan14b", "minimax_h3"):
                    return self._send_json({"error": "backend must be 'wan', 'wan14b' or 'minimax_h3'"}, 400)
                if backend == "minimax_h3" and not minimax_h3_enabled():
                    return self._send_json({"error": f"{MINIMAX_H3_DISABLED_MESSAGE} (licence)"}, 400)
                if not motion_prompt or not raw_out or (use_still and not still_prompt):
                    return self._send_json({"error": "Provide 'motion_prompt', 'output_path' and 'still_prompt' when use_still is true"}, 400)
                output_path = Path(raw_out)
                confined_output = _inside_data_dir(output_path)
                if not confined_output:
                    return self._send_json({"error": f"Path outside the data directory: {raw_out}"}, 400)
                raw_still = body.get("still_path")
                confined_still = _inside_data_dir(raw_still) if raw_still else None
                if raw_still and not confined_still:
                    return self._send_json({"error": f"Path outside the data directory: {raw_still}"}, 400)

                raw_ref = body.get("reference_image") or body.get("reference_path")
                confined_ref = None
                if raw_ref:
                    candidate_ref = Path(raw_ref)
                    if not candidate_ref.is_absolute():
                        if _inside_project_data(PROJECT_ROOT / candidate_ref):
                            candidate_ref = PROJECT_ROOT / candidate_ref
                        else:
                            candidate_ref = DATA_DIR / candidate_ref
                    confined_ref = _inside_project_data(candidate_ref)
                    if not confined_ref:
                        return self._send_json({"error": f"Path outside the data directory: {raw_ref}"}, 400)

                if not comfy.is_alive():
                    return self._send_json({"status": "error", "error": f"ComfyUI is offline at {comfy.server_url}"}, 503)
                result = comfy.generate_preschool_clip(
                    still_prompt,
                    motion_prompt,
                    confined_output,
                    seed=body.get("seed"),
                    width=int(body.get("width", 480)),
                    height=int(body.get("height", 832)),
                    frames=int(body.get("frames", 85)),
                    fps=int(body.get("fps", 24)),
                    still_path=confined_still,
                    still_width=int(body["still_width"]) if body.get("still_width") else None,
                    still_height=int(body["still_height"]) if body.get("still_height") else None,
                    weight_dtype=body.get("weight_dtype", "default"),
                    use_still=use_still,
                    backend=backend,
                    reference_image=confined_ref,
                    still_seed=body.get("still_seed"),
                    clip_seconds=body.get("clip_seconds"),
                )
                return self._send_json({"status": "success", **result})

            # 8. Studio: cut timed scenes to the voice-over and burn in captions
            elif self.path == "/api/edit":
                if not body.get("audio_path") or not body.get("output_path") or not isinstance(body.get("scenes"), list) or not body["scenes"]:
                    return self._send_json({"error": "Provide 'audio_path', 'output_path' and a non-empty 'scenes' list"}, 400)
                flags, err = _render_flags(body)
                if err:
                    return self._send_json({"error": err}, 400)
                result = StudioEditor(assembler).edit(
                    body["audio_path"], body["scenes"], body.get("words") or [], bool(body.get("captions", True)), body["output_path"],
                    title=body.get("title"), sfx=body.get("sfx") or None,
                    tight_end=(body.get("style") == "viral_v1"), style=body.get("style"),
                    stats=body.get("stats") if body.get("style") == "viral_v1" or flags.get("stat_cards") else None,
                    cover=bool(body.get("cover")),
                    **flags,
                    **({"label_windows": body.get("label_windows")} if flags.get("caption_tail_v1") else {}),
                    **({"cut_frames": body["cut_frames"]} if _valid_cut_frames(body.get("cut_frames"), len(body["scenes"])) else {}),  # KAN-603
                )
                return self._send_json({"status": "success", **result})

            # 9. Remux / replace voice-over audio on an existing video
            elif self.path == "/api/remux-voiceover":
                raw_out = body.get("output_path")

                if raw_out and not _inside_data_dir(raw_out):
                    return self._send_json({"error": f"Path outside the data directory: {raw_out}"}, 400)

                temp_dir = DATA_DIR / "temp" / f"remux_{int(time.time()*1000)}"
                video_path, audio_path, err = _stage_inputs(body, temp_dir)
                if err:
                    return self._send_json({"error": err}, 400)

                if not video_path or not audio_path:
                    return self._send_json({"error": "Provide 'video_path' (or 'video_base64') and 'audio_path' (or 'audio_base64')"}, 400)

                output_path = _sanitize_output_path(raw_out or video_path, f"remux_{int(time.time()*1000)}", "remuxed.mp4")

                result = StudioEditor(assembler).remux_voiceover(
                    video_path,
                    audio_path,
                    output_path,
                    words=body.get("words"),
                    captions=bool(body.get("captions", False)),
                    title=body.get("title"),
                    style=body.get("style"),
                )

                out_file = result.get("video_file") or output_path
                video_url = None
                video_b64 = None
                if Path(out_file).exists() and Path(out_file).is_file():
                    try:
                        v_bytes = Path(out_file).read_bytes()
                        video_b64 = base64.b64encode(v_bytes).decode("ascii")
                        try:
                            rel_v = os.path.relpath(out_file, str(DATA_DIR)).replace("\\", "/")
                        except Exception:
                            rel_v = Path(out_file).name
                        video_url = f"/api/video?file={quote(rel_v)}"
                    except Exception as e:
                        log.warning(f"Could not encode remuxed video: {e}")

                return self._send_json({
                    "status": "success",
                    "video_url": video_url,
                    "video_base64": video_b64,
                    **result
                })

            # 9. Preschool assembly: trim + cover-scale scene clips, hard-cut join over one kids music+SFX bed
            elif self.path == "/api/preschool-edit":
                clips = body.get("clips")
                music_path = body.get("music_path")
                output_path = body.get("output_path")
                cues = body.get("cues") or []
                clip_seconds = body.get("clip_seconds", PRESCHOOL_SCENE_SECONDS)
                if clip_seconds not in (3.5, 5.0, 7.5, 10.0):
                    return self._send_json({"error": "clip_seconds must be 3.5, 5.0, 7.5 or 10.0"}, 400)
                bad_input = (
                    not isinstance(clips, list) or not clips
                    or not all(isinstance(c, str) for c in clips)
                    or not isinstance(music_path, str) or not music_path
                    or not isinstance(output_path, str) or not output_path
                    or not isinstance(cues, list)
                    or not all(isinstance(c, dict) and isinstance(c.get("kind"), str) and isinstance(c.get("t"), (int, float)) for c in cues)
                )
                if bad_input:
                    return self._send_json({"error": "Provide 'clips' (list of paths), 'music_path', 'output_path', and 'cues' as a list of {kind, t}"}, 400)

                outside = next((p for p in [*clips, music_path, output_path] if not _inside_data_dir(p)), None)
                if outside:
                    return self._send_json({"error": f"Path outside the data directory: {outside}"}, 400)

                total_seconds = clip_seconds * len(clips)
                bed_dir = DATA_DIR / "temp" / f"preschool_{int(time.time() * 1000)}"
                bed_dir.mkdir(parents=True, exist_ok=True)
                bed = build_kids_bed(music_path, cues, total_seconds, bed_dir / "bed.wav")
                result = StudioEditor(assembler).edit_preschool(clips, bed, output_path, clip_seconds=clip_seconds)
                return self._send_json({"status": "success", **result})

            else:
                return self._send_json({"error": f"Unknown endpoint: {self.path}"}, 404)

        except Exception as e:
            log.exception(f"POST {self.path} failed after {time.time() - started:.1f}s: {e}")
            return self._send_json({"status": "error", "error": str(e)}, 500)
        finally:
            log.info("POST %s finished in %.1fs", self.path, time.time() - started)


def start_server():
    global PORT, HOST
    parser = argparse.ArgumentParser(description="Narrative Factory & Voiceover Server")
    parser.add_argument("--host", default=os.environ.get("HOST", HOST), help=f"Host address to bind (default: {HOST})")
    parser.add_argument("--port", type=int, default=int(os.environ.get("PORT", PORT)), help=f"Port number (default: {PORT})")
    args, _ = parser.parse_known_args()

    HOST = args.host
    PORT = args.port

    server = ThreadingHTTPServer((HOST, PORT), RequestHandler)
    log.info(f"Narrative Shorts Factory API on http://{HOST}:{PORT}: GET /status /api/logs /api/audio /api/video; "
             "POST /api/run-pipeline /api/script /api/voiceover /api/tts /api/tts-timed /api/image /api/preschool-clip /api/preschool-edit /api/edit /api/remux-voiceover")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        log.info("Narrative Shorts Factory API shutdown.")


if __name__ == "__main__":
    start_server()
