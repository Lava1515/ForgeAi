import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

const clientRoot = fileURLToPath(new URL('..', import.meta.url));

test('the start form shows One author only when the server capability is true', async () => {
  const vite = await createServer({
    root: clientRoot,
    configFile: path.join(clientRoot, 'vite.config.js'),
    optimizeDeps: { noDiscovery: true, entries: [] },
    server: { middlewareMode: true },
    appType: 'custom',
  });
  try {
    const { default: CodebuiltStart } = await vite.ssrLoadModule('/src/components/episode/CodebuiltStart.jsx');
    const enabled = renderToStaticMarkup(React.createElement(CodebuiltStart, { authorModeAvailable: true }));
    const disabled = renderToStaticMarkup(React.createElement(CodebuiltStart, { authorModeAvailable: false }));
    assert.match(enabled, />One author</);
    assert.doesNotMatch(disabled, />One author</);
  } finally {
    await vite.close();
  }
});
