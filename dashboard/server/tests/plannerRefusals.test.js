// 2026-11-16 14:45 +02:00 · codex · gpt-6-astra
// Point Nemo mwj2oo6y-8c76c2: a local `hold` object triggered a render-setting refusal.
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateBuildScript } from '../episode/codebuilt/planner.js';

const base = `from blender_worker.codebuilt import meshes, shotcheck, renderloop, timeline
OUT = '/job/frames'
NFRAMES = 90
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
const check = (code) => validateBuildScript(code, { nframes: 90, shotStarts: [0] });

test('Point Nemo local hold and unrelated settings do not refuse a valid build', () => {
  assert.deepEqual(check(base), []);
  for (const extra of [
    "hold = meshes.empty(c, 'mk_hold', loc=p); hold.parent = gh['globe']",
    'hold = 1.2\nhold_s = 2.5\nhelper(hold=3)',
    '# hold=2\ntext = "hold=2"',
    'samples = 64\nfps = 12\nresolution_x = 4\nresolution_y = 5\nresolution_percentage = 50',
  ]) assert.deepEqual(check(base + extra), [], extra);
  for (const [owner, key, value] of [
    ['render', 'resolution_x', 4], ['render', 'resolution_y', 5],
    ['render', 'resolution_percentage', 50], ['render', 'fps', 12], ['cycles', 'samples', 64],
  ]) {
    for (const op of ['=', '+=']) {
      assert.ok(check(base + `scene.${owner}.${key} ${op} ${value}`).some((r) => r.includes(key)));
    }
  }
});

test('every QA and render call still requires literal hold=1', () => {
  for (const call of ['shotcheck.run_qa', 'renderloop.render_frames']) {
    for (const value of ['2', '1.2', 'hold', '1 + 1', 'helper(hold=1)']) {
      const code = base.replace(new RegExp(`(${call.replaceAll('.', '\\.')}[^\n]*hold=)1`), `$1${value}`);
      assert.ok(check(code).some((r) => r.includes('hold=1')), `${call}: ${value}`);
    }
    assert.ok(check(base + `${call}(hold=2)`).some((r) => r.includes('hold=1')));
  }
});

test('job fence refusals remain strict, including text matches', () => {
  for (const extra of [
    'import subprocess', 'import socket', 'import pathlib',
    'os.system("echo hi")', 'os.remove("/kit/file")', 'os.makedirs("/outside")',
    'open("/outside", "w")', 'exec("x=1")', '__import__("os")',
    'bpy.ops.wm.save_as_mainfile(filepath="/outside")',
    '# open("/outside", "w")', 'text = "subprocess"',
  ]) assert.ok(check(base + extra).length, extra);
  assert.ok(check(base.replace('/job/frames', '/outside')).some((r) => r.includes('OUT must')));
});
