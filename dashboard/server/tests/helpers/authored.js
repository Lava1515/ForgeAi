// codex · gpt-6.1-sol · 2026-11-19: move existing pipeline regressions onto the real author loop.
import fs from 'node:fs';
import path from 'node:path';
import { hash, authorArgv } from '../../episode/codebuilt/authorCall.js';

export const CODE = '# scene camera light material world setup timeline layers framing\ndef shot_0(t):\n    pass\n';
export function authorOptions(root, hooks = {}) {
  fs.mkdirSync(root, { recursive: true });
  const capsFile = path.join(root, 'test-caps.json'), configDir = path.join(root, 'test-config');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(capsFile, JSON.stringify({ measuredAt: '2026-11-19', cliVersion: '2.1.322', model: 'sonnet', runs: [{ previews: 3 }, { previews: 3 }, { previews: 3 }], caps: { billableTotal: 1472004, contextPeak: 900000 }, reserves: { IMAGE_RESERVE: 4000, OUTPUT_RESERVE: 40000 } }));
  return {
    capsFile, configDir, repoRoot: 'C:/code/ForgeAi', newCode: () => 'ABCDE',
    probe: async () => ({ passed: true }),
    askAuthor: async (prompt, images, { model }) => ({
      text: images.length ? JSON.stringify({ look: { sheet_codes: ['ABCDE'], verdict: 'pass', shots: [{ id: 'shot-0', sees: 'The subject fills the frame.', ok: true }], findings: [], targets: [], edits: [] }, notes: 'Subject' }) : '```python\n' + (hooks.code ?? CODE) + '```\n```json\n' + JSON.stringify(hooks.spec ?? {version:1}) + '\n```',
      rawUsage: { input_tokens: 10, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      receipt: { argvSha256: hash(JSON.stringify(authorArgv(model))), promptSha256: hash(prompt), imageSha256: images.map(i => hash(i.bytes)), imageCount: images.length, noSessionPersistence: true, toolsOffered: 0, transport: 'stdin-image-blocks' },
    }),
    runPreview: async request => {
      await hooks.visual?.({ ...request, route: 'authored', jobId: request.jobId.replace(/-a\d+-pv\d+$/, '') });
      const dir = path.join(root, request.jobId, 'preview'); fs.mkdirSync(dir, { recursive: true });
      const work = path.join(path.dirname(dir),'work'); fs.mkdirSync(work,{recursive:true}); fs.writeFileSync(path.join(work,'render-timing.json'),JSON.stringify({render_s:1,rendered:10}));
      if(hooks.nframes) fs.writeFileSync(path.join(work,'anchors-all.done.json'),JSON.stringify({version:1,frames:hooks.nframes,max_frame:hooks.nframes-1,anchors:false}));
      return { dir, frames: [{ name: '1.png', sha256: 'frame' }] };
    },
    sheetMaker: { makeSheets: async ({ outDir }) => {
      fs.mkdirSync(outDir, { recursive: true }); const file = path.join(outDir, 'sheet.jpg'); fs.writeFileSync(file, 'pixels');
      return [{ path: file, code: 'ABCDE', sha256: hash('pixels'), tiles: [{ n: 1, frame: 1 }] }];
    } },
    layoutCheck: async ({ overlaySpec, words, anchors, nframes }) => ({ version: 1, ok: true, framesChecked: nframes, fps: 30, previewFrames: hooks.nframes ?? 1, anchoredFrames: 0, blocking: [], labelHidden: [], inputs: { overlaySha256: hash(fs.readFileSync(overlaySpec)), anchorsSha256: anchors ? hash(fs.readFileSync(anchors)) : null, wordsSha256: words ? hash(fs.readFileSync(words)) : null } }),
  };
}
export const renderPack = { id: 'codebuilt', skills: [], rules: { routes: { overlay: { render: { RENDER_BUDGET_S_PER_FRAME: 1.5 } } } } };
export function authorPlanner(onPlan = async () => {}) {
  return {
    planCodebuiltDirection: async input => {
      await onPlan(input);
      return { direction: { narrations: ['The subject moves.'], places: [{ id: 'p1', base: 'custom', what: 'world' }], shots: [{ place: 'p1', shows: 'subject', action: 'moves', camera: 'orbit' }] }, shotStarts: [0] };
    },
    frameCountFor: () => 900, authorBuildPrompt: () => 'Write code', KIT_CONTRACT: 'kit',
    validateBuildScript: () => [], pythonSyntaxCheck: () => null, pythonQaStructureCheck: () => [],
  };
}
