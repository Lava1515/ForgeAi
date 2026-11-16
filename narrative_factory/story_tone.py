#!/usr/bin/env python3
"""
Story Tone & Dynamic Vocal Emotion Engine for ForgeAI (Qwen3-TTS).
Provides:
1. Inline tag extraction ([curious], [climax], etc.) and stage direction stripping
2. Story arc tone progression (Hook -> Intrigue -> Escalation -> Climax -> Resolution)
3. Themed modulation through base style presets (suspense, enthusiastic, documentary, etc.)
4. Delivery sanitizing and normalization (every explicit beat retains its feeling)
5. TimedSentence tuple helper preserving backward compatibility with (sentence, start, end).
"""

from __future__ import annotations

import re
from typing import List, Tuple, Optional

# Every line is read by one natural narrator; the tag/arc/planner text only adds a light feeling on top.
# Positive wording only: Qwen3 follows the words it sees, so "no whispering" / "relaxed" made it whisper and drag (~1.3 words/s).
NARRATOR = "confident storyteller speaking clearly at full normal volume and a brisk, natural pace, engaged and expressive"

# Acted-delivery, hush/slow words, and leaked semantic phrases stripped from tags and planner directions.
_EFFECT_WORDS = re.compile(
    r"\b("
    r"whisper\w*|breath\w*|hush\w*|gasp\w*|sigh\w*|moan\w*|scream\w*|shout\w*|yell\w*|explosive|explosion|"
    r"staccato|aggressive|ecstatic|conspiratorial|close mic|lean(?:ing)? in|shock\w*|stunned|loud|punch\w*|"
    r"intimate|quiet\w*|soft\w*|(?:a (?:bit|little) )?slow\w*|drop in pitch|leaner volume|rising tension|"
    r"(?:delicate\s+)?acoustic\s+weight|delicate|decelerat\w*|(?:auditory\s+)?braking|awe-struck(?:\s+pause)?|"
    r"(?:solemn\s+)?reverence|solemn|building dread|breathless(?:\s+pause)?|lingering(?:\s+finality)?|"
    r"pre-collapse(?:\s+tension)?|system breach(?:\s+whisper)?|chilling(?:\s+cadence\s+stretch)?|cadence stretch|"
    r"slight drop|\bdrop\b|tense(?:\s+anticipation|\s+of\s+pace|\s+pause|\s+revelation)?|more personal"
    r")\b",
    re.I,
)


def sanitize_delivery(delivery: Optional[str]) -> str:
    """Strips acted-delivery and hush/slow words and phrases from a delivery string."""
    if not delivery:
        return ""
    cleaned = _EFFECT_WORDS.sub("", str(delivery))
    cleaned = re.sub(r"\s*,\s*(,\s*)+", ",", cleaned)
    cleaned = re.sub(r"\s+", " ", cleaned).strip(" ,;.")
    return cleaned[:200]


# E1b (owner order 2026-11-15): the script gives every shot one feel word; the voice call forwards it as that shot's delivery.
# Mild wording only, positive words only (see NARRATOR). Every hint must survive sanitize_delivery: "punchline" would be cut, so it is not used.
FEEL_HINTS = {
    "curious": "curious, interested",
    "intrigued": "intrigued, interested",
    "building": "building interest",
    "surprised": "mildly surprised",
    "amazed": "bright, impressed, a smile in the voice, landing the final line",
    "playful": "light, amused",
    "satisfied": "warm, confident, pleased",
    "tense": "focused, suspenseful anticipation",
    "worried": "concerned, emotionally invested",
    "urgent": "urgent, focused, brisk emphasis",
    "awed": "wonder and admiration, impressed",
    "funny": "light, amused, playful",
}


def feel_hint(delivery: Optional[str]) -> str:
    """A feel word (curious, intrigued, building, surprised, amazed, playful, satisfied) becomes its narrator hint.
    Anything else (a planner's free-text direction, an empty value) is returned unchanged, so older callers behave as before."""
    if delivery is None:
        return ""
    text = str(delivery)
    return FEEL_HINTS.get(text.strip().lower(), text)


# codex · gpt-6.1-sol · 2026-11-16 08:59 +02:00: retain middle-beat feelings, not just hook and ending.
def normalize_deliveries(
    directions: Optional[List[Optional[str]]],
    total_scenes: Optional[int] = None,
) -> List[str]:
    """
    Sanitizes and retains each beat's delivery so the narration can carry the selected feeling throughout.
    """
    if not directions:
        n = total_scenes or 0
        return ["" for _ in range(n)]

    total = total_scenes or len(directions)
    cleaned = [sanitize_delivery(feel_hint(d)) for d in directions[:total]]
    while len(cleaned) < total:
        cleaned.append("")

    return cleaned


def narrator(mood: str) -> str:
    """Wraps a mood hint into the one narrator instruction every sentence gets."""
    mood = sanitize_delivery(mood)
    return f"{NARRATOR}, a touch of: {mood}" if mood else NARRATOR


# Supported inline emotion tags and their Qwen3 mood hints (all mild, no speed/volume manipulation)
EMOTION_TAGS = {
    "hook": "confident, engaging opening",
    "curious": "curious, interested",
    "intrigue": "intrigued, interested",
    "wonder": "gentle wonder",
    "tense": "slightly serious",
    "suspense": "slightly serious",
    "escalation": "building interest",
    "intense": "serious, focused",
    "dramatic": "serious, with weight",
    "shocked": "mildly surprised",
    "climax": "clear emphasis on the key point",
    "somber": "calm and serious",
    "reflective": "thoughtful, reflective",
    "excited": "upbeat, warm energy",
    "enthusiastic": "upbeat, warm energy",
    "eerie": "slightly mysterious",
    "calm": "calm, even",
    "casual": "casual, friendly",
    "authoritative": "confident, assured",
    "playful": "light, playful",
    "urgent": "focused",
    "urgency": "focused",
}

# Themed mood progressions across the 5 story arc stages (kept mild, varying only slightly)
THEMED_ARCS = {
    "suspense": [
        "confident opening, slightly mysterious",
        "curious, interested",
        "slightly serious",
        "clear emphasis on the key point",
        "calm, thoughtful close",
    ],
    "enthusiastic": [
        "upbeat, engaging opening",
        "warm, interested",
        "building interest",
        "pleased, clear emphasis",
        "warm, friendly close",
    ],
    "documentary": [
        "confident, assured opening",
        "measured, interested",
        "serious, focused",
        "clear emphasis on the key point",
        "calm, thoughtful close",
    ],
    "viral_hook": [
        "confident, engaging opening",
        "lively, interested",
        "building interest",
        "clear emphasis on the key point",
        "friendly, curious close",
    ],
    "mystery": [
        "engaging opening, gentle wonder",
        "curious, interested",
        "slightly mysterious",
        "clear emphasis on the key point",
        "thoughtful, open-ended close",
    ],
    "default": [
        "confident, engaging opening",
        "curious, interested",
        "building interest, slightly serious",
        "clear emphasis on the key point",
        "bright, confident payoff, a smile in the voice",
    ],
}

DEFAULT_INSTRUCT = THEMED_ARCS["default"][1]  # curious, interested

# Uniform temperature across all sentences to prevent batch-boundary averaging skew
DEFAULT_TEMPERATURE = 0.31
STAGE_TEMPERATURES = [0.31, 0.31, 0.31, 0.31, 0.31]
DIRECTED_TEMPERATURE = 0.31


class TimedSentence(tuple):
    """
    3-tuple (text, start, end) that behaves identically to standard tuples
    for backward-compatible unpacking, while providing .tone attribute.
    """
    def __new__(cls, text: str, start: float, end: float, tone: str = ""):
        return super().__new__(cls, (text, start, end))

    def __init__(self, text: str, start: float, end: float, tone: str = ""):
        self.tone = tone


def parse_inline_tags(text: str) -> Tuple[str, Optional[str]]:
    """
    Extracts inline tone tags like [curious] or [hook] from sentence text,
    and strips bracketed tags and stage directions in parentheses like (whispering), (gasps), (sighs).
    Returns (cleaned_text, detected_tag_or_instruction).
    """
    # Clean parentheses stage directions: e.g. (whispering), (gasps), (sighs), (pause)
    stage_dir_pattern = r"\((?:stage\s+direction\w*|whisper\w*|gasp\w*|sigh\w*|pause\w*|dramatic\s+pause|clears?\s+throat|breathing|softly)\)"
    text = re.sub(stage_dir_pattern, "", text, flags=re.I)

    pattern = r"\[([a-zA-Z0-9_\-:\s]+)\]"
    match = re.search(pattern, text)
    if not match:
        cleaned = re.sub(r"\s+", " ", text).strip()
        cleaned = re.sub(r"\s+([.,!?;:])", r"\1", cleaned)
        return cleaned, None

    raw_tag = match.group(1).strip().lower()
    if raw_tag.startswith("tone:"):
        raw_tag = raw_tag[5:].strip()

    # Clean the sentence so the model never speaks the bracketed tag
    cleaned = re.sub(pattern, "", text).strip()
    cleaned = re.sub(r"\s+", " ", cleaned)
    cleaned = re.sub(r"\s+([.,!?;:])", r"\1", cleaned)

    # Whisper/gasp/sigh are stripped completely
    if any(k in raw_tag for k in ["whisper", "gasp", "sigh"]):
        return cleaned, None

    # Resolve tag to rich prompt if known
    instruct = EMOTION_TAGS.get(raw_tag, raw_tag if len(raw_tag) > 3 else None)
    if instruct:
        instruct = sanitize_delivery(instruct)
    return cleaned, instruct if instruct else None


def detect_base_theme(instruct: Optional[str]) -> str:
    """Detects which themed arc matches the given instruct string."""
    if not instruct:
        return "default"
    inst_lower = instruct.lower()
    if any(k in inst_lower for k in ["suspense", "whisper", "dread", "dark"]):
        return "suspense"
    if any(k in inst_lower for k in ["enthusiastic", "upbeat", "vibrant", "excited"]):
        return "enthusiastic"
    if any(k in inst_lower for k in ["documentary", "authoritative", "grave", "history"]):
        return "documentary"
    if any(k in inst_lower for k in ["viral", "punchy", "retention", "fast"]):
        return "viral_hook"
    if any(k in inst_lower for k in ["mystery", "eerie", "hypnotic", "cosmic"]):
        return "mystery"
    return "default"


def compute_story_arc_tones(
    sentences: List[str],
    base_instruct: Optional[str] = None,
    dynamic: bool = True,
    directions: Optional[List[Optional[str]]] = None,
) -> List[Tuple[str, str, float]]:
    """
    Calculates the appropriate vocal tone instruction and temperature for each sentence.
    When directions or inline tags are passed, collects them into a single list and normalizes
    them so every sentence retains its beat's sanitized feeling.
    When dynamic story arc fallback is used, instructions vary only slightly and temperatures
    remain uniform at 0.31.
    Returns a list of (cleaned_sentence, instruct_string, temperature).
    """
    if not sentences:
        return []

    total = len(sentences)
    parsed = [parse_inline_tags(s) for s in sentences]
    cleaned_sentences = [p[0] for p in parsed]
    inline_tags = [p[1] for p in parsed]

    # Collect inline tags and planner directions into ONE candidate list.
    # Inline tags win over directions for the same sentence.
    has_explicit = (directions is not None) or any(inline_tags)
    if has_explicit:
        candidates = []
        for idx in range(total):
            tag = inline_tags[idx]
            if tag:
                candidates.append(tag)
            elif directions is not None and idx < len(directions) and directions[idx]:
                candidates.append(directions[idx])
            else:
                candidates.append("")
        normed_dirs = normalize_deliveries(candidates, total_scenes=total)
        return [(cleaned_sentences[i], narrator(normed_dirs[i]), DEFAULT_TEMPERATURE) for i in range(total)]

    # If dynamic story arc is disabled and base_instruct is provided, use static narrator instruct
    if not dynamic and base_instruct:
        return [(cleaned, narrator(base_instruct), DEFAULT_TEMPERATURE) for cleaned in cleaned_sentences]

    # Fallback Story Arc progression (only when no planner directions or inline tags are supplied)
    theme_key = detect_base_theme(base_instruct)
    arc = THEMED_ARCS.get(theme_key, THEMED_ARCS["default"])

    results = []
    for idx, cleaned in enumerate(cleaned_sentences):
        progress = idx / max(1, total - 1)
        if progress < 0.15:
            stage_idx = 0  # Hook
        elif progress < 0.40:
            stage_idx = 1  # Intrigue / Context
        elif progress < 0.70:
            stage_idx = 2  # Escalation / Tension
        elif progress < 0.88:
            stage_idx = 3  # Climax / Revelation
        else:
            stage_idx = 4  # Resolution / Outro
        stage_instruct = arc[stage_idx]

        # Punctuation-aware vocal modulation (only for algorithmic fallback arc)
        end = cleaned.rstrip("\"')”’")
        if end.endswith("?"):
            stage_instruct = f"{stage_instruct}, natural question intonation"
        elif end.endswith("!"):
            stage_instruct = f"{stage_instruct}, a little more emphasis"
        elif end.endswith("...") or end.endswith("…"):
            stage_instruct = f"{stage_instruct}, short pause before the next line"

        # If user passed a custom base_instruct that wasn't in THEMED_ARCS, blend it
        if base_instruct and theme_key == "default" and base_instruct.strip() != DEFAULT_INSTRUCT:
            stage_instruct = f"{stage_instruct} ({base_instruct.strip()})"

        results.append((cleaned, narrator(stage_instruct), DEFAULT_TEMPERATURE))

    return results
