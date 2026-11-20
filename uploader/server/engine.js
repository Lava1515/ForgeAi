// The uploader's loop: take signed packages from the share into its own folder, hand the next one of each channel to
// YouTube for its slot, watch that YouTube published it, and delete the copy a week later. All state is one JSON file.
import fs from 'node:fs';
import path from 'node:path';
import { ensureShare, shareDirs, intake, localPackage, deleteLocal, writeResult, writeJsonAtomic, readJson, claimShare, ownerId } from './share.js';
import { planUploads, upcomingSlots, cleanSlots, cleanDailyLimit, isChannelId, isSafeId, holdsSlot, DEFAULT_SLOTS, DEFAULT_DAILY_LIMIT, DAY_MS } from './rules.js';

const RETRY_MS = 30 * 60 * 1000;
const MAX_ATTEMPTS = 3;
const CHECK_EVERY_MS = 5 * 60 * 1000;
const MAX_UPLOADS_PER_PASS = 10;
const ENDED = new Set(['refused', 'removed', 'cancelled', 'gone', 'failed']);
const UNCLEAR = 'The upload was cut off, so the video may or may not be on YouTube. Look in YouTube Studio first: if it is there, press Remove here; if not, press Retry. Its slot stays reserved until you choose.';

export function createEngine({ share, stateDir, youtube, key, now = () => Date.now(), aheadMs = 6 * 60 * 60 * 1000, keepDays = 7 }) {
  fs.mkdirSync(stateDir, { recursive: true });
  const stateFile = path.join(stateDir, 'state.json');
  const tokensFile = path.join(stateDir, 'tokens.json');
  const logFile = path.join(stateDir, 'uploader.log.jsonl');
  const localDir = path.join(stateDir, 'packages'); // the verified copies; uploads read from here, never from the share
  const owner = ownerId(stateDir);
  const dirs = shareDirs(share);
  const state = { paused: false, channels: {}, packages: {}, ...(readJson(stateFile) || {}) };
  let tokens = readJson(tokensFile) || {};
  let problems = [];
  let busy = false;

  const iso = (ms = now()) => new Date(ms).toISOString();
  const save = () => writeJsonAtomic(stateFile, state);
  const log = (event, detail = {}) => { try { fs.appendFileSync(logFile, `${JSON.stringify({ at: iso(), event, ...detail })}\n`); } catch { /* the log never stops the work */ } };
  // The answer for ForgeAi. When the share is away the package is marked and the answer is written on a later pass.
  const publish = (pkg) => { try { writeResult(dirs, key, pkg); pkg.result_due = false; } catch { pkg.result_due = true; } };
  const channelOf = (id) => (state.channels[id] ??= { name: tokens[id]?.title || id, slots: [...DEFAULT_SLOTS], daily_limit: DEFAULT_DAILY_LIMIT, paused: false });

  // An upload that was cut off (power, crash) may have reached YouTube. It keeps its slot and is never sent again by itself.
  for (const pkg of Object.values(state.packages)) {
    if (pkg.state === 'uploading') { Object.assign(pkg, { state: 'unclear', error: UNCLEAR, result_due: true }); log('unclear', { id: pkg.id, reason: 'restart during upload' }); }
  }
  save();

  async function uploadOne({ id, channel, publishAt }) {
    const pkg = state.packages[id];
    const local = localPackage(localDir, id);
    if (!local || local.manifest.youtube_channel_id !== channel || local.manifest.sha256 !== pkg.sha256) {
      Object.assign(pkg, { state: 'failed', error: 'The uploader\'s copy of this video is missing or changed.', ended_at: iso(), publish_at: null });
      log('failed', { id, reason: pkg.error }); save(); publish(pkg); return;
    }
    Object.assign(pkg, { state: 'uploading', publish_at: publishAt, error: null });
    save(); // on disk before the first byte leaves: a crash now is seen as "unclear", never as "still waiting"
    try {
      const { video_id } = await youtube.upload({ refreshToken: tokens[channel].refresh_token, manifest: local.manifest, videoFile: local.videoFile, publishAt });
      Object.assign(pkg, { state: 'scheduled', video_id, uploaded_at: iso(), synthetic: local.manifest.contains_synthetic_media === true });
      log('scheduled', { id, channel, video_id, publish_at: publishAt });
    } catch (err) {
      const reason = String(err.message || err).slice(0, 400);
      if (err.sent === true) {
        // Video bytes left this machine: YouTube may hold the video. Keep the slot, do not retry, let the owner decide.
        Object.assign(pkg, { state: 'unclear', error: `${UNCLEAR} (${reason})` });
        log('unclear', { id, channel, reason });
      } else {
        const attempts = (pkg.attempts || 0) + 1;
        const final = err.fatal === true || attempts >= MAX_ATTEMPTS;
        Object.assign(pkg, { attempts, error: reason, publish_at: null }, final ? { state: 'failed', ended_at: iso() } : { state: 'queued', next_try_at: iso(now() + RETRY_MS) });
        log(final ? 'failed' : 'retry_later', { id, channel, reason });
      }
    }
    save(); publish(pkg);
  }

  async function reconcile() {
    for (const pkg of Object.values(state.packages)) {
      if (pkg.state !== 'scheduled' || Date.parse(pkg.publish_at) + 2 * 60 * 1000 > now()) continue;
      if (pkg.checked_at && Date.parse(pkg.checked_at) + CHECK_EVERY_MS > now()) continue;
      const token = tokens[pkg.youtube_channel_id];
      if (!token) continue;
      pkg.checked_at = iso();
      try {
        const privacy = await youtube.privacyOf({ refreshToken: token.refresh_token, videoId: pkg.video_id });
        if (privacy === 'public') { Object.assign(pkg, { state: 'public', public_at: pkg.publish_at, error: null }); log('public', { id: pkg.id }); }
        else if (privacy === 'gone') { Object.assign(pkg, { state: 'gone', error: 'The video is no longer on YouTube.', ended_at: iso() }); log('gone', { id: pkg.id }); }
        else if (now() > Date.parse(pkg.publish_at) + 6 * 60 * 60 * 1000) pkg.error = 'YouTube has not made it public yet. Check it in YouTube Studio.';
      } catch (err) { pkg.error = String(err.message || err).slice(0, 400); }
      publish(pkg);
    }
  }

  function cleanup() {
    const keep = keepDays * DAY_MS;
    for (const pkg of Object.values(state.packages)) {
      if (pkg.deleted_at) continue;
      const since = pkg.state === 'public' ? Date.parse(pkg.public_at) : ENDED.has(pkg.state) ? Date.parse(pkg.ended_at || pkg.received_at) : NaN;
      if (Number.isFinite(since) && since + keep <= now()) {
        try { deleteLocal(localDir, pkg.id); pkg.deleted_at = iso(); log('copy_deleted', { id: pkg.id }); } catch { /* next pass */ }
      }
    }
  }

  async function tick() {
    if (busy) return;
    busy = true;
    const found = [];
    try {
      try { ensureShare(share); } catch (err) { found.push(`The hand-over folder is not usable: ${share} (${err.code || err.message}). Nothing is taken or uploaded until it is.`); return; }
      const clash = claimShare(dirs, owner, now());
      if (clash) { found.push(`Stopped: ${clash}.`); return; }
      for (const e of await intake(dirs, { packages: state.packages, key, owner, localDir, save, now: iso })) {
        log(e.state === 'queued' ? 'received' : e.state, { id: e.id, reason: e.reason });
        if (e.state === 'ignored') found.push(`Inbox folder "${e.id}": ${e.reason}.`);
      }
      for (const pkg of Object.values(state.packages)) {
        if (isChannelId(pkg.youtube_channel_id)) channelOf(pkg.youtube_channel_id);
        if (pkg.result_due) publish(pkg);
      }
      save();
      if (!youtube.configured) found.push('YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET are not set. Nothing can be uploaded.');
      else {
        // One at a time, and the plan is made again before each upload from what is true at that moment: a pause, a removed
        // video, a changed limit or a slot that has come too close all take effect before the next video leaves.
        for (let i = 0; i < MAX_UPLOADS_PER_PASS; i += 1) {
          const [next] = planUploads({ state, connected: new Set(Object.keys(tokens)), now: now(), aheadMs });
          if (!next) break;
          if (claimShare(dirs, owner, now())) break;
          await uploadOne(next);
        }
        await reconcile();
      }
      cleanup();
      save();
    } catch (err) {
      found.push(`Unexpected error: ${String(err.message || err).slice(0, 200)}`);
      log('tick_error', { reason: String(err.message || err).slice(0, 400) });
    } finally { problems = found; busy = false; }
  }

  const brief = (pkg) => ({ id: pkg.id, title: pkg.title, state: pkg.state, error: pkg.error || null, received_at: pkg.received_at, publish_at: pkg.publish_at || null,
    public_at: pkg.public_at || null, video_id: pkg.video_id || null, url: pkg.video_id ? `https://www.youtube.com/shorts/${pkg.video_id}` : null, video_type: pkg.video_type || null, next_try_at: pkg.next_try_at || null });

  function view() {
    const packages = Object.values(state.packages);
    const ids = new Set([...Object.keys(state.channels), ...Object.keys(tokens)]);
    const channels = [...ids].map((id) => {
      const cfg = channelOf(id);
      const mine = packages.filter((p) => p.youtube_channel_id === id);
      const booked = mine.filter(holdsSlot);
      let slots = [];
      try { slots = upcomingSlots(cleanSlots(cfg.slots), now(), now() + 2 * DAY_MS).slice(0, 4).map((at) => ({ at: new Date(at).toISOString(), package: booked.find((p) => Date.parse(p.publish_at) === at)?.title || null })); } catch { /* a broken setting shows no slots */ }
      return {
        id, name: tokens[id]?.title || cfg.name || id, connected: Boolean(tokens[id]), paused: cfg.paused === true, slots: cfg.slots, daily_limit: cfg.daily_limit, next_slots: slots,
        queue: mine.filter((p) => p.state === 'queued').sort((a, b) => (a.order ?? 0) - (b.order ?? 0)).map(brief),
        scheduled: mine.filter((p) => ['scheduled', 'uploading', 'unclear'].includes(p.state)).sort((a, b) => String(a.publish_at).localeCompare(String(b.publish_at))).map(brief),
        history: mine.filter((p) => p.state === 'public' || ENDED.has(p.state)).sort((a, b) => String(b.public_at || b.ended_at || b.received_at).localeCompare(String(a.public_at || a.ended_at || a.received_at))).slice(0, 30).map(brief),
      };
    }).sort((a, b) => a.name.localeCompare(b.name));
    return { paused: state.paused === true, share, oauth_configured: youtube.configured, problems, channels, now: iso(), time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone };
  }

  return {
    tick, view, dirs, owner,
    setPaused(paused, channelId) {
      if (channelId === undefined) state.paused = paused === true;
      else { if (!state.channels[channelId]) throw new Error('Unknown channel'); state.channels[channelId].paused = paused === true; }
      log(paused ? 'paused' : 'resumed', { channel: channelId || 'all' }); save();
    },
    setChannel(channelId, { slots, daily_limit }) {
      if (!state.channels[channelId]) throw new Error('Unknown channel');
      const next = { slots: cleanSlots(slots), daily_limit: cleanDailyLimit(daily_limit) };
      Object.assign(state.channels[channelId], next);
      log('settings', { channel: channelId, ...next }); save();
    },
    async packageAction(id, action) {
      const pkg = isSafeId(id) ? state.packages[id] : null;
      if (!pkg) throw new Error('Unknown video');
      if (action === 'remove' && ['queued', 'failed', 'unclear'].includes(pkg.state)) Object.assign(pkg, { state: 'removed', ended_at: iso(), publish_at: null });
      else if (action === 'retry' && ['failed', 'unclear'].includes(pkg.state)) Object.assign(pkg, { state: 'queued', attempts: 0, error: null, next_try_at: null, ended_at: null, publish_at: null });
      else if ((action === 'up' || action === 'down') && pkg.state === 'queued') {
        const line = Object.values(state.packages).filter((p) => p.state === 'queued' && p.youtube_channel_id === pkg.youtube_channel_id).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
        const other = line[line.indexOf(pkg) + (action === 'up' ? -1 : 1)];
        if (other) [pkg.order, other.order] = [other.order, pkg.order];
      } else if (action === 'cancel' && pkg.state === 'scheduled') {
        if (Date.parse(pkg.publish_at) <= now()) throw new Error('This video is already public or about to be. Change it in YouTube Studio.');
        const token = tokens[pkg.youtube_channel_id];
        if (!token) throw new Error('This channel is not connected.');
        await youtube.cancelSchedule({ refreshToken: token.refresh_token, videoId: pkg.video_id, containsSyntheticMedia: pkg.synthetic === true });
        Object.assign(pkg, { state: 'cancelled', ended_at: iso(), publish_at: null, error: 'Schedule cancelled. The video stays private on YouTube.' });
      } else throw new Error('That is not possible for this video now.');
      log(action, { id }); save(); publish(pkg);
    },
    connect({ refresh_token, scope, channel }) {
      tokens = { ...tokens, [channel.id]: { refresh_token, scope, title: channel.title } };
      writeJsonAtomic(tokensFile, tokens);
      channelOf(channel.id).name = channel.title;
      log('connected', { channel: channel.id }); save();
    },
    disconnect(channelId) {
      if (!tokens[channelId]) throw new Error('Unknown channel');
      const { [channelId]: _gone, ...rest } = tokens;
      tokens = rest;
      writeJsonAtomic(tokensFile, tokens);
      log('disconnected', { channel: channelId });
    },
  };
}
