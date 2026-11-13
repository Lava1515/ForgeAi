"""Word-cue timeline helpers (pure Python)."""
import json
import math

from .paths import require_abs

FPS = 30
LEAD = 0.35


def load_words(path):
    """Load words.json ({"dur": seconds, "words": [{"w","s","e"}, ...]}). Path must be absolute."""
    with open(require_abs(path), encoding="utf-8") as fh:
        return json.load(fh)


def cue(words, word, n=0, end=False, lead=LEAD):
    """Time of the n-th occurrence of word (its start, or end if end=True), plus lead."""
    k = 0
    for w in words["words"]:
        if w["w"].lower() == word.lower():
            if k == n:
                return (w["e"] if end else w["s"]) + lead
            k += 1
    raise KeyError(word)


def frame_count(words, fps=FPS, lead=LEAD, tail=1.5):
    return int((words["dur"] + lead + tail) * fps)


def current_shot(shots, t):
    """shots: list of (start_time, collection_name, fn) ascending; the one active at t."""
    cur = shots[0]
    for s in shots:
        if t >= s[0]:
            cur = s
    return cur


def apply_frame(f, shots, colls, fps=FPS):
    """Show only the active shot's collection and pose it. colls: name -> object with hide_render."""
    cur = current_shot(shots, f / fps)
    for name, c in colls.items():
        c.hide_render = (name != cur[1])
    cur[2](f / fps)
    return cur


def shot_frame_ranges(shots, nframes, fps=FPS):
    """[(name, first_frame, end_frame_exclusive)] for each shot."""
    out = []
    for i, s in enumerate(shots):
        a = int(math.ceil(s[0] * fps - 1e-9))
        b = int(math.ceil(shots[i + 1][0] * fps - 1e-9)) if i + 1 < len(shots) else nframes
        out.append((s[1], a, b))
    return out
