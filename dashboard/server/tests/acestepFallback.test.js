// claude-pro · claude-fable-5-2 · 2026-11-20: all three videos of run-mwow3a91-f47cff fell back to the synth with one merged reason.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fallbackReason } from '../episode/codebuilt/acestepMusic.js';

test('the music fallback names the refusal the worker gave', () => {
  assert.equal(fallbackReason('Traceback (most recent call last):\n  File "x.py", line 1\nRuntimeError: card_memory\n'), 'card_memory');
  assert.equal(fallbackReason('Traceback\r\nRuntimeError: card_busy\r\n'), 'card_busy');
  assert.equal(fallbackReason('RuntimeError: pin_mismatch'), 'pin_mismatch');
  assert.equal(fallbackReason('RuntimeError: ACE-Step generation failed'), 'generation_failed');
  assert.equal(fallbackReason(''), 'generation_failed');
});
