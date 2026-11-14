// Auto release (backlog P2). claude-pro · claude-sonnet-5-5 · 2026-11-14
// Per channel, OFF by default. The owner switches it on; an agent never does. Channel shape (stored by channelsManager):
//   channel.auto_release = { enabled: boolean, daily_cap: positive integer }
// There is NO default cap: with no cap set, nothing is released. A draft is uploaded unlisted with a scheduled publishAt
// (releaseDue() in youtube.js makes it public) only when its recorded checks all passed. Every decision is logged.
import fs from 'node:fs';
import path from 'node:path';

export const MAX_CAP = 20;
export const RELEASE_LEAD_MS = 30 * 60 * 1000; // earliest publishAt after the upload decision

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

/** { enabled, cap }. enabled is true only for the literal value true; cap is null unless a whole number 1..MAX_CAP. */
export function autoReleaseSettings(channel) {
  const s = isObj(channel?.auto_release) ? channel.auto_release : {};
  const cap = s.daily_cap;
  return { enabled: s.enabled === true, cap: Number.isInteger(cap) && cap >= 1 && cap <= MAX_CAP ? cap : null };
}

/**
 * The quality bar: fact check passed, length within tolerance, visual check approved. Each must be an explicit pass in the draft
 * (generation_details.fact_check.verified, .length_check.within_tolerance, and a visual loop that accepted a round without an
 * unapproved visual_check). Missing evidence is a fail, never a pass. -> { ok, reasons[] }
 */
export function releaseQuality(meta) {
  const g = isObj(meta?.generation_details) ? meta.generation_details : {};
  const reasons = [];
  if (g.fact_check?.verified !== true) reasons.push('fact check not recorded as passed');
  if (g.length_check?.within_tolerance !== true) reasons.push('length not recorded as within tolerance');
  const loop = g.visual_loop;
  if (g.visual_check?.approved === false || !isObj(loop) || !Number.isInteger(loop.accepted_round)) reasons.push('visual check not approved');
  return { ok: reasons.length === 0, reasons };
}

/** Why a draft cannot be auto released, or null. Pure. */
export function ineligibleReason(meta, channelId) {
  if (!meta?.video_file) return 'no video file';
  if ((meta.channel_id || 'default') !== channelId) return 'other channel';
  if (meta.youtube?.video_id) return 'already uploaded';
  if (meta.future_upload_at) return 'parked as a future upload';
  if (meta.auto_release_error) return 'an earlier auto release failed; clear auto_release_error to retry';
  if (!isObj(meta.generation_details)) return 'not a generated draft';
  const q = releaseQuality(meta);
  return q.ok ? null : `quality bar not met: ${q.reasons.join('; ')}`;
}

/**
 * Pick the next draft and its slot for one channel. `capCheck(drafts, channelId, atIso, cap)` is youtube.js's per-day counter.
 * -> { action: 'skip', reason } | { action: 'release', draft, publishAt }
 */
export function planRelease({ drafts, channel, now, capCheck }) {
  const { enabled, cap } = autoReleaseSettings(channel);
  if (!enabled) return { action: 'skip', reason: 'auto release is off' };
  if (cap === null) return { action: 'skip', reason: 'no daily cap set; nothing is released without one' };
  const candidates = drafts
    .filter(({ meta }) => ineligibleReason(meta, channel.id) === null)
    .sort((a, b) => String(a.meta.created_at).localeCompare(String(b.meta.created_at)));
  if (!candidates.length) return { action: 'skip', reason: 'no draft passes the quality bar', quiet: true };
  const at = new Date(now + RELEASE_LEAD_MS).toISOString();
  const full = capCheck(drafts, channel.id, at, cap);
  if (full && !full.next) return { action: 'skip', reason: 'no free release slot in the next 60 days' };
  return { action: 'release', draft: candidates[0], publishAt: full ? full.next : at };
}

// ---- release log: one JSON object per line ----
export function appendReleaseLog(file, entry) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
}

export function readReleaseLog(file, limit = 200) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-limit).map((l) => JSON.parse(l)).reverse();
  } catch {
    return [];
  }
}

let running = false;
const noted = new Set(); // channel|reason already logged, so a standing "no cap" is logged once, not every minute

/**
 * One pass, at most one upload per channel. Dependencies are injected so tests never touch YouTube.
 * deps: { channels, drafts, now, capCheck, upload(draft, publishAt) -> youtube record, writeMeta(draft), logFile }
 */
export async function autoReleaseTick({ channels, drafts, now = Date.now(), capCheck, upload, writeMeta, logFile }) {
  if (running) return [];
  running = true;
  const results = [];
  try {
    for (const channel of channels) {
      if (!autoReleaseSettings(channel).enabled) continue;
      const plan = planRelease({ drafts, channel, now, capCheck });
      if (plan.action === 'skip') {
        const key = `${channel.id}|${plan.reason}`;
        if (!plan.quiet && !noted.has(key)) { noted.add(key); appendReleaseLog(logFile, { channel: channel.id, action: 'skipped', reason: plan.reason }); }
        results.push({ channel: channel.id, ...plan });
        continue;
      }
      noted.clear();
      const { draft, publishAt } = plan;
      try {
        const youtube = await upload(draft, publishAt);
        appendReleaseLog(logFile, { channel: channel.id, draft: draft.draftId, action: 'scheduled', publish_at: publishAt, video_id: youtube?.video_id });
        results.push({ channel: channel.id, action: 'scheduled', draft: draft.draftId, publishAt });
      } catch (err) {
        // Never retried automatically: a half-finished upload could otherwise be repeated every minute.
        draft.meta.auto_release_error = { at: new Date().toISOString(), message: String(err?.message || err).slice(0, 300) };
        try { writeMeta(draft); } catch { /* the log below still records it */ }
        appendReleaseLog(logFile, { channel: channel.id, draft: draft.draftId, action: 'failed', error: draft.meta.auto_release_error.message });
        results.push({ channel: channel.id, action: 'failed', draft: draft.draftId });
      }
    }
  } finally {
    running = false;
  }
  return results;
}
