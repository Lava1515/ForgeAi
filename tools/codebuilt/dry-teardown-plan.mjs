// claude-pro · claude-sonnet-5-5, 2026-11-15 (lane M5p). Dry teardown plan: runs the real planner functions
// (planCodebuiltDirection, planCodebuiltBuild) with the model call replaced by a recorder, so no model, CLI, GPU or
// network is used. It shows which skills and set manual text the prompts really contain for a teardown topic.
// Usage:  node tools/codebuilt/dry-teardown-plan.mjs <label>   -> output/agent-jobs/m5p-stealth-teardown/<label>/dry-plan/
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { planCodebuiltDirection, planCodebuiltBuild, loadCodebuiltPathPack } from '../../dashboard/server/episode/codebuilt/planner.js';
import { topicGuideNamesFor } from '../../dashboard/server/episode/codebuilt/skills.js';

const label = process.argv[2];
if (!/^[a-z0-9][a-z0-9-]{0,30}$/.test(label ?? '')) { console.error('usage: node dry-teardown-plan.mjs <label>'); process.exit(2); }
const checkout = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const outDir = path.join(checkout, 'output', 'agent-jobs', 'm5p-stealth-teardown', label, 'dry-plan');
fs.mkdirSync(outDir, { recursive: true });
const pack = loadCodebuiltPathPack();

const topic = 'How does a stealth jet hide from radar?';
const script = 'A stealth jet hides from radar by shape first. Its flat angled panels bounce radar waves away from the radar that sent them. A special coating soaks up what is left. The engines sit deep inside the body behind curved ducts, and the weapons ride in an internal bay, so nothing sticks out to ring back like a bell.';
const wordList = script.split(/\s+/);
const words = { dur: Math.round(wordList.length / 2.9 * 100) / 100, words: wordList.map((w, i) => ({ w, s: Math.round(i / 2.9 * 100) / 100, e: Math.round((i + 0.8) / 2.9 * 100) / 100, ...(/[.,]$/.test(w) ? { punct: w.slice(-1) } : {}) })) };
const prompts = { direction: [], build: [] };
const askFn = (step) => async (prompt) => { prompts[step].push(prompt); return 'not a usable reply'; };
const summary = { topic, words: wordList.length, seconds: words.dur };

const dir = await planCodebuiltDirection({ topic, duration: 30, script, brief: 'teardown explainer', beats: [], words, pathPack: pack }, { askFn: askFn('direction') });
summary.direction = { source: dir.direction.source, calls: dir.calls.length, prompt_attempts: prompts.direction.length };
try {
  await planCodebuiltBuild({ topic, duration: 30, script, brief: 'teardown explainer', words, pathPack: pack, direction: dir.direction, shotStarts: dir.shotStarts }, { askFn: askFn('build') });
} catch (e) { summary.build_stopped_as_expected = String(e.code ?? e.message).slice(0, 80); }

const has = (text, needle) => text.includes(needle);
for (const step of ['direction', 'build']) {
  const prompt = prompts[step][0] ?? '';
  fs.writeFileSync(path.join(outDir, `${step}-prompt.txt`), prompt);
  summary[step] = { ...summary[step], prompt_chars: prompt.length,
    has_teardown_skill: has(prompt, '### codebuilt-teardown'),
    has_set_manual_entry: has(prompt, 'stealth_jet_teardown.build(origin)'),
    has_new_camera_pose: has(prompt, '9.9, -20.1, 30.1'), has_old_camera_pose: has(prompt, '(9.5, -16.0, 11.0)'),
    has_stale_subsystem_claim: has(prompt, '17+'), has_callout_part_id_rule: has(prompt, 'a part id, not a facts key'),
    has_disclaimer: has(prompt, 'Illustrative schematic reconstruction'),
    set_listed_in_picker: has(prompt, 'stealth_jet_teardown:') };
}
// Which phrasing of a teardown topic loads the teardown skill at the direction and build steps?
const phrasings = ['How does a stealth jet hide from radar?', 'How does the F-117 Nighthawk work?', 'How does a stealth bomber avoid radar?',
  'Inside a stealth fighter', 'How do stealth planes work?', 'Teardown of a stealth aircraft', 'What makes the B-2 Spirit invisible to radar?', 'How a jet engine works',
  'How does radar absorbent coating work?', 'Why are stealth jets shaped like diamonds?'];
summary.keyword_matches = Object.fromEntries(phrasings.map((t) => [t, { direction: topicGuideNamesFor(pack, 'direction', t).includes('codebuilt-teardown'), build: topicGuideNamesFor(pack, 'build', t).includes('codebuilt-teardown') }]));
fs.writeFileSync(path.join(outDir, 'dry-plan.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
