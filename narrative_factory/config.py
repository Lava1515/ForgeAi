"""Loads narrative_factory/config.json and repo-level .env; every consumer supplies its own defaults."""

import json
import os
from pathlib import Path

CONFIG_PATH = Path(__file__).resolve().parent / "config.json"
ENV_PATH = Path(__file__).resolve().parent.parent / ".env"

# Auto-load repo-level .env if present into os.environ
if ENV_PATH.exists():
    try:
        for line in ENV_PATH.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            k = k.strip()
            v = v.strip().strip("'\"")
            if k and k not in os.environ:
                os.environ[k] = v
    except Exception:
        pass


def service_token() -> str:
    """KAN-525: secret the dashboard expects on /api/gemini/ask. Empty when not configured. Never log it."""
    return os.environ.get("SERVICE_TOKEN", "")


def get_config() -> dict:
    try:
        return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
