FROM python:3.12-slim

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg fonts-montserrat sox && rm -rf /var/lib/apt/lists/*

# Install uv from official Astral image
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /bin/

ENV PYTHONUNBUFFERED=1 \
    UV_SYSTEM_PYTHON=1

# CUDA build of torch for Qwen3-TTS (its own layer: ~2.5 GB, rarely changes)
RUN uv pip install --no-cache torch torchaudio --index-url https://download.pytorch.org/whl/cu128

# Prebuilt flash-attn wheel matching torch 2.11 + cu128 for faster Qwen3-TTS inference
RUN uv pip install --no-cache https://github.com/mjun0812/flash-attention-prebuild-wheels/releases/download/v0.9.4/flash_attn-2.8.3+cu128torch2.11-cp312-cp312-linux_x86_64.whl

COPY requirements.txt /tmp/requirements.txt
RUN uv pip install --no-cache -r /tmp/requirements.txt

# Code is bind-mounted at /forgeai so edits apply on restart and data/ lands on the host
WORKDIR /forgeai/narrative_factory

# Qwen3-TTS weights download once into data/ (survives rebuilds)
ENV HF_HOME=/forgeai/data/narrative_shorts/models/qwen3
# KAN-514: run as a fixed uid/gid 1000 user (home /home/forgeai, login shell disabled, video group for NVENC device nodes).
# Runtime writes go to /forgeai/data and /forgeai/output (bind mount), /tmp, and this home (torch/HF caches, pycache).
RUN groupadd -g 1000 forgeai \
 && useradd -u 1000 -g 1000 -G video -m -d /home/forgeai -s /usr/sbin/nologin forgeai
ENV HOME=/home/forgeai \
    PYTHONPYCACHEPREFIX=/home/forgeai/.pycache
USER forgeai

CMD ["python", "server.py"]
