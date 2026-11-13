"""
Narrative Factory - Script & Story Generator
Uses Gemini to generate structured voiceover scripts + visual image prompts.
Fallback to local text parsing if no API key or API call fails.
"""

from __future__ import annotations

import os
import re
import json
import urllib.request
import urllib.error
import time

from comfy_client import _request_json
from config import service_token
from logs import get_logger
from story_tone import normalize_deliveries

log = get_logger("gemini")
from typing import Dict, Any, List, Optional


def mask_prompt(text, limit: int = 80) -> str:
    """The log buffer is forwarded to the dashboard drawer: log the opening of a prompt, never the whole brief."""
    flat = " ".join(str(text or "").split())
    return flat if len(flat) <= limit else f"{flat[:limit]}... [{len(flat) - limit} more chars not logged]"

# Spoken pace for Qwen3 TTS, pauses included: ~2.0 words/second (measured 2026-10-11; the old 2.6 doubled video length)
# Keep in step with WORDS_PER_SECOND in dashboard/server/routes/studioPlan.js
WORDS_PER_SECOND = 2.0

# Scene-prompt styles for script_from_text (fallback when offline / using custom script)
STYLES = {
    "stickman": "minimalist black ink stick figure on clean plain white paper background, whiteboard animation sketch style, simple clean line art",
    "cinematic": "cinematic lighting, photorealistic, 8k, volumetric rays, dramatic depth of field, 9:16 vertical composition",
}

# Spoken-delivery rules; tts_engine.PAUSES sizes the pauses from this punctuation.
# Same rules as VOICE_RULES in dashboard/server/routes/studioPlan.js; keep the two in step.
VOICE_RULES = """   - Write for the ear: one idea per sentence. Most sentences 4-12 words; after a long sentence, hit with a short one. Never over 20 words.
   - Sentence 1 is the hook, under 10 words: a bold claim, a shocking fact or a sharp question. It must also work as on-screen text.
   - Punctuation is the delivery. "." = full stop and a breath. "," = a quick breath. "?" = opens a loop and lets it land. "..." = a dramatic beat right before a reveal (at most once every 15 seconds). An em dash = a sudden turn mid-sentence.
   - No semicolons, parentheses, emojis, hashtags, or stage directions like [pause]. The punctuation already does it.
   - End each sentence on its stress word. Use contractions and plain spoken words; write numbers the way they are said.
   - Structure it as HOOK -> PROGRESSION -> CLIMAX:
     HOOK: sentence 1 introduces the topic and raises questions, but never gives the answer away. Front-load the shocking anomaly or consequence ("The What"), while strictly withholding the explanation ("The How").
     PROGRESSION: every beat keeps the hook's promise and escalates; open loops and cognitive closure tension (Zeigarnik Effect). Maintain a relentless dopamine anticipation ramp without early reveals or detours.
     CLIMAX: the payoff the viewer waited for, only in the last ~15% of the script; the last line echoes the hook or creates an open syntactic loop bridge so the video loops seamlessly."""

# Overrides any whisper/acting asks in channel rules; story_tone.narrator() enforces the same at synthesis.
NARRATOR_DELIVERY = (
    "One confident, natural narrator speaking clearly at full normal conversational volume and a steady pace throughout. "
    "Never whisper, slow down, shout, or act out theatrical emotions; at most one deliberate tone change per video (hook or climax)."
)

# Psychology-proven vocal retention rules for short-form audio
PSYCHOLOGICAL_RETENTION_RULES = """PSYCHOLOGICAL VOCAL RETENTION RULES:
1. STEADY VOCAL DELIVERY:
   One confident, natural narrator speaking clearly at full normal conversational volume and a brisk, steady pace throughout.
   Short, clear sentences. Never whisper, slow down, shout, or act out theatrical emotions.
2. HOOK & CLIMAX EMPHASIS:
   Sentence 1 (The Hook) and the climax get confident, clear emphasis on the key words, never shouted.
   Maintain steady natural momentum on all intermediate sentences. At most ONE deliberate tone change per video (hook or climax).
3. THE ZEIGARNIK EFFECT & SUSPENSIVE RISE:
   On questions, clues, or open curiosity loops, end on a sustained mid-tone or slight upward inflection.
   This holds active working memory in the brain. Never sound final until the very end.
4. SEAMLESS INFINITE LOOP STITCHING (Linguistic & Syntactic Loop Bridge):
   Structure the closing sentence so its final words seamlessly bridge syntactically and rhythmically into Sentence 1 (The Hook) without a conclusive terminal pitch drop (e.g., "...and that is the exact reason why..." flowing into the hook). Viewers do not register the video ended and watch 2-5 seconds into the second loop, pushing completion rate over 100%.
5. THE PAYOFF GAP & INFORMATION GAP (The "What" vs. The "How"):
   Front-load Sentence 1 (The Hook) with the extraordinary result, anomaly, or high-stakes consequence ("The What"), while strictly withholding the underlying cause, solution, or mechanism ("The How") until the final beats to prevent premature drop-off."""


def sanitize_psychology_rules(rules: Optional[str]) -> str:
    """
    Sanitizes channel voiceover psychology rules for LLM prompts.
    Replaces known old base rules (marked by 'CONTRAST IS MANDATORY', 'CONSPIRATORIAL DROP', etc.)
    with PSYCHOLOGICAL_RETENTION_RULES, and strips rule blocks asking for whispers/deceleration.
    """
    if not rules or not str(rules).strip():
        return PSYCHOLOGICAL_RETENTION_RULES

    text = str(rules).strip()
    if re.search(r"CONTRAST IS MANDATORY|CONSPIRATORIAL DROP|AUDITORY BRAKING|system breach whisper", text, re.I):
        return PSYCHOLOGICAL_RETENTION_RULES

    whisper_pattern = re.compile(r"(?<!never\s)(?<!no\s)(?:whisper\w*|conspiratorial|decelerat\w*|staccato)", re.I)
    if whisper_pattern.search(text):
        blocks = re.split(r"\n\s*\n", text)
        filtered = [b for b in blocks if not whisper_pattern.search(b)]
        text = "\n\n".join(filtered).strip()
        if not text:
            return PSYCHOLOGICAL_RETENTION_RULES

    return text


def script_from_text(text: str, title: str | None = None, style: str = "stickman") -> Dict[str, Any]:
    """
    Turns a user-supplied script into the same shape Gemini returns, without any API call.
    Sentences are grouped into ~10s scenes (1-30); each scene's narration doubles as its image prompt.
    """
    full_script = " ".join(text.split())
    sentences = re.split(r"(?<=[.!?])\s+", full_script) if full_script else []
    words = len(full_script.split())
    n = min(30, max(1, round(words / WORDS_PER_SECOND / 10)), len(sentences) or 1)

    target = words / n
    chunks, current = [], []
    for sentence in sentences:
        current.append(sentence)
        remaining = len(sentences) - sum(len(c) for c in chunks) - len(current)
        if len(chunks) < n - 1 and (len(" ".join(current).split()) >= target or remaining < n - 1 - len(chunks)):
            chunks.append(current)
            current = []
    if current:
        chunks.append(current)

    style_suffix = STYLES.get(style, STYLES["stickman"])
    scenes = [
        {"scene_number": i, "narration": " ".join(c), "image_prompt": f"{' '.join(c)} — {style_suffix}", "delivery": ""}
        for i, c in enumerate(chunks, 1)
    ]
    return {
        "title": title or " ".join(full_script.split()[:6]),
        "hook": sentences[0] if sentences else "",
        "full_script": full_script,
        "scenes": scenes,
    }


# Delivery notes are one short phrase per sentence: start on flash-lite so they never use the script model's quota.
LITE_MODELS = ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite"]


class ScriptGenerator:
    def __init__(self, api_key: str | None = None):
        raw_key = api_key or os.getenv("GEMINI_API_KEYS") or os.getenv("GEMINI_API_KEY", "")
        self.api_keys: List[str] = [k.strip() for k in re.split(r"[,;\n\r]+", raw_key) if k.strip()]
        self.key_index = 0

    @property
    def api_key(self) -> str:
        if not self.api_keys:
            return ""
        return self.api_keys[self.key_index % len(self.api_keys)]

    def _call_gemini_json(self, prompt: str, timeout: float = 25.0, models: Optional[List[str]] = None) -> Dict[str, Any]:
        """Calls Gemini API with automatic fallback between working models and parses the returned JSON string."""
        if models is None:
            # Strictly ordered fallback list: 3.8-flash -> 3.6-flash -> 3.5-flash -> 3.5-flash-lite -> 3.1-flash-lite
            models = [
                "gemini-3.8-flash",
                "gemini-3.6-flash",
                "gemini-3.5-flash",
                "gemini-3.5-flash-lite",
                "gemini-3.1-flash-lite",
            ]
            env_model = os.getenv("GEMINI_MODEL")
            if env_model and env_model not in models and env_model != "gemini-3.5-flash":
                models.insert(0, env_model)

        # The dashboard asks Antigravity CLI first, then the same API keys, and logs which one answered.
        # Only an unreachable dashboard falls through to calling the API from here.
        dashboard = os.getenv("DASHBOARD_URL")
        if dashboard:
            headers = {}
            token = service_token()
            if token:
                headers["X-Service-Token"] = token
            try:
                # Longer than the dashboard's Antigravity CLI limit (600 s): a slow agy answer must not look unreachable.
                result = _request_json(f"{dashboard}/api/gemini/ask", "POST", {"prompt": prompt, "model": models[0]}, timeout=660, headers=headers)
                log.info("Generated through the dashboard (its GEMINI log line says Antigravity CLI or Gemini API).")
                return result
            except urllib.error.HTTPError as e:
                raise RuntimeError(f"Dashboard Gemini call failed: {e.read().decode('utf-8', 'replace')[:300]}") from e
            except (urllib.error.URLError, TimeoutError, OSError) as e:
                log.warning(f"Dashboard unreachable ({e}); calling the Gemini API directly.")

        payload = {
            "contents": [{"parts": [{"text": prompt}]}],
            "generationConfig": {
                "response_mime_type": "application/json",
                "temperature": 0.7,
            },
        }
        log.debug(f"Gemini prompt ({len(prompt)} chars): {mask_prompt(prompt)}")
        last_err = None
        # Bound each individual model call so a stalled preview/experimental model doesn't exhaust the full timeout
        per_model_timeout = max(5.0, min(timeout, 18.0))

        keys_count = max(1, len(self.api_keys))
        for key_attempt in range(keys_count):
            for model in models:
                url = (
                    "https://generativelanguage.googleapis.com/v1beta/models/"
                    f"{model}:generateContent?key={self.api_key}"
                )
                try:
                    log.debug(f"Calling {model} (key #{self.key_index + 1}/{len(self.api_keys) or 1}, timeout {per_model_timeout:.0f}s)...")
                    started = time.time()
                    result = _request_json(url, "POST", payload, timeout=per_model_timeout)
                    log.info(f"Generated with Gemini API ({model}, key #{self.key_index + 1}) in {time.time() - started:.1f}s.")

                    raw_text = result["candidates"][0]["content"]["parts"][0]["text"]
                    raw_text = re.sub(r"^```json\s*", "", raw_text.strip(), flags=re.MULTILINE)
                    raw_text = re.sub(r"^```\s*$", "", raw_text.strip(), flags=re.MULTILINE)
                    return json.loads(raw_text.strip())
                except urllib.error.HTTPError as e:
                    last_err = e
                    if e.code == 429 and len(self.api_keys) > 1 and key_attempt < keys_count - 1:
                        old_idx = self.key_index
                        self.key_index = (self.key_index + 1) % len(self.api_keys)
                        log.warning(f"Gemini quota exceeded (429) on key #{old_idx + 1}. Switching to key #{self.key_index + 1} and retrying.")
                        break  # Break out of inner model loop to retry with next key
                    log.warning(f"{model} failed: {e}." + (" Trying the next model." if model != models[-1] else " No models left."))
                except Exception as e:
                    last_err = e
                    log.warning(f"{model} failed: {e}." + (" Trying the next model." if model != models[-1] else " No models left."))

        raise last_err or RuntimeError("Failed to generate content from Gemini.")

    def _fallback_narrative(self, topic: str, seconds: float = 60, style: str = "stickman") -> Dict[str, Any]:
        """Resilient offline fallback that creates a formatted story structure for the topic."""
        clean_topic = topic.strip().rstrip(".!?")
        sentences = [
            f"Here is the untold mystery behind {clean_topic}.",
            f"For years, researchers could not explain what was actually happening.",
            f"Strange anomalies kept surfacing in the documented records.",
            f"Every single clue only pointed toward a much deeper revelation.",
            f"And that is why {clean_topic} remains one of history's greatest secrets.",
        ]
        full_script = " ".join(sentences)
        return script_from_text(full_script, title=clean_topic, style=style)

    def direct_script_sentences(
        self,
        sentences: List[str],
        topic: str = "",
        psychology_rules: Optional[str] = None,
        genre: Optional[str] = None,
    ) -> List[str]:
        """
        Analyzes a list of sentences and returns a psychological vocal delivery instruction for each one.
        Uses retention rules to guarantee dynamic vocal variety and prevent listener drop-off.
        """
        if not sentences:
            return []
        if not self.api_key:
            return ["" for _ in sentences]

        active_rules = sanitize_psychology_rules(psychology_rules)
        genre_str = f" in the '{genre}' genre" if genre else ""

        numbered = "\n".join(f"{i+1}. {s}" for i, s in enumerate(sentences))
        prompt = f"""
You are an elite vocal retention engineer and video narrator director for vertical short-form videos{genre_str}.
Below are {len(sentences)} sentences of a spoken voiceover script about "{topic}".

Apply these psychological retention rules to guarantee clear delivery, Zeigarnik curiosity tension, and high viewer retention:
{active_rules}

Rules for delivery:
1. Standard narration for all sentences: leave direction as empty string ("").
2. At most ONE sentence in the video may have a mild, concrete tone change (e.g. "hook emphasis" on sentence 1 OR "clear resolution" on the final sentence). All other sentences must be empty string ("").
3. Never output whispers, speed changes, dramatic slowing, or emotional stage directions.
4. {NARRATOR_DELIVERY}

Sentences:
{numbered}

Return ONLY valid JSON with this exact schema:
{{
  "directions": [
    "delivery direction for sentence 1",
    "delivery direction for sentence 2"
  ]
}}
"""
        try:
            res = self._call_gemini_json(prompt, timeout=18.0, models=LITE_MODELS)
            directions = res.get("directions") or res.get("deliveries", [])
            raw_padded = [str(d).strip() for d in directions[:len(sentences)]]
            while len(raw_padded) < len(sentences):
                raw_padded.append("")
            return normalize_deliveries(raw_padded, len(sentences))
        except Exception as e:
            log.warning(f"Vocal delivery directing failed ({e}): using neutral delivery.")
            return ["" for _ in sentences]

    def generate_narrative(
        self,
        topic: str,
        seconds: float = 60,
        style: str | None = None,
        target_seconds: float | None = None,
        psychology_rules: Optional[str] = None,
        genre: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Generates a viral narrative script shaped specifically for target duration.
        """
        if target_seconds is not None:
            seconds = target_seconds

        chosen_style = style if style is not None else "stickman"

        if not self.api_key:
            log.warning("No GEMINI_API_KEY: using the built-in 5-sentence template script, not a real story.")
            return self._fallback_narrative(topic, seconds=seconds, style=chosen_style)

        seconds = min(300, max(1, float(seconds)))
        min_words = max(1, round(seconds * (WORDS_PER_SECOND - 0.2)))
        max_words = max(min_words + 1, round(seconds * (WORDS_PER_SECOND + 0.2)))
        scenes = min(30, max(1, round(seconds / 10)))

        if chosen_style == "stickman":
            visual_instructions = (
                "For each scene, provide a funny, highly expressive stick figure doodle image prompt "
                "tailored for text-to-image models (minimalist black ink stick figure on clean plain white paper background, "
                "expressive face, whiteboard animation sketch style, simple clean line art, humorous concept)"
            )
        else:
            visual_instructions = (
                "For each scene, provide a cinematic, atmospheric image prompt tailored for high-end text-to-image models "
                "(photorealistic, cinematic lighting, 8k, volumetric rays, dramatic depth of field)"
            )

        active_rules = sanitize_psychology_rules(psychology_rules)
        genre_str = f" for a channel in the '{genre}' genre" if genre else ""
        growth_metadata = "SEO metadata:" in active_rules
        title_guidance = (
            "The title must be 20-40 characters and begin with the primary search keyword."
            if growth_metadata else "Short punchy title"
        )
        description_guidance = (
            "\nThe opening 125 characters should state the topic and viewer value clearly for the upload description.\n"
            if growth_metadata else ""
        )

        prompt = f"""
You are an elite viral documentary scriptwriter and retention engineer for vertical narrative shorts{genre_str}.
Write an intensely compelling, humorous and relatable {seconds:g}-second narrative story based on this topic:
"{topic}"

CRITICAL VIRAL RETENTION SCRIPTWRITING RULES:{description_guidance}
1. THE HOOK (The Payoff Gap): The very first sentence must be an aggressive pattern-interrupt hook that stops the scroll within 3 seconds. Front-load "The What" (the shocking anomaly, result, or consequence) and strictly withhold "The How" (the explanation). Do NOT start with "In the world of" or "Have you ever wondered".
2. WORD COUNT & DURATION: The full spoken voiceover MUST be between {min_words} and {max_words} words, so that spoken at natural pace it lasts about {seconds:g} seconds.
3. STRUCTURE (scale to the length; very short scripts may be just the hook):
   - First ~5%: The Shocking Hook (The What).
   - Next ~30%: The Hidden Context / The Discovery (Open Curiosity Loops).
   - Next ~40%: The Rising Escalation / Mystery / Unexplained Twist (Dopamine Ramp via continuous progress).
   - Final ~25%: The Mind-Bending Resolution / Seamless Infinite Loop Stitching back to Sentence 1.
4. SCRIPTWRITING VOICE RULES (an AI voice reads this and treats punctuation as timing):
{VOICE_RULES}
5. PSYCHOLOGICAL RETENTION ARCHITECTURE:
   The voiceover text itself must embody these behavioral retention rules (e.g. Cognitive Closure tension and Seamless Loop bridging):
{active_rules}

   CRITICAL DELIVERY OVERRIDE (must come last):
   Every scene MUST include a "delivery" field: {NARRATOR_DELIVERY}
6. VISUAL BEATS: Break the story down into exactly {scenes} visual scene(s); every scene ends at a sentence end (the picture cuts in the pause). {visual_instructions}.

Return ONLY valid JSON with this exact schema:
{{
  "title": "{title_guidance}",
  "hook": "The opening sentence",
  "full_script": "The complete uninterrupted spoken text of the narrative ({min_words}-{max_words} words).",
  "scenes": [
    {{
      "scene_number": 1,
      "narration": "Line spoken during this scene",
      "image_prompt": "Description of the visual scene for AI generation",
      "delivery": "psychological vocal delivery for this scene (under 15 words)"
    }}
  ]
}}
"""
        try:
            script_data = self._call_gemini_json(prompt, timeout=min(30.0, 15.0 + seconds / 4.0))
            word_count = len(script_data.get("full_script", "").split())
            log.info(f"Script \"{script_data.get('title')}\": {word_count} words (target {min_words}-{max_words}), {len(script_data.get('scenes', []))} scenes.")
            return script_data
        except Exception as e:
            log.warning(f"Gemini script failed ({e}): using the built-in 5-sentence template script, not a real story.")
            return self._fallback_narrative(topic, seconds=seconds, style=chosen_style)

    def generate_script(
        self,
        topic: str,
        n_scenes: int = 4,
        style: str | None = None,
        duration: str | None = None,
        seconds: float | None = None,
        target_seconds: float | None = None,
        **kwargs,
    ) -> Dict[str, Any]:
        """
        Legacy endpoint: delegates to generate_narrative for realistic spoken length.
        """
        if target_seconds is not None:
            target = target_seconds
        elif seconds is not None:
            target = seconds
        elif duration == "long":
            target = 45.0
        elif duration == "short":
            target = 15.0
        else:
            target = float(n_scenes * 10)
        return self.generate_narrative(topic, seconds=target, **kwargs)
