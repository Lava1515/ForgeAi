import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSnippet, uploadTitleError } from '../routes/youtube.js';

test('upload title rules preserve a descriptive title and reject empty, date, digits, draft ID, and overlong titles', () => {
  const title = 'Why the Danube bends through Budapest';
  const snippet = buildSnippet({ listing_copy: { title, description: 'The river curves through the city.' }, script: 'The river curves through the city.' });
  assert.equal(snippet.title, title);
  assert.ok(!snippet.title.endsWith('#Shorts'));
  assert.equal(uploadTitleError(title, 'draft-123'), null);
  assert.match(uploadTitleError('   ', 'draft-123'), /title/i);
  // The old channel got uploads titled with a Hebrew date; none of these may pass.
  for (const bad of ['2026-11-14', '१२३४', '14 בנובמבר 2026', '14 בנוב׳ 2026', 'נובמבר 2026', '14 Nov 2026', 'November 14, 2026', 'Mon Nov 14 2026', '2026年11月14日', '12:30', '2026-11-14T12:30:00Z', '14.11.2026 12:30', 'יום שבת 14.11']) {
    assert.match(uploadTitleError(bad, 'draft-123') || '', /date/i, bad);
  }
  for (const good of ['What happened in 1969?', '2026 World Cup', 'Why Java has 150 million people', 'Why May is the wettest month in Texas']) {
    assert.equal(uploadTitleError(good, 'draft-123'), null, good);
  }
  // The first description line is not a repeat of the narration's opening sentence.
  assert.equal(snippet.description.match(/The river curves through the city\./g).length, 1);
  assert.match(uploadTitleError('draft-123', 'draft-123'), /draft ID/i);
  assert.match(uploadTitleError('x'.repeat(101), 'draft-123'), /100 characters/i);
});
