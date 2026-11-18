// claude-max · claude-haiku-5-5 · 2026-11-18: fable check 2, fixes 4, 7 and 8.
// Fix 4: picture-route narration keeps colours out of the narration, and a fact-check rewrite cannot repeat a refused statement.
// Fix 7: the map skill's picture-route section says markers stay smaller than their place and land must not read as snow.
// Fix 8: a layout finding with no frame prints no "frame -1".
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { planCodebuiltScript, PICTURE_NARRATION_RULE } from '../episode/codebuilt/planner.js';
import { loadCodebuiltGuides } from '../episode/codebuilt/skills.js';
import { buildLookPrompt } from '../episode/codebuilt/visualLoopPrompts.js';

const root = new URL('../../../', import.meta.url);
const pack = JSON.parse(fs.readFileSync(new URL('paths/codebuilt.json', root), 'utf8'));
const STATEMENT = 'Deep below the keel, purple water flows north.';
const SENTENCES = [
  "A giant tanker squeezes through a gap barely seven hundred meters wide.",
  "Why do giant ships spin out of control while crossing the strait?",
  "Meet the harbor pilot.",
  "Their job: steer a thousand-foot tanker around sharp bends.",
  "Then the wind shifts.",
  "Blue water rushes south at the surface.",
  "Two opposite currents push the hull at once.",
  "Hills close in.",
  "Past the Maiden's Tower, the tanker glides into open sea.",
  "Two seas, stacked in one strait.",
];
const scriptWith = (middle) => [...SENTENCES.slice(0, 4), middle, ...SENTENCES.slice(4)].join(' ');
const shotsFor = (text) => text.split(/(?<=[.!?])\s+/).map((narration) => ({ narration, subject: 'tanker', action: 'slides through the channel', feel: 'curious' }));
const reply = (text) => {
  const shots = shotsFor(text);
  shots[0].feel = 'intrigued';
  shots.at(-1).feel = 'amazed';
  return JSON.stringify({ script: text, shots, brief: 'A tanker threads a narrow strait between two currents. The visuals follow the pilot and the hull.' });
};
const corrections = [{ text: STATEMENT, problem: 'contradicted', evidence: 'The water itself is not purple.' }];

test('picture routes add the narration rule; classic and implicit prompts do not', async () => {
  const prompts = {};
  for (const route of ['authored', 'overlay', 'classic', undefined]) {
    await planCodebuiltScript({ topic: 'the strait', duration: 30, route, corrections, pack }, {
      askFn: async (prompt) => { prompts[String(route)] = prompt; return reply(scriptWith('The pilot waits for the turn.')); },
      askRoleFn: async () => { throw new Error('ending check off for this test'); },
    });
  }
  for (const route of ['authored', 'overlay']) {
    assert.ok(prompts[route].includes(PICTURE_NARRATION_RULE), route);
    assert.match(prompts[route], /in its own words/, route);
  }
  for (const route of ['classic', 'undefined']) {
    assert.ok(!prompts[route].includes('Narration states only what is true'), route);
    assert.ok(!prompts[route].includes('in its own words'), route);
  }
});

test('a picture-route rewrite that repeats a refused statement is asked again and the second answer is kept', async () => {
  const prompts = [];
  const replies = [reply(scriptWith(STATEMENT)), reply(scriptWith('The pilot waits for the turn.'))];
  const result = await planCodebuiltScript({ topic: 'the strait', duration: 30, route: 'authored', corrections, pack }, {
    askFn: async (prompt) => { prompts.push(prompt); return replies[Math.min(prompts.length - 1, 1)]; },
    askRoleFn: async () => { throw new Error('ending check off for this test'); },
  });
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /repeats a statement the fact check refused/);
  assert.ok(!result.script.includes(STATEMENT));
  assert.ok(result.script.includes('The pilot waits for the turn.'));
});

test('a classic rewrite that repeats the same statement is not refused (classic text is unchanged)', async () => {
  let calls = 0;
  const result = await planCodebuiltScript({ topic: 'the strait', duration: 30, route: 'classic', corrections, pack }, {
    askFn: async () => { calls += 1; return reply(scriptWith(STATEMENT)); },
    askRoleFn: async () => { throw new Error('ending check off for this test'); },
  });
  assert.equal(calls, 1);
  assert.ok(result.script.includes(STATEMENT));
});

test('a layout finding with no frame number prints no "frame -1"', () => {
  const prompt = buildLookPrompt({
    brief: 'A tanker.', script: 'A tanker.', shots: [{ id: 'shot-0', subject: 'tanker', narration: 'A tanker.' }],
    buildScript: 'x = 1', kitContract: 'kit', shotStarts: [0], round: 0,
    layoutFindings: [{ frame: -1, code: 'label_hidden', elements: ['labels[1]'] }, { frame: 7, code: 'caption_overlap', elements: ['labels[0]'] }],
  });
  assert.ok(!/frame -1/.test(prompt));
  assert.match(prompt, /no single frame: label_hidden \(labels\[1\]\)/);
  assert.match(prompt, /frame 7: caption_overlap \(labels\[0\]\)/);
});

test('the picture-route skill text carries the marker and land rules, and classic map guidance is unchanged', () => {
  const mapPack = { ...pack, rules: { ...pack.rules, skillsByStep: { ...pack.rules.skillsByStep, build: ['codebuilt-scene-generation'] } } };
  const picture = loadCodebuiltGuides({ pack: mapPack, step: 'build', topic: 'a country border map', route: 'authored', formats: [] });
  assert.match(picture, /A place marker is smaller than the place it marks/);
  assert.match(picture, /Land must read as land/);
  const classic = loadCodebuiltGuides({ pack: mapPack, step: 'build', topic: 'a country border map', route: 'classic', formats: [] });
  assert.ok(classic.includes('### codebuilt-maps'));
  assert.ok(!classic.includes('A place marker is smaller'));
  assert.ok(!classic.includes('Land must read as land'));
  const before = execFileSync('git', ['show', '018dd15:.claude/skills/codebuilt-maps/SKILL.md'], { cwd: fileURLToPath(root), encoding: 'utf8' })
    .replace(/\r\n/g, '\n').replace(/^---\n[\s\S]*?\n---\n/, '').split('\n## When text is drawn after the render')[0].trim();
  assert.equal(classic.replace(/\r\n/g, '\n').split('### codebuilt-maps\n')[1].split('\n### ')[0].trim(), before);
});

test('the picture-route script skill text forbids colours in narration and repeated refused statements', () => {
  const scriptPack = { ...pack, rules: { ...pack.rules, skillsByStep: { ...pack.rules.skillsByStep, script: ['codebuilt-script'] } } };
  const picture = loadCodebuiltGuides({ pack: scriptPack, step: 'script', route: 'authored', formats: [] });
  assert.match(picture, /never in `narration`/);
  assert.match(picture, /must not come back in its own words/);
  const classic = loadCodebuiltGuides({ pack: scriptPack, step: 'script', route: 'classic', formats: [] });
  assert.ok(!classic.includes('never in `narration`'));
});

