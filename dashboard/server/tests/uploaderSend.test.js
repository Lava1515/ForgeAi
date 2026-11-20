// Send to uploader: the manifest names the draft's own channel, and a draft that cannot be matched to a YouTube channel is not sent.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildManifest, applyResult, UPLOAD_CATEGORY } from '../routes/uploader.js';

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

test('a result file is untrusted: another package, another channel, a bad id or an unknown state changes nothing', () => {
  const sent = { package_id: 'cb-1', youtube_channel_id: channel.youtube_channel_id, state: 'sent' };
  const good = { package_id: 'cb-1', state: 'scheduled', video_id: 'abcDEF12345', publish_at: '2026-11-21T13:00:00.000Z', youtube_channel_id: channel.youtube_channel_id, url: 'https://evil.example/x', updated_at: '2026-11-20T16:00:00.000Z' };
  for (const bad of [{ ...good, package_id: 'cb-2' }, { ...good, youtube_channel_id: 'UC' + 'b'.repeat(22) }, { ...good, state: 'published!!' }, null, [], 'x']) {
    const m = { uploader: { ...sent } };
    assert.equal(applyResult(m, bad), false);
    assert.equal(m.youtube, undefined);
  }
  const noId = { uploader: { ...sent } };
  applyResult(noId, { ...good, video_id: '../../etc' });
  assert.equal(noId.youtube, undefined);
  const m = { uploader: { ...sent } };
  assert.equal(applyResult(m, good), true);
  assert.equal(m.youtube.url, 'https://www.youtube.com/shorts/abcDEF12345');
  assert.equal(m.youtube.privacy, 'private');
  assert.equal(m.uploader.state, 'scheduled');
});
