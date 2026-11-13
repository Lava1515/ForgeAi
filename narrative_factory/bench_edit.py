"""Re-cuts an existing Studio draft (its scenes/ + voiceover.wav) to a temp file and reports time and size.
Run: MSYS_NO_PATHCONV=1 docker exec forgeai-narrative python bench_edit.py /forgeai/output/drafts/<id>"""

import json
import sys
import tempfile
import time
from pathlib import Path

from assembler import get_audio_duration
from captions import estimate_word_timings
from editor import StudioEditor

draft = Path(sys.argv[1])
plan = json.loads((draft / "plan.json").read_text(encoding="utf-8"))
files = {p.stem: p for p in (draft / "scenes").iterdir()}
duration = get_audio_duration(draft / "voiceover.wav")
step = duration / len(plan["scenes"])
scenes, texts, spans = [], [], []
for i, s in enumerate(plan["scenes"]):
    f = files.get(f"scene_{i}")
    start, end = i * step, (i + 1) * step - 0.05
    kind = "card" if f is None else ("clip" if f.suffix == ".mp4" else "image")
    scenes.append({"start": start, "end": end, "kind": kind, "file": str(f) if f else None, "motion": s.get("motion"), "text": s.get("text", "")})
    texts.append(s.get("text", "") or "...")
    spans.append((start, end))

out = Path(tempfile.mkdtemp()) / "video.mp4"
t0 = time.time()
StudioEditor().edit(str(draft / "voiceover.wav"), scenes, estimate_word_timings(texts, spans), True, str(out))
print(f"seconds={time.time() - t0:.1f} size_mb={out.stat().st_size / 1024 / 1024:.1f}")
