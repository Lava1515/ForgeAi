import { enforceWhatIfPremise } from './studioPlan.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { askGemini, GEMINI_MID_MODEL, isQuotaExceeded } from './gemini.js';
import { VIDEO_KINDS } from './studioPlan.js';
import { boundedResearch } from './storyVerification.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = process.env.FORGEAI_ROOT || path.resolve(__dirname, '../../../');
// Every real story an auto video was made about. Its own file, not the drafts: deleting a draft must not free its story.
const storiesFile = () => process.env.FORGEAI_STORIES_FILE || path.join(REPO_ROOT, 'data/covered_stories.json');
// ponytail: only the newest covered stories are named in the prompt; older ones are still dropped by key below,
// but Gemini may keep suggesting them. Send only the theme's own stories if that starts wasting searches.
const PROMPT_EXCLUDES = 150;

// The English Wikipedia title is a story's identity: "The Dyatlov Mystery" and "Dyatlov Pass incident" are one story.
export const storyKey = (story) => {
  const entity = String(story?.wiki_title || story?.name || '').toLowerCase().replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
  if (story?.contentMode !== 'whatif') return entity;
  const premise = String(story.premise || story.name || '').toLowerCase()
    .replace(/^what if\b\s*/, '').trim().replace(/[?.]+$/, '').replace(/\s+/g, ' ').trim();
  return `whatif:${entity}:${premise}`;
};

export function coveredStories() {
  try {
    return JSON.parse(fs.readFileSync(storiesFile(), 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err; // unreadable: never start over from [] and overwrite the history
  }
}

// Called once the video is made, so a failed video's story can come up again.
export function recordStory(story, extra = {}) {
  const file = storiesFile();
  const stories = coveredStories();
  stories.push({ name: story.name, wiki_title: story.wiki_title, date: story.date, ...(story.contentMode && { contentMode: story.contentMode }), ...(story.premise && { premise: story.premise }), ...extra, covered_at: new Date().toISOString() });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(stories, null, 2));
  fs.renameSync(`${file}.tmp`, file); // a crash mid-write leaves the old ledger, not half a file
}

// One JSON object, not an array: extractJson (gemini.js) returns only the first {...} in the answer.
const searchPrompt = (theme, exclude) => `Find 3 real, well-documented events or true stories for a short narrated video in the theme "${theme.name}"${theme.why ? ` (${theme.why})` : ''}.
Use Google Search to check every fact. Each one must be a real event with its own English Wikipedia article. No legends told as fact, no fiction, no composite stories.
${exclude.length ? `Already covered. Do NOT suggest these, or the same event under another name:\n${exclude.map((s) => `- ${s}`).join('\n')}\n` : ''}
Return ONLY this JSON object, no commentary:
{"candidates": [{"name": "short name of the event", "wiki_title": "its English Wikipedia article title as you know it (don't search just to confirm the title)", "date": "when it happened", "facts": ["5-8 short verified facts: who, where, what happened, the outcome, one surprising detail"]}]}`;

// 3D cutaway channels: the story is about one physical object the Blender worker can build (model3d.js).
// Any theme (director engine): can be whatif, explain, built, story, or other. If a physical object is featured, includes dimensions and components under object.
const anySearchPrompt = (theme, exclude) => `Find 3 real, well-documented topics for a short narrated video in the theme "${theme.name}"${theme.why ? ` (${theme.why})` : ''}.
Topics can be a real event, historical mystery, engineering breakthrough, human body / medical question, scientific phenomenon, or specific machine/structure.
Use Google Search to check every fact. Each one must have its own English Wikipedia article (a real phenomenon or documented event counts). No legends told as fact, no fiction.
For each candidate:
- "video_kind": one of ${VIDEO_KINDS.join(', ')} ('whatif' for body/biology/hypothetical scenarios, 'explain' for how things work, 'built' for how things were made, 'story' for narrative events/mysteries, 'other' for everything else).
- If the topic features a specific physical machine, vehicle, structure, or device, include "object": {"name": "common name", "wiki_title": "Wikipedia article", "dimensions": {"length": metres, "width": metres, "height": metres}, "components": ["4-10 named parts"]}. Otherwise, "object": null.
${exclude.length ? `Already covered. Do NOT suggest these, or the same topic under another name:\n${exclude.map((s) => `- ${s}`).join('\n')}\n` : ''}
Return ONLY this JSON object, no commentary:
{"candidates": [{"name": "short name of topic", "wiki_title": "its English Wikipedia article title", "date": "when it happened or was built", "video_kind": "one of ${VIDEO_KINDS.join(', ')}", "facts": ["5-8 short verified facts"], "object": null}]}`;

const objectSearchPrompt = (theme, exclude) => `Find 3 real, specific physical objects for a short narrated 3D cutaway video in the theme "${theme.name}"${theme.why ? ` (${theme.why})` : ''}: a machine, vehicle, aircraft, ship, structure or device with its own English Wikipedia article and a surprising engineering detail (how it works inside, a strange design choice, a flaw, a record).
Use Google Search to check every fact. Real objects only, no fiction or legends.
${exclude.length ? `Already covered. Do NOT suggest these, or the same object under another name:\n${exclude.map((s) => `- ${s}`).join('\n')}\n` : ''}
Return ONLY this JSON object, no commentary:
{"candidates": [{"name": "the object's common name", "wiki_title": "its English Wikipedia article title as you know it", "date": "when it was built or first used", "facts": ["5-8 short verified facts, including the surprising engineering detail"], "dimensions": {"length": metres, "width": metres, "height": metres}, "components": ["4-10 named physical parts the facts mention or the object is known for"]}]}`;

const whatifSearchPrompt = (theme, exclude) => `Find 3 intriguing "What if?" hypothetical scenario video topics related to the theme "${theme.name}"${theme.why ? ` (${theme.why})` : ''}.
Each candidate must pose a single hypothetical premise question starting with "What if?" (for example, "What if the Moon orbited twice as close to Earth?" or "What if the Sahara Desert was covered in solar panels?").
DO NOT require a Wikipedia article describing the imaginary event as if it actually happened. Instead, identify the real real-world entities, places, or scientific phenomena presupposed inside the question, and their real English Wikipedia articles.
Research real facts and scientific/historical mechanisms about these real entities using Google Search.
${exclude.length ? `Already covered. Do NOT suggest these, or the same topic under another name:\n${exclude.map((s) => `- ${s}`).join('\n')}\n` : ''}
Return ONLY this JSON object, no commentary:
{"candidates": [{"name": "hypothetical scenario question starting with 'What if?'", "premise": "exact 'What if ... ?' question", "wiki_title": "English Wikipedia article title of the real central entity/mechanism", "facts": ["5-8 short verified background facts about the real entities and scientific mechanisms"]}]}`;

// One agy search_web call per auto video -> the first candidate not covered yet: { name, wiki_title, date, facts[] }.
// Callers can surface quota and agy availability failures.
// Returns null for unrelated search failures or nothing new; quota and agy availability errors propagate.
// A failed research result is never permission to label an unchecked story verified.
export async function discoverRealStory(theme, { ask = askGemini, emit = () => {}, kind = 'event', contentMode = 'factual' } = {}) {
  try {
    const stories = coveredStories();
    const covered = new Set(stories.map(storyKey));
    const exclude = stories.slice(-PROMPT_EXCLUDES).map((s) => s.wiki_title || s.name);
    const mode = contentMode || theme?.contentMode || 'factual';
    const promptFn = mode === 'whatif' ? whatifSearchPrompt : (kind === 'any' ? anySearchPrompt : (kind === 'object' ? objectSearchPrompt : searchPrompt));
    const query = `${promptFn(theme, exclude)}
For each candidate also include "evidence": [{"text":"exact fact text","sources":[{"url":"actual retrieved source URL","title":"source title","passage":"relevant supporting passage or summary"}]}].
Prefer primary/authoritative sources; corroborate disputed central claims. A URL existing is not evidence for an unrelated fact. Never invent sources.`;
    const raw = await ask(query, { search: true, model: GEMINI_MID_MODEL, apiFallback: false });
    if (!raw) {
      emit('WARN', "Story search skipped: Antigravity CLI didn't answer and there's no Gemini API key.");
      return null;
    }
    const candidates = Array.isArray(raw.candidates) ? raw.candidates : [];
    const eligible = (c) => c?.name && (c?.wiki_title || mode === 'whatif') && Array.isArray(c.facts) && c.facts.length;
    const droppedCovered = candidates.filter((candidate) => eligible(candidate) && covered.has(storyKey(candidate)));
    const pick = candidates.find((c) => eligible(c) && !covered.has(storyKey(c)));
    if (!pick) {
      emit('WARN', `Story search found nothing new for "${theme.name}" (${candidates.length} candidate(s), all covered or incomplete).`);
      return null;
    }
    const found = {
      name: String(pick.name),
      wiki_title: String(pick.wiki_title || ''),
      date: String(pick.date || ''),
      facts: pick.facts.map(String),
      ...(mode !== 'factual' && { contentMode: mode }),
      ...(mode === 'whatif' && {
        premise: pick.premise ? enforceWhatIfPremise(pick.premise) : enforceWhatIfPremise(pick.name),
      }),
    };
    const retained = boundedResearch({ ...pick, grounding: raw._grounding });
    if (Array.isArray(pick.evidence)) found.evidence = retained.evidence;
    if (Array.isArray(raw._grounding)) found.grounding = retained.grounding;
    const researchReceipt = {
      query,
      // askGemini sets _agy only when agy answered; other callers may use the API's google_search fallback.
      tool: raw._agy ? 'agy search_web' : 'gemini api google_search',
      agy_fallback: raw._agy !== true,
      source_links: [...new Set(candidates.flatMap((candidate) => (candidate.evidence || []).flatMap((entry) => (entry.sources || []).map((source) => source.url)).filter((url) => typeof url === 'string')))],
      candidates,
      picked: { ...pick, why: `First complete candidate not already covered (${pick.wiki_title || pick.name}).` },
      dropped_covered: droppedCovered.map((candidate) => ({ ...candidate, why: 'Story is already covered.' })),
    };
    Object.defineProperty(found, 'research_receipt', { value: researchReceipt, enumerable: false, configurable: true });
    if (kind === 'any') {
      const video_kind = VIDEO_KINDS.includes(pick.video_kind) ? pick.video_kind : 'other';
      let obj = null;
      if (pick.object && typeof pick.object === 'object') {
        const oName = pick.object.name ? String(pick.object.name) : null;
        const oWiki = pick.object.wiki_title ? String(pick.object.wiki_title) : null;
        const oDims = pick.object.dimensions && ['length', 'width', 'height'].every((k) => Number(pick.object.dimensions[k]) > 0) ? pick.object.dimensions : null;
        const oComps = Array.isArray(pick.object.components) ? pick.object.components.map(String).slice(0, 10) : [];
        if (oName && oWiki) {
          obj = { name: oName, wiki_title: oWiki, dimensions: oDims, components: oComps };
        }
      }
      return { ...found, video_kind, object: obj };
    }
    if (kind !== 'object') return found;
    const dims = pick.dimensions && ['length', 'width', 'height'].every((k) => Number(pick.dimensions[k]) > 0) ? pick.dimensions : null;
    return { ...found, dimensions: dims, components: Array.isArray(pick.components) ? pick.components.map(String).slice(0, 10) : [] };
  } catch (err) {
    emit('WARN', `Story search failed (${String(err.message || '').slice(0, 1000)}).`);
    if (err?.unavailable || isQuotaExceeded(err)) throw err;
    return null;
  }
}
