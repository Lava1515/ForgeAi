import test from 'node:test';
import assert from 'node:assert/strict';
import { extendClippedFirstWord } from '../episode/codebuilt/voice.js';

// A 16-bit mono 16 kHz WAV: silence, then a tone from `soundFrom` seconds to the end; `click` adds a 10 ms tone at that time.
function wav(seconds, soundFrom, click) {
  const rate = 16000; const frames = Math.round(seconds * rate); const data = Buffer.alloc(frames * 2);
  for (let i = Math.round(soundFrom * rate); i < frames; i += 1) data.writeInt16LE(Math.round(Math.sin(i / 5) * 12000), i * 2);
  if (click !== undefined) for (let i = Math.round(click * rate); i < Math.round((click + 0.01) * rate); i += 1) data.writeInt16LE(Math.round(Math.sin(i / 5) * 12000), i * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8); h.write('fmt ', 12); h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}
const timing = (start, end = 0.4) => ({ words: [{ text: 'Venice', start, end }, { text: 'floods,', start: 0.4, end: 1.2 }] });

// Job mwgt0zmz-c75642, 2026-11-14: the aligner put "Venice" at 0.40-0.40 s while the voice sounded from 0.02 s, so every take was refused.
test('a first word the aligner collapsed after the voice started is moved back to the audible start', () => {
  const out = extendClippedFirstWord({ wav: wav(2, 0.02), timing: timing(0.4) });
  assert.ok(Math.abs(out.timing.words[0].start - 0.02) <= 0.011);
  assert.equal(out.timing.words[0].end, 0.4);
  assert.deepEqual(out.timing.words[1], { text: 'floods,', start: 0.4, end: 1.2 });
});

// codex · gpt-6.1-sol: reproduce job mwiciyuk-846e26 without depending on retained local outputs.
test('the Florence 60 ms alignment boundary is corrected while detached sound stays refused', () => {
  const out = extendClippedFirstWord({ wav: wav(2, 0.03), timing: timing(0.34, 0.4) });
  assert.ok(Math.abs(out.timing.words[0].start - 0.03) <= 0.02);
  assert.equal(out.timing.words[0].end, 0.4);
  assert.ok(out.extendedSeconds > 0.29 && out.extendedSeconds <= 0.32);
  const offset = extendClippedFirstWord({ wav: wav(2, 0.03), timing: timing(0.344, 0.404) });
  assert.ok(offset.extendedSeconds > 0.3);
  const longer = timing(0.344, 0.404001);
  assert.equal(extendClippedFirstWord({ wav: wav(2, 0.03), timing: longer }).timing, longer);

  const detached = timing(0.34, 0.4);
  assert.equal(extendClippedFirstWord({ wav: wav(2, 0.34, 0.03), timing: detached }).timing, detached);
});

test('a first word inside the slack, or sound far earlier than the limit, is left alone', () => {
  const near = timing(0.15);
  assert.equal(extendClippedFirstWord({ wav: wav(2, 0.02), timing: near }).timing, near);
  const far = { words: [{ text: 'Venice', start: 0.9, end: 1.0 }] };
  assert.equal(extendClippedFirstWord({ wav: wav(2, 0.02), timing: far }).timing, far);
});

// Review finding (codex, 2026-11-14): a detached click before a correctly timed word must still be refused, not absorbed into the word.
test('a detached sound before the first word, or a first word with a real length, is left for the checker to refuse', () => {
  const clicked = { words: [{ text: 'Venice', start: 0.4, end: 0.4 }] };
  assert.equal(extendClippedFirstWord({ wav: wav(2, 0.4, 0.02), timing: clicked }).timing, clicked);
  const real = timing(0.4, 0.7);
  assert.equal(extendClippedFirstWord({ wav: wav(2, 0.02), timing: real }).timing, real);
});
