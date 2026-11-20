// Tests for real damage only: over the daily limit, the same video twice, the wrong channel, an upload while paused,
// and a cut-off upload sent a second time.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { planUploads, manifestError, titleError, cleanSlots, localDay, MIN_GAP_MS } from '../server/rules.js';
import { ensureShare, intake, shareDirs, readJson, sign, verified, claimShare } from '../server/share.js';
import { createEngine } from '../server/engine.js';

const SCRATCH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../output/temp/uploader-tests');
const scratch = () => { fs.mkdirSync(SCRATCH, { recursive: true }); return fs.mkdtempSync(path.join(SCRATCH, 't-')); };
const CH = 'UC' + 'a'.repeat(22);
const CH2 = 'UC' + 'b'.repeat(22);
const at = (h, m = 0, day = 21) => new Date(2026, 10, day, h, m).getTime(); // local time, like the slots
const queued = (id, channel = CH, extra = {}) => ({ id, state: 'queued', order: Number(id.replace(/\D/g, '')) || 0, received_at: id, youtube_channel_id: channel, sha256: id.padEnd(64, '0'), title: `Video ${id}`, ...extra });
const stateOf = (packages, channels = { [CH]: { slots: ['15:00', '21:00'], daily_limit: 2 } }, paused = false) => ({ paused, channels, packages: Object.fromEntries(packages.map((p) => [p.id, p])) });
const DAY = 24 * 60 * 60 * 1000;
const KEY = 'k'.repeat(40);

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

const manifest = (over = {}) => ({ package_id: 'pkg1', sha256: 'a'.repeat(64), youtube_channel_id: CH, title: 'Why This Town Has Twenty Borders', description: 'x', tags: ['borders'], language: 'en', category_id: '27', made_for_kids: false, contains_synthetic_media: true, submission_id: 'sub1', ...over });

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

function drop(dirs, id, { title = `Video ${id} about a bridge`, channel = CH, bytes = `video-${id}`, ready = true, sha, key = KEY, tamper } = {}) {
  const folder = path.join(dirs.inbox, id);
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'video.mp4'), bytes);
  const m = manifest({ package_id: id, title, youtube_channel_id: channel, sha256: sha || crypto.createHash('sha256').update(bytes).digest('hex') });
  m.mac = sign(key, 'manifest', m);
  if (tamper) Object.assign(m, tamper); // changed on the share after ForgeAi signed it
  fs.writeFileSync(path.join(folder, 'manifest.json'), JSON.stringify(m));
  if (ready) fs.writeFileSync(path.join(folder, 'READY'), '');
}
const take = (dirs, packages, root) => intake(dirs, { packages, key: KEY, owner: 'me', localDir: path.join(root, 'local') });

test('intake: the same file twice is refused, a half-copied package is left alone, a damaged copy is refused', async () => {
  const root = scratch();
  const dirs = ensureShare(path.join(root, 'share'));
  const packages = {};
  drop(dirs, 'a1');
  drop(dirs, 'a2', { bytes: 'video-a1' }); // same bytes under a new name
  drop(dirs, 'a3', { ready: false });
  drop(dirs, 'a4', { sha: 'f'.repeat(64) });
  await take(dirs, packages, root);
  assert.equal(packages.a1.state, 'queued');
  assert.equal(packages.a2.state, 'refused');
  assert.match(packages.a2.error, /already sent/);
  assert.equal(packages.a3, undefined);
  assert.ok(fs.existsSync(path.join(dirs.inbox, 'a3')));
  assert.match(packages.a4.error, /does not match/);
  assert.equal(fs.readFileSync(path.join(root, 'local', 'a1', 'video.mp4'), 'utf8'), 'video-a1');
  assert.deepEqual(fs.readdirSync(dirs.claimed), []); // nothing of ours is left on the share
  const refused = readJson(path.join(dirs.results, 'a2.json'));
  assert.equal(refused.state, 'refused');
  assert.ok(verified(KEY, 'result', refused));
  // Sending a1 again changes nothing.
  drop(dirs, 'a1', { bytes: 'other' });
  await take(dirs, packages, root);
  assert.equal(packages.a1.state, 'queued');
  assert.equal(fs.readFileSync(path.join(root, 'local', 'a1', 'video.mp4'), 'utf8'), 'video-a1');
});

test('intake: a package ForgeAi did not sign, or one changed on the share after signing, is never queued', async () => {
  const root = scratch();
  const dirs = ensureShare(path.join(root, 'share'));
  const packages = {};
  drop(dirs, 's1', { key: 'x'.repeat(40) }); // a stranger's package
  drop(dirs, 's2', { tamper: { youtube_channel_id: CH2 } }); // pointed at another channel
  drop(dirs, 's3', { tamper: { title: 'Another title entirely' } });
  await take(dirs, packages, root);
  assert.deepEqual(packages, {});
  assert.deepEqual(fs.readdirSync(dirs.results), []); // and no answer is written in its name
});

test('intake: a folder with anything but the three plain files is left untouched; a crash after claiming is picked up', async () => {
  const root = scratch();
  const dirs = ensureShare(path.join(root, 'share'));
  const packages = {};
  drop(dirs, 'o1');
  fs.mkdirSync(path.join(dirs.inbox, 'o1', 'extra'));
  fs.writeFileSync(path.join(dirs.inbox, 'o1', 'extra', 'keep.txt'), 'x');
  drop(dirs, 'o2');
  fs.renameSync(path.join(dirs.inbox, 'o2'), path.join(dirs.claimed, 'o2.me')); // claimed, then the uploader died
  drop(dirs, 'o3');
  fs.renameSync(path.join(dirs.inbox, 'o3'), path.join(dirs.claimed, 'o3.other')); // another uploader's claim
  const events = await take(dirs, packages, root);
  assert.ok(fs.existsSync(path.join(dirs.inbox, 'o1', 'extra', 'keep.txt')));
  assert.equal(packages.o1, undefined);
  assert.ok(events.some((e) => e.id === 'o1' && e.state === 'ignored'));
  assert.equal(packages.o2.state, 'queued');
  assert.equal(packages.o3, undefined);
  assert.ok(fs.existsSync(path.join(dirs.claimed, 'o3.other')));
});

test('one uploader per folder: a second one is told to stop until the first is silent for 3 minutes', () => {
  const dirs = ensureShare(path.join(scratch(), 'share'));
  const t0 = at(10);
  assert.equal(claimShare(dirs, 'first', t0), null);
  assert.equal(claimShare(dirs, 'first', t0 + 60000), null);
  assert.match(claimShare(dirs, 'second', t0 + 2 * 60000), /another uploader/);
  assert.equal(claimShare(dirs, 'second', t0 + 5 * 60000), null);
  assert.match(claimShare(dirs, 'first', t0 + 5 * 60000 + 1000), /another uploader/);
});

function fakeYouTube({ owner = CH, fail, during } = {}) {
  const calls = [];
  return { calls, configured: true,
    async upload({ manifest: m, publishAt }) {
      calls.push([m.package_id, publishAt]);
      if (during) await during(calls.length);
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
  const engine = createEngine({ share, stateDir, youtube: yt, key: KEY, now: () => clock, aheadMs: 6 * 60 * 60 * 1000 });
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
  const r2 = readJson(path.join(shareDirs(share).results, 'b2.json'));
  assert.equal(r2.video_id, 'yt-b2');
  assert.ok(verified(KEY, 'result', r2));
  assert.equal(r2.submission_id, 'sub1');
});

test('engine: a pause or a removal made while one video uploads stops the next one', async () => {
  for (const change of ['pause', 'remove']) {
    const root = scratch();
    const share = path.join(root, 'share');
    const dirs = ensureShare(share);
    let engine;
    const yt = fakeYouTube({ during: async (n) => { if (n === 1) { if (change === 'pause') engine.setPaused(true); else await engine.packageAction('g2', 'remove'); } } });
    engine = createEngine({ share, stateDir: path.join(root, 'state'), youtube: yt, key: KEY, now: () => at(10), aheadMs: 14 * 60 * 60 * 1000 });
    engine.connect({ refresh_token: 'r', scope: 's', channel: { id: CH, title: 'Forge Atlas' } });
    drop(dirs, 'g1'); drop(dirs, 'g2');
    await engine.tick(); await engine.tick();
    assert.deepEqual(yt.calls.map((c) => c[0]), ['g1'], change);
  }
});

test('engine: an upload that broke after bytes left keeps its slot and waits for the owner', async () => {
  const root = scratch();
  const share = path.join(root, 'share');
  const dirs = ensureShare(share);
  let clock = at(10);
  const yt = fakeYouTube({ fail: Object.assign(new Error('socket hang up'), { sent: true }) });
  const engine = createEngine({ share, stateDir: path.join(root, 'state'), youtube: yt, key: KEY, now: () => clock, aheadMs: 6 * 60 * 60 * 1000 });
  engine.connect({ refresh_token: 'r', scope: 's', channel: { id: CH, title: 'Forge Atlas' } });
  drop(dirs, 'h1'); drop(dirs, 'h2');
  await engine.tick();
  for (let i = 0; i < 4; i += 1) { clock += 31 * 60 * 1000; await engine.tick(); }
  assert.deepEqual(yt.calls.map((c) => [c[0], new Date(c[1]).getHours()]), [['h1', 15]]); // h1 not sent again, h2 not put into h1's 15:00 slot
  assert.equal(engine.view().channels[0].scheduled[0].state, 'unclear');
});

test('engine: a sign-in of another channel uploads nothing and is not tried again', async () => {
  const root = scratch();
  const share = path.join(root, 'share');
  const dirs = ensureShare(share);
  const yt = fakeYouTube({ owner: CH2 });
  const engine = createEngine({ share, stateDir: path.join(root, 'state'), youtube: yt, key: KEY, now: () => at(10) });
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
  const engine = createEngine({ share, stateDir, youtube: yt, key: KEY, now: () => at(10) });
  await engine.tick(); await engine.tick();
  assert.equal(yt.calls.length, 0);
  assert.equal(engine.view().channels[0].scheduled[0].state, 'unclear');
});

test('engine: a failed upload waits 30 minutes, and stops after three tries', async () => {
  const root = scratch();
  const share = path.join(root, 'share');
  const dirs = ensureShare(share);
  let clock = at(10);
  const yt = fakeYouTube({ fail: new Error('YouTube HTTP 503') });
  const engine = createEngine({ share, stateDir: path.join(root, 'state'), youtube: yt, key: KEY, now: () => clock });
  engine.connect({ refresh_token: 'r', scope: 's', channel: { id: CH, title: 'Forge Atlas' } });
  drop(dirs, 'e1');
  await engine.tick(); await engine.tick();
  assert.equal(yt.calls.length, 1);
  for (let i = 0; i < 6; i += 1) { clock += 31 * 60 * 1000; await engine.tick(); }
  assert.equal(yt.calls.length, 3);
  assert.equal(engine.view().channels[0].history[0].state, 'failed');
});
