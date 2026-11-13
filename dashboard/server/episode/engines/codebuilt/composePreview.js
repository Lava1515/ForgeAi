// Visual loop (KAN-934): composition of preview jobs. A preview runs through the SAME runner instance (or, standalone, the same
// composeCodebuiltRunner) that the final render uses, so it reaches the fence with exactly the approved launch: same image, argv,
// gpu flag, limits and read-only kit mount. What a caller can choose is the job id, the script, the frame list and the scale; there is
// no option for an image, command, network, limit, mount or environment (the runner's fenceOptions allowlist is not even passed).
import fs from 'node:fs';
import path from 'node:path';
import { JOB_ROOT } from '../../codebuilt/jobPaths.js';
import { composeCodebuiltRunner } from './compose.js';
import { GENERATED_EXECUTOR_ID, GENERATED_GPU_EXECUTOR_ID } from './launch.js';
import { CodebuiltError } from './errors.js';

export const PREVIEW_TIMEOUT_MS = 8 * 60 * 1000;
const DIAGNOSTIC_MAX_BYTES = 4096;
// Tab, newline and printable ASCII only.
const PRINTABLE = (text) => [...String(text ?? '')].filter((ch) => ch === '\t' || ch === '\n' || (ch >= ' ' && ch <= '~')).join('');

/**
 * Why a preview failed, cleaned, or null: the QA failure text the kit left in <job>/work/qa_failure.txt, else the end of the
 * container's stderr the host saved in <job>/work/stderr_tail.txt (a Python traceback when the generated code crashed).
 * Either must be a regular file of at most 4 KB.
 */
export function readPreviewDiagnostic(jobRoot, jobId) {
  for (const name of ['qa_failure.txt', 'stderr_tail.txt']) {
    try {
      const file = path.join(jobRoot, jobId, 'work', name);
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size === 0 || stat.size > DIAGNOSTIC_MAX_BYTES) continue;
      const text = PRINTABLE(fs.readFileSync(file, 'utf8')).trim();
      if (text) return text.slice(0, DIAGNOSTIC_MAX_BYTES);
    } catch { /* try the next file */ }
  }
  return null;
}

/**
 * runPreview({ jobId, buildScript, spec: { frames, scale }, signal }) -> { dir, frames } for the visual loop.
 * `runner` is a createBuildJobRunner result; `inputs` is { script, voWav, words, pathPack, brief } exactly as the final job gets them.
 * A failed preview rethrows the runner's typed error with `.diagnostic` set when the kit left a QA failure text.
 */
export function createPreviewRunFn({ runner, inputs, jobRoot, timeoutMs = PREVIEW_TIMEOUT_MS } = {}) {
  if (!runner || typeof runner.run !== 'function') throw new TypeError('runner is required');
  if (!inputs || typeof inputs !== 'object') throw new TypeError('inputs are required');
  if (typeof jobRoot !== 'string' || !path.isAbsolute(jobRoot)) throw new TypeError('jobRoot must be absolute');
  if (!(timeoutMs > 0)) throw new TypeError('timeoutMs must be positive');
  const { script, voWav, words, pathPack, brief } = inputs;
  return async function runPreview({ jobId, buildScript, spec, signal } = {}) {
    const request = {
      script, voWav, words, pathPack, brief, jobId, kind: 'generated-code', mode: 'preview', buildScript,
      previewFrames: spec?.frames, previewScale: spec?.scale, timeoutMs, signal,
    };
    try {
      const result = await runner.run(request);
      return { dir: result.preview.dir, frames: result.preview.frames, resumed: result.resumed === true };
    } catch (error) {
      if (error && typeof error === 'object') {
        const diagnostic = readPreviewDiagnostic(jobRoot, jobId);
        if (diagnostic) error.diagnostic = diagnostic;
      }
      throw error;
    }
  };
}

/** Standalone composition: the final render's launch (the GPU entry by default) and nothing else a caller can change. */
export function composePreviewRunner({ root, inputRoots = [], launchId = GENERATED_GPU_EXECUTOR_ID, inputs, timeoutMs, deps = {} } = {}) {
  // Only the two approved generated-code executors can run a preview; a proof or stub entry is not a renderer.
  if (launchId !== GENERATED_GPU_EXECUTOR_ID && launchId !== GENERATED_EXECUTOR_ID) throw new CodebuiltError('LAUNCH_NOT_APPROVED', `launch ${JSON.stringify(launchId)} cannot run a preview`);
  const composed = composeCodebuiltRunner({ ...(root ? { root } : {}), launchId, inputRoots, deps });
  return Object.freeze({
    launch: composed.launch,
    runPreview: createPreviewRunFn({ runner: composed.runner, inputs, jobRoot: path.resolve(root ?? JOB_ROOT), timeoutMs }),
  });
}
