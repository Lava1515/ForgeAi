// The outside-the-job snapshot must not truncate just because finished job folders pile up, and must still see a job
// that wrote anything outside its own folder (a new top-level entry, or an add/change/delete inside another job folder).
// Real bug (2026-11-15): the old spec walked every sibling job folder 4 levels deep, hit the 50000 entry limit, and every
// fenced job after that ended audit_incomplete -> preview_failed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { snapshotTrees, diffSnapshots, preventionEvidence } from '../episode/codebuilt/audit.js';
import { defaultWatchRoots } from '../episode/codebuilt/runJob.js';
import { evaluateFenceReport } from '../episode/engines/codebuilt/acceptance.js';
import { buildDockerArgv } from '../episode/codebuilt/dockerFence.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const OLD = 1_000_000_000_000; // an old mtime (ms) so a later change always shows

function scratchDir() {
  const tempRoot = path.join(REPO_ROOT, 'output', 'temp');
  fs.mkdirSync(tempRoot, { recursive: true });
  return fs.mkdtempSync(path.join(tempRoot, 'fence-snapshot-bounded-'));
}
const age = (p) => fs.utimesSync(p, OLD / 1000, OLD / 1000);

/** `jobs` finished sibling job folders, each: 10 files + frames/ with `frames` files. Returns the root. */
function buildJobRoot(scratch, { jobs, frames }) {
  const jobRoot = path.join(scratch, 'agent-jobs');
  for (let j = 0; j < jobs; j++) {
    const dir = path.join(jobRoot, `finished-${String(j).padStart(3, '0')}`);
    fs.mkdirSync(path.join(dir, 'frames'), { recursive: true });
    for (let f = 0; f < 10; f++) fs.writeFileSync(path.join(dir, `file-${f}.json`), '{}');
    for (let f = 0; f < frames; f++) fs.writeFileSync(path.join(dir, 'frames', `f${f}.png`), '');
    age(path.join(dir, 'frames')); age(dir);
  }
  age(jobRoot);
  return jobRoot;
}

function ownJob(jobRoot) {
  const jobDir = path.join(jobRoot, 'my-job-pv1');
  fs.mkdirSync(path.join(jobDir, 'work'), { recursive: true });
  return jobDir;
}

/** The production sibling spec itself (the first of defaultWatchRoots). */
const siblingSpec = (jobRoot, jobDir) => defaultWatchRoots({ jobRoot, jobDir, repoRoot: path.dirname(jobRoot) })[0];

/** Same wiring as runJob: second snapshot reuses the first one's listed folders. */
function snapshotPair(spec, mutate, opts = {}) {
  const before = snapshotTrees([spec], opts);
  mutate();
  const after = snapshotTrees([spec], { ...opts, like: before });
  return { before, after };
}

function report(outside, jobDir) {
  const argv = buildDockerArgv({ jobId: path.basename(jobDir), jobDir, jobRoot: path.dirname(jobDir), image: `sha256:${'a'.repeat(64)}`, command: ['/probe'], network: 'none' }, { runToken: 'a'.repeat(12) }).args;
  const prevention = preventionEvidence(argv);
  return {
    status: 'audit_incomplete', ok: false, simulated: false, started: true, orphan: false, lockRetained: false, leaseRetained: false,
    run: { status: 'ok' }, cleanup: { verified: true }, jobDir, containerName: prevention.containerName,
    containment: { prevention }, outside, scan: { findings: [], coverage: { complete: true } },
    leaks: { status: 'not_run', coverage: { secretsSupplied: 0 } }, checks: { outside: outside.status, leakScan: 'not_run', scriptScan: 'complete' },
  };
}
const accept = (outside, jobDir) => evaluateFenceReport(report(outside, jobDir), { policy: 'prevention-primary', expectKind: 'stub' });

// One big tree (about 62000 entries) shared by the two big tests; each case takes its own snapshots around its own change.
let big;
function bigFixture() {
  if (!big) {
    const scratch = scratchDir();
    const jobRoot = buildJobRoot(scratch, { jobs: 56, frames: 1100 }); // 56 * (1100 + 10 + 2) = about 62300 entries
    big = { scratch, jobRoot, jobDir: ownJob(jobRoot) };
  }
  return big;
}
test.after(() => { if (big) fs.rmSync(big.scratch, { recursive: true, force: true }); });

test('60000+ files across many finished jobs: the snapshot is far below the limit, not truncated, and the job that stayed home is accepted', () => {
  const { scratch, jobRoot, jobDir } = bigFixture();
  const spec = siblingSpec(jobRoot, jobDir);

  // The old spec cannot cope with this tree: it truncates, and the policy then blocks the report.
  const old = snapshotTrees([{ root: jobRoot, depth: 4, exclude: [jobDir] }]);
  assert.equal(old.truncated, true);
  const oldOutside = diffSnapshots(old, old, { codeRoot: scratch });
  assert.equal(oldOutside.status, 'incomplete');
  assert.match(accept(oldOutside, jobDir).blocking.join('\n'), /outside snapshot walk was truncated/);

  const { before, after } = snapshotPair(spec, () => fs.writeFileSync(path.join(jobDir, 'work', 'out.png'), 'x')); // the job writes only in its own folder
  assert.equal(before.truncated, false);
  assert.equal(after.truncated, false);
  assert.ok(before.entries.size < 2000, `entries ${before.entries.size}`);
  const outside = diffSnapshots(before, after, { codeRoot: scratch });
  assert.equal(outside.status, 'clean');
  assert.deepEqual([outside.added, outside.changed, outside.removed], [[], [], []]);
  const verdict = accept(outside, jobDir);
  assert.deepEqual(verdict.blocking, []);
  assert.equal(verdict.accepted, true);
});

test('cross-job writes are still seen: add, modify, delete inside a sibling job folder, and a new top-level folder', () => {
  const { scratch, jobRoot, jobDir } = bigFixture();
  const spec = siblingSpec(jobRoot, jobDir);
  const sib = (n) => path.join(jobRoot, `finished-${String(n).padStart(3, '0')}`);
  // Each case runs against the full-size tree. `strict` (no codeRoot) is what blocks a report; `prod` is the production
  // rule (writes inside C:/code are reported, only outside C:/code or .env is a violation).
  const cases = {
    'a: add a file in a sibling job folder': { mutate: () => fs.writeFileSync(path.join(sib(3), 'planted.txt'), 'x'), added: path.join(sib(3), 'planted.txt') },
    'a2: add a file in a sibling frames folder': { mutate: () => fs.writeFileSync(path.join(sib(4), 'frames', 'planted.png'), 'x'), changedDir: path.join(sib(4), 'frames') },
    'b: modify a file in a sibling job folder': { mutate: () => fs.appendFileSync(path.join(sib(5), 'file-2.json'), ' '), changed: path.join(sib(5), 'file-2.json') },
    'c: delete a file in a sibling job folder': { mutate: () => fs.rmSync(path.join(sib(6), 'file-7.json')), removed: path.join(sib(6), 'file-7.json') },
    'c2: delete a file in a sibling frames folder': { mutate: () => fs.rmSync(path.join(sib(7), 'frames', 'f9.png')), changedDir: path.join(sib(7), 'frames') },
    'c3: delete a whole sibling job folder': { mutate: () => fs.rmSync(sib(8), { recursive: true, force: true }), removed: sib(8) },
    'd: a new top-level folder next to the job folder': { mutate: () => fs.mkdirSync(path.join(jobRoot, 'stray-folder')), added: path.join(jobRoot, 'stray-folder') },
  };
  for (const [name, c] of Object.entries(cases)) {
    // fresh baseline per case: undo the previous mutation by rebuilding is too slow, so each case snapshots just before it
    const { before, after } = snapshotPair(spec, c.mutate);
    assert.equal(before.truncated || after.truncated, false, name);
    const strict = diffSnapshots(before, after, {});
    assert.equal(strict.status, 'changed', name);
    assert.equal(strict.ok, false, name);
    const seen = [...strict.added, ...strict.changed, ...strict.removed];
    for (const key of ['added', 'changed', 'removed']) if (c[key]) assert.ok(strict[key].includes(c[key]), `${name}: ${key} lists ${c[key]}, got ${seen.join(', ')}`);
    if (c.changedDir) assert.ok(strict.changed.includes(c.changedDir), `${name}: the frames folder entry changed`);
    // a report with this outside result is blocked by the acceptance policy
    const verdict = accept(strict, jobDir);
    assert.equal(verdict.accepted, false, name);
    assert.match(verdict.blocking.join('\n'), /outside snapshot saw a change/, name);
    // production rule: still detected and listed, exactly the same paths
    const prod = diffSnapshots(before, after, { codeRoot: scratch });
    assert.deepEqual([prod.added, prod.changed, prod.removed], [strict.added, strict.changed, strict.removed], name);
    assert.equal(prod.status, 'inside_code_changes', name);
  }
});

test('the old spec and the new spec both see the same sibling writes on a small tree', (t) => {
  const mutations = [
    (jobRoot) => fs.writeFileSync(path.join(jobRoot, 'finished-002', 'planted.txt'), 'x'),
    (jobRoot) => fs.appendFileSync(path.join(jobRoot, 'finished-002', 'file-1.json'), ' '),
    (jobRoot) => fs.rmSync(path.join(jobRoot, 'finished-002', 'file-3.json')),
    (jobRoot) => fs.mkdirSync(path.join(jobRoot, 'stray')),
  ];
  for (const mutate of mutations) {
    const scratch = scratchDir();
    t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
    const jobRoot = buildJobRoot(scratch, { jobs: 5, frames: 20 });
    const jobDir = ownJob(jobRoot);
    const mutateOnce = (() => { let done = false; return () => { if (!done) { done = true; mutate(jobRoot); } }; })();
    const oldPair = snapshotPair({ root: jobRoot, depth: 4, exclude: [jobDir] }, mutateOnce);
    const oldDiff = diffSnapshots(oldPair.before, oldPair.after, {});
    // the mutation is already applied; undo-free comparison: take the new spec's baseline from a fresh copy of the tree
    const scratch2 = scratchDir();
    t.after(() => fs.rmSync(scratch2, { recursive: true, force: true }));
    const jobRoot2 = buildJobRoot(scratch2, { jobs: 5, frames: 20 });
    const jobDir2 = ownJob(jobRoot2);
    const newPair = snapshotPair(siblingSpec(jobRoot2, jobDir2), () => mutate(jobRoot2));
    const newDiff = diffSnapshots(newPair.before, newPair.after, {});
    assert.equal(oldDiff.status, 'changed');
    assert.equal(newDiff.status, 'changed');
    const rel = (root, list) => list.map(p => path.relative(root, p)).sort();
    for (const key of ['added', 'changed', 'removed']) {
      // the new spec may add the changed folder entry itself; every path the old spec named, it names too
      for (const p of rel(jobRoot, oldDiff[key])) assert.ok(rel(jobRoot2, newDiff[key]).includes(p), `${key}: ${p}`);
    }
  }
});

test('a folder that does not fit the detail budget is summarised, not truncated, and an add/remove inside it is still seen', (t) => {
  const scratch = scratchDir();
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const jobRoot = buildJobRoot(scratch, { jobs: 6, frames: 0 }); // 6 folders of 11 direct children
  const jobDir = ownJob(jobRoot);
  const spec = { ...siblingSpec(jobRoot, jobDir), detailBudget: 25 }; // room for 2 folders, 4 are summarised
  const { before, after } = snapshotPair(spec, () => fs.writeFileSync(path.join(jobRoot, 'finished-005', 'planted.txt'), 'x'));
  assert.equal(before.truncated || after.truncated, false);
  const info = before.roots[0].detail;
  assert.equal(info.listedFolders, 2);
  assert.equal(info.summarisedFolders, 4); // 6 sibling folders (the job's own folder is excluded) - 2 listed
  assert.ok(diffSnapshots(before, after, {}).changed.includes(path.join(jobRoot, 'finished-005')));
  // the second snapshot lists the very same folders as the first, even when a new one appeared
  assert.deepEqual([...after.detail.get(0).listed].sort(), [...before.detail.get(0).listed].sort());
  // a root with more top-level entries than maxEntries is genuinely too large: that is still truncated
  const tooMany = snapshotTrees([spec], { maxEntries: 5 });
  assert.equal(tooMany.truncated, true);
});
