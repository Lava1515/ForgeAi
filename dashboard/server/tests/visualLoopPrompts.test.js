import test from 'node:test';
import assert from 'node:assert/strict';
import { applyScopedEdits, buildLookPrompt } from '../episode/codebuilt/visualLoopPrompts.js';

function fixture(newline = '\n') {
  return [
    'VALUE = 1',
    ...Array.from({ length: 18 }, (_, i) => `def filler_${i}():\n    return ${i}`),
    'def shot_3():',
    '    return VALUE',
    '',
  ].map((line) => line.replace(/\n/g, newline)).join(newline);
}

function apply(source, edits) {
  return applyScopedEdits(source, { edits, targets: edits.map((edit) => edit.name) }).source;
}

test('same-anchor add_def survives replace_def in either reply order', () => {
  const add = { op: 'add_def', name: 'num_vis_helper', before: 'shot_3', source: 'def num_vis_helper():\n    return VALUE' };
  const replace = { op: 'replace_def', name: 'shot_3', source: 'def shot_3():\n    return num_vis_helper()' };

  for (const edits of [[add, replace], [replace, add]]) {
    const result = apply(fixture(), edits);
    assert.equal((result.match(/^def num_vis_helper\(\):$/gm) ?? []).length, 1);
    assert.equal((result.match(/^def shot_3\(\):$/gm) ?? []).length, 1);
    assert.match(result, /return num_vis_helper\(\)/);
    assert.ok(result.indexOf('def num_vis_helper') < result.indexOf('def shot_3'));
  }
});

test('same-anchor inserts retain reply order and CRLF line endings', () => {
  const edits = [
    { op: 'add_def', name: 'first_helper', before: 'shot_3', source: 'def first_helper():\n    return VALUE' },
    { op: 'add_def', name: 'second_helper', before: 'shot_3', source: 'def second_helper():\n    return VALUE' },
  ];
  const result = apply(fixture('\r\n'), edits);

  assert.ok(result.indexOf('def first_helper') < result.indexOf('def second_helper'));
  assert.ok(result.indexOf('def second_helper') < result.indexOf('def shot_3'));
  assert.ok(result.includes('\r\n'));
  assert.equal(result.replace(/\r\n/g, '').includes('\n'), false);
});

test('look prompt describes final caption and overlay tiles and includes preview layout findings', () => {
  const prompt = buildLookPrompt({ brief: 'brief', script: 'words', shots: [{ id: 'shot-0', subject: 'subject', narration: 'words' }],
    buildScript: 'pass', kitContract: 'kit', sheets: [{ code: 'ABCDE', tiles: [{ n: 1, frame: 6 }] }], shotStarts: [0],
    layoutFindings: [{ frame: 6, code: 'caption_overlap', elements: ['label[0]'] }] });
  assert.match(prompt, /tiles carry the final text/);
  assert.match(prompt, /readable at phone size/);
  assert.match(prompt, /covers the subject/);
  assert.match(prompt, /frame 6: caption_overlap/s);
});
