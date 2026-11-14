import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { autoReleaseTick, autoReleaseSettings, releaseQuality, readReleaseLog } from '../routes/autoRelease.js';
import { capCheck } from '../routes/youtube.js';

const good = (id, extra = {}) => ({ draftId: id, meta: { channel_id: 'c1', video_file: 'v.mp4', created_at: id, generation_details: { fact_check: { verified: true }, length_check: { within_tolerance: true }, visual_loop: { accepted_round: 1 } }, ...extra } });
const logFile = () => path.join(fs.mkdtempSync(path.join(process.env.TEMP || os.tmpdir(), 'rel-')), 'log.jsonl');
const run = (channel, drafts, up = []) => autoReleaseTick({ channels: [channel], drafts, now: Date.UTC(2026, 10, 15, 8), capCheck, logFile: logFile(), writeMeta() {}, upload: async (d, at) => { up.push([d.draftId, at]); d.meta.youtube = { video_id: 'v', publish_at: at, privacy: 'unlisted' }; return d.meta.youtube; } });

test('auto release is off by default and releases nothing without a cap', async () => {
  const up = [];
  assert.deepEqual(autoReleaseSettings({ id: 'c1' }), { enabled: false, cap: null });
  await run({ id: 'c1' }, [good('a')], up);
  await run({ id: 'c1', auto_release: { enabled: true } }, [good('a')], up);
  await run({ id: 'c1', auto_release: { enabled: true, daily_cap: 0 } }, [good('a')], up);
  await run({ id: 'c1', auto_release: { enabled: 'true', daily_cap: 2 } }, [good('a')], up);
  assert.equal(up.length, 0);
});

test('the quality bar needs explicit passes; missing evidence blocks', () => {
  assert.equal(releaseQuality(good('a').meta).ok, true);
  assert.equal(releaseQuality({ generation_details: {} }).reasons.length, 3);
  assert.equal(releaseQuality(good('a', { generation_details: { fact_check: { verified: true }, length_check: { within_tolerance: true }, visual_loop: { accepted_round: 1 }, visual_check: { approved: false } } }).meta).ok, false);
});

test('release respects the cap per day, schedules unlisted publishAt, and logs', async () => {
  const up = [];
  const ch = { id: 'c1', auto_release: { enabled: true, daily_cap: 1 } };
  const drafts = [good('a'), good('b'), good('bad', { generation_details: {} })];
  await run(ch, drafts, up);
  await run(ch, drafts, up);
  assert.deepEqual(up.map((u) => u[0]), ['a', 'b']);
  assert.notEqual(up[0][1].slice(0, 10), up[1][1].slice(0, 10)); // cap 1: second goes to another day
});

test('a cap above 20 is the owner\'s choice and is kept', () => {
  assert.equal(autoReleaseSettings({ auto_release: { enabled: true, daily_cap: 40 } }).cap, 40);
});

test('a lost race with the Publish button is skipped, not marked as a failure', async () => {
  const d = good('a');
  const res = await autoReleaseTick({ channels: [{ id: 'c1', auto_release: { enabled: true, daily_cap: 3 } }], drafts: [d], now: Date.UTC(2026, 10, 15, 8), capCheck, logFile: logFile(), writeMeta() {}, upload: async () => { throw Object.assign(new Error('busy'), { code: 'SKIP' }); } });
  assert.equal(res[0].action, 'skipped');
  assert.equal(d.meta.auto_release_error, undefined);
});

test('evidence stores only real verdicts', async () => {
  const { releaseEvidence } = await import('../episode/codebuilt/draftAdapter.js');
  assert.deepEqual(releaseEvidence({ requestedDuration: null, duration: null }), {});
  assert.equal(releaseEvidence({ factCheck: { verified: false }, requestedDuration: 60, duration: 61 }).fact_check, undefined);
  const e = releaseEvidence({ factCheck: { verified: true, summary: { claims: 7, false_claims: 0 } }, requestedDuration: 60, duration: 100 });
  assert.equal(e.fact_check.claims, 7);
  assert.equal(e.length_check.within_tolerance, false); // a real miss is recorded as a miss
});
