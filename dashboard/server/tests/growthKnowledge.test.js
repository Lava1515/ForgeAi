// Bug that happened: growth/knowledge/ was missing from this repo, so every growth prompt ran on a one-line placeholder
// with no output schema. Each sub-skill must exist, name the keys check.js requires, and load its references.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGrowthPrompt } from '../growth/askGrowth.js';
import { REQUIRED_SECTIONS_BY_SUBSKILL } from '../growth/check.js';

const SUBSKILLS = ['tags', 'titles', 'metadata', 'hook', 'ideate', 'script', 'strategy', 'analyze', 'audit', 'competitor', 'seo', 'shorts'];

for (const subskill of SUBSKILLS) {
  test(`growth sub-skill ${subskill} has its knowledge file, schema keys and references`, () => {
    const prompt = buildGrowthPrompt({ subskill, channel: { name: 'Test', genre: 'geography' } });
    assert.doesNotMatch(prompt, /Execute growth workflow for/, 'knowledge file missing');
    assert.match(prompt, /## Reference Knowledge/, 'no reference loaded');
    const file = subskill === 'tags' || subskill === 'titles' ? 'metadata' : subskill;
    for (const key of REQUIRED_SECTIONS_BY_SUBSKILL[file] || []) assert.ok(prompt.includes(`"${key}"`), `schema key "${key}" not named`);
  });
}

test('the keys report.js, ideas.js and strategy.js read are named in their sub-skills', () => {
  const has = (subskill, keys) => { const p = buildGrowthPrompt({ subskill }); for (const k of keys) assert.ok(p.includes(`"${k}"`), `${subskill}: "${k}"`); };
  has('analyze', ['top_actions', 'next_subskill', 'priority_actions', 'scores']);
  has('audit', ['scores', 'action_plan', 'seo', 'performance', 'strategy', 'monetization', 'overall']);
  has('ideate', ['topic', 'score']);
  has('competitor', ['gaps']);
  has('strategy', ['content_pillar', 'upload_cadence']);
});
