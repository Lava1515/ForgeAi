// CB5: the host output producer. It runs ONLY after the fence has returned with the container confirmed gone, so no
// generated code is alive while it reads the job folder. The executor leaves <job>/frames (PNG); this stage stages
// words.json and the TRUSTED voice recording (inputs/vo.wav, hash-verified by the runner) next to them as mix.wav and runs
// the CB4 post kit (narrative_factory/codebuilt/post/cb5.py) to write out/{video.mp4,subtitles.srt,contact_sheet.png,report.json}.
//
// Honest limits: the post kit decodes untrusted PNG frames with Pillow (PNG only) and ffmpeg on the host (poisoned file
// content is out of scope of the fence, docs/codebuilt-isolation.md). The audio is always the voice recording
// (`audio: 'voice-only'`): a mix.wav the executor wrote is NEVER used, it is refused, so no executor-made file is ever fed
// to the host ffmpeg as audio; no music is invented. The python argv is fixed except for the absolute job folder path
// (python -I <post kit script> <job dir>); no shell, no inherited secrets.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { assertNoLinksInTree } from '../../codebuilt/jobPaths.js';
import { scanReparsePoints } from '../../codebuilt/reparse.js';
import { CodebuiltError } from './errors.js';
import { REPO_ROOT } from './launch.js';

const SAFE_ENV_KEYS = ['PATH', 'Path', 'SystemRoot', 'TEMP', 'TMP', 'FFMPEG_PATH', 'LANG'];
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const isRegular = (file) => { try { const st = fs.lstatSync(file); return st.isFile() && !st.isSymbolicLink() && st.nlink === 1; } catch { return false; } };

function safeEnv(env) {
  const out = {};
  for (const key of SAFE_ENV_KEYS) if (typeof env[key] === 'string') out[key] = env[key];
  return out;
}

/** Copies src to dst unless dst exists; an existing dst must be byte-identical to src (the host owns these names; a different file there was written by the executor and is refused). */
function stage(src, dst, label) {
  if (!isRegular(src)) throw new CodebuiltError('PRODUCER_FAILED', `${label}: source is not a regular file`);
  if (fs.lstatSync(dst, { throwIfNoEntry: false })) {
    if (!isRegular(dst) || sha(dst) !== sha(src)) throw new CodebuiltError('PRODUCER_FAILED', `${label}: the job folder already holds a different ${path.basename(dst)}`);
    return;
  }
  fs.copyFileSync(src, dst, fs.constants.COPYFILE_EXCL);
}

export function createHostOutputProducer({
  repoRoot = REPO_ROOT, python = 'python', execFileFn, timeoutMs = 30 * 60 * 1000, env = process.env, linkScan = scanReparsePoints,
} = {}) {
  if (typeof execFileFn !== 'function') throw new TypeError('execFileFn must be passed in by the composition (this folder has no process surface of its own)');
  if (!(timeoutMs > 0)) throw new TypeError('timeoutMs must be positive');
  const script = path.join(path.resolve(repoRoot), 'narrative_factory', 'codebuilt', 'post', 'cb5_main.py');

  return async function produceOutputs({ jobDir, signal } = {}) {
    if (typeof jobDir !== 'string' || !path.isAbsolute(jobDir)) throw new CodebuiltError('PRODUCER_FAILED', 'jobDir must be absolute');
    const job = path.resolve(jobDir);
    try { assertNoLinksInTree(job, 'job folder', { reparseScan: linkScan }); } catch (error) {
      throw new CodebuiltError('PRODUCER_FAILED', String(error?.message ?? error).slice(0, 300));
    }
    const frames = path.join(job, 'frames');
    let hasFrames = false;
    try { const st = fs.lstatSync(frames); hasFrames = st.isDirectory() && !st.isSymbolicLink() && fs.readdirSync(frames).some((n) => /\.png$/i.test(n)); } catch { /* none */ }
    if (!hasFrames) throw new CodebuiltError('MISSING_OUTPUT', 'the executor left no frames/*.png', { missing: ['frames'] });

    const looping = JSON.parse(fs.readFileSync(path.join(job, 'inputs', 'pathpack.json'), 'utf8')).videoType === 'loop';
    if (!looping) stage(path.join(job, 'inputs', 'words.json'), path.join(job, 'words.json'), 'words.json');
    // Always the trusted voice. stage() copies it, or accepts an existing mix.wav only when it is byte-identical to the voice
    // (a rerun of this stage); anything else already in that place was written by the executor and is refused.
    const audio = looping ? 'synthesized-loop' : 'voice-only';
    if (!looping) stage(path.join(job, 'inputs', 'vo.wav'), path.join(job, 'mix.wav'), 'mix.wav');

    const stdout = await new Promise((resolve, reject) => {
      const child = execFileFn(python, ['-I', script, job], { timeout: timeoutMs, windowsHide: true, shell: false, env: safeEnv(env), maxBuffer: 1024 * 1024, signal }, (error, out, err) => {
        if (error) reject(new CodebuiltError('PRODUCER_FAILED', `the post kit failed: ${String(err || out || error.message).trim().slice(-300)}`));
        else resolve(String(out));
      });
      child?.on?.('error', () => {});
    });
    let status = null;
    try { status = JSON.parse(stdout.trim().split(/\r?\n/).pop()).status; } catch { /* handled below */ }
    if (status !== 'ok') throw new CodebuiltError('PRODUCER_FAILED', 'the post kit did not report ok');
    return { audio };
  };
}
