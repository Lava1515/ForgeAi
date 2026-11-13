// KAN-928 (CB16): the Auto-topic provider for owner-started batch videos.
//
// theme.js (CB8) is pure scoring: it makes no model call and was never wired to anything. This module is its provider side:
//   1. candidates  - one router call (askRole role "planner", router step "theme"; agy first, Claude Sonnet on fallback), JSON only
//   2. history     - the channel's saved video list (data/trends/channel*.json) plus the topics already chosen earlier in this run
//   3. sets        - code-built scenes are built from code, so rule 5 (set library fit) is waived and a one-entry catalogue stands in
//   4. scoring     - theme.js scoreCandidates, with the made-for-kids channel policy applied when a channel is known
// Every attempt is reported through onCallRecord (the router's own sink), so the pick is costed like any other step.
// Nothing is faked: no valid candidate, or every candidate rejected, is a named failure (theme_*), never an invented topic.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scoreCandidates, loadChannelHistory, DEFAULT_OPTIONS } from './theme.js';
import { askRole } from '../../routes/askRole.js';
import { getChannelById, isSafeId } from '../../routes/channelsManager.js';
import { isWhatIfTopic } from './productionChoices.js';
import { storyDirection } from './storyDirection.js';

export const THEME_STEP = 'theme';
export const TOPIC_MAX = 200;
export const MAX_CANDIDATES_ASKED = 6;
const SETS = Object.freeze([Object.freeze({ name: 'code_built', themes: Object.freeze(['code', 'built']) })]);

export class AutoTopicError extends Error {
  constructor(code) { super(code); this.name = 'AutoTopicError'; this.code = code; }
}

/** askRole with the theme router step; refuses under the test runner so a rig that injects nothing cannot reach a model. */
export const productionTopicAsk = (role, instruction, options = {}) => process.env.NODE_TEST_CONTEXT
  ? Promise.reject(new Error('model calls are disabled under the test runner'))
  : askRole(role, instruction, { ...options, step: THEME_STEP });

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = () => process.env.FORGEAI_ROOT || path.resolve(here, '../../../../');

/** Channel history file as the channel scan saves it (routes/channel.js getChannelCacheFile). null when there is nothing safe to read. */
export function channelHistoryFile(channelId, trendsDir = path.join(repoRoot(), 'data/trends')) {
  if (!channelId || channelId === 'default') return path.join(trendsDir, 'channel.json');
  return isSafeId(channelId) ? path.join(trendsDir, `channel_${channelId}.json`) : null;
}

/** Read-only. A missing or unreadable file is an empty history; the run notes it, it does not fail. */
export function readChannelHistory(channelId) {
  const file = channelHistoryFile(channelId);
  if (!file || !fs.existsSync(file)) return { videos: [], available: false };
  try { return { videos: loadChannelHistory({ file }).videos, available: true }; } catch { return { videos: [], available: false }; }
}

const clean = (v, max) => (typeof v === 'string' ? v.replace(/[\x00-\x1f\x7f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '');

function promptFor({ genre, theme, type, inspiration, previousTopics }) {
  const whatif = type === 'whatif';
  return [
    `Propose ${MAX_CANDIDATES_ASKED} different topics for one vertical educational short on a faceless 3D channel. Each must be explainable with simple 3D scenes and real, checkable numbers.`,
    whatif ? 'Every topic must be a "What if ...?" question about real physics or science.' : 'Every topic is a factual question or claim with a true, checkable answer. Never a "What if ...?" question.',
    storyDirection(type),
    genre ? `Genre: ${JSON.stringify(genre)}` : 'Genre: any',
    theme ? `Theme to stay inside: ${JSON.stringify(theme)}` : 'Theme: your choice',
    inspiration ? `The channel's own current idea (optional inspiration): ${JSON.stringify(inspiration)}` : '',
    previousTopics.length ? `Already made or chosen, do not repeat or paraphrase: ${JSON.stringify(previousTopics.slice(-20))}` : '',
    `Reply with ONE JSON object and nothing else: {"candidates":[{"topic": string (at most ${TOPIC_MAX} characters), "answer": string, "hook": string (a number, a question or a point of view, at most 12 words), "facts":[{"value": number, "source": string}, at least 3], "shots":[{"visual": string, "location": string}, 7 to 9, visually different, at least 3 locations], "main_setting": string, "tags":[string]}]}`,
  ].filter(Boolean).join('\n');
}

/** Candidates the model returned, reduced to the fields theme.js reads. Anything malformed is dropped, never repaired. */
export function sanitizeCandidates(answer, { type = 'factual' } = {}) {
  const raw = Array.isArray(answer?.candidates) ? answer.candidates : [];
  const episodePath = type === 'whatif' ? 'whatif' : 'breakdown';
  const out = [];
  for (const c of raw) {
    if (out.length >= MAX_CANDIDATES_ASKED + 2) break;
    if (!c || typeof c !== 'object') continue;
    const topic = clean(c.topic, TOPIC_MAX);
    // The topic must agree with the type the video was resolved to: what-if questions only for a what-if video, and never for a factual one.
    if (!topic || isWhatIfTopic(topic) !== (type === 'whatif')) continue;
    out.push({
      id: `c${out.length + 1}`, topic, answer: clean(c.answer, 600), hook: clean(c.hook, 200), main_setting: clean(c.main_setting, 80), episode_path: episodePath,
      facts: (Array.isArray(c.facts) ? c.facts : []).slice(0, 12).filter((f) => f && Number.isFinite(f.value)).map((f) => ({ value: f.value, source: clean(f.source, 200) })),
      shots: (Array.isArray(c.shots) ? c.shots : []).slice(0, 14).filter((s) => s && typeof s === 'object').map((s) => ({ visual: clean(s.visual, 120), location: clean(s.location, 80) })),
      tags: (Array.isArray(c.tags) ? c.tags : []).slice(0, 8).map((t) => clean(t, 32)).filter(Boolean),
    });
  }
  return out;
}

/**
 * Production default: { askRoleFn: productionTopicAsk, history: readChannelHistory, getChannel: getChannelById }.
 * pickTopic({ genre, theme, type, inspiration, previousTopics, channelId, onCallRecord }) -> { topic, candidate_id, total, ranked, rejected, history_used, history_available }
 */
export function createAutoTopicProvider({ askRoleFn = productionTopicAsk, history = readChannelHistory, getChannel = getChannelById, score = scoreCandidates, now = () => new Date() } = {}) {
  return async function pickTopic({ genre = '', theme = '', type = 'factual', inspiration = '', previousTopics = [], channelId, onCallRecord } = {}) {
    let answer;
    try { answer = await askRoleFn('planner', promptFor({ genre, theme, type, inspiration, previousTopics }), { onCallRecord }); } catch { throw new AutoTopicError('theme_provider_failed'); }
    const candidates = sanitizeCandidates(answer, { type });
    if (!candidates.length) throw new AutoTopicError('theme_no_candidates');
    const loaded = (() => { try { return history(channelId); } catch { return { videos: [], available: false }; } })();
    const earlier = previousTopics.map((topic, i) => ({ video_id: `run-${i + 1}`, title: topic, theme: '', published_at: new Date(now().getTime() - (previousTopics.length - i) * 1000).toISOString() }));
    let scored;
    try {
      scored = score({
        candidates, history: [...earlier, ...(loaded.videos ?? [])], sets: SETS,
        options: { ...DEFAULT_OPTIONS, owner_wants_new_sets: true, safety_rules: { blocked_tags: [], require_verified_claims: false }, ...(channelId ? { channel: { id: channelId, get_channel: getChannel } } : {}) },
      });
    } catch { throw new AutoTopicError('theme_scoring_failed'); }
    if (!scored.chosen) throw new AutoTopicError('theme_all_rejected');
    return {
      topic: scored.chosen.topic, candidate_id: scored.chosen.id, total: scored.chosen.total,
      ranked: scored.ranked.length, rejected: scored.rejected.map((r) => ({ id: r.id, reasons: r.reasons.map((x) => `${x.rule}:${x.detail}`) })),
      history_used: scored.history_used, history_available: loaded.available === true,
    };
  };
}
