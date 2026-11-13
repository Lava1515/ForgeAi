import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDockerArgv, CODEBUILT_SKILL_DIR, CODEBUILT_SKILL_DST, READONLY_MOUNT_ALLOWLIST, validateReadonlyMount } from '../episode/codebuilt/dockerFence.js';
import { loadCodebuiltBuildSkill } from '../episode/codebuilt/skills.js';
import { preventionEvidence } from '../episode/codebuilt/audit.js';
import { preventionProblems } from '../episode/engines/codebuilt/acceptance.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const pack = {
  id: 'codebuilt',
  skills: [{ id: 'codebuilt-scene-generation', skill: 'codebuilt-scene-generation', mode: 'guidance_only' }],
  rules: { skillsByStep: { build: 'codebuilt-scene-generation' } },
};

test('approved project-authored build skill is loaded and only its directory can be mounted read-only', () => {
  const skill = loadCodebuiltBuildSkill({ pack });
  assert.match(skill.text, /project-authored guidance/);
  const bind = validateReadonlyMount({ src: CODEBUILT_SKILL_DIR, dst: CODEBUILT_SKILL_DST });
  assert.match(bind, /,readonly$/);
  assert.equal(bind.includes(path.join('.claude', 'skills') + ',dst='), false);
  const evidence = preventionEvidence(['--mount', bind]);
  assert.deepEqual(evidence.readonlyHostMounts, [{ src: CODEBUILT_SKILL_DIR, dst: CODEBUILT_SKILL_DST }]);
  assert.equal(READONLY_MOUNT_ALLOWLIST.includes(path.dirname(CODEBUILT_SKILL_DIR)), false);
});

test('simulated generated-job argv applies exactly the two approved read-only mounts', (t) => {
  const tempRoot = path.join(REPO_ROOT, 'output', 'temp');
  fs.mkdirSync(tempRoot, { recursive: true });
  const scratch = fs.mkdtempSync(path.join(tempRoot, 'codebuilt-skill-fence-probe-'));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const jobRoot = path.join(scratch, 'jobs');
  const jobDir = path.join(jobRoot, 'probe-1');
  fs.mkdirSync(jobDir, { recursive: true });
  const { args } = buildDockerArgv({
    jobId: 'probe-1', jobDir, jobRoot,
    image: `sha256:${'a'.repeat(64)}`, command: ['/probe'], network: 'none',
    readonlyMounts: [
      { src: READONLY_MOUNT_ALLOWLIST[0], dst: '/kit/blender_worker/codebuilt' },
      { src: CODEBUILT_SKILL_DIR, dst: CODEBUILT_SKILL_DST },
    ],
  }, { runToken: 'a'.repeat(12) });
  const evidence = preventionEvidence(args);
  assert.deepEqual(evidence.writableHostMounts, [{ src: fs.realpathSync.native(jobDir), dst: '/job' }]);
  assert.deepEqual(evidence.readonlyHostMounts.map(({ src, dst }) => ({ src, dst })), [
    { src: fs.realpathSync.native(READONLY_MOUNT_ALLOWLIST[0]), dst: '/kit/blender_worker/codebuilt' },
    { src: fs.realpathSync.native(CODEBUILT_SKILL_DIR), dst: CODEBUILT_SKILL_DST },
  ]);
  assert.equal(evidence.network, 'none');
  assert.equal(args.includes('--read-only'), true);
  assert.deepEqual(preventionProblems(evidence, jobDir), []);
  assert.deepEqual(preventionProblems({ ...evidence, readonlyHostMounts: [] }, jobDir, { expectKind: 'stub' }), []);
  assert.notDeepEqual(preventionProblems({ ...evidence, readonlyHostMounts: [] }, jobDir), []);
});

test('build skill pack cannot widen the allowlist or mount its parent', () => {
  assert.throws(() => loadCodebuiltBuildSkill({ pack: { ...pack, rules: { skillsByStep: { build: 'other-skill' } } } }), /not approved/);
  assert.throws(() => validateReadonlyMount({ src: path.dirname(CODEBUILT_SKILL_DIR), dst: '/skills' }), /not on the read-only mount allowlist/);
  assert.throws(() => validateReadonlyMount({ src: CODEBUILT_SKILL_DIR, dst: '/job/skills' }), /may not overlap/);
});
