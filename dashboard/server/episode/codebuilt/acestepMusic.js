// codex · gpt-6.1-sol · 2026-11-19: C3, host-only opt-in music; reuse the existing GPU lease.
import fs from 'node:fs';
import path from 'node:path';
import { acquireGpu } from '../queue.js';

const INSTALL = 'C:/code/ForgeAi/output/agent-jobs/tools-tests-1119';

// The worker ends on one of these words when it refuses to start (acestep_music.py); anything else is a failed generation.
const REFUSALS = ['pin_mismatch', 'card_busy', 'card_memory', 'card_unknown'];
export function fallbackReason(log) {
  const last = String(log ?? '').trim().split(/\r?\n/).pop() ?? '';
  const word = /^RuntimeError: (\w+)$/.exec(last.trim())?.[1];
  return REFUSALS.includes(word) ? word : 'generation_failed';
}

export async function prepareAceMusic({ job, repoRoot, env, execFileFn, signal }) {
  if (env.FORGEAI_ACESTEP_MUSIC !== '1') return {};
  let lease, logText = '';
  try {
    // Busy means synth now, rather than queueing another expensive graphics-card job.
    lease = await acquireGpu({ who: 'acestep', ticket: 'C3', timeoutMs: 100, signal });
  } catch (error) {
    if (signal?.aborted) throw error;
    return { FORGEAI_MUSIC_FALLBACK: 'gpu_busy' };
  }
  try {
    const work = fs.mkdtempSync(path.join(job, '.acestep-'));
    const python = path.join(INSTALL, 'ace-step/.venv/Scripts/python.exe');
    const script = path.join(repoRoot, 'narrative_factory/codebuilt/post/acestep_music.py');
    await new Promise((resolve, reject) => {
      let failure;
      const child = execFileFn(python, ['-I', script, job, work], {
        shell: false, windowsHide: true, timeout: 120_000, signal, maxBuffer: 2 * 1024 * 1024, cwd: work,
        // NVML needs ProgramW6432/ProgramFiles to find its driver on Windows.
        env: Object.fromEntries(['PATH', 'Path', 'SystemRoot', 'ProgramW6432', 'ProgramFiles', 'TEMP', 'TMP'].filter(k => typeof env[k] === 'string').map(k => [k, env[k]])),
      }, (error, stdout, stderr) => {
        logText = String(stdout ?? '') + String(stderr ?? '');
        fs.writeFileSync(path.join(work, 'generation.log'), logText);
        failure = error;
      });
      // Abort may call execFile's callback before Python exits. Keep the GPU lease until close.
      child.once('close', () => failure ? reject(failure) : resolve());
    });
    return { FORGEAI_ACE_BED: path.join(work, 'bed.wav'), FORGEAI_ACE_REPORT: path.join(work, 'music.json') };
  } catch (error) {
    if (signal?.aborted) throw error;
    return { FORGEAI_MUSIC_FALLBACK: error.killed ? 'timeout' : fallbackReason(logText) };
  } finally {
    await lease.release();
  }
}
