// The asset library is optional: without it (or with the switch off) the prompts must be unchanged.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readAssetCatalog, assetContractText, assetPickerText } from '../episode/codebuilt/assetCatalog.js';

function lib(assets) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'assetlib-'));
  for (const a of assets) if (a.onDisk !== false) { fs.mkdirSync(path.dirname(path.join(root, a.file)), { recursive: true }); fs.writeFileSync(path.join(root, a.file), 'x'); }
  fs.writeFileSync(path.join(root, 'catalog.json'), JSON.stringify({ version: 1, assets }));
  return root;
}

test('no catalog, a broken catalog or the switch off give empty prompt text', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'assetlib-'));
  assert.deepEqual(readAssetCatalog(empty, {}), []);
  fs.writeFileSync(path.join(empty, 'catalog.json'), '{not json');
  assert.deepEqual(readAssetCatalog(empty, {}), []);
  const root = lib([{ id: 'Drill_01', kind: 'model', file: 'm/Drill_01.blend' }]);
  assert.equal(readAssetCatalog(root, { CODEBUILT_ASSET_LIBRARY: '0' }).length, 0);
  assert.equal(assetContractText([]), '');
  assert.equal(assetPickerText([]), '');
});

test('only assets whose file is on disk inside the library are offered', () => {
  const root = lib([
    { id: 'Drill_01', kind: 'model', file: 'm/Drill_01.blend', category: 'Tools/Drills', dimensions_m: [0.18, 0.05, 0.19] },
    { id: 'gone', kind: 'model', file: 'm/gone.blend', onDisk: false },
    { id: 'escape', kind: 'model', file: '../outside.blend', onDisk: false },
    { id: 'bad id!', kind: 'model', file: 'm/Drill_01.blend' },
    { id: 'sky', kind: 'hdri', file: 'h/sky.hdr', attributes: { time_of_day: 'sunset' } },
  ]);
  const got = readAssetCatalog(root, {});
  assert.deepEqual(got.map((a) => a.id), ['Drill_01', 'sky']);
  const text = assetContractText(got);
  assert.match(text, /Drill_01 \(Drills, 0\.19 m tall\)/);
  assert.match(text, /sky \(sunset\)/);
  assert.doesNotMatch(text, /gone|escape/);
});

// codex ? gpt-6.1-sol ? 2026-11-19: reproduced library guidance leaking to overlay with no catalog.
test('non-authored routes never receive the asset library skill section', async () => {
  const { loadCodebuiltGuides } = await import('../episode/codebuilt/skills.js');
  const pack = JSON.parse(fs.readFileSync(new URL('../../../paths/codebuilt.json', import.meta.url), 'utf8'));
  for (const route of ['classic', 'overlay']) {
    const text = loadCodebuiltGuides({ pack, step: 'build', route, formats: ['journey'] });
    assert.doesNotMatch(text, /Real assets from the library|library\.hdri/);
  }
});
