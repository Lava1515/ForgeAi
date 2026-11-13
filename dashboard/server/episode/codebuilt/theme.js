// KAN-917 (CB8): theme pick for the code-built path.
//
// Scores candidate topics on the six rules in section 7 of docs/superpowers/plans/2026-11-12-code-built-shorts-plan.md
// and writes a job-owned plan.json (choice, runners-up, scores) that the Grand Plan page (KAN-895) can show.
//
// scoreCandidates() is a pure function. Candidates, channel history and the set-library catalogue are injected:
// this module makes no CLI, model or network call. Reuse of KAN-839: the plan.json top level follows the brief
// stage's plan shape (goal + steps, snake_case keys, no path-like keys, under 256 KB), the output is confined and
// written atomically the same way as brief.js, and the made-for-kids rule comes from selectEpisodeChannel (channel.js).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { selectEpisodeChannel, EpisodeChannelError } from '../channel.js';

export const THEME_VERSION = 'codebuilt-theme-v1';
export const MAX_CANDIDATES = 50;
const MAX_STRING = 12000;
const MAX_FILE_BYTES = 256 * 1024;

// The six rules, in the order of the plan. `gate` rules reject a candidate; the others only lower its score.
export const THEME_RULES = Object.freeze([
  { key: 'numbers_checkable', label: 'A true answer that can be checked, with at least three real numbers', gate: false },
  { key: 'shots_locations', label: 'Seven to nine visually different shots and at least three locations', gate: false },
  { key: 'hook', label: 'A hook that works in the first second (a number, a question or a point of view)', gate: false },
  { key: 'not_repeat', label: "Not close to the channel's last 20 videos, in topic or in main setting", gate: true },
  { key: 'set_fit', label: 'Fits sets already in the set library (lower cost), unless the owner asks for something new', gate: false },
  { key: 'fact_safety', label: "Clear of the channel's fact and safety rules", gate: true },
]);

export const DEFAULT_OPTIONS = Object.freeze({
  history_window: 20,            // rule 4: how many of the newest videos count
  topic_similarity_limit: 0.5,   // rule 4: share of the shorter word set that overlaps (needs two shared words) at which a topic counts as a repeat
  setting_window: 3,             // rule 4: the main setting may not match one of this many newest videos
  history_setting_min_hits: 2,   // rule 4: theme words a past video needs to be placed in a set
  min_numbers: 3,                // rule 1
  shots_min: 7, shots_max: 9, min_locations: 3, // rule 2
  hook_max_words: 12,            // rule 3: roughly what is spoken in the first seconds
  owner_wants_new_sets: false,   // rule 5
  safety_rules: Object.freeze({ blocked_tags: Object.freeze([]), require_verified_claims: true }), // rule 6
  channel: null,                 // rule 6: { id, get_channel } to apply the made-for-kids Episode policy
  weights: null,                 // optional { rule_key: number }, default 1 each
  runners_up: 3,
});

function fail(message) { throw new Error(`theme: ${message}`); }
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const round3 = (n) => Math.round(n * 1000) / 1000;
const clamp01 = (n) => Math.min(1, Math.max(0, n));
const text = (v) => (typeof v === 'string' ? v : '');

// ---- words ---------------------------------------------------------------------------------------------------

const STOP = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'what', 'why', 'how', 'who', 'when', 'where', 'which', 'does', 'did', 'are', 'was', 'were', 'you', 'your', 'its', 'into', 'about', 'than', 'then', 'them', 'they', 'their', 'inside', 'happens', 'happen', 'shorts', 'short', 'not', 'can', 'could', 'would', 'will', 'has', 'have', 'had', 'but', 'all', 'out', 'off', 'one', 'there', 'here', 'just', 'like', 'more', 'most', 'every', 'while', 'over', 'under', 'after', 'before', 'hide', 'hides']);

function stem(word) {
  let w = word;
  if (w.length > 5 && w.endsWith('ing')) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith('ed')) w = w.slice(0, -2);
  if (w.length > 3 && /(ch|sh|x|s|z)es$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

function words(value) {
  return String(value ?? '').normalize('NFKC').toLocaleLowerCase('en-US').split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 3 && !STOP.has(w)).map(stem);
}

const wordSet = (...parts) => new Set(parts.flatMap(words));
const normalise = (v) => String(v ?? '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US');

// ---- set registry (injected catalogue: [{ name, description, themes }]) ---------------------------------------------

function indexSets(sets) {
  return sets.map((s) => ({ name: s.name, words: wordSet(String(s.name).replace(/_/g, ' '), ...(s.themes || [])) }));
}

// The set whose name/theme words overlap `tokens` most, or null below `minHits`. Ties go to the first set listed.
function bestSet(index, tokens, minHits) {
  let best = null; let bestHits = 0;
  for (const s of index) {
    let hits = 0;
    for (const w of tokens) if (s.words.has(w)) hits++;
    if (hits > bestHits) { best = s.name; bestHits = hits; }
  }
  return bestHits >= minHits ? best : null;
}

// ---- input checks -----------------------------------------------------------------------------------------------

function checkBoundedStrings(value, where, depth = 0) {
  if (depth > 6) fail(`${where} is nested too deeply`);
  if (typeof value === 'string') { if (value.length > MAX_STRING) fail(`${where} has a string over ${MAX_STRING} characters`); }
  else if (Array.isArray(value)) { if (value.length > 200) fail(`${where} has an array over 200 entries`); value.forEach((v) => checkBoundedStrings(v, where, depth + 1)); }
  else if (object(value)) Object.values(value).forEach((v) => checkBoundedStrings(v, where, depth + 1));
}

function checkInputs({ candidates, history, sets }) {
  if (!Array.isArray(candidates) || candidates.length === 0) fail('candidates must be a non-empty array');
  if (candidates.length > MAX_CANDIDATES) fail(`candidates must have at most ${MAX_CANDIDATES} entries`);
  if (!Array.isArray(history)) fail('history must be an array of videos');
  if (!Array.isArray(sets) || sets.length === 0) fail('sets must be a non-empty array of { name, themes }');
  sets.forEach((s, i) => { if (!object(s) || typeof s.name !== 'string' || !s.name.trim() || !Array.isArray(s.themes)) fail(`sets[${i}] needs a name and a themes array`); });
  const seen = new Set();
  candidates.forEach((c, i) => {
    if (!object(c)) fail(`candidates[${i}] must be an object`);
    checkBoundedStrings(c, `candidates[${i}]`);
    if (typeof c.topic !== 'string' || !c.topic.trim()) fail(`candidates[${i}] needs a topic`);
    const id = c.id === undefined ? `c${i}` : c.id;
    if (typeof id !== 'string' || !/^[A-Za-z0-9_.-]{1,64}$/.test(id)) fail(`candidates[${i}] has an invalid id`);
    if (seen.has(id)) fail(`duplicate candidate id ${id}`);
    seen.add(id);
    for (const key of ['facts', 'shots', 'claims', 'tags']) if (c[key] !== undefined && !Array.isArray(c[key])) fail(`candidates[${i}].${key} must be an array`);
  });
  history.forEach((v, i) => { if (!object(v)) fail(`history[${i}] must be an object`); });
}

function resolveOptions(options = {}) {
  if (!object(options)) fail('options must be an object');
  const merged = { ...DEFAULT_OPTIONS, ...options };
  merged.safety_rules = { ...DEFAULT_OPTIONS.safety_rules, ...(options.safety_rules || {}) };
  merged.safety_rules.blocked_tags = [...merged.safety_rules.blocked_tags].map(normalise);
  const weights = Object.fromEntries(THEME_RULES.map((r) => [r.key, 1]));
  for (const [key, value] of Object.entries(options.weights || {})) {
    if (!Object.hasOwn(weights, key) || !Number.isFinite(value) || value < 0) fail(`invalid weight for ${key}`);
    weights[key] = value;
  }
  if (Object.values(weights).every((w) => w === 0)) fail('at least one rule weight must be above zero');
  merged.weights = weights;
  for (const key of ['history_window', 'runners_up', 'setting_window']) if (!Number.isInteger(merged[key]) || merged[key] < 0) fail(`${key} must be a whole number of at least 0`);
  return merged;
}

// ---- the six rules ----------------------------------------------------------------------------------------------

// Rule 1: a true answer that can be checked, with at least three real numbers (each with a named source).
function ruleNumbers(c, o) {
  const answer = text(c.answer).trim().length > 0;
  const numbers = (c.facts || []).filter((f) => object(f) && typeof f.value === 'number' && Number.isFinite(f.value) && text(f.source).trim()).length;
  const score = (answer ? 0.25 : 0) + 0.75 * clamp01(numbers / o.min_numbers);
  return { score, pass: answer && numbers >= o.min_numbers, detail: { answer, numbers, needed: o.min_numbers } };
}

// Rule 2: seven to nine visually different shots, at least three locations.
function ruleShots(c, o) {
  const shots = (c.shots || []).filter(object);
  const visuals = new Set(shots.map((s) => normalise(s.visual)).filter(Boolean));
  const locations = new Set(shots.map((s) => normalise(s.location)).filter(Boolean));
  const n = visuals.size;
  let shotScore;
  if (n < o.shots_min) shotScore = n / o.shots_min;
  else if (n > o.shots_max) shotScore = clamp01(1 - (n - o.shots_max) / 3);
  else shotScore = 1;
  const score = (shotScore + clamp01(locations.size / o.min_locations)) / 2;
  const pass = n >= o.shots_min && n <= o.shots_max && locations.size >= o.min_locations;
  return { score, pass, detail: { distinct_shots: n, locations: locations.size, shots_range: [o.shots_min, o.shots_max], locations_needed: o.min_locations } };
}

const NUMBER_WORDS = new Set(['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety', 'hundred', 'thousand', 'million', 'billion', 'trillion', 'zero', 'half', 'double', 'triple']);
const QUESTION_START = /^(who|what|why|how|when|where|which|can|could|do|does|did|is|are|will|would|should)\b/;
const POV = /\b(i|i'm|you|you're|your|we|our|imagine|picture|pov|what if)\b/;

// Rule 3: the hook is a number, a question or a point of view, and short enough to land in the first second.
function ruleHook(c, o) {
  const hook = text(c.hook).trim();
  const lower = normalise(hook);
  const tokens = lower.split(/[^\p{L}\p{N}']+/u).filter(Boolean);
  const kinds = [];
  if (/\d/.test(hook) || tokens.some((t) => NUMBER_WORDS.has(t))) kinds.push('number');
  if (hook.includes('?') || QUESTION_START.test(lower)) kinds.push('question');
  if (POV.test(lower)) kinds.push('point_of_view');
  const short = tokens.length > 0 && tokens.length <= o.hook_max_words;
  const score = kinds.length === 0 ? 0 : (short ? 1 : 0.5);
  return { score, pass: score === 1, detail: { kinds, words: tokens.length, max_words: o.hook_max_words } };
}

function prepareHistory(history, o, index) {
  const ordered = history.map((v, i) => ({ v, i, t: Date.parse(v.published_at) }))
    .sort((a, b) => (Number.isNaN(b.t) ? -Infinity : b.t) - (Number.isNaN(a.t) ? -Infinity : a.t) || a.i - b.i)
    .slice(0, o.history_window).map(({ v }) => v);
  return ordered.map((v) => {
    const tokens = wordSet(v.title, v.theme);
    return { video_id: text(v.video_id), title: text(v.title), tokens, setting: bestSet(index, tokens, o.history_setting_min_hits) };
  });
}

function candidateSetting(c, index) {
  const given = normalise(c.main_setting).replace(/\s+/g, '_');
  const named = index.find((s) => s.name === given);
  if (named) return named.name;
  return bestSet(index, wordSet(c.main_setting), 1);
}

// Rule 4: not close to the newest videos in topic or main setting. A repeat is rejected.
function ruleRepeat(c, o, videos, index) {
  const own = wordSet(c.topic, c.title);
  let topicSimilarity = 0; let topicVideo = null;
  for (const v of videos) {
    const shared = [...own].filter((w) => v.tokens.has(w)).length;
    const smaller = Math.min(own.size, v.tokens.size);
    const similarity = shared >= 2 && smaller > 0 ? shared / smaller : 0;
    if (similarity > topicSimilarity) { topicSimilarity = similarity; topicVideo = v; }
  }
  const setting = candidateSetting(c, index);
  const sameSetting = setting ? videos.filter((v) => v.setting === setting) : [];
  const settingShare = videos.length ? sameSetting.length / videos.length : 0;
  const recent = setting ? videos.slice(0, o.setting_window).find((v) => v.setting === setting) : null;
  const reasons = [];
  if (topicVideo && topicSimilarity >= o.topic_similarity_limit) reasons.push({ rule: 'not_repeat', detail: 'topic', video_id: topicVideo.video_id, title: topicVideo.title, similarity: round3(topicSimilarity) });
  if (recent) reasons.push({ rule: 'not_repeat', detail: 'main_setting', video_id: recent.video_id, title: recent.title, setting });
  const score = clamp01(1 - Math.max(topicSimilarity, settingShare));
  return { score, pass: reasons.length === 0, reasons, detail: { topic_similarity: round3(topicSimilarity), nearest_video_id: topicVideo ? topicVideo.video_id : null, main_setting: setting, setting_share: round3(settingShare), videos_compared: videos.length } };
}

// Rule 5: shot locations the set library already covers (lower cost). The owner can ask for something new instead.
function ruleSetFit(c, o, index) {
  const names = new Set(index.map((s) => s.name));
  const covered = new Map(); // location -> set or null
  for (const s of (c.shots || []).filter(object)) {
    const location = normalise(s.location);
    if (!location || covered.get(location)) continue;
    const given = normalise(s.set).replace(/\s+/g, '_');
    covered.set(location, names.has(given) ? given : bestSet(index, wordSet(s.location), 1));
  }
  const locations = [...covered.keys()];
  const newLocations = locations.filter((l) => !covered.get(l));
  const setsUsed = [...new Set(locations.map((l) => covered.get(l)).filter(Boolean))];
  const fit = locations.length ? (locations.length - newLocations.length) / locations.length : 0;
  if (o.owner_wants_new_sets) return { score: 1, pass: true, detail: { waived: true, fit: round3(fit), sets_used: setsUsed, new_locations: newLocations } };
  return { score: fit, pass: fit === 1, detail: { waived: false, fit: round3(fit), sets_used: setsUsed, new_locations: newLocations } };
}

// Rule 6: clear of the channel's fact and safety rules. Any hit is a rejection.
function ruleFactSafety(c, o) {
  const rules = o.safety_rules;
  const reasons = [];
  const claims = (c.claims || []).filter(object);
  const status = (cl) => normalise(cl.status);
  if (claims.some((cl) => status(cl) === 'false')) reasons.push('false_claim');
  if (rules.require_verified_claims) {
    if (claims.length === 0) reasons.push('no_verified_claims');
    else if (claims.some((cl) => status(cl) !== 'verified')) reasons.push('unverified_claim');
  }
  for (const tag of (c.tags || []).map(normalise)) if (rules.blocked_tags.includes(tag)) reasons.push(`blocked_tag:${tag}`);
  // Fail closed: with a channel configured every candidate goes through the channel policy; a missing or invalid episode_path is rejected as invalid_path.
  if (o.channel) {
    try { selectEpisodeChannel({ channelId: o.channel.id, path: c.episode_path, subPath: c.sub_path, getChannel: o.channel.get_channel }); }
    catch (error) { if (error instanceof EpisodeChannelError) reasons.push(error.code); else throw error; }
  }
  const unique = [...new Set(reasons)];
  return { score: unique.length ? 0 : 1, pass: unique.length === 0, reasons: unique.map((detail) => ({ rule: 'fact_safety', detail })), detail: { claims: claims.length, problems: unique } };
}

// ---- scoring ------------------------------------------------------------------------------------------------------

export function scoreCandidates({ candidates, history, sets, options } = {}) {
  checkInputs({ candidates, history, sets });
  const o = resolveOptions(options);
  const index = indexSets(sets);
  const videos = prepareHistory(history, o, index);
  const weightSum = Object.values(o.weights).reduce((a, b) => a + b, 0);

  const scored = candidates.map((c, position) => {
    const results = {
      numbers_checkable: ruleNumbers(c, o),
      shots_locations: ruleShots(c, o),
      hook: ruleHook(c, o),
      not_repeat: ruleRepeat(c, o, videos, index),
      set_fit: ruleSetFit(c, o, index),
      fact_safety: ruleFactSafety(c, o),
    };
    const reasons = THEME_RULES.filter((r) => r.gate).flatMap((r) => results[r.key].reasons || []);
    const total = THEME_RULES.reduce((sum, r) => sum + o.weights[r.key] * results[r.key].score, 0) / weightSum;
    const rules = Object.fromEntries(THEME_RULES.map((r) => {
      const { score, pass, detail } = results[r.key];
      return [r.key, { score: round3(score), pass, detail }];
    }));
    return { id: c.id === undefined ? `c${position}` : c.id, topic: c.topic.trim(), total: round3(total), rules, reasons, position };
  });

  const ranked = scored.filter((c) => c.reasons.length === 0)
    .sort((a, b) => b.total - a.total || a.position - b.position)
    .map((c, i) => { const { position, reasons, ...rest } = c; return { rank: i + 1, ...rest }; });
  const rejected = scored.filter((c) => c.reasons.length > 0).map((c) => { const { position, ...rest } = c; return { ...rest, rank: null }; });
  return {
    chosen: ranked[0] || null,
    runners_up: ranked.slice(1, 1 + o.runners_up),
    ranked,
    rejected,
    history_used: videos.length,
  };
}

// ---- history (read-only) --------------------------------------------------------------------------------------------

// Reads a saved channel report (the shape the channel scan saves: { videos: [{ video_id, title, theme, published_at, ... }] }).
// The file is only read. Newest first, at most `limit` videos, only the fields the scoring needs.
export function loadChannelHistory({ file, limit = DEFAULT_OPTIONS.history_window } = {}) {
  if (typeof file !== 'string' || !file) fail('history file must be a path string');
  let report;
  try { report = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { fail('channel history cannot be read or is not JSON'); }
  if (!object(report) || !Array.isArray(report.videos)) fail('channel history needs a videos array');
  const usable = report.videos.filter((v) => object(v) && !Number.isNaN(Date.parse(v.published_at)));
  const videos = usable.sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at)).slice(0, limit)
    .map((v) => ({ video_id: text(v.video_id), title: text(v.title), theme: text(v.theme), published_at: v.published_at }));
  return { videos, total_saved: report.videos.length, skipped: report.videos.length - usable.length, scanned_at: typeof report.scanned_at === 'string' ? report.scanned_at : null, channel_id: typeof report.channel_id === 'string' ? report.channel_id : null };
}

// ---- plan.json -------------------------------------------------------------------------------------------------------

export function buildThemePlan({ candidates, history, sets, options, now = new Date().toISOString(), historyInfo = null } = {}) {
  const result = scoreCandidates({ candidates, history, sets, options });
  const o = resolveOptions(options);
  const { channel, safety_rules: safety, ...shown } = o;
  return {
    goal: 'Pick the theme for the next code-built short',
    steps: [
      'Score each supplied candidate on the six theme rules',
      'Reject candidates that repeat the last videos or break the fact and safety rules',
      'Take the highest score as the choice and keep the runners-up',
    ],
    theme_pick: {
      version: THEME_VERSION,
      created_at: now,
      rules: THEME_RULES.map(({ key, label, gate }) => ({ key, label, gate })),
      options: { ...shown, safety_rules: safety, channel_id: channel ? channel.id : null },
      history: { used: result.history_used, ...(historyInfo || {}) },
      chosen: result.chosen,
      runners_up: result.runners_up,
      ranked: result.ranked,
      rejected: result.rejected,
    },
  };
}

function isWithin(root, target) { const rel = path.relative(root, target); return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel); }
const defaultJobsRoot = () => path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../output/agent-jobs');

function confinedJob(jobDir, root) {
  if (typeof jobDir !== 'string' || !jobDir || jobDir.split(/[\\/]/).includes('..')) fail('invalid job folder path');
  let rootResolved; let resolved;
  try {
    rootResolved = fs.realpathSync(root);
    const candidate = path.isAbsolute(jobDir) ? path.resolve(jobDir) : path.resolve(rootResolved, jobDir);
    resolved = fs.realpathSync(candidate);
  } catch { fail('job folder does not exist or cannot be resolved'); }
  if (!isWithin(rootResolved, resolved) || !fs.statSync(resolved).isDirectory()) fail('job folder escapes the jobs root');
  return resolved;
}

function checkPlan(plan) {
  if (!object(plan) || typeof plan.goal !== 'string' || !Array.isArray(plan.steps) || !object(plan.theme_pick)) fail('plan needs goal, steps and theme_pick');
  if (Object.keys(plan).some((k) => !/^[a-z][a-z0-9_]{0,63}$/.test(k))) fail('plan has an invalid key');
}

// Writes plan.json (only that file) into a folder that must already exist inside the jobs root.
export function writeThemePlan({ jobDir, jobsRoot = defaultJobsRoot(), plan } = {}) {
  checkPlan(plan);
  const folder = confinedJob(jobDir, jobsRoot);
  const content = `${JSON.stringify(plan, null, 2)}\n`;
  if (Buffer.byteLength(content) > MAX_FILE_BYTES) fail('plan exceeds 256 KB');
  const target = path.join(folder, 'plan.json');
  const temp = path.join(folder, `.plan.json.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  try { fs.writeFileSync(temp, content, { flag: 'wx' }); fs.renameSync(temp, target); }
  catch (error) { try { fs.unlinkSync(temp); } catch {} throw error; }
  return { file: target };
}

// Orchestrates one pick with injected providers: candidates, channel history and the set catalogue.
export async function pickTheme({ jobDir, jobsRoot, candidatesProvider, historyProvider, setsProvider, options, now } = {}) {
  for (const [name, provider] of Object.entries({ candidatesProvider, historyProvider, setsProvider })) {
    if (typeof provider !== 'function') fail(`${name} must be a function`);
  }
  const candidates = await candidatesProvider();
  const loaded = await historyProvider();
  const sets = await setsProvider();
  const history = Array.isArray(loaded) ? loaded : (object(loaded) ? loaded.videos : null);
  const historyInfo = object(loaded) && !Array.isArray(loaded)
    ? Object.fromEntries(['total_saved', 'scanned_at', 'channel_id'].filter((k) => loaded[k] !== undefined && loaded[k] !== null).map((k) => [k, loaded[k]]))
    : null;
  const plan = buildThemePlan({ candidates, history, sets, options, now, historyInfo });
  const { file } = writeThemePlan({ jobDir, jobsRoot, plan });
  return { plan, file };
}
