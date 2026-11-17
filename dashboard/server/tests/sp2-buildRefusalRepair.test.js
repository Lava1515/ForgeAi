import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { extractPython, loadCodebuiltPathPack, planCodebuiltBuild } from '../episode/codebuilt/planner.js';

test('extractPython prefers a valid longest block, then joins split blocks if that block is invalid', () => {
  const split = '```python\ndef answer():\n    value = 4\n    return (\n```\ncommentary\n```python\n        value\n    )\n```';
  assert.equal(extractPython(split), 'def answer():\n    value = 4\n    return (\n\n        value\n    )\n');

  const candidates = '```python\ndef short():\n    return 1\n```\n```python\ndef longer():\n    return 2\n```';
  assert.equal(extractPython(candidates), 'def longer():\n    return 2\n');
  assert.equal(extractPython(split, { syntaxCheck: (code) => code.includes('        value') ? '' : 'syntax error' }), 'def answer():\n    value = 4\n    return (\n\n        value\n    )\n');
  assert.equal(extractPython(split, { syntaxCheck: () => null }), 'def answer():\n    value = 4\n    return (\n');
  const single = '```python\nx = 1\n```';
  assert.equal(extractPython(single, { syntaxCheck: () => { throw new Error('single fence should not be parsed'); } }), 'x = 1\n');
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
# Extra descriptive source keeps this fixture above the production minimum length.
# The comments are deliberately harmless and do not alter the validator or render path.
# This is a stable parser fixture for build refusal and bounded repair regressions.
# Keep the sample readable while matching the real planner's minimum complete-script size.
# These notes explain the fixture and have no executable effect on the generated scene.
# All required render settings, kit calls, and safety gates remain in the surrounding code.
# Additional context also ensures tests exercise repair, rather than the minimum-length gate.
# Fixture annotation: all settings below are required source-level values, with no hidden validator bypasses.
# Fixture annotation: all settings below are required source-level values, with no hidden validator bypasses.
# Fixture annotation: all settings below are required source-level values, with no hidden validator bypasses.
# Fixture annotation: all settings below are required source-level values, with no hidden validator bypasses.
# Fixture annotation: all settings below are required source-level values, with no hidden validator bypasses.
# Fixture annotation: all settings below are required source-level values, with no hidden validator bypasses.
# Fixture annotation: all settings below are required source-level values, with no hidden validator bypasses.
# Fixture annotation: all settings below are required source-level values, with no hidden validator bypasses.
`;
test('fixture is large enough for full build validation', () => assert.ok(validBuild.length >= 600, String(validBuild.length)));
const input = {
  topic: 'A canal', duration: 30, script: 'A short script.', brief: 'Build a canal scene.',
  words: { dur: 1, words: [{ w: 'Canal', s: 0, e: 1 }] },
  pathPack: loadCodebuiltPathPack(),
};

test('a fixable build refusal routes one bounded scoped edit over the previous build', async () => {
  let calls = 0;
  let repairPrompt = '';
  let refusedCode = '';
  let refusedReasons = [];
  const result = await planCodebuiltBuild(input, {
    forcedTier: 'sonnet',
    direct: false,
    onRefused: (code, reasons) => { refusedCode = code; refusedReasons = reasons; },
    guidesFor: () => 'guide',
    syntaxCheck: () => '',
    qaStructureCheck: () => [],
    askFn: async (prompt) => {
      calls += 1;
      if (calls === 1) return `\`\`\`python\n${validBuild.replace('scene.cycles.samples = 8', 'def build_scene():\n    scene.cycles.samples = 64')}\n\`\`\``;
      assert.match(prompt, /scoped edit/i, JSON.stringify(refusedReasons));
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

for (const [label, refused, badEdit] of [
  ['malformed JSON', validBuild.replace('scene.cycles.samples = 8', 'scene.cycles.samples = 64'), 'not json'],
  ['bad edit shape', validBuild.replace('scene.cycles.samples = 8', 'scene.cycles.samples = 64'), JSON.stringify({ targets: ['scene'], edits: [{ op: 'replace_assign', name: 'scene.cycles.samples', source: 'scene.cycles.samples = 8' }] })],
  ['unknown locked target', validBuild.replace('scene.cycles.samples = 8', 'scene.cycles.samples = 64'), JSON.stringify({ targets: ['NFRAMES'], edits: [{ op: 'replace_assign', name: 'NFRAMES', source: 'NFRAMES = 85' }] })],
]) {
  test(`failed scoped edit (${label}) falls back to one full response`, async () => {
    let calls = 0;
    const prompts = [];
    const result = await planCodebuiltBuild(input, {
      direct: false, forcedTier: 'sonnet', guidesFor: () => 'guide', syntaxCheck: () => '', qaStructureCheck: () => [],
      askFn: async (prompt) => {
        prompts.push(prompt); calls += 1;
        if (calls === 1) return `\`\`\`python\n${refused}\n\`\`\``;
        if (calls === 2) return badEdit;
        return `\`\`\`python\n${validBuild}\n\`\`\``;
      },
    });
    assert.equal(calls, 3);
    assert.match(prompts[1], /scoped edit/i);
    assert.match(prompts[2], /answer again in full/i);
    assert.equal(result.buildScript, validBuild);
  });
}

for (const [label, refused] of [
  ['locked NFRAMES', validBuild.replace('NFRAMES = 85', 'NFRAMES = 84')],
  ['missing kit imports', validBuild.replace('from blender_worker.codebuilt import meshes, shotcheck, renderloop, timeline', 'import bpy')],
]) {
  test(`${label} uses full retry and never scoped edit`, async () => {
    let calls = 0;
    let secondPrompt = '';
    await planCodebuiltBuild(input, {
      direct: false, forcedTier: 'sonnet', guidesFor: () => 'guide', syntaxCheck: () => '', qaStructureCheck: () => [],
      askFn: async (prompt) => {
        calls += 1;
        if (calls === 1) return `\`\`\`python\n${refused}\n\`\`\``;
        secondPrompt = prompt;
        return `\`\`\`python\n${validBuild}\n\`\`\``;
      },
    });
    assert.equal(calls, 2);
    assert.doesNotMatch(secondPrompt, /scoped edit/i);
  });
}

test('unavailable Python disables scoped repair and still gets the ordinary full retry', async () => {
  let calls = 0;
  let secondPrompt = '';
  await planCodebuiltBuild(input, {
    direct: false, forcedTier: 'sonnet', guidesFor: () => 'guide', syntaxCheck: () => null, qaStructureCheck: () => null,
    askFn: async (prompt) => {
      calls += 1;
      if (calls === 1) return `\`\`\`python\n${validBuild.replace('scene.cycles.samples = 8', 'scene.cycles.samples = 64')}\n\`\`\``;
      secondPrompt = prompt;
      return `\`\`\`python\n${validBuild}\n\`\`\``;
    },
  });
  assert.equal(calls, 2);
  assert.doesNotMatch(secondPrompt, /scoped edit/i);
});

test('joined split source passes the complete build validator', async () => {
  let calls = 0;
  const splitAt = 'timeline.apply_frame(scene, shots, colls, 0)';
  const cut = validBuild.indexOf(splitAt) + 'timeline.apply_frame(scene, shots, colls,'.length;
  const first = validBuild.slice(0, cut);
  const second = validBuild.slice(cut);
  await planCodebuiltBuild(input, {
    direct: false, forcedTier: 'sonnet', guidesFor: () => 'guide', qaStructureCheck: () => [],
    syntaxCheck: (code) => code.includes(',\n\n 0)') ? '' : 'incomplete split statement',
    askFn: async () => { calls += 1; return `\`\`\`python\n${first}\n\`\`\`\nnotes\n\`\`\`python\n${second}\n\`\`\``; },
  }).then(() => assert.equal(calls, 1));
});

test('the retained Corinth refusal is incomplete source, not proof of the original split reply', () => {
  const file = 'C:/code/ForgeAi/output/agent-jobs/.start/mwjj7l2f-c588c5/refused-build-1.py';
  if (!fs.existsSync(file)) return;
  const retained = fs.readFileSync(file, 'utf8');
  assert.match(retained, /REFUSED:/);
  assert.match(retained, /must import the kit/);
  assert.match(retained, /\n\)\s*\n/);
});
