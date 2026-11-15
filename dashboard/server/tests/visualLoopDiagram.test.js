// V1 (2026-11-15): legible diagrams. A repeated diagram or text finding must produce a rebuild directive, the checklist must carry measurable
// diagram limits and the board exemption, and the skill text must only name functions that blender_worker/codebuilt/diagram.py defines.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOOK_CHECKLIST, buildLookPrompt, repeatedLegibilityShots } from '../episode/codebuilt/visualLoopPrompts.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

// The three findings of job mwhu3xfu-a118b6 (Everest, rounds 2 to 4), shortened only by the shot id.
const everest = [
  { round: 2, findings: [{ severity: 'P1', shot: 'shot-3', issue: 'The triangle is small in the frame and its lines are too thin to read as a diagram.', fix: 'Move the camera in to d=62 and thicken the lines.' }] },
  { round: 3, findings: [{ severity: 'P1', shot: 'shot-3', issue: 'The triangle is small and thin and does not read as a diagram.', fix: 'Move the camera in to d=50.' }, { severity: 'P1', shot: 'shot-1', issue: 'The MODERN OUTLINES plate is wide and overlaps the surveyors\' heads.' }] },
  { round: 4, findings: [{ severity: 'P1', shot: 'shot-3', issue: 'The triangle diagram is not readable as a triangle: the lines are thin and the subject is small.', fix: 'Move the camera closer and use thicker lines.' }, { severity: 'P1', shot: 'shot-4', issue: 'The bent ray, correction arrow and layers of air are not readable.' }] },
];

test('a diagram finding that returns for the same shot is reported, a single one is not', () => {
  assert.deepEqual(repeatedLegibilityShots(everest), ['shot-3']);
  assert.deepEqual(repeatedLegibilityShots(everest.slice(0, 1)), []);
  assert.deepEqual(repeatedLegibilityShots(undefined), []);
});

test('plate width findings and P2 notes are not legibility repeats', () => {
  const plate = (round) => ({ round, findings: [{ severity: 'P0', shot: 'shot-0', issue: 'The 1856 plate is about 77% of the frame width, over the 70% limit.' }, { severity: 'P2', shot: 'shot-2', issue: 'The label is small.' }] });
  assert.deepEqual(repeatedLegibilityShots([plate(1), plate(2), plate(3)]), []);
});

test('the same shot twice in one round counts once', () => {
  const twice = { round: 0, findings: [{ severity: 'P1', shot: 'shot-3', issue: 'The text is too small.' }, { severity: 'P1', shot: 'shot-3', issue: 'The arrow is thin.' }] };
  assert.deepEqual(repeatedLegibilityShots([twice]), []);
});

function prompt(previous) {
  return buildLookPrompt({
    brief: 'brief', script: 'script', shots: [{ id: 'shot-3', subject: 'triangle', narration: 'n' }], buildScript: 'x = 1', kitContract: 'kit',
    sheets: [], shotStarts: [0], previous, qaText: 'no pictures', round: 3,
  });
}

test('the look prompt tells the director to rebuild a repeated diagram on a board, and not otherwise', () => {
  const withRepeat = prompt(everest);
  assert.match(withRepeat, /REPEATED LEGIBILITY FINDING \(shot-3\)/);
  assert.match(withRepeat, /diagram\.Board/);
  assert.match(withRepeat, /corner outside the frame needs a camera further back/);
  assert.doesNotMatch(prompt(everest.slice(0, 1)), /REPEATED LEGIBILITY FINDING/);
  assert.doesNotMatch(prompt(undefined), /REPEATED LEGIBILITY FINDING/);
});

test('the checklist keeps every earlier rule and adds measurable diagram limits and the board exemption', () => {
  const text = LOOK_CHECKLIST.join('\n');
  assert.match(text, /no label, HUD plate or readout wider than 70 percent/);   // the 70 percent plate rule is not weakened
  assert.match(text, /A diagram board .* up to 84 percent/);
  assert.match(text, /Diagrams \(triangles, arrows, charts, number cards/);
  assert.match(text, /at least 15 px wide and capital letters at least 50 px tall/);
  assert.match(text, /at most 6 short labels/);
  assert.equal(LOOK_CHECKLIST.length, 15);
});

test('the skills name only diagram functions that exist, and stay under the skill size limit', () => {
  const py = read('blender_worker', 'codebuilt', 'diagram.py');
  const defined = new Set([...py.matchAll(/^\s*def (\w+)\(/gm)].map((m) => m[1]));
  for (const skill of ['codebuilt-scene-generation', 'codebuilt-look-review']) {
    const text = read('.claude', 'skills', skill, 'SKILL.md');
    assert.ok(Buffer.byteLength(text) < 24 * 1024, `${skill} must stay under the 24 KB skill limit`);
    for (const m of text.matchAll(/diagram\.([a-zA-Z_]\w*)/g)) assert.ok(m[1] === 'Board' || m[1] === 'DiagramError' || defined.has(m[1]), `${skill} names diagram.${m[1]}`);
    for (const m of text.matchAll(/`(?:b|board)\.([a-z_]+)\(/g)) assert.ok(defined.has(m[1]), `${skill} names Board.${m[1]}`);
  }
  assert.match(read('.claude', 'skills', 'codebuilt-scene-generation', 'SKILL.md'), /diagram\.Board\(c, 'tri'/);
  for (const name of ['line', 'arrow', 'dot', 'label', 'require', 'camera', 'draw']) assert.ok(defined.has(name), `Board.${name}`);
});
