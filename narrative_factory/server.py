#!/usr/bin/env python3
"""
ForgeAI voice service.
HTTP API for the dashboard: timed voice-over (Qwen3-TTS) and word timings (Whisper alignment).
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

from aligner import align_words, words_for_job
from tts_engine import get_tts_engine, resolve_voice

PORT = 5050
HOST = os.environ.get("HOST", "127.0.0.1")  # bind wider only via --host / HOST env, and always set TTS_TOKEN then
log = logs.get_logger("server")

BASE_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = BASE_DIR.parent
DATA_DIR = PROJECT_ROOT / "data" / "narrative_shorts"


class Laps:
    """Wall seconds between consecutive marks, by substep name (timings_detail). Off, every call does nothing."""
    def __init__(self, on=False):
        self.on = bool(on)
        self.out = {}
        self.start = self.last = time.perf_counter()

    def mark(self, key):
        if not self.on:
            return 0.0
        now = time.perf_counter()
        spent, self.last = now - self.last, now
        self.out[key] = self.out.get(key, 0.0) + spent
        return spent

    def note_model(self, engine):
        """Cold or warm start: the Qwen3 engine knows whether its model was already loaded."""
        if self.on and hasattr(engine, "_model"):
            self.out["tts_model_loaded_before"] = engine._model is not None

    def finish(self):
        self.out["total_s"] = time.perf_counter() - self.start
        return self.out


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

        if self.path in ["/", "/health", "/status"]:
            tts = get_tts_engine()
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
                "service": "ForgeAI voice service",
                "status": "online",
                "port": PORT,
                "host": self.headers.get("Host", f"{HOST}:{PORT}"),
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

        if self.path == "/api/align":  # needs no voice engine
            status, answer = _align_request(body)
            return self._send_json(answer, status)

        logs.run_id.set(body.get("run_id"))
        started = time.time()
        log.info("POST %s started", self.path)
        log.debug("POST %s body: %s", self.path, json.dumps({k: (v if len(str(v)) < 200 else f"{str(v)[:200]}... ({len(str(v))} chars)") for k, v in body.items()}))

        try:
            if self.path == "/api/tts-timed":
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

            else:
                return self._send_json({"error": f"Unknown endpoint: {self.path}"}, 404)

        except Exception as e:
            log.exception(f"POST {self.path} failed after {time.time() - started:.1f}s: {e}")
            return self._send_json({"status": "error", "error": str(e)}, 500)
        finally:
            log.info("POST %s finished in %.1fs", self.path, time.time() - started)


def start_server():
    global PORT, HOST
    parser = argparse.ArgumentParser(description="ForgeAI voice service")
    parser.add_argument("--host", default=os.environ.get("HOST", HOST), help=f"Host address to bind (default: {HOST})")
    parser.add_argument("--port", type=int, default=int(os.environ.get("PORT", PORT)), help=f"Port number (default: {PORT})")
    args, _ = parser.parse_known_args()

    HOST = args.host
    PORT = args.port

    server = ThreadingHTTPServer((HOST, PORT), RequestHandler)
    log.info(f"ForgeAI voice service on http://{HOST}:{PORT}: GET /status /api/logs /api/audio; POST /api/tts-timed /api/align")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        log.info("Voice service shutdown.")


if __name__ == "__main__":
    start_server()
