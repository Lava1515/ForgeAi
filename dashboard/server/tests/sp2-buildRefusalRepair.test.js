import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { extractPython, loadCodebuiltPathPack, planCodebuiltBuild } from '../episode/codebuilt/planner.js';

test('extractPython prefers a valid longest block, then joins split blocks if that block is invalid', () => {
  const split = '```python\ndef answer():\n    value = 4\n    return (\n```\ncommentary\n```python\n        value\n    )\n```';
  assert.equal(extractPython(split), 'def answer():\n    value = 4\n    return (\n\n        value\n    )\n');

  const candidates = '```python\ndef short():\n    return 1\n```\n```python\ndef longer():\n    return 2\n```';
  assert.equal(extractPython(candidates), 'def longer():\n    return 2\n');
});

test('code outside fenced reply blocks is never included in executable build source', () => {
  assert.equal(extractPython('Explanation\nimport os\n```python\nvalue = 1\n```\nimport subprocess'), 'value = 1\n');
});

const validBuild = `from blender_worker.codebuilt import meshes, shotcheck, renderloop, timeline
OUT = '/job/frames'
NFRAMES = 85
SHOT_STARTS = [0]
FPS = 30
scene.render.engine = 'CYCLES'
scene.cycles.device = 'CPU'
scene.render.resolution_x = 1080
scene.render.resolution_y = 1920
scene.render.resolution_percentage = 100
scene.render.fps = FPS
scene.cycles.samples = 8
c = meshes.coll(scene, 'shot-0')
${Array.from({ length: 9 }, (_, i) => `obj${i} = meshes.ball(c)`).join('\n')}
timeline.apply_frame(scene, shots, colls, 0)
shotcheck.run_qa(scene, cam, apply, NFRAMES, shots, hold=1)
renderloop.render_frames(range(NFRAMES), OUT, apply, render_fn, hold=1, require_qa=True)
`;
const input = {
  topic: 'A canal', duration: 30, script: 'A short script.', brief: 'Build a canal scene.',
  words: { dur: 1, words: [{ w: 'Canal', s: 0, e: 1 }] },
  pathPack: loadCodebuiltPathPack(),
};

test('a fixable build refusal routes one bounded scoped edit over the previous build', async () => {
  let calls = 0;
  let repairPrompt = '';
  let refusedCode = '';
  const result = await planCodebuiltBuild(input, {
    forcedTier: 'sonnet',
    direct: false,
    onRefused: (code) => { refusedCode = code; },
    guidesFor: () => 'guide',
    syntaxCheck: () => '',
    qaStructureCheck: () => [],
    askFn: async (prompt) => {
      calls += 1;
      if (calls === 1) return `\`\`\`python\n${validBuild.replace('scene.cycles.samples = 8', 'def build_scene():\n    scene.cycles.samples = 64')}\n\`\`\``;
      repairPrompt = prompt;
      assert.match(refusedCode, /def build_scene/);
      return JSON.stringify({ targets: ['build_scene'], edits: [{ op: 'replace_def', name: 'build_scene', source: 'def build_scene():\n    scene.cycles.samples = 8' }] });
    },
  });
  assert.equal(calls, 2);
  assert.match(repairPrompt, /scoped edit/i);
  assert.match(repairPrompt, /previous build/i);
  assert.match(result.buildScript, /cycles\.samples = 8/);
});

test('policy refusals do not enter scoped repair', async () => {
  let calls = 0;
  let prompt2 = '';
  const result = await planCodebuiltBuild(input, {
    guidesFor: () => 'guide', syntaxCheck: () => '', qaStructureCheck: () => [],
    forcedTier: 'sonnet',
    direct: false,
    askFn: async (prompt) => {
      calls += 1;
      if (calls === 1) return `\`\`\`python\n${validBuild}\nimport subprocess\n\`\`\``;
      prompt2 = prompt;
      return `\`\`\`python\n${validBuild}\n\`\`\``;
    },
  });
  assert.equal(calls, 2);
  assert.match(prompt2, /previous reply was refused/i);
  assert.doesNotMatch(prompt2, /scoped edit/i);
  assert.doesNotMatch(result.buildScript, /import subprocess/);
});

test('the retained Corinth refusal is incomplete source, not proof of the original split reply', () => {
  const file = 'C:/code/ForgeAi/output/agent-jobs/.start/mwjj7l2f-c588c5/refused-build-1.py';
  if (!fs.existsSync(file)) return;
  const retained = fs.readFileSync(file, 'utf8');
  assert.match(retained, /REFUSED:/);
  assert.match(retained, /must import the kit/);
  assert.match(retained, /\n\)\s*\n/);
});
