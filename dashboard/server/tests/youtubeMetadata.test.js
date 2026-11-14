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
  assert.match(uploadTitleError('2026-11-14', 'draft-123'), /date/i);
  assert.match(uploadTitleError('१२३४', 'draft-123'), /digits/i);
  assert.match(uploadTitleError('draft-123', 'draft-123'), /draft ID/i);
  assert.match(uploadTitleError('x'.repeat(101), 'draft-123'), /100 characters/i);
});
