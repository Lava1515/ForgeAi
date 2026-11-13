// Bug of 2026-11-13 (job mwf06gtw-069893): generated scene code crashed in Blender (abs(Vector) -> TypeError) and the
// traceback was thrown away, so the build model was asked to fix a crash it could not see.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { saveStderrTail, STDERR_TAIL_FILE } from '../episode/codebuilt/processGuard.js';
import { readPreviewDiagnostic } from '../episode/engines/codebuilt/composePreview.js';

const TRACE = 'Traceback (most recent call last):\n  File "/job/build/build.py", line 344, in court_assets\nTypeError: bad operand type for abs(): \'Vector\'\n';

function jobDir() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crashdiag-'));
  fs.mkdirSync(path.join(root, 'job1', 'work'), { recursive: true });
  return { root, dir: path.join(root, 'job1') };
}

test('the end of a failed container stderr reaches the preview diagnostic', () => {
  const { root, dir } = jobDir();
  assert.equal(saveStderrTail(dir, `noise\u001b[31m\n${TRACE}`), true);
  const text = readPreviewDiagnostic(root, 'job1');
  assert.match(text, /TypeError: bad operand type for abs\(\): 'Vector'/);
  assert.ok(!text.includes('\u001b'), 'control characters are dropped');
});

test('an existing file is never overwritten, and a QA failure text wins', () => {
  const { root, dir } = jobDir();
  fs.writeFileSync(path.join(dir, 'work', STDERR_TAIL_FILE), 'left by the job');
  assert.equal(saveStderrTail(dir, TRACE), false);
  assert.equal(fs.readFileSync(path.join(dir, 'work', STDERR_TAIL_FILE), 'utf8'), 'left by the job');
  fs.writeFileSync(path.join(dir, 'work', 'qa_failure.txt'), 'label clipped in shot 3');
  assert.equal(readPreviewDiagnostic(root, 'job1'), 'label clipped in shot 3');
});

test('nothing is written for an empty stderr or a missing work folder', () => {
  const { root, dir } = jobDir();
  assert.equal(saveStderrTail(dir, '   '), false);
  assert.equal(saveStderrTail(path.join(root, 'nope'), TRACE), false);
  assert.equal(readPreviewDiagnostic(root, 'job1'), null);
});
