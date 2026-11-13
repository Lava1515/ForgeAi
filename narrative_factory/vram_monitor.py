#!/usr/bin/env python3
"""
VRAM Monitoring helper.
Samples peak VRAM and free VRAM before/after GPU tasks using nvidia-smi.
"""

from __future__ import annotations

import subprocess
import threading
import time
from typing import Dict, Optional

from logs import get_logger

log = get_logger("vram_monitor")


def sample_vram() -> Dict[str, Optional[int]]:
    """Sample memory.used and memory.free in MiB via nvidia-smi."""
    try:
        res = subprocess.run(
            ["nvidia-smi", "--query-gpu=memory.used,memory.free", "--format=csv,noheader,nounits"],
            capture_output=True,
            text=True,
            timeout=2,
        )
        if res.returncode != 0:
            return {"used_mb": None, "free_mb": None}
        line = res.stdout.strip().splitlines()[0]
        used_s, free_s = line.split(",")
        return {"used_mb": int(used_s.strip()), "free_mb": int(free_s.strip())}
    except Exception:
        return {"used_mb": None, "free_mb": None}


class VramMonitor:
    """
    Context manager that samples free VRAM before, tracks peak VRAM during,
    and logs peak VRAM and free VRAM before/after upon exit.
    """

    def __init__(self, interval: float = 0.25, logger=None):
        self.interval = interval
        self.logger = logger or log
        self.used_before: Optional[int] = None
        self.free_before: Optional[int] = None
        self.used_after: Optional[int] = None
        self.free_after: Optional[int] = None
        self.peak_used_mb: Optional[int] = None
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None

    def _sample_loop(self):
        while not self._stop.is_set():
            curr = sample_vram()
            if curr["used_mb"] is not None:
                if self.peak_used_mb is None or curr["used_mb"] > self.peak_used_mb:
                    self.peak_used_mb = curr["used_mb"]
            time.sleep(self.interval)

    def __enter__(self):
        before = sample_vram()
        self.used_before = before["used_mb"]
        self.free_before = before["free_mb"]
        self.peak_used_mb = self.used_before
        self._stop.clear()
        self._thread = threading.Thread(target=self._sample_loop, daemon=True)
        self._thread.start()
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=1.0)
        after = sample_vram()
        self.used_after = after["used_mb"]
        self.free_after = after["free_mb"]
        if self.used_after is not None:
            if self.peak_used_mb is None or self.used_after > self.peak_used_mb:
                self.peak_used_mb = self.used_after

        self.logger.info(
            f"VRAM monitor: before: used={self.used_before} MiB, free={self.free_before} MiB | "
            f"peak used={self.peak_used_mb} MiB | "
            f"after: used={self.used_after} MiB, free={self.free_after} MiB"
        )
