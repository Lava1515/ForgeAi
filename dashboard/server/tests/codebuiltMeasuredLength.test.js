import test from 'node:test';
import assert from 'node:assert/strict';
import { measuredLengthFailure } from '../episode/codebuilt/start.js';

test('measured narration rejects an overrun beyond tolerance and accepts the tolerance boundary', () => {
  const requested = 45;
  assert.equal(measuredLengthFailure(requested, { seconds: 58.63, source: 'voice.json' }), 'too_long');
  assert.equal(measuredLengthFailure(requested, { seconds: 55, source: 'voice.json' }), null);
});
