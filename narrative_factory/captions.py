"""Caption timing and TikTok-style punch subtitles (ASS) for the Studio editor."""

import math
import re

WHITE = "&H00FFFFFF"
EMBER = "&H001F5AFF"  # #FF5A1F in ASS &HAABBGGRR order
FONT = "Montserrat ExtraBold"

VIRAL_STYLE = "viral_v1"
BOX_SENTENCE_STYLE = "box_sentence"
BASE_SIZE = 86
MIN_SIZE = 48
SAFE_WIDTH = 920  # 1080 - MarginL 80 - MarginR 80: the width a caption line may use
LINE_HEIGHT = 1.2
BAND_TOP, BAND_BOTTOM = 1150, 1450  # bottom-aligned captions must sit inside this y range at 1080x1920
POP = r"\fscx115\fscy115\t(0,80,\fscx100\fscy100)"
POP_RESET = r"\fscx100\fscy100"
COUNTER_FONT = "Montserrat ExtraBold"
COUNTER_SIZE = 92
COUNTER_VALUE_COLOR = WHITE
COUNTER_UNIT_COLOR = EMBER
COUNTER_X, COUNTER_Y = 540, 420
COUNTER_STEPS = 12
COUNTER_SECONDS = 0.6
GAP_BREAK = 0.15  # shared onset-gap break used by caption_tail_v1 and captions_chunk3_v1


def ass_time(seconds: float) -> str:
    cs = int(round(max(0.0, seconds) * 100))
    h, cs = divmod(cs, 360000)
    m, cs = divmod(cs, 6000)
    s, cs = divmod(cs, 100)
    return f"{h}:{m:02d}:{s:02d}.{cs:02d}"


def _weight(word: str) -> float:
    """Rough speaking time of a word: letters plus a pause after punctuation."""
    w = len(re.sub(r"\W", "", word)) + 2
    if word.endswith((",", ";", ":")):
        w += 3
    elif word.endswith((".", "!", "?")):
        w += 5
    return w


def estimate_word_timings(scene_texts, spans):
    """The TTS gives no word timestamps; spread each scene's span over its words by weight."""
    words = []
    for text, (start, end) in zip(scene_texts, spans):
        tokens = text.split()
        total = sum(_weight(t) for t in tokens) or 1
        t = start
        for i, token in enumerate(tokens):
            nxt = end if i == len(tokens) - 1 else t + (end - start) * _weight(token) / total
            words.append({"text": token, "start": round(t, 3), "end": round(nxt, 3)})
            t = nxt
    return words


def chunk_words(words, max_words=4, min_words=2, pause_s=None):
    """2-4 word caption groups; a sentence end, or a comma after min_words words, closes a group."""
    chunks, current = [], []
    for i, w in enumerate(words):
        current.append(w)
        text = w["text"]
        pause = pause_s is not None and i + 1 < len(words) and words[i + 1]["start"] - w["end"] >= pause_s
        if len(current) >= max_words or text.endswith((".", "!", "?", ";", ":")) or (text.endswith(",") and len(current) >= min_words) or pause:
            chunks.append(current)
            current = []
    if current:
        chunks.append(current)
    return chunks


def _text_width(text, size=BASE_SIZE):
    return len(text) * size * 0.58  # Montserrat ExtraBold advance, same estimate as scripts/video_checks.js


def _hyphen_pieces(word):
    """Cut a compound after each hyphen, keeping the hyphen on the left piece."""
    parts = word.split("-")
    return [p for p in [part + "-" for part in parts[:-1]] + [parts[-1]] if p]


def _units(text):
    """The text as (piece, glue) units: words keep their space, a hyphenated compound may break after a hyphen."""
    units = []
    for word in text.split():
        for i, piece in enumerate(_hyphen_pieces(word)):
            units.append((piece, "" if i else " "))
    return units


def _lines(text, size=BASE_SIZE):
    """The lines the renderer shows: spaces wrap at the safe width, a compound breaks at its hyphens."""
    lines, current = [], ""
    for piece, glue in _units(text):
        trial = current + glue + piece if current else piece
        if current and _text_width(trial, size) > SAFE_WIDTH:
            lines.append(current)
            current = piece
        else:
            current = trial
    return lines + [current] if current else lines


def caption_fit(text, size=BASE_SIZE, max_lines=2):
    """Font size and rendered lines for one caption: shrink only when the hyphens cannot keep it in 2 safe lines."""
    lines = _lines(text, size)
    while size > MIN_SIZE and (len(lines) > max_lines or any(_text_width(line, size) > SAFE_WIDTH for line in lines)):
        size -= 2
        lines = _lines(text, size)
    return size, lines


def caption_box(lines, size, height=1920, margin_v=520):
    """Top and bottom y of a bottom-aligned caption box; viral_v1 keeps this inside the safe band."""
    bottom = height - margin_v
    return bottom - max(1, len(lines)) * size * LINE_HEIGHT, bottom


def _clean(text: str) -> str:
    # braces open ASS override blocks and backslashes start tags: never pass them through
    return text.replace("\\", "").replace("{", "(").replace("}", ")").upper()


TITLE_SECONDS = 1.5


def _rendered(word, size):
    return "\\N".join(_lines(_clean(word["text"]), size))


def _highlight(word, size, viral):
    """The active word in ember; viral_v1 also pops it in from 115% over 80 ms."""
    text = _rendered(word, size)
    if not viral:
        return f"{{\\c{EMBER}&}}{text}{{\\c{WHITE}&}}"
    return f"{{\\c{EMBER}&{POP}}}{text}{{\\c{WHITE}&{POP_RESET}}}"


# --- captions_v2 titles: entrance variants, dead-still landing, read-time hold, blur-out exit ---
TITLE_FRAC_BASE, TITLE_FRAC_MIN = 0.054, 0.04  # title height as a share of the frame: 4-9% allowed (77-173 px at 1920)
TITLE_VARIANTS = 3  # per-word blur-in, per-word grey-to-ink, whole-line blur-in
TITLE_GREY = "&H00A0A0A0"
HOLD_BASE, HOLD_PER_WORD, HOLD_LAST_MIN = 0.5, 0.3, 2.0  # seconds
EXIT_MS = 200  # blur-out and fade, inside the 130-250 ms window


def title_hold(word_count, last=False):
    """Seconds a title stays readable before its exit starts."""
    hold = HOLD_BASE + HOLD_PER_WORD * word_count
    return max(hold, HOLD_LAST_MIN) if last else hold


def _title_fit(text, height):
    """Font size and at most two lines: shrink to the 4% floor, then drop trailing words (ponytail: a long single word can still overflow)."""
    words = text.split()
    base, floor = round(TITLE_FRAC_BASE * height), math.ceil(TITLE_FRAC_MIN * height)
    while True:
        size = base
        lines = _lines(" ".join(words), size)
        while size > floor and (len(lines) > 2 or any(_text_width(l, size) > SAFE_WIDTH for l in lines)):
            size -= 2
            lines = _lines(" ".join(words), size)
        if len(lines) <= 2 or len(words) == 1:
            return size, lines
        words.pop()


def _title_event(text, start, variant, last, height):
    size, lines = _title_fit(text, height)
    hold = round(title_hold(len(text.split()), last) * 1000)
    exit_tag = rf"\t({hold},{hold + EXIT_MS},\alpha&HFF&\blur8)"
    out, n = [], 0
    for line in lines:
        toks = line.split()
        accent = max(range(len(toks)), key=lambda i: len(toks[i]))  # first of the longest: one accent word per line
        parts = []
        for i, tok in enumerate(toks):
            ink = EMBER if i == accent else WHITE
            if variant == 0:
                s = round(n * 67)
                tags = rf"\c{ink}&\alpha&HFF&\blur6\t({s},{s + 130},\alpha&H00&\blur0)"
            elif variant == 1:
                s = n * 80
                tags = rf"\c{TITLE_GREY}&\t({s},{s + 80},\c{ink}&)"
            else:
                tags = rf"\c{ink}&\alpha&HFF&\blur8\t(0,160,\alpha&H00&\blur0)"
            parts.append(f"{{{tags}{exit_tag}}}{tok}")
            n += 1
        out.append(" ".join(parts))
    body = "\\N".join(out)
    return f"Dialogue: 1,{ass_time(start)},{ass_time(start + hold / 1000 + EXIT_MS / 1000)},Title,,0,0,0,,{{\\fs{size}}}{body}"


def build_title_events(titles, height=1920):
    """One Title event per entry ({'text', 'start'}); the entrance variant rotates per title, the last title holds >= 2 s."""
    items = [(_clean(str(t.get("text", "")).strip()), float(t.get("start", 0))) for t in titles or []]
    items = [(text, start) for text, start in items if text]
    return [_title_event(text, start, i % TITLE_VARIANTS, i == len(items) - 1, height) for i, (text, start) in enumerate(items)]


def build_counter_events(stats, width=1080, height=1920):
    """Build ForgeAI's top-third value counters as stepped ASS events."""
    lines = []
    for stat in stats or []:
        try:
            start, end, value = float(stat["start"]), float(stat["end"]), float(stat["value"])
            unit = _clean(str(stat.get("unit", "")))
        except (KeyError, TypeError, ValueError):
            continue
        if not (math.isfinite(start) and math.isfinite(end) and math.isfinite(value) and start >= 0 and end > start):
            continue
        steps = min(COUNTER_STEPS, max(1, int(round(abs(value)))))
        count_end = min(end, start + COUNTER_SECONDS)
        count_duration = max(0.0, count_end - start)
        values = [value * i / steps for i in range(steps + 1)]
        values = [round(v) for v in values] if float(value).is_integer() else values
        values[-1] = int(value) if float(value).is_integer() else value  # exact final value, no float drift
        for i, shown in enumerate(values):
            event_start = start + count_duration * i / steps
            event_end = (start + count_duration * (i + 1) / steps) if i < steps else end
            if event_end <= event_start:
                continue
            value_text = (f"{shown:.4f}".rstrip("0").rstrip(".")) if isinstance(shown, float) else str(shown)
            text = (f"{{\\an8\\pos({COUNTER_X},{COUNTER_Y})\\fn{COUNTER_FONT}\\fs{COUNTER_SIZE}"
                    f"\\c{COUNTER_VALUE_COLOR}&}}{value_text}"
                    f"{{\\c{COUNTER_UNIT_COLOR}&}} {unit}")
            lines.append(f"Dialogue: 2,{ass_time(event_start)},{ass_time(event_end)},Counter,,0,0,0,,{text}")
    return lines


def build_stat_card_events(stats, width=1080, height=1920):
    """Build top-left two-line stat cards, stepping the value over ramp_s."""
    lines = []
    for stat in stats or []:
        try:
            start, end, value = float(stat["start"]), float(stat["end"]), float(stat["value"])
            unit = _clean(str(stat.get("unit", "")))
            meaning = _clean(str(stat.get("meaning", "")))
        except (KeyError, TypeError, ValueError):
            continue
        if not (math.isfinite(start) and math.isfinite(end) and math.isfinite(value) and start >= 0 and end > start):
            continue
        try:
            ramp = float(stat.get("ramp_s", COUNTER_SECONDS))
        except (TypeError, ValueError):
            ramp = COUNTER_SECONDS
        if not math.isfinite(ramp) or ramp <= 0:
            ramp = COUNTER_SECONDS
        count_end = min(end, start + ramp)
        steps = min(COUNTER_STEPS, max(1, int(round(abs(value)))))
        count_duration = count_end - start
        values = [value * i / steps for i in range(steps + 1)]
        values = [round(v) for v in values] if float(value).is_integer() else values
        values[-1] = int(value) if float(value).is_integer() else value
        for i, shown in enumerate(values[1:]):
            event_start = start + count_duration * i / steps
            event_end = (start + count_duration * (i + 1) / steps) if i + 1 < steps else end
            if event_end <= event_start:
                continue
            value_text = (f"{shown:.4f}".rstrip("0").rstrip(".")) if isinstance(shown, float) else str(shown)
            text = (f"{{\\an7\\pos(60,160)\\fn{COUNTER_FONT}\\fs{COUNTER_SIZE}\\bord4\\3c&H000000&"
                    f"\\c{COUNTER_VALUE_COLOR}&}}{value_text}{(' ' + unit) if unit else ''}"
                    f"\\N{{\\fs{COUNTER_SIZE * 0.42}}}{meaning}")
            lines.append(f"Dialogue: 2,{ass_time(event_start)},{ass_time(event_end)},Counter,,0,0,0,,{text}")
    return lines


def build_ass(words, width=1080, height=1920, title=None, style=None, stats=None, captions_v2=False, titles=None,
              caption_tail_v1=False, tail_end=None, suppress=None, stat_cards=False, caption_style=None,
              captions_chunk3_v1=False):
    """Punch captions; title (optional) shows big at the top for the first 1.5 s: the hook text and thumbnail frame.
    style='viral_v1' adds 1-3 word chunks and the pop on each active word.
    captions_v2 swaps the title for rotated entrance variants with read-time holds; `titles` ([{'text','start'}]) is
    shown under viral_v1 too, a plain `title` is still suppressed there. Flag off: output unchanged."""
    viral = style == VIRAL_STYLE
    counter_style = (f"Style: Counter,{COUNTER_FONT},{COUNTER_SIZE},{COUNTER_VALUE_COLOR},{COUNTER_VALUE_COLOR},&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,0,0,8,0,0,0,1\n"
                     if (viral or stat_cards) and stats else "")
    box_style = (f"Style: Box,{FONT},{BASE_SIZE},{WHITE},{WHITE},&H00000000,&H50000000,-1,0,0,0,100,100,0,0,3,0,0,2,80,80,400,1\n"
                 if caption_style == BOX_SENTENCE_STYLE else "")
    header = f"""[Script Info]
ScriptType: v4.00+
PlayResX: {width}
PlayResY: {height}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Punch,{FONT},{BASE_SIZE},{WHITE},{WHITE},&H00000000,&H64000000,-1,0,0,0,100,100,0,0,1,7,2,2,80,80,520,1
Style: Title,{FONT},104,{WHITE},{WHITE},&H00000000,&H64000000,-1,0,0,0,100,100,0,0,1,9,3,8,70,70,260,1
{counter_style}{box_style}
[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    lines = []
    if captions_v2:
        has_title = title and title.strip() and not viral
        lines.extend(build_title_events(titles or ([{"text": title, "start": 0}] if has_title else []), height))
    elif not viral and title and title.strip():
        lines.append(f"Dialogue: 1,{ass_time(0)},{ass_time(TITLE_SECONDS)},Title,,0,0,0,,{_clean(title.strip())}")
    if caption_style == BOX_SENTENCE_STYLE:
        sentences, current = [], []
        for word in words:
            current.append(word)
            if str(word.get("text", "")).rstrip().endswith((".", "!", "?")):
                sentences.append(current)
                current = []
        if current:
            sentences.append(current)
        visible_sentences = []
        for sentence in sentences:
            if caption_tail_v1 and suppress:
                sentence_words = {re.sub(r"\W", "", str(word.get("text", ""))).upper() for word in sentence}
                if any(
                    (label_word := re.sub(r"\W", "", str(item.get("text", ""))).upper())
                    and label_word in sentence_words
                    and sentence[0]["start"] <= item.get("end", 0) + 0.8
                    and sentence[-1]["end"] >= item.get("start", 0) - 0.8
                    for item in suppress
                ):
                    continue
            visible_sentences.append(sentence)
        for sentence_index, sentence in enumerate(visible_sentences):
            plain = " ".join(_clean(str(word.get("text", ""))) for word in sentence).strip()
            if not plain:
                continue
            size = caption_fit(plain)[0]
            # Greedily partition words so every event wraps to at most two lines.
            groups, group = [], []
            for word in sentence:
                candidate = group + [word]
                candidate_text = " ".join(_clean(str(item.get("text", ""))) for item in candidate).strip()
                if group and len(_lines(candidate_text, size)) > 2:
                    groups.append(group)
                    group = [word]
                else:
                    group = candidate
            if group:
                groups.append(group)
            total_words = len(sentence)
            word_offset = 0
            for group_index, group in enumerate(groups):
                group_text = " ".join(_clean(str(word.get("text", ""))) for word in group).strip()
                rendered = _lines(group_text, size)
                start = sentence[0]["start"] + (sentence[-1]["end"] - sentence[0]["start"]) * word_offset / total_words
                word_offset += len(group)
                end = sentence[0]["start"] + (sentence[-1]["end"] - sentence[0]["start"]) * word_offset / total_words
                if (sentence_index == len(visible_sentences) - 1 and group_index == len(groups) - 1
                        and caption_tail_v1 and tail_end is not None):
                    end = float(tail_end)
                text = "\\N".join(rendered)
                lines.append(f"Dialogue: 0,{ass_time(start)},{ass_time(end)},Box,,0,0,0,,{{\\fs{size}}}{text}")
    if captions_chunk3_v1:
        chunks = chunk_words(words, max_words=3, min_words=1, pause_s=GAP_BREAK)
    else:
        chunks = (chunk_words(words, max_words=3, min_words=1, pause_s=GAP_BREAK) if viral else chunk_words(words, pause_s=GAP_BREAK)) if caption_tail_v1 else (chunk_words(words, max_words=3, min_words=1) if viral else chunk_words(words))
    if caption_tail_v1 and suppress:
        def repeats_suppressed_word(chunk):
            chunk_words_upper = {re.sub(r"\W", "", word["text"]).upper() for word in chunk}
            for item in suppress:
                label_word = re.sub(r"\W", "", str(item.get("text", ""))).upper()
                if not label_word or label_word not in chunk_words_upper:
                    continue
                start, end = item.get("start", 0) - 0.8, item.get("end", 0) + 0.8
                if chunk[0]["start"] <= end and chunk[-1]["end"] >= start:
                    return True
            return False
        chunks = [chunk for chunk in chunks if not repeats_suppressed_word(chunk)]
    for chunk in ([] if caption_style == BOX_SENTENCE_STYLE else chunks):
        size = caption_fit(" ".join(_clean(w["text"]) for w in chunk))[0]
        head = f"{{\\fs{size}}}" if size != BASE_SIZE else ""
        for i, active in enumerate(chunk):
            end = chunk[i + 1]["start"] if i + 1 < len(chunk) else active["end"]
            if caption_tail_v1 and tail_end is not None and chunk is chunks[-1] and i + 1 == len(chunk):
                end = float(tail_end)
            text = " ".join(
                _highlight(w, size, viral) if w is active else _rendered(w, size)
                for w in chunk
            )
            lines.append(f"Dialogue: 0,{ass_time(active['start'])},{ass_time(end)},Punch,,0,0,0,,{head}{text}")
    if stat_cards:
        lines.extend(build_stat_card_events(stats, width, height))
    elif viral:
        lines.extend(build_counter_events(stats, width, height))
    return header + "\n".join(lines) + "\n"
