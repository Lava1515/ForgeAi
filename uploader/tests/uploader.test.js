// Tests for real damage only: over the daily limit, the same video twice, the wrong channel, an upload while paused,
// and a cut-off upload sent a second time.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { planUploads, manifestError, titleError, cleanSlots, localDay, MIN_GAP_MS } from '../server/rules.js';
import { ensureShare, intake, shareDirs, readJson } from '../server/share.js';
import { createEngine } from '../server/engine.js';

const SCRATCH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../output/temp/uploader-tests');
const scratch = () => { fs.mkdirSync(SCRATCH, { recursive: true }); return fs.mkdtempSync(path.join(SCRATCH, 't-')); };
const CH = 'UC' + 'a'.repeat(22);
const CH2 = 'UC' + 'b'.repeat(22);
const at = (h, m = 0, day = 21) => new Date(2026, 10, day, h, m).getTime(); // local time, like the slots
const queued = (id, channel = CH, extra = {}) => ({ id, state: 'queued', order: Number(id.replace(/\D/g, '')) || 0, received_at: id, youtube_channel_id: channel, sha256: id.padEnd(64, '0'), title: `Video ${id}`, ...extra });
const stateOf = (packages, channels = { [CH]: { slots: ['15:00', '21:00'], daily_limit: 2 } }, paused = false) => ({ paused, channels, packages: Object.fromEntries(packages.map((p) => [p.id, p])) });
const DAY = 24 * 60 * 60 * 1000;

test('never more than the daily limit, never two in one slot, oldest first', () => {
  const state = stateOf([queued('p1'), queued('p2'), queued('p3'), queued('p4'), queued('p5')]);
  const plan = planUploads({ state, connected: new Set([CH]), now: at(10), aheadMs: 3 * DAY });
  assert.deepEqual(plan.map((p) => p.id), ['p1', 'p2', 'p3', 'p4', 'p5']);
  const perDay = {};
  for (const p of plan) perDay[localDay(Date.parse(p.publishAt))] = (perDay[localDay(Date.parse(p.publishAt))] || 0) + 1;
  assert.ok(Object.values(perDay).every((n) => n <= 2), JSON.stringify(perDay));
  assert.equal(new Set(plan.map((p) => p.publishAt)).size, plan.length);
  const times = plan.map((p) => Date.parse(p.publishAt)).sort((a, b) => a - b);
  for (let i = 1; i < times.length; i += 1) assert.ok(times[i] - times[i - 1] >= MIN_GAP_MS);
});

test('a slot that already holds a video is not used again, and a limit of 1 leaves the second slot empty', () => {
  const held = queued('p0', CH, { state: 'scheduled', publish_at: new Date(at(15)).toISOString() });
  const two = planUploads({ state: stateOf([held, queued('p1'), queued('p2')]), connected: new Set([CH]), now: at(10), aheadMs: 14 * 60 * 60 * 1000 });
  assert.deepEqual(two.map((p) => [p.id, new Date(p.publishAt).getHours()]), [['p1', 21]]);
  const one = planUploads({ state: stateOf([held, queued('p1')], { [CH]: { slots: ['15:00', '21:00'], daily_limit: 1 } }), connected: new Set([CH]), now: at(10), aheadMs: 14 * 60 * 60 * 1000 });
  assert.deepEqual(one, []);
});

test('paused, not connected, or a broken setting: nothing is uploaded', () => {
  const pkgs = [queued('p1')];
  const base = { connected: new Set([CH]), now: at(10), aheadMs: DAY };
  assert.equal(planUploads({ ...base, state: stateOf(pkgs) }).length, 1);
  assert.deepEqual(planUploads({ ...base, state: stateOf(pkgs, undefined, true) }), []);
  assert.deepEqual(planUploads({ ...base, state: stateOf(pkgs, { [CH]: { slots: ['15:00'], daily_limit: 2, paused: true } }) }), []);
  assert.deepEqual(planUploads({ ...base, state: stateOf(pkgs), connected: new Set([CH2]) }), []);
  assert.deepEqual(planUploads({ ...base, state: stateOf(pkgs, { [CH]: { slots: ['15:00', '16:00'], daily_limit: 2 } }) }), []);
  assert.deepEqual(planUploads({ ...base, state: stateOf(pkgs, { [CH]: { slots: ['15:00'], daily_limit: 99 } }) }), []);
});

test('a video of one channel never takes a slot of another', () => {
  const state = stateOf([queued('p1', CH2)], { [CH]: { slots: ['15:00'], daily_limit: 2 }, [CH2]: { slots: ['16:00'], daily_limit: 2 } });
  const plan = planUploads({ state, connected: new Set([CH, CH2]), now: at(10), aheadMs: DAY });
  assert.deepEqual(plan.map((p) => [p.id, p.channel, new Date(p.publishAt).getHours()]), [['p1', CH2, 16]]);
});

test('slot times closer than 4 hours are refused, also across midnight', () => {
  assert.deepEqual(cleanSlots(['21:00', '7:00']), ['07:00', '21:00']);
  assert.throws(() => cleanSlots(['15:00', '18:00']));
  assert.throws(() => cleanSlots(['01:00', '23:00']));
  assert.throws(() => cleanSlots(['25:00']));
});

const manifest = (over = {}) => ({ package_id: 'pkg1', sha256: 'a'.repeat(64), youtube_channel_id: CH, title: 'Why This Town Has Twenty Borders', description: 'x', tags: ['borders'], language: 'en', category_id: '27', made_for_kids: false, contains_synthetic_media: true, ...over });

test('the manifest rules: a date title, a kids flag, a known file and a foreign folder name are refused', () => {
  assert.equal(manifestError(manifest(), { folderId: 'pkg1' }), null);
  assert.match(manifestError(manifest({ title: '19 בנובמבר 2026' })), /date/);
  assert.match(manifestError(manifest({ title: '2026-11-20 14:00' })), /date/);
  assert.equal(titleError('What if Earth stopped spinning for 5 seconds?'), null);
  assert.match(manifestError(manifest({ made_for_kids: true })), /made_for_kids/);
  assert.match(manifestError(manifest(), { knownHashes: new Set(['a'.repeat(64)]) }), /already sent/);
  assert.match(manifestError(manifest(), { folderId: 'other' }), /folder/);
  assert.match(manifestError(manifest({ youtube_channel_id: 'ForgeStudio' })), /channel/);
  assert.match(manifestError(manifest({ package_id: '../x' })), /package_id/);
});

function drop(dirs, id, { title = `Video ${id} about a bridge`, channel = CH, bytes = `video-${id}`, ready = true, sha } = {}) {
  const folder = path.join(dirs.inbox, id);
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'video.mp4'), bytes);
  fs.writeFileSync(path.join(folder, 'manifest.json'), JSON.stringify(manifest({ package_id: id, title, youtube_channel_id: channel, sha256: sha || crypto.createHash('sha256').update(bytes).digest('hex') })));
  if (ready) fs.writeFileSync(path.join(folder, 'READY'), '');
}

test('intake: the same file twice is refused, a half-copied package is left alone, a damaged copy is refused', async () => {
  const dirs = ensureShare(scratch());
  const packages = {};
  drop(dirs, 'a1');
  drop(dirs, 'a2', { bytes: 'video-a1' }); // same bytes under a new name
  drop(dirs, 'a3', { ready: false });
  drop(dirs, 'a4', { sha: 'f'.repeat(64) });
  await intake(dirs, packages);
  assert.equal(packages.a1.state, 'queued');
  assert.equal(packages.a2.state, 'refused');
  assert.match(packages.a2.error, /already sent/);
  assert.equal(packages.a3, undefined);
  assert.ok(fs.existsSync(path.join(dirs.inbox, 'a3')));
  assert.match(packages.a4.error, /does not match/);
  assert.ok(fs.existsSync(path.join(dirs.taken, 'a1', 'video.mp4')));
  assert.equal(readJson(path.join(dirs.results, 'a2.json')).state, 'refused');
  // Sending a1 again changes nothing.
  drop(dirs, 'a1', { bytes: 'other' });
  await intake(dirs, packages);
  assert.equal(packages.a1.state, 'queued');
  assert.equal(fs.readFileSync(path.join(dirs.taken, 'a1', 'video.mp4'), 'utf8'), 'video-a1');
});

function fakeYouTube({ owner = CH, fail } = {}) {
  const calls = [];
  return { calls, configured: true,
    async upload({ manifest: m, publishAt }) {
      calls.push([m.package_id, publishAt]);
      if (fail) throw fail;
      if (owner !== m.youtube_channel_id) throw Object.assign(new Error('wrong channel'), { fatal: true });
      return { video_id: `yt-${m.package_id}` };
    },
    async privacyOf() { return 'public'; }, async cancelSchedule() {} };
}

test('engine: a package is handed to YouTube once, for its slot; paused hands over nothing', async () => {
  const root = scratch();
  const share = path.join(root, 'share'); const stateDir = path.join(root, 'state');
  const dirs = ensureShare(share);
  let clock = at(10);
  const yt = fakeYouTube();
  const engine = createEngine({ share, stateDir, youtube: yt, now: () => clock, aheadMs: 6 * 60 * 60 * 1000 });
  engine.connect({ refresh_token: 'r', scope: 's', channel: { id: CH, title: 'Forge Atlas' } });
  drop(dirs, 'b1'); drop(dirs, 'b2'); drop(dirs, 'b3');
  engine.setPaused(true);
  await engine.tick();
  assert.equal(yt.calls.length, 0);
  engine.setPaused(false);
  await engine.tick();
  await engine.tick();
  assert.deepEqual(yt.calls.map((c) => [c[0], new Date(c[1]).getHours()]), [['b1', 15]]); // 21:00 is more than 6 h ahead
  clock = at(15, 30);
  await engine.tick();
  await engine.tick();
  assert.deepEqual(yt.calls.map((c) => c[0]), ['b1', 'b2']);
  const view = engine.view().channels[0];
  assert.equal(view.queue.length, 1);
  assert.equal(readJson(path.join(shareDirs(share).results, 'b1.json')).state, 'public');
  assert.equal(readJson(path.join(shareDirs(share).results, 'b2.json')).video_id, 'yt-b2');
});

test('engine: a sign-in of another channel uploads nothing and is not tried again', async () => {
  const root = scratch();
  const share = path.join(root, 'share');
  const dirs = ensureShare(share);
  const yt = fakeYouTube({ owner: CH2 });
  const engine = createEngine({ share, stateDir: path.join(root, 'state'), youtube: yt, now: () => at(10) });
  engine.connect({ refresh_token: 'r', scope: 's', channel: { id: CH, title: 'Forge Atlas' } });
  drop(dirs, 'c1');
  await engine.tick(); await engine.tick(); await engine.tick();
  assert.equal(yt.calls.length, 1);
  assert.equal(engine.view().channels[0].history[0].state, 'failed');
});

test('engine: an upload cut off by a crash is not sent a second time', async () => {
  const root = scratch();
  const share = path.join(root, 'share'); const stateDir = path.join(root, 'state');
  ensureShare(share);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'state.json'), JSON.stringify(stateOf([queued('d1', CH, { state: 'uploading', publish_at: new Date(at(15)).toISOString() })])));
  fs.writeFileSync(path.join(stateDir, 'tokens.json'), JSON.stringify({ [CH]: { refresh_token: 'r', title: 'Forge Atlas' } }));
  const yt = fakeYouTube();
  const engine = createEngine({ share, stateDir, youtube: yt, now: () => at(10) });
  await engine.tick(); await engine.tick();
  assert.equal(yt.calls.length, 0);
  assert.equal(engine.view().channels[0].history[0].state, 'failed');
});

test('engine: a failed upload waits 30 minutes, and stops after three tries', async () => {
  const root = scratch();
  const share = path.join(root, 'share');
  const dirs = ensureShare(share);
  let clock = at(10);
  const yt = fakeYouTube({ fail: new Error('YouTube HTTP 503') });
  const engine = createEngine({ share, stateDir: path.join(root, 'state'), youtube: yt, now: () => clock });
  engine.connect({ refresh_token: 'r', scope: 's', channel: { id: CH, title: 'Forge Atlas' } });
  drop(dirs, 'e1');
  await engine.tick(); await engine.tick();
  assert.equal(yt.calls.length, 1);
  for (let i = 0; i < 6; i += 1) { clock += 31 * 60 * 1000; await engine.tick(); }
  assert.equal(yt.calls.length, 3);
  assert.equal(engine.view().channels[0].history[0].state, 'failed');
});
