import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { writeHostJobReceipt } from '../episode/codebuilt/hostJobReceipts.js';

test('host receipts replace read-only forgeries and refuse locked or substituted job folders', () => {
  const base = path.resolve('../../output/agent-jobs');
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'host-receipt-test-'));
  const job = path.join(root, 'job');
  fs.mkdirSync(job);
  const target = path.join(job, 'visual_loop.json');
  try {
    fs.writeFileSync(target, 'FORGED'); fs.chmodSync(target, 0o444);
    writeHostJobReceipt(root, 'job', 'visual_loop.json', 'HOST');
    assert.equal(fs.readFileSync(target, 'utf8'), 'HOST');
    fs.mkdirSync(path.join(root, '.cb6-locks'));
    for (const lock of ['job.lock', 'job-pv2.lock']) {
      const file = path.join(root, '.cb6-locks', lock);
      fs.writeFileSync(file, '{}');
      assert.throws(() => writeHostJobReceipt(root, 'job', 'visual_loop.json', 'BAD'));
      assert.equal(fs.readFileSync(target, 'utf8'), 'HOST');
      fs.unlinkSync(file);
    }
    fs.unlinkSync(target); fs.mkdirSync(target);
    assert.throws(() => writeHostJobReceipt(root, 'job', 'visual_loop.json', 'BAD'));
    fs.rmdirSync(target);
    const outside = path.join(root, 'outside'); fs.mkdirSync(outside);
    fs.rmdirSync(job); fs.symlinkSync(outside, job, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => writeHostJobReceipt(root, 'job', 'visual_loop.json', 'BAD'));
    assert.deepEqual(fs.readdirSync(outside), []);
    fs.unlinkSync(job);
  } finally {
    // This fixture owns the tree; explicitly unlink the only possible junction before removal.
    if (fs.existsSync(job) && fs.lstatSync(job).isSymbolicLink()) fs.unlinkSync(job);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
