// Send to uploader: the manifest names the draft's own channel, and a draft that cannot be matched to a YouTube channel is not sent.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildManifest, applyResult, sign, UPLOAD_CATEGORY } from '../routes/uploader.js';

const meta = { video_file: 'video.mp4', script: 'A town has twenty borders. Here is why.', made_for_kids: false, ai_disclosure: true, listing_copy: { title: 'old', tags: ['baarle', 'borders'] }, generation_details: { fact_check: { verified: true } } };
const channel = { id: 'ch_1', name: 'Forge Atlas', youtube_channel_id: 'UC' + 'a'.repeat(22), profile: { language: 'en' } };
const args = (over = {}) => ({ draftId: 'cb-1', meta, channel, title: 'Why This Town Has Twenty Borders', tags: undefined, sha256: 'f'.repeat(64), ...over });

test('the manifest carries the channel of the draft and never a kids flag', () => {
  const m = buildManifest(args());
  assert.equal(m.youtube_channel_id, channel.youtube_channel_id);
  assert.equal(m.package_id, 'cb-1');
  assert.equal(m.title, 'Why This Town Has Twenty Borders');
  assert.equal(m.made_for_kids, false);
  assert.equal(m.contains_synthetic_media, true);
  assert.equal(m.category_id, UPLOAD_CATEGORY);
  assert.deepEqual(m.tags, ['baarle', 'borders']);
  assert.match(m.description, /twenty borders/);
});

test('no YouTube channel id, a kids draft or a date title: nothing is sent', () => {
  assert.throws(() => buildManifest(args({ channel: { ...channel, youtube_channel_id: '' } })), /YouTube Channel ID/);
  assert.throws(() => buildManifest(args({ channel: { ...channel, youtube_channel_id: 'ForgeAtlas' } })), /YouTube Channel ID/);
  assert.throws(() => buildManifest(args({ channel: null })), /no channel/);
  assert.throws(() => buildManifest(args({ meta: { ...meta, made_for_kids: true } })), /kids/);
  assert.throws(() => buildManifest(args({ title: '20 November 2026' })), /date/);
});

test('a result counts only when the uploader signed it for exactly this send', () => {
  const KEY = 'k'.repeat(40);
  const sent = { package_id: 'cb-1', submission_id: 'sub1', sha256: 'f'.repeat(64), youtube_channel_id: channel.youtube_channel_id, state: 'sent' };
  const signed = (over = {}, key = KEY) => { const r = { package_id: 'cb-1', submission_id: 'sub1', sha256: 'f'.repeat(64), state: 'scheduled', video_id: 'abcDEF12345', publish_at: '2026-11-21T13:00:00.000Z', public_at: null, reason: null, youtube_channel_id: channel.youtube_channel_id, updated_at: '2026-11-20T16:00:00.000Z', ...over }; r.mac = sign(key, 'result', r); return r; };
  const unchanged = (result) => { const m = { uploader: { ...sent } }; assert.equal(applyResult(m, result, KEY), false); assert.equal(m.youtube, undefined); };
  unchanged(signed({}, 'x'.repeat(40))); // not the uploader's key
  unchanged({ ...signed(), state: 'public' }); // changed after signing
  unchanged(signed({ package_id: 'cb-2' }));
  unchanged(signed({ submission_id: 'older-send' }));
  unchanged(signed({ sha256: 'e'.repeat(64) }));
  unchanged(signed({ youtube_channel_id: 'UC' + 'b'.repeat(22) }));
  unchanged(signed({ state: 'published!!' }));
  for (const junk of [null, [], 'x', {}]) unchanged(junk);
  const noId = { uploader: { ...sent } };
  applyResult(noId, signed({ video_id: '../../etc' }), KEY);
  assert.equal(noId.youtube, undefined);
  const m = { uploader: { ...sent } };
  assert.equal(applyResult(m, signed(), KEY), true);
  assert.equal(m.youtube.url, 'https://www.youtube.com/shorts/abcDEF12345');
  assert.equal(m.youtube.privacy, 'private');
  assert.equal(applyResult(m, signed({ state: 'public', public_at: '2026-11-21T13:00:00.000Z', updated_at: '2026-11-21T13:05:00.000Z' }), KEY), true);
  assert.equal(m.youtube.privacy, 'public');
  // Public stays public, and a record made by the dashboard's own Publish button is never replaced.
  assert.equal(applyResult(m, signed({ state: 'removed', video_id: null, updated_at: '2026-11-22T00:00:00.000Z' }), KEY), false);
  const direct = { uploader: { ...sent }, youtube: { video_id: 'directPublish1', privacy: 'public' } };
  assert.equal(applyResult(direct, signed(), KEY), false);
  assert.equal(direct.youtube.video_id, 'directPublish1');
});
