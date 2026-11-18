"""Word-by-word captions for code-built shorts (CB4 / KAN-913).

Copied and generalised from the chat's post.py (gum-short-v2, earth-stop-short): grouping, the active-word highlight, the pop-in,
placement. New here: sizes scale with the frame, a safe-zone check that every placed caption must pass, and cue timing for the .srt.

Reuse: the side margin comes from narrative_factory.captions.SAFE_WIDTH (the ASS editor's 920 px line width at 1080), so both caption
paths keep the same left and right margins. The grouping rule is not shared on purpose: captions.chunk_words closes on a comma only
after two words and has no 13-character cap, while the chat shorts close on any punctuation.
"""
import json
import os

from PIL import Image, ImageDraw, ImageFont

from narrative_factory.captions import SAFE_WIDTH   # reused: side margins of the existing caption path (1080 - 2 * 80)

PAUSE = 0.45            # seconds of silence between words that closes a group
MAX_WORDS = 3
MAX_CHARS = 13
BASE_W, BASE_H = 1080, 1920
FONT_PX = 112            # at 1080 wide
CAPTION_CY = 1400        # caption centre line at 1920 high
POP = 1.18               # largest pop-in scale
SAFE_TOP, SAFE_BOTTOM = 220, 380      # px kept clear at the top and bottom at 1920 high (feed UI, buttons)
LEAD_IN = 0.04           # captions appear this much before the word is heard
TAIL = 0.45
ACTIVE, PLAIN = (255, 225, 0, 255), (255, 255, 255, 255)
_FONT_FILES = (r"C:\Windows\Fonts\impact.ttf", r"C:\Windows\Fonts\arialbd.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
               "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf", "/Library/Fonts/Arial Bold.ttf")


def load_words(path):
    """words.json as the chat wrote it: {"dur": seconds, "words": [{"w", "s", "e", optional "punct"}]}. Returns (dur, words)."""
    with open(path, encoding="utf-8") as fh:
        data = json.load(fh)
    words = data["words"]
    last = -1.0
    for i, w in enumerate(words):
        if not isinstance(w.get("w"), str) or not w["w"] or not (0 <= w["s"] <= w["e"]) or w["s"] < last - 1e-6:
            raise ValueError(f"words.json word {i} has no text or out-of-order timing")
        last = w["s"]
    return float(data.get("dur", words[-1]["e"] if words else 0.0)), words


_TRAIL = ".,;:!?…—–-)]}\"”’"      # punctuation that may trail a word (or stand alone as a token) and belongs to the word before it
_CLOSE = ".,;:!?…—–"            # of those, the marks that end a caption group (a hyphen or a bracket does not)


def split_word(w):
    """(core, punct) of one word entry: whitespace trimmed, trailing marks in the text moved to `punct`, no mark doubled."""
    text = w["w"].strip()
    core = text.rstrip(_TRAIL)
    trail = text[len(core):]
    extra = (w.get("punct") or "").strip()
    if extra and not trail.endswith(extra):
        trail += extra
    return core, trail


def normalize_words(words):
    """Copies of the words with clean text and punctuation. A token that is only punctuation joins the word before it."""
    out = []
    for w in words:
        core, punct = split_word(w)
        if not core:
            if out and punct:
                out[-1]["punct"] += punct
                out[-1]["e"] = max(out[-1]["e"], w["e"])
            continue
        out.append({**w, "w": core, "punct": punct})
    return out


def display_words(chunk):
    """The text shown for each word of a group, punctuation included. The picture and the .srt both use this."""
    return [core + punct for core, punct in map(split_word, chunk)]


def group_words(words, pause=PAUSE, max_words=MAX_WORDS, max_chars=MAX_CHARS):
    """Groups close on a mark such as , . ! ?, a pause longer than 0.45 s to the next word, 3 words, or 13 letters (marks not counted)."""
    words = normalize_words(words)
    chunks, cur = [], []
    for i, w in enumerate(words):
        cur.append(w)
        gap = round(words[i + 1]["s"] - w["e"], 3) if i + 1 < len(words) else None
        if any(c in _CLOSE for c in w["punct"]) or (gap is not None and gap > pause) or len(cur) >= max_words                 or sum(len(x["w"]) for x in cur) >= max_chars:
            chunks.append(cur)
            cur = []
    if cur:
        chunks.append(cur)
    return chunks


def cues(chunks, lead=0.0):
    """Subtitle cues, one per group. A cue ends 0.15 s after its last word or 10 ms before the next cue, whichever is first."""
    out = []
    for i, ch in enumerate(chunks):
        start, end = ch[0]["s"] + lead, ch[-1]["e"] + lead + 0.15
        if i + 1 < len(chunks):
            end = min(end, chunks[i + 1][0]["s"] + lead - 0.01)
        end = max(end, start + 0.01)
        out.append({"start": start, "end": end, "text": " ".join(display_words(ch))})
    return out


def load_font(px, files=None):
    for f in files or _FONT_FILES:
        if os.path.isfile(f):
            return ImageFont.truetype(f, px)
    return ImageFont.load_default(px)


def font_for(width):
    return load_font(max(8, round(FONT_PX * width / BASE_W)))


def layer(chunk, active, font, style="classic"):
    """RGBA picture of one group with word `active` highlighted. Upper case, thick black outline, 40 px padding at 1080 wide."""
    scale = font.size / (92 if style == "overlay" else FONT_PX)
    pad, stroke = round(40 * scale), max(1, round(11 * scale))
    if style == "overlay":
        stroke = max(1, round(10 * scale))
    words = [x.upper() for x in display_words(chunk)]
    space = font.getlength(" ")
    widths = [font.getlength(x) for x in words]
    total = sum(widths) + space * (len(widths) - 1)
    h = round(220 * scale)
    im = Image.new("RGBA", (int(total) + 2 * pad, h), (0, 0, 0, 0))
    d, x = ImageDraw.Draw(im), pad
    for i, (wd, wl) in enumerate(zip(words, widths)):
        yellow = i <= active and keyword(chunk[i]) if style == "overlay" else i == active
        color = (255, 214, 10, 255) if style == "overlay" else ACTIVE
        d.text((x, h // 2), wd, font=font, anchor="lm", fill=color if yellow else PLAIN, stroke_width=stroke, stroke_fill=(0, 0, 0, 255))
        x += wl + space
    return im


def _fit(im, k, width, height, style="classic"):
    """Scale a layer by the pop factor, then shrink it so it fits the safe width. Returns the final size."""
    w, h = round(im.width * k), round(im.height * k)
    limit = round(SAFE_WIDTH * width / BASE_W)
    if style == "overlay":
        # Fit before rounding: double rounding can make an intermediate pop taller than its envelope.
        factor = min(k, limit / im.width)
        return max(1, round(im.width * factor)), max(1, round(im.height * factor))
    if w > limit:
        h, w = round(h * limit / w), limit
    return w, h


def place(chunk, active, font, width, height, pop=1.0, style="classic"):
    """The box (x, y, w, h) a group occupies on the frame at pop-in scale `pop`; the same maths the renderer uses."""
    w, h = _fit(layer(chunk, active, font, style), pop, width, height, style)
    cy = round((1354 if style == "overlay" else CAPTION_CY) * height / BASE_H)
    return ((width - w) // 2, cy - h // 2, w, h)


def safe_zone(width, height):
    """(left, top, right, bottom) in px. Sides use the existing caption path's margins; top and bottom keep the feed UI clear."""
    side = round((BASE_W - SAFE_WIDTH) / 2 * width / BASE_W)
    return side, round(SAFE_TOP * height / BASE_H), width - side, height - round(SAFE_BOTTOM * height / BASE_H)


def inside_safe_zone(box, width, height):
    x, y, w, h = box
    left, top, right, bottom = safe_zone(width, height)
    return x >= left and y >= top and x + w <= right and y + h <= bottom


class Track:
    """Which group, which active word and which pop scale show at time t. Layers are cached per (group, active word)."""

    def __init__(self, words, width, height, lead=0.0, font=None, style="classic"):
        if style not in ("classic", "overlay"):
            raise ValueError("unknown caption style")
        self.style = style
        chunks = group_words(words, pause=float("inf"), max_chars=float("inf")) if style == "overlay" else group_words(words)
        self.chunks, self.lead, self.width, self.height = chunks, lead, width, height
        self.font = font or (load_font(max(8, round(92 * width / BASE_W)),
                            (r"C:\Windows\Fonts\ariblk.ttf",) + _FONT_FILES) if style == "overlay" else font_for(width))
        self._cache = {}

    def at(self, t):
        lead_in, tail = (0.03, 0.35) if self.style == "overlay" else (LEAD_IN, TAIL)
        for ci, ch in enumerate(self.chunks):
            s, e = ch[0]["s"] + self.lead - lead_in, ch[-1]["e"] + self.lead
            nxt = self.chunks[ci + 1][0]["s"] + self.lead - lead_in if ci + 1 < len(self.chunks) else e + 0.5
            if s <= t < min(nxt, e + tail):
                act = max([i for i, x in enumerate(ch) if x["s"] + self.lead - lead_in <= t] or [0])
                if self.style == "overlay":
                    # Words turn yellow only once heard, even during the group's lead-in.
                    act = max([i for i, x in enumerate(ch) if x["s"] + self.lead <= t] or [-1])
                    return ci, act, overlay_pop(t - s)
                return ci, act, 1.0 + (POP - 1.0) * max(0.0, 1 - (t - s) / 0.1)
        return None

    def draw(self, im, t):
        """Paste the caption for time t onto a PIL RGB image. Returns the box used, or None."""
        hit = self.at(t)
        if hit is None:
            return None
        ci, act, k = hit
        if (ci, act) not in self._cache:
            self._cache[(ci, act)] = layer(self.chunks[ci], act, self.font, self.style)
        base = self._cache[(ci, act)]
        w, h = _fit(base, k, self.width, self.height, self.style)
        L = base if (w, h) == base.size else base.resize((w, h), Image.LANCZOS)
        box = place(self.chunks[ci], act, self.font, self.width, self.height, k, self.style)
        im.paste(L, (box[0], box[1]), L)
        return box

    def worst_boxes(self):
        """Every group and active word at the largest pop scale; the safe-zone audit runs on these."""
        return [self.box(ci, a) for ci, ch in enumerate(self.chunks) for a in range(len(ch))]

    def box(self, ci, active):
        """Conservative pop envelope, shared by layout checks and the renderer."""
        return place(self.chunks[ci], active, self.font, self.width, self.height,
                     1.031 if self.style == "overlay" else POP, self.style)


# Taken, not asked: generic content words/numbers, with per-word explicit emphasis overriding the heuristic.
# No topic bank. Function words stay white; a keyword stays yellow after it is spoken.
_FUNCTION_WORDS = frozenset("this that these those with from into onto over under then than when where what which who "
                            "have has had been being were was are will would could should can may might must "
                            "they them their there here your you ours our its it's isn't doesn't don't just also "
                            "only very even more most some such about after before because through while".split())


def keyword(word):
    if isinstance(word.get("emphasis"), bool):
        return word["emphasis"]
    core = split_word(word)[0].casefold()
    return any(c.isdigit() for c in core) or (len(core) >= 4 and core not in _FUNCTION_WORDS)


def overlay_pop(elapsed):
    """70% grow-in, 0.16 seconds, ease-out-back (maximum below 1.031)."""
    u = min(1.0, max(0.0, elapsed / 0.16)) - 1.0
    return 0.7 + 0.3 * (1 + 2.70158 * u ** 3 + 1.70158 * u ** 2)
