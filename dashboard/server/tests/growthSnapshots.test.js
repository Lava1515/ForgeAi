// G3: ages must be read from stored points, never guessed. A video is only compared at an age it was actually measured near.
import test from 'node:test';
import assert from 'node:assert/strict';
import { addSnapshots, historyFor, views24h } from '../growth/snapshots.js';

const H = 3600 * 1000;
const pub = Date.parse('2026-11-01T00:00:00Z');
const video = (views) => ({ video_id: 'v1', published_at: new Date(pub).toISOString(), views, likes: 0, comments: 0 });

test('points are kept at most every 45 minutes and give views at the measured ages only', () => {
  let store = {};
  store = addSnapshots(store, [video(10)], pub + 1 * H);
  store = addSnapshots(store, [video(11)], pub + 1.2 * H); // too close: dropped
  store = addSnapshots(store, [video(300)], pub + 23 * H);
  store = addSnapshots(store, [video(500)], pub + 47 * H);
  store = addSnapshots(store, [video(900)], pub + 28.5 * 24 * H);
  assert.equal(store.v1.length, 4);
  const hist = historyFor(store.v1);
  assert.deepEqual(hist.map((h) => [h.age_days, h.views]), [[1, 300], [2, 500], [28, 900]]); // no point near day 7: no entry
});

test('views_24h needs a point 18 to 30 hours before the latest', () => {
  let store = addSnapshots({}, [video(100)], pub + 2 * H);
  assert.equal(views24h(store.v1), null);
  store = addSnapshots(store, [video(160)], pub + 26 * H);
  assert.equal(views24h(store.v1), 60);
});
