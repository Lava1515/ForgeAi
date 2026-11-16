"""X1 missing/fictional asset regression. Appearance is verified by fenced renders.
Author: codex · gpt-6.1-sol, 2026-11-16 09:45 +02:00.
"""
import hashlib
import json
from pathlib import Path


def test_registered_real_raster_exists_and_matches_hash():
    root = Path(__file__).resolve().parents[2]
    entries = json.loads((root / "licenses/register.json").read_text(encoding="utf-8"))["entries"]
    entry = next(e for e in entries if e["id"] == "naturalearth:raster")
    asset = root / entry["local_file"]
    assert asset.is_file()
    assert hashlib.sha256(asset.read_bytes()).hexdigest() == entry["sha256"]
    assert asset.stat().st_size < 4 * 1024 * 1024
    assert entry["dimensions"] == [4096, 2048]
    assert entry["allowed"] is True
