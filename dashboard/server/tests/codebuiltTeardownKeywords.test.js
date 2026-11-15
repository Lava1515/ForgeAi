import test from 'node:test';
import assert from 'node:assert/strict';
import { loadCodebuiltPathPack } from '../episode/codebuilt/planner.js';
import { topicGuideNamesFor } from '../episode/codebuilt/skills.js';

test('teardown keywords match singular, plural and reworded stealth topics at direction and build steps', () => {
  const pack = loadCodebuiltPathPack();
  const shouldMatch = [
    'stealth jet',
    'stealth jets',
    'stealth plane',
    'stealth fighter',
    'stealth aircraft',
    'how stealth planes hide from radar',
    'stealth jet teardown',
    'F-117',
    'how a stealth bomber works',
  ];

  for (const topic of shouldMatch) {
    const directionSkills = topicGuideNamesFor(pack, 'direction', topic);
    const buildSkills = topicGuideNamesFor(pack, 'build', topic);
    assert.ok(
      directionSkills.includes('codebuilt-teardown'),
      `expected direction to match teardown for: "${topic}", got: ${JSON.stringify(directionSkills)}`
    );
    assert.ok(
      buildSkills.includes('codebuilt-teardown'),
      `expected build to match teardown for: "${topic}", got: ${JSON.stringify(buildSkills)}`
    );
  }
});

test('unrelated topics do not select codebuilt-teardown', () => {
  const pack = loadCodebuiltPathPack();
  const shouldNotMatch = [
    'jet engine history',
    'what if the sun vanished',
    'world map of trade routes',
  ];

  for (const topic of shouldNotMatch) {
    const directionSkills = topicGuideNamesFor(pack, 'direction', topic);
    const buildSkills = topicGuideNamesFor(pack, 'build', topic);
    assert.ok(
      !directionSkills.includes('codebuilt-teardown'),
      `expected direction NOT to match teardown for: "${topic}", got: ${JSON.stringify(directionSkills)}`
    );
    assert.ok(
      !buildSkills.includes('codebuilt-teardown'),
      `expected build NOT to match teardown for: "${topic}", got: ${JSON.stringify(buildSkills)}`
    );
  }
});
