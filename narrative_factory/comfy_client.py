#!/usr/bin/env python3
"""
ComfyUI API Client
Communicates with the local ComfyUI instance (http://127.0.0.1:8188),
submitting generation jobs and tracking completion.
"""

from __future__ import annotations

import os
import json
import time
import random
import subprocess
import urllib.request
import urllib.error
import urllib.parse
import tempfile
from pathlib import Path
from typing import List, Dict, Any, Optional

import soundfile as sf

from config import get_config
from logs import get_logger
from vram_monitor import VramMonitor

log = get_logger("comfyui")

BASE_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = BASE_DIR.parent


def build_acestep_music_workflow(prompt: str, seconds: float, seed: int, lyrics: str = "") -> Dict[str, Any]:
    """Build ComfyUI's native ACE-Step 1.5 checkpoint workflow for instrumental audio."""
    if not isinstance(prompt, str) or not prompt.strip():
        raise ValueError("ACE-Step music prompt must not be empty")
    if seconds <= 0:
        raise ValueError("ACE-Step music duration must be positive")
    if not isinstance(seed, int) or seed < 0:
        raise ValueError("ACE-Step music seed must be a non-negative integer")
    if not isinstance(lyrics, str) or len(lyrics) > 2000 or (lyrics and not any(char.isalpha() for char in lyrics)):
        raise ValueError("ACE-Step lyrics must be at most 2000 characters and contain letters")

    return {
        "1": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": "ace_step_1.5_turbo_aio.safetensors"}},
        "2": {"class_type": "TextEncodeAceStepAudio1.5", "inputs": {
            "clip": ["1", 1], "tags": prompt.strip(), "lyrics": lyrics, "seed": seed,
            "bpm": 120, "duration": seconds, "timesignature": "4", "language": "en",
            "keyscale": "C major", "generate_audio_codes": True, "cfg_scale": 2.0,
            "temperature": 0.85, "top_p": 0.9, "top_k": 0, "min_p": 0.0,
        }},
        "3": {"class_type": "EmptyAceStep1.5LatentAudio", "inputs": {"seconds": seconds, "batch_size": 1}},
        "4": {"class_type": "ModelSamplingAuraFlow", "inputs": {"model": ["1", 0], "shift": 3}},
        "5": {"class_type": "KSampler", "inputs": {
            "model": ["4", 0], "positive": ["2", 0], "negative": ["6", 0],
            "latent_image": ["3", 0], "seed": seed, "steps": 8, "cfg": 1,
            "sampler_name": "euler", "scheduler": "simple", "denoise": 1,
        }},
        "6": {"class_type": "ConditioningZeroOut", "inputs": {"conditioning": ["2", 0]}},
        "7": {"class_type": "VAEDecodeAudio", "inputs": {"samples": ["5", 0], "vae": ["1", 2]}},
        "8": {"class_type": "SaveAudioAdvanced", "inputs": {
            "audio": ["7", 0], "filename_prefix": "kids/acestep", "format": ["flac", {}],
        }},
    }


def build_wan_workflow(
    motion_prompt: str,
    still_image: Optional[str],
    seed: Optional[int] = None,
    width: int = 480,
    height: int = 832,
    frames: int = 85,
    fps: int = 24,
    weight_dtype: str = "default",
) -> Dict[str, Any]:
    """Build the ComfyUI API graph for Wan 2.2 TI2V 5B."""
    workflow = {
        "1": {"inputs": {"unet_name": "wan2.2_ti2v_5B_fp16.safetensors", "weight_dtype": weight_dtype}, "class_type": "UNETLoader"},
        "2": {"inputs": {"clip_name": "umt5_xxl_fp8_e4m3fn_scaled.safetensors", "type": "wan", "device": "default"}, "class_type": "CLIPLoader"},
        "3": {"inputs": {"vae_name": "wan2.2_vae.safetensors"}, "class_type": "VAELoader"},
        "4": {"inputs": {"text": motion_prompt, "clip": ["2", 0]}, "class_type": "CLIPTextEncode"},
        "5": {"inputs": {"text": "", "clip": ["2", 0]}, "class_type": "CLIPTextEncode"},
        "6": {"inputs": {"model": ["1", 0], "shift": 5.0}, "class_type": "ModelSamplingSD3"},
        "7": {"inputs": {"vae": ["3", 0], "width": width, "height": height, "length": frames, "batch_size": 1}, "class_type": "Wan22ImageToVideoLatent"},
        "9": {"inputs": {"seed": seed if seed is not None else random.randint(1, 1000000000000000), "steps": 20, "cfg": 5.0, "sampler_name": "euler", "scheduler": "simple", "denoise": 1.0, "model": ["6", 0], "positive": ["4", 0], "negative": ["5", 0], "latent_image": ["7", 0]}, "class_type": "KSampler"},
        "10": {"inputs": {"samples": ["9", 0], "vae": ["3", 0]}, "class_type": "VAEDecode"},
        "11": {"inputs": {"images": ["10", 0], "fps": fps, "codec": "h264"}, "class_type": "CreateVideo"},
        "12": {"inputs": {"video": ["11", 0], "filename_prefix": "preschool/clip", "format": "auto"}, "class_type": "SaveVideo"},
    }
    if still_image:
        workflow["7"]["inputs"]["start_image"] = ["8", 0]
        workflow["8"] = {"inputs": {"image": still_image}, "class_type": "LoadImage"}
    return workflow


# Wan 2.2 14B is trained on 81-frame (5 s at 16 fps) clips; longer lengths are allowed but quality drops with length
# (identity drift, looping motion), so only these three are accepted. Length must be 4n+1: 81, 121, 161.
WAN14B_CLIP_SECONDS = (5.0, 7.5, 10.0)


def wan14b_length(seconds: float) -> int:
    return round(seconds * 16) + 1


def build_wan14b_workflow(
    still_image: str,
    motion_prompt: str,
    seed: Optional[int] = None,
    seconds: float = 5.0,
) -> Dict[str, Any]:
    """Build the official Wan 2.2 I2V 14B lightx2v 4-step graph with RIFE."""
    noise_seed = seed if seed is not None else random.randint(1, 1000000000000000)
    return {
        "1": {"inputs": {"unet_name": "wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors", "weight_dtype": "default"}, "class_type": "UNETLoader"},
        "2": {"inputs": {"unet_name": "wan2.2_i2v_low_noise_14B_fp8_scaled.safetensors", "weight_dtype": "default"}, "class_type": "UNETLoader"},
        "3": {"inputs": {"clip_name": "umt5_xxl_fp8_e4m3fn_scaled.safetensors", "type": "wan", "device": "default"}, "class_type": "CLIPLoader"},
        "6": {"inputs": {"vae_name": "wan_2.1_vae.safetensors"}, "class_type": "VAELoader"},
        "7": {"inputs": {"clip": ["3", 0], "text": motion_prompt}, "class_type": "CLIPTextEncode"},
        "8": {"inputs": {"clip": ["3", 0], "text": ""}, "class_type": "CLIPTextEncode"},
        "9": {"inputs": {"image": still_image}, "class_type": "LoadImage"},
        "10": {"inputs": {"positive": ["7", 0], "negative": ["8", 0], "vae": ["6", 0], "width": 480, "height": 832, "length": wan14b_length(seconds), "batch_size": 1, "start_image": ["9", 0]}, "class_type": "WanImageToVideo"},
        "11": {"inputs": {"model": ["1", 0], "lora_name": "wan2.2_i2v_lightx2v_4steps_lora_v1_high_noise.safetensors", "strength_model": 1.0}, "class_type": "LoraLoaderModelOnly"},
        "12": {"inputs": {"model": ["11", 0], "shift": 5.0}, "class_type": "ModelSamplingSD3"},
        "13": {"inputs": {"model": ["2", 0], "lora_name": "wan2.2_i2v_lightx2v_4steps_lora_v1_low_noise.safetensors", "strength_model": 1.0}, "class_type": "LoraLoaderModelOnly"},
        "14": {"inputs": {"model": ["13", 0], "shift": 5.0}, "class_type": "ModelSamplingSD3"},
        "15": {"inputs": {"model": ["12", 0], "add_noise": "enable", "noise_seed": noise_seed, "steps": 4, "cfg": 1.0, "sampler_name": "euler", "scheduler": "simple", "positive": ["10", 0], "negative": ["10", 1], "latent_image": ["10", 2], "start_at_step": 0, "end_at_step": 2, "return_with_leftover_noise": "enable"}, "class_type": "KSamplerAdvanced"},
        "16": {"inputs": {"model": ["14", 0], "add_noise": "disable", "noise_seed": 0, "steps": 4, "cfg": 1.0, "sampler_name": "euler", "scheduler": "simple", "positive": ["10", 0], "negative": ["10", 1], "latent_image": ["15", 0], "start_at_step": 2, "end_at_step": 4, "return_with_leftover_noise": "disable"}, "class_type": "KSamplerAdvanced"},
        "17": {"inputs": {"samples": ["16", 0], "vae": ["6", 0]}, "class_type": "VAEDecode"},
        "18": {"inputs": {"model_name": "rife_v4.25.safetensors"}, "class_type": "FrameInterpolationModelLoader"},
        "19": {"inputs": {"interp_model": ["18", 0], "images": ["17", 0], "multiplier": 3}, "class_type": "FrameInterpolate"},
        # Encode at 48 fps; the studio editor's 24 fps timeline takes every second frame.
        "20": {"inputs": {"images": ["19", 0], "fps": 48, "codec": "h264"}, "class_type": "CreateVideo"},
        "21": {"inputs": {"video": ["20", 0], "filename_prefix": "preschool/clip", "format": "auto"}, "class_type": "SaveVideo"},
    }


# MiniMax H3 licence bars use of its outputs in the US, EU, UK and South Korea (docs/model-licences.md):
# off unless FORGEAI_ALLOW_MINIMAX_H3=1 (internal evaluation only). Same env name as the dashboard.
MINIMAX_H3_DISABLED_MESSAGE = "MiniMax H3 is disabled: its licence does not allow public uploads in the US, EU, UK or South Korea"


def minimax_h3_enabled() -> bool:
    return os.environ.get("FORGEAI_ALLOW_MINIMAX_H3") == "1"


def build_minimax_h3_workflow(
    still_image: str, motion_prompt: str, seed: Optional[int] = None,
    width: int = 480, height: int = 832, megapixels: float = 0.4,
    seconds: float = 5, steps: int = 8, turbo: bool = True,
) -> Dict[str, Any]:
    """Build the MiniMax H3 image-to-video graph used by the local ComfyUI workflow."""
    # H3 snaps these requests to 124 and 90 frames; the editor trims them to
    # the requested 120 or 84 frames respectively.
    length = {5: 124, 3.5: 90}.get(seconds, round(seconds * 24) + 4)
    return {
        "1": {"inputs": {"image": still_image}, "class_type": "LoadImage"},
        "2": {"inputs": {"image": ["1", 0], "upscale_method": "lanczos", "megapixels": megapixels, "resolution_steps": 32}, "class_type": "ImageScaleToTotalPixels"},
        "3": {"inputs": {"vae_name": "minimax_h3_video_vae_int8_convrot.safetensors"}, "class_type": "VAELoader"},
        "4": {"inputs": {"vae_name": "minimax_h3_audio_vae_fp32.safetensors"}, "class_type": "VAELoader"},
        "5": {"inputs": {"clip_name": "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors", "type": "minimax", "device": "default"}, "class_type": "CLIPLoader"},
        "6": {"inputs": {"unet_name": "minimax_h3_fl2va_pruned_int8_convrot.safetensors", "weight_dtype": "default"}, "class_type": "UNETLoader"},
        "7": {"inputs": {"model": ["6", 0], "lora_name": "minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors", "strength_model": 1.0}, "class_type": "LoraLoaderModelOnly"},
        "8": {"inputs": {"switch": ["22", 0], "on_false": ["6", 0], "on_true": ["7", 0]}, "class_type": "ComfySwitchNode"},
        "9": {"inputs": {"value": steps}, "class_type": "PrimitiveInt"},
        "10": {"inputs": {"value": steps}, "class_type": "PrimitiveInt"},
        "11": {"inputs": {"switch": ["22", 0], "on_false": ["9", 0], "on_true": ["10", 0]}, "class_type": "ComfySwitchNode"},
        "12": {"inputs": {"model": ["8", 0], "conditioning": ["13", 0]}, "class_type": "BasicGuider"},
        "13": {"inputs": {"clip": ["5", 0], "vae": ["3", 0], "prompt": motion_prompt, "width": width, "height": height, "length": length, "first_frame": ["2", 0]}, "class_type": "MiniMaxH3ImageToVideo"},
        "14": {"inputs": {"scheduler": "simple", "steps": ["11", 0], "denoise": 1.0, "model": ["8", 0]}, "class_type": "BasicScheduler"},
        "15": {"inputs": {"sampler_name": "res_multistep"}, "class_type": "KSamplerSelect"},
        "16": {"inputs": {"noise_seed": seed if seed is not None else random.randint(1, 1000000000000000)}, "class_type": "RandomNoise"},
        "17": {"inputs": {"noise": ["16", 0], "guider": ["12", 0], "sampler": ["15", 0], "sigmas": ["14", 0], "latent_image": ["13", 1]}, "class_type": "SamplerCustomAdvanced"},
        "18": {"inputs": {"samples": ["17", 0], "vae": ["3", 0]}, "class_type": "VAEDecode"},
        "19": {"inputs": {"samples": ["17", 0], "vae": ["4", 0]}, "class_type": "VAEDecodeAudio"},
        "20": {"inputs": {"images": ["18", 0], "audio": ["19", 0], "fps": 24, "bit_depth": 8, "color_space": "sRGB", "codec": "none"}, "class_type": "CreateVideo"},
        "21": {"inputs": {"video": ["20", 0], "filename_prefix": "preschool/clip", "format": "auto"}, "class_type": "SaveVideo"},
        "22": {"inputs": {"value": bool(turbo)}, "class_type": "PrimitiveBoolean"},
    }


def is_kill_switch_active() -> bool:
    """Check if pipeline kill switch is engaged on disk."""
    candidates = [
        PROJECT_ROOT / "data" / "pipeline_state.json",
        Path("/forgeai/data/pipeline_state.json"),
    ]
    env_file = os.environ.get("FORGEAI_STATE_FILE")
    if env_file:
        candidates.insert(0, Path(env_file))
    for p in candidates:
        if p.exists():
            try:
                with open(p, "r", encoding="utf-8") as f:
                    data = json.load(f)
                    return bool(data.get("kill_switch_active") or data.get("status") == "stopped")
            except Exception:
                pass
    return False


def _request_json(url: str, method: str = "GET", payload: Any = None, timeout: float = 10, headers: Optional[Dict[str, str]] = None) -> Any:
    """JSON request and JSON response. Network and HTTP errors propagate to the caller."""
    data = None if payload is None else json.dumps(payload).encode("utf-8")
    hdrs = dict(headers or {})
    if data is not None:
        hdrs.setdefault("Content-Type", "application/json")
    req = urllib.request.Request(url, data=data, headers=hdrs, method=method)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


class ComfyClient:
    def __init__(self, server_url: Optional[str] = None):
        cfg = get_config()
        self.server_url = (server_url or os.environ.get("COMFYUI_URL") or cfg.get("comfyui", {}).get("server_url", "http://127.0.0.1:8188")).rstrip("/")
        self.timeout = cfg.get("comfyui", {}).get("timeout_seconds", 300)
        self._last_alive_check = 0.0
        self._last_alive_status = False

    def is_alive(self, cache_ttl: float = 3.0) -> bool:
        """Check if ComfyUI server is reachable and responsive (cached for cache_ttl seconds)."""
        now = time.time()
        if now - self._last_alive_check < cache_ttl:
            return self._last_alive_status

        try:
            req = urllib.request.Request(f"{self.server_url}/system_stats")
            with urllib.request.urlopen(req, timeout=1.0) as resp:
                self._last_alive_status = (resp.status == 200)
        except Exception:
            self._last_alive_status = False

        self._last_alive_check = now
        return self._last_alive_status

    def interrupt(self) -> bool:
        """Interrupt active prompt and clear queue on ComfyUI."""
        success = True
        try:
            req = urllib.request.Request(
                f"{self.server_url}/interrupt",
                data=b"{}",
                headers={"Content-Type": "application/json"}
            )
            with urllib.request.urlopen(req, timeout=2) as resp:
                pass
        except Exception:
            success = False

        try:
            req = urllib.request.Request(
                f"{self.server_url}/queue",
                data=json.dumps({"clear": True}).encode("utf-8"),
                headers={"Content-Type": "application/json"}
            )
            with urllib.request.urlopen(req, timeout=2) as resp:
                pass
        except Exception:
            pass

        return success

    def free_vram(self) -> bool:
        """Ask ComfyUI to unload its models so the next GPU user (Qwen3-TTS) has the card. Best effort."""
        try:
            req = urllib.request.Request(
                f"{self.server_url}/free",
                data=json.dumps({"unload_models": True, "free_memory": True}).encode("utf-8"),
                headers={"Content-Type": "application/json"},
            )
            with urllib.request.urlopen(req, timeout=3) as resp:
                return resp.status == 200
        except Exception:
            return False

    def upload_image(self, image_path: Path | str, overwrite: bool = True) -> str:
        """
        Uploads an image file to ComfyUI's input directory via POST /upload/image.
        Returns the filename (or subfolder/filename) recognized by ComfyUI.
        """
        path = Path(image_path).resolve()
        if not path.is_file():
            raise FileNotFoundError(f"Reference image file not found: {path}")

        boundary = f"----WebKitFormBoundary{random.randint(1000000000, 9999999999)}"
        body = bytearray()

        def add_field(name: str, value: str):
            body.extend(f"--{boundary}\r\n".encode("utf-8"))
            body.extend(f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode("utf-8"))
            body.extend(f"{value}\r\n".encode("utf-8"))

        add_field("overwrite", "true" if overwrite else "false")

        filename = path.name
        body.extend(f"--{boundary}\r\n".encode("utf-8"))
        body.extend(f'Content-Disposition: form-data; name="image"; filename="{filename}"\r\n'.encode("utf-8"))
        body.extend(b"Content-Type: image/png\r\n\r\n")
        body.extend(path.read_bytes())
        body.extend(b"\r\n")

        body.extend(f"--{boundary}--\r\n".encode("utf-8"))

        req = urllib.request.Request(
            f"{self.server_url}/upload/image",
            data=bytes(body),
            headers={"Content-Type": f"multipart/form-data; boundary={boundary}"}
        )
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            name = data.get("name", filename)
            subfolder = data.get("subfolder", "")
            if subfolder:
                return f"{subfolder}/{name}"
            return name

    def build_prompt_workflow(
        self,
        prompt_text: str,
        width: int = 1024,
        height: int = 1024,
        seed: Optional[int] = None,
        reference_image: Optional[str] = None,
        reference_path: Optional[str] = None,
        backend: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Builds a high quality text-to-image workflow for ComfyUI.
        Uses Z-Image Turbo (Apache-2.0).
        When reference_image or reference_path is provided, uses the 5.1 character reference workflow (Cand 1 Z-Image Omni).
        When backend == "klein4b", uses the tested FLUX.2 Klein 4B single-reference workflow.
        When not provided, keeps today's text-to-image generation workflow untouched.
        """
        if backend is not None and backend not in ("klein4b", "still"):
            raise ValueError(f"Unsupported image backend: {backend}")

        if seed is None:
            seed = random.randint(1, 1000000000000000)
        ref = reference_path if reference_path is not None else reference_image

        if backend == "klein4b":
            if not ref:
                raise ValueError("Klein 4B reference workflow requires a reference image")
            return {
                "model": {
                    "class_type": "UNETLoader",
                    "inputs": {
                        "unet_name": "flux-2-klein-4b-fp8.safetensors",
                        "weight_dtype": "default",
                    },
                },
                "clip": {
                    "class_type": "CLIPLoader",
                    "inputs": {
                        "clip_name": "qwen_3_4b.safetensors",
                        "type": "flux2",
                        "device": "default",
                    },
                },
                "vae": {
                    "class_type": "VAELoader",
                    "inputs": {
                        "vae_name": "flux2-vae.safetensors",
                    },
                },
                "input": {
                    "class_type": "LoadImage",
                    "inputs": {
                        "image": ref,
                    },
                },
                "scale": {
                    "class_type": "ImageScale",
                    "inputs": {
                        "image": ["input", 0],
                        "upscale_method": "lanczos",
                        "width": width,
                        "height": height,
                        "crop": "center",
                    },
                },
                "encode": {
                    "class_type": "VAEEncode",
                    "inputs": {
                        "pixels": ["scale", 0],
                        "vae": ["vae", 0],
                    },
                },
                "text": {
                    "class_type": "CLIPTextEncode",
                    "inputs": {
                        "text": prompt_text,
                        "clip": ["clip", 0],
                    },
                },
                "zero": {
                    "class_type": "ConditioningZeroOut",
                    "inputs": {
                        "conditioning": ["text", 0],
                    },
                },
                "positive": {
                    "class_type": "ReferenceLatent",
                    "inputs": {
                        "conditioning": ["text", 0],
                        "latent": ["encode", 0],
                    },
                },
                "negative": {
                    "class_type": "ReferenceLatent",
                    "inputs": {
                        "conditioning": ["zero", 0],
                        "latent": ["encode", 0],
                    },
                },
                "guider": {
                    "class_type": "CFGGuider",
                    "inputs": {
                        "model": ["model", 0],
                        "positive": ["positive", 0],
                        "negative": ["negative", 0],
                        "cfg": 1.0,
                    },
                },
                "sampler": {
                    "class_type": "KSamplerSelect",
                    "inputs": {
                        "sampler_name": "euler",
                    },
                },
                "schedule": {
                    "class_type": "Flux2Scheduler",
                    "inputs": {
                        "steps": 4,
                        "width": width,
                        "height": height,
                    },
                },
                "latent": {
                    "class_type": "EmptyFlux2LatentImage",
                    "inputs": {
                        "width": width,
                        "height": height,
                        "batch_size": 1,
                    },
                },
                "noise": {
                    "class_type": "RandomNoise",
                    "inputs": {
                        "noise_seed": seed,
                    },
                },
                "sample": {
                    "class_type": "SamplerCustomAdvanced",
                    "inputs": {
                        "noise": ["noise", 0],
                        "guider": ["guider", 0],
                        "sampler": ["sampler", 0],
                        "sigmas": ["schedule", 0],
                        "latent_image": ["latent", 0],
                    },
                },
                "decode": {
                    "class_type": "VAEDecode",
                    "inputs": {
                        "samples": ["sample", 0],
                        "vae": ["vae", 0],
                    },
                },
                "save": {
                    "class_type": "SaveImage",
                    "inputs": {
                        "images": ["decode", 0],
                        "filename_prefix": "forgeai_klein4b",
                    },
                },
            }

        if ref:
            # NextDiT Lumina2 requires latent dimensions divisible by patch_size 2
            # with 8x VAE downsampling, meaning pixel dimensions must be multiples of 16.
            aligned_w = max(16, round(width / 16.0) * 16)
            aligned_h = max(16, round(height / 16.0) * 16)
            return {
                "load_img": {
                    "inputs": {
                        "image": ref
                    },
                    "class_type": "LoadImage"
                },
                "scale_ref": {
                    "inputs": {
                        "image": [
                            "load_img",
                            0
                        ],
                        "upscale_method": "lanczos",
                        "width": aligned_w,
                        "height": aligned_h,
                        "crop": "center",
                    },
                    "class_type": "ImageScale"
                },
                "clip_loader": {
                    "inputs": {
                        "clip_name": "qwen_3_4b.safetensors",
                        "type": "lumina2",
                        "device": "default"
                    },
                    "class_type": "CLIPLoader"
                },
                "vae_loader": {
                    "inputs": {
                        "vae_name": "ae.safetensors"
                    },
                    "class_type": "VAELoader"
                },
                "unet_loader": {
                    "inputs": {
                        "unet_name": "z_image_turbo_bf16.safetensors",
                        "weight_dtype": "default"
                    },
                    "class_type": "UNETLoader"
                },
                "sampling": {
                    "inputs": {
                        "shift": 3.0,
                        "sampling": "flow",
                        "model": [
                            "unet_loader",
                            0
                        ]
                    },
                    "class_type": "ModelSamplingAuraFlow"
                },
                "omni_encode": {
                    "inputs": {
                        "clip": [
                            "clip_loader",
                            0
                        ],
                        "prompt": prompt_text,
                        "auto_resize_images": False,
                        "vae": [
                            "vae_loader",
                            0
                        ],
                        "image1": [
                            "scale_ref",
                            0
                        ]
                    },
                    "class_type": "TextEncodeZImageOmni"
                },
                "zero_cond": {
                    "inputs": {
                        "conditioning": [
                            "omni_encode",
                            0
                        ]
                    },
                    "class_type": "ConditioningZeroOut"
                },
                "empty_latent": {
                    "inputs": {
                        "width": aligned_w,
                        "height": aligned_h,
                        "batch_size": 1
                    },
                    "class_type": "EmptySD3LatentImage"
                },
                "sampler": {
                    "inputs": {
                        "seed": seed,
                        "steps": 8,
                        "cfg": 1.0,
                        "sampler_name": "res_multistep",
                        "scheduler": "simple",
                        "denoise": 1.0,
                        "model": [
                            "sampling",
                            0
                        ],
                        "positive": [
                            "omni_encode",
                            0
                        ],
                        "negative": [
                            "zero_cond",
                            0
                        ],
                        "latent_image": [
                            "empty_latent",
                            0
                        ]
                    },
                    "class_type": "KSampler"
                },
                "vae_decode": {
                    "inputs": {
                        "samples": [
                            "sampler",
                            0
                        ],
                        "vae": [
                            "vae_loader",
                            0
                        ]
                    },
                    "class_type": "VAEDecode"
                },
                "save_image": {
                    "inputs": {
                        "filename_prefix": "narrative_factory",
                        "images": [
                            "vae_decode",
                            0
                        ]
                    },
                    "class_type": "SaveImage"
                }
            }

        # Fast Z-Image Turbo / SD3 / Flux workflow graph (untouched)
        workflow = {
            "9": {
                "inputs": {
                    "filename_prefix": "narrative_factory",
                    "images": ["57:8", 0]
                },
                "class_type": "SaveImage"
            },
            "57:30": {
                "inputs": {
                    "clip_name": "qwen_3_4b.safetensors",
                    "type": "lumina2",
                    "device": "default"
                },
                "class_type": "CLIPLoader"
            },
            "57:29": {
                "inputs": {
                    "vae_name": "ae.safetensors"
                },
                "class_type": "VAELoader"
            },
            "57:33": {
                "inputs": {
                    "conditioning": ["57:27", 0]
                },
                "class_type": "ConditioningZeroOut"
            },
            "57:8": {
                "inputs": {
                    "samples": ["57:3", 0],
                    "vae": ["57:29", 0]
                },
                "class_type": "VAEDecode"
            },
            "57:28": {
                "inputs": {
                    "unet_name": "z_image_turbo_bf16.safetensors",
                    "weight_dtype": "default"
                },
                "class_type": "UNETLoader"
            },
            "57:27": {
                "inputs": {
                    "text": prompt_text,
                    "clip": ["57:30", 0]
                },
                "class_type": "CLIPTextEncode"
            },
            "57:13": {
                "inputs": {
                    "width": width,
                    "height": height,
                    "batch_size": 1
                },
                "class_type": "EmptySD3LatentImage"
            },
            "57:11": {
                "inputs": {
                    "shift": 3,
                    "sampling": "flow",
                    "model": ["57:28", 0]
                },
                "class_type": "ModelSamplingAuraFlow"
            },
            "57:3": {
                "inputs": {
                    "seed": seed,
                    "steps": 8,
                    "cfg": 1.0,
                    "sampler_name": "res_multistep",
                    "scheduler": "simple",
                    "denoise": 1.0,
                    "model": ["57:11", 0],
                    "positive": ["57:27", 0],
                    "negative": ["57:33", 0],
                    "latent_image": ["57:13", 0]
                },
                "class_type": "KSampler"
            }
        }
        return workflow

    def queue_prompt(self, workflow_dict: Dict[str, Any]) -> str:
        """Submit a prompt graph to ComfyUI and return the prompt_id."""
        data = _request_json(f"{self.server_url}/prompt", "POST", {"prompt": workflow_dict}, timeout=10)
        prompt_id = data.get("prompt_id")
        if not prompt_id:
            raise RuntimeError(f"ComfyUI prompt submission failed: {data}")
        log.debug(f"Queued prompt {prompt_id} on {self.server_url}.")
        return prompt_id

    def wait_for_completion(self, prompt_id: str, poll_interval: float = 1.0) -> List[str]:
        """
        Poll /history/{prompt_id} until generation completes.
        Returns the list of generated output media filenames.
        """
        start_time = time.time()
        log.info(f"Waiting for ComfyUI (prompt {prompt_id[:8]})...")
        last_note = start_time
        
        while time.time() - start_time < self.timeout:
            if is_kill_switch_active():
                self.interrupt()
                raise RuntimeError("ComfyUI generation aborted: Kill switch active.")

            try:
                history = _request_json(f"{self.server_url}/history/{prompt_id}", timeout=5)

                if prompt_id in history:
                    outputs = history[prompt_id].get("outputs", {})
                    image_files = []
                    for node_id, node_out in outputs.items():
                        for media_key in ("images", "videos", "gifs", "audio"):
                            if media_key not in node_out:
                                continue
                            for img_info in node_out[media_key]:
                                fname = img_info.get("filename")
                                subfolder = img_info.get("subfolder", "")
                                if fname:
                                    if subfolder:
                                        image_files.append(os.path.join(subfolder, fname))
                                    else:
                                        image_files.append(fname)
                    if image_files:
                        log.info(f"ComfyUI finished prompt {prompt_id[:8]} in {time.time() - start_time:.1f}s.")
                        return image_files
            except Exception as e:
                log.debug(f"ComfyUI history poll failed ({e}); retrying.")
            if time.time() - last_note >= 15:
                last_note = time.time()
                log.debug(f"Still rendering prompt {prompt_id[:8]}: {last_note - start_time:.0f}s elapsed (timeout {self.timeout}s).")
            time.sleep(poll_interval)
            
        raise TimeoutError(f"ComfyUI prompt {prompt_id} timed out after {self.timeout}s")

    def generate_kids_music(
        self,
        prompt: str,
        seconds: float,
        seed: int,
        out_path: Path | str,
        lyrics: str = "",
    ) -> Dict[str, Any]:
        """Generate one ACE-Step loop and save the ComfyUI audio output as WAV."""
        if is_kill_switch_active():
            raise RuntimeError("ComfyUI generation aborted: Kill switch active.")
        destination = Path(out_path).resolve()
        destination.parent.mkdir(parents=True, exist_ok=True)
        self.free_vram()
        try:
            if lyrics:
                workflow = build_acestep_music_workflow(prompt, seconds, seed, lyrics=lyrics)
            else:
                workflow = build_acestep_music_workflow(prompt, seconds, seed)
            prompt_id = self.queue_prompt(workflow)
            filenames = self.wait_for_completion(prompt_id)
            if not filenames:
                raise RuntimeError("No audio output returned from ComfyUI")

            normalized = filenames[0].replace("\\", "/")
            subfolder, _, filename = normalized.rpartition("/")
            query = urllib.parse.urlencode({"filename": filename, "subfolder": subfolder, "type": "output"})
            with tempfile.TemporaryDirectory() as temp_dir:
                flac_path = Path(temp_dir) / filename
                urllib.request.urlretrieve(f"{self.server_url}/view?{query}", str(flac_path))
                audio, sample_rate = sf.read(str(flac_path), dtype="float32", always_2d=False)
                sf.write(str(destination), audio, sample_rate, format="WAV")
            return {"path": str(destination), "seconds": seconds, "seed": seed}
        finally:
            self.free_vram()

    def generate_preschool_clip(
        self,
        still_prompt: str,
        motion_prompt: str,
        out_path: Path | str,
        seed: Optional[int] = None,
        width: int = 480,
        height: int = 832,
        frames: int = 85,
        fps: int = 24,
        still_path: Optional[Path | str] = None,
        still_width: Optional[int] = None,
        still_height: Optional[int] = None,
        weight_dtype: str = "default",
        use_still: bool = True,
        backend: str = "wan",
        reference_image: Optional[str | Path] = None,
        reference_path: Optional[str | Path] = None,
        still_seed: Optional[int] = None,
        clip_seconds: Optional[float] = None,
    ) -> Dict[str, Any]:
        """Generate a Wan clip with VRAM eviction, optionally using a generated or supplied hero still."""
        if backend not in ("wan", "wan14b", "minimax_h3"):
            raise ValueError(f"Unknown preschool clip backend: {backend}")
        if backend == "minimax_h3" and not minimax_h3_enabled():
            raise ValueError(f"{MINIMAX_H3_DISABLED_MESSAGE} (licence); set FORGEAI_ALLOW_MINIMAX_H3=1 for internal evaluation only")
        if backend == "minimax_h3" and not use_still:
            raise ValueError("MiniMax H3 requires a still image")
        if backend == "wan14b" and not use_still:
            raise ValueError("Wan 2.2 I2V 14B requires a still image")
        wan14b_seconds = 5.0 if clip_seconds is None else float(clip_seconds)
        if backend == "wan14b" and wan14b_seconds not in WAN14B_CLIP_SECONDS:
            raise ValueError(f"Wan 2.2 I2V 14B clip_seconds must be one of {WAN14B_CLIP_SECONDS}")
        if is_kill_switch_active():
            raise RuntimeError("ComfyUI generation aborted: Kill switch active.")
        destination = Path(out_path).resolve()
        destination.parent.mkdir(parents=True, exist_ok=True)
        still = Path(still_path).resolve() if still_path else destination.with_name(destination.stem + "_still.png")
        self.free_vram()
        try:
            seconds_still = 0.0
            if use_still:
                still_started = time.monotonic()
                if still_path is None:
                    ref = reference_path if reference_path is not None else reference_image
                    self.generate_scene_image(
                        still_prompt, still,
                        width=still_width or width,
                        height=still_height or height,
                        reference_image=ref,
                        seed=still_seed,
                    )
                seconds_still = time.monotonic() - still_started

            self.free_vram()
            uploaded = self.upload_image(still) if use_still else None
            if backend == "minimax_h3":
                workflow = build_minimax_h3_workflow(uploaded, motion_prompt, seed, width, height, seconds=5, steps=8, turbo=True)
            elif backend == "wan14b":
                workflow = build_wan14b_workflow(uploaded, motion_prompt, seed, wan14b_seconds)
            else:
                workflow = build_wan_workflow(motion_prompt, uploaded, seed, width, height, frames, fps, weight_dtype)
            video_started = time.monotonic()
            prompt_id = self.queue_prompt(workflow)
            filenames = self.wait_for_completion(prompt_id)
            if not filenames:
                raise RuntimeError("No video output returned from ComfyUI")
            normalized = filenames[0].replace("\\", "/")
            subfolder, _, filename = normalized.rpartition("/")
            query = urllib.parse.urlencode({"filename": filename, "subfolder": subfolder, "type": "output"})
            urllib.request.urlretrieve(f"{self.server_url}/view?{query}", str(destination))
            if backend == "minimax_h3":
                from imageio_ffmpeg import get_ffmpeg_exe
                silent = destination.with_name(destination.stem + "_silent.mp4")
                result = subprocess.run([get_ffmpeg_exe(), "-y", "-i", str(destination), "-an", "-c:v", "copy", str(silent)], capture_output=True, text=True)
                if result.returncode:
                    raise RuntimeError(f"Could not remove MiniMax audio stream: {result.stderr[-1000:]}")
                os.replace(silent, destination)
            seconds_video = time.monotonic() - video_started
            output_frames = 124 if backend == "minimax_h3" else ((wan14b_length(wan14b_seconds) - 1) * 3 + 1 if backend == "wan14b" else frames)
            result_seconds = wan14b_seconds if backend == "wan14b" else (5.0 if backend == "minimax_h3" else 3.5)
            return {"path": str(destination), "seconds_still": seconds_still, "seconds_video": seconds_video, "frames": output_frames, "backend": backend, "clip_seconds": result_seconds}
        finally:
            self.free_vram()

    def generate_scene_image(
        self,
        prompt_text: str,
        target_filepath: Path | str,
        width: int = 1024,
        height: int = 1024,
        reference_image: Optional[str | Path] = None,
        reference_path: Optional[str | Path] = None,
        seed: Optional[int] = None,
        backend: Optional[str] = None,
        return_metadata: bool = False,
    ) -> str | Dict[str, Any]:
        """
        Renders a single scene prompt, downloads/copies the image to target_filepath.
        When reference_image or reference_path is provided, uses the 5.1 character reference workflow.
        """
        if is_kill_switch_active():
            raise RuntimeError("ComfyUI generation aborted: Kill switch active.")
        if backend is not None and backend not in ("still", "klein4b"):
            raise ValueError(f"Unsupported image backend: {backend}")
        if backend == "klein4b" and not (reference_path or reference_image):
            raise ValueError("Klein 4B reference workflow requires a reference image")

        start_time = time.monotonic()
        target_path = Path(target_filepath).resolve()
        target_path.parent.mkdir(parents=True, exist_ok=True)

        ref = reference_path if reference_path is not None else reference_image
        ref_image_name = None
        fallback_reason: Optional[str] = None
        if ref:
            ref_str = str(ref)
            p = Path(ref_str)
            if p.is_file():
                try:
                    ref_image_name = self.upload_image(p)
                except Exception as e:
                    fallback_reason = f"Could not upload reference image to ComfyUI ({e}); using filename directly."
                    log.warning(fallback_reason)
                    ref_image_name = p.name
            else:
                ref_image_name = p.name if ("/" in ref_str or "\\" in ref_str) else ref_str

        with VramMonitor(logger=log):
            workflow = self.build_prompt_workflow(
                prompt_text,
                width=width,
                height=height,
                seed=seed,
                reference_image=ref_image_name,
                backend=backend,
            )
            prompt_id = self.queue_prompt(workflow)
            filenames = self.wait_for_completion(prompt_id)
            
            if not filenames:
                raise RuntimeError("No image output returned from ComfyUI")
                
            view_url = f"{self.server_url}/view?filename={urllib.parse.quote(filenames[0])}"
            urllib.request.urlretrieve(view_url, str(target_path))
                
            log.debug(f"Saved frame to {target_path}")
            if return_metadata:
                timing_ms = max(0.0, round((time.monotonic() - start_time) * 1000.0, 2))
                model = next((node["inputs"].get("unet_name") for node in workflow.values() if node.get("class_type") == "UNETLoader"), None)
                actual_backend = "klein4b" if model == "flux-2-klein-4b-fp8.safetensors" else "still"
                result = {
                    "file": str(target_path),
                    "backend": actual_backend,
                    "fallback_reason": fallback_reason,
                    "timing_ms": timing_ms,
                }
                if model:
                    result["model"] = model
                return result
            return str(target_path)
