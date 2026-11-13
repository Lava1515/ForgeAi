// CB6: the lowest execution boundary. runFenced is the only function in this path that can start a container,
// and it decides for itself whether the launch is allowed: Docker runtime only, the launch must be on the frozen
// approved list (exact kind, image content address, command argv, review identity), the caller must hold the job
// lock, and the image must already be present locally. It then runs the container under a hard time limit and a
// watchdog, and confirms the container is gone afterwards.
//
// Generated Blender Python runs inside this offline container (owner decision, KAN-915). The "at most N Blender"
// cap is DETECTION ONLY: the watchdog reads `docker top` and counts processes that look like Blender (a blender
// executable name, a background/-b run with a Python script or .blend file, or a bpy module run). Code in the
// container can rename or copy the binary, wrap it, or set argv[0] (exec -a), and nothing here can stop that: the
// job folder is a writable, executable bind mount and the code runs as the same user. So the cap catches an honest
// mistake (a script that starts a third Blender) and nothing more. What limits a hostile job is the hard bounds:
// container pids/memory/cpu, network none, the timeout and the single GPU lease. See docs/codebuilt-isolation.md.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { buildDockerArgv } from './dockerFence.js';
import { JOB_ROOT, samePath, assertNoLinksInTree } from './jobPaths.js';
import { assertLaunchAllowed, assertApprovedLaunch, blenderCapFor, APPROVED_LAUNCHES, IsolationRefused } from './policy.js';
import { removeAndVerify, STABLE_CHECKS, STABLE_MS } from './jobLock.js';
import { scanReparsePoints } from './reparse.js';
import { preventionEvidence } from './audit.js';

export const BLENDER_CAP = Object.freeze({
  enforcement: 'detect-only',
  method: 'docker top: executable named blender, or background/-b with a python script or .blend, or a bpy module run',
  evadedBy: 'a renamed or copied binary, a wrapper, exec -a, or a python process that loads bpy without a visible marker',
});
export const MAX_TIMEOUT_MS = 6 * 60 * 60 * 1000;
const MAX_STARTUP_GRACE_MS = 120000;
const MAX_TOP_LINES = 1024; // docker top can list up to the pids limit; the cap is tiny, so reading more adds nothing
const MAX_LINE_CHARS = 4096;
// A stop right after a start: the container may not exist yet and `docker run` may still be creating it. Removal must
// then hold for STABLE_CHECKS checks STABLE_MS apart (about 2 s) before it is believed (jobLock.removeAndVerify).
export { STABLE_CHECKS, STABLE_MS };

/** Executable of a command line: first token, or a quoted first token (Windows paths with spaces). */
function exeName(line) {
  const s = String(line).trim();
  let tok;
  if (s.startsWith('"')) {
    const end = s.indexOf('"', 1);
    tok = s.slice(1, end < 0 ? undefined : end);
  } else tok = s.split(/\s+/)[0];
  return tok.split(/[\\/]/).pop().toLowerCase();
}

const PYTHON_FLAGS = new Set(['-P', '--python', '--python-text', '--python-expr', '--python-console']);
const BPY_RE = /(?:^|\s)-m\s+bpy(?:\s|$)|\b(?:import|from)\s+bpy\b/;

/** Does one command line look like a Blender process? Heuristic by design (see BLENDER_CAP.evadedBy). */
export function looksLikeBlender(line) {
  const text = String(line).slice(0, MAX_LINE_CHARS);
  if (/^blender(\.exe)?$/.test(exeName(text))) return true;
  const tokens = text.trim().split(/\s+/).slice(0, 64);
  const background = tokens.some(t => t === '-b' || t === '--background');
  if (background && tokens.some(t => PYTHON_FLAGS.has(t) || /\.blend$/i.test(t))) return true; // renamed binary, run as Blender
  return BPY_RE.test(text);
}

export function countBlenderProcesses(commandLines) {
  return commandLines.slice(0, MAX_TOP_LINES).filter(looksLikeBlender).length;
}

const STDERR_TAIL_CHARS = 6000;
// Tab, newline and printable ASCII only: control characters and escape sequences never reach a file or a prompt.
const printable = (text) => [...String(text ?? '')].filter((ch) => ch === '\t' || ch === '\n' || (ch >= ' ' && ch <= '~')).join('');
export const STDERR_TAIL_FILE = 'stderr_tail.txt';

/** Called with the job lock held and no previous container alive, before a new launch. */
export function clearRunDiagnostics(jobDir) {
  try {
    assertNoLinksInTree(jobDir, 'job folder');
    for (const name of ['qa_failure.txt', STDERR_TAIL_FILE]) {
      const file = path.join(jobDir, 'work', name);
      const stat = fs.lstatSync(file, { throwIfNoEntry: false });
      if (!stat) continue;
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
        throw new IsolationRefused(`unexpected diagnostic file ${name}`);
      }
      fs.unlinkSync(file);
    }
  } catch (error) {
    if (error instanceof IsolationRefused) throw error;
    throw new IsolationRefused('could not clear diagnostics before launch');
  }
}

/**
 * Writes the end of a failed container's stderr to <job>/work/stderr_tail.txt. Called after the docker client closed.
 * Flag 'wx' creates the file or fails: an existing name (a file or a link the job left) is never written through.
 */
export function saveStderrTail(jobDir, text) {
  try {
    const clean = printable(text).trim();
    if (!clean || typeof jobDir !== 'string') return false;
    const work = path.join(jobDir, 'work');
    if (!fs.lstatSync(work).isDirectory()) return false;
    fs.writeFileSync(path.join(work, STDERR_TAIL_FILE), clean.slice(-4000), { flag: 'wx' });
    return true;
  } catch { return false; }
}

/** `docker top <name>` text -> command lines (column CMD / COMMAND, header row skipped). */
export function parseDockerTop(text) {
  const rows = String(text).split(/\r?\n/).map(r => r.trim()).filter(Boolean);
  if (rows.length < 2) return [];
  const header = rows[0].split(/\s+/);
  let idx = header.findIndex(h => /^(CMD|COMMAND)$/i.test(h));
  if (idx < 0) idx = header.length - 1;
  return rows.slice(1).map(r => r.split(/\s+/).slice(idx).join(' '));
}

function execDocker(args, { timeoutMs = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile('docker', args, { timeout: timeoutMs, windowsHide: true, shell: false }, (err, stdout) => (err ? reject(err) : resolve(String(stdout))));
  });
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const KILL_RETRY_MS = 250;
const TEST_ONLY = ['approvals', 'listProcesses', 'mountAllowlist', 'watchRoots', 'maxSnapshotEntries', 'acquireGpu', 'gpuOptions', 'isPidAlive', 'verify', 'reparseScan'];

/**
 * Real Docker or a simulation, never a mix. Passing BOTH spawnFn and dockerFn is a simulation: the caller's own
 * doubles run, this module starts nothing, and the result is marked `simulated`. Only a simulation may replace the
 * approved list or any other test-only input. With the real effects every such override is refused and the job root
 * is the fixed one, so no caller-supplied value can widen what real Docker is asked to run or mount.
 */
export function resolveEffects(config = {}, deps = {}) {
  const injected = ['spawnFn', 'dockerFn'].filter(k => deps[k] !== undefined);
  if (injected.length === 1) throw new IsolationRefused('pass both spawnFn and dockerFn (simulation) or neither (real Docker)');
  const simulated = injected.length === 2;
  if (!simulated) {
    const used = TEST_ONLY.filter(k => deps[k] !== undefined);
    if (used.length) throw new IsolationRefused(`test-only overrides are refused with real Docker: ${used.join(', ')}`);
    if (config.jobRoot !== undefined && !samePath(config.jobRoot, JOB_ROOT)) throw new IsolationRefused(`real runs use the fixed job root ${JOB_ROOT}`);
  }
  return {
    simulated,
    spawnFn: simulated ? deps.spawnFn : spawn,
    dockerFn: simulated ? deps.dockerFn : (a) => execDocker(a),
    approvals: simulated ? deps.approvals ?? APPROVED_LAUNCHES : APPROVED_LAUNCHES,
  };
}

/** Real runs always use the file-system reparse scan (it sees WSL symlinks); a simulation may inject its own or skip it. */
export const reparseScanFor = (fx, deps = {}) => (fx.simulated ? deps.reparseScan : scanReparsePoints);

function checkTimes({ timeoutMs, startupGraceMs = 30000 }) {
  if (typeof timeoutMs !== 'number' || !(timeoutMs > 0) || timeoutMs > MAX_TIMEOUT_MS) throw new Error(`timeoutMs must be > 0 and at most ${MAX_TIMEOUT_MS}`);
  if (typeof startupGraceMs !== 'number' || !(startupGraceMs > 0) || startupGraceMs > MAX_STARTUP_GRACE_MS) throw new Error(`startupGraceMs must be > 0 and at most ${MAX_STARTUP_GRACE_MS}`);
  return { timeoutMs, startupGraceMs };
}

/** Everything that can refuse a launch, with no side effect. runIsolatedJob calls it early; runFenced calls it again. */
export function validateLaunch(config, deps = {}) {
  assertLaunchAllowed({ runtime: config?.runtime });
  const fx = resolveEffects(config, deps);
  const approval = assertApprovedLaunch(config, fx.approvals);
  const times = checkTimes(config);
  return { fx, approval, times };
}

/**
 * config: the job (see dockerFence.buildDockerArgv) plus { runtime, kind, timeoutMs, pollMs?, graceMs?,
 * startupGraceMs?, maxBlender?, maxWatchdogFailures? }.
 * deps: { lock } is required (jobLock.acquireJobLock); { spawnFn, dockerFn, ... } only for a simulation.
 * Throws IsolationRefused / Error before anything is started. After the container is started it never throws:
 * it resolves { status, reason, exitCode, cleanup: { verified, attempts, error }, blender, simulated, ... }.
 */
export async function runFenced(config, deps = {}) {
  const { fx, approval, times } = validateLaunch(config, deps);
  const { lock, signal } = deps;
  if (signal?.aborted) throw Object.assign(new Error('aborted before launch: nothing was started'), { name: 'AbortError', code: 'ABORT_ERR' });
  if (!lock || lock.jobId !== config.jobId || typeof lock.isHeld !== 'function' || !lock.isHeld()) {
    throw new IsolationRefused('runFenced needs the held job lock for this job (jobLock.acquireJobLock)');
  }
  const docker = buildDockerArgv(config, { runToken: lock.token, mountAllowlist: fx.simulated ? deps.mountAllowlist : undefined });
  if (docker.containerName !== lock.containerName) throw new IsolationRefused('job lock does not match the container of this run');
  // A link that is already in the job folder could be followed from inside the mount: refuse before starting.
  assertNoLinksInTree(docker.jobDir, 'job folder', { reparseScan: reparseScanFor(fx, deps) });
  clearRunDiagnostics(docker.jobDir);

  // `prevention` is read back from the argv that this function spawns (docker.args), not from a second derivation: it
  // is what the fence actually allowed for THIS run (real container name and run token, env key names, GPUs, mounts).
  const base = { simulated: fx.simulated, approvalId: approval.id, containerName: docker.containerName, prevention: preventionEvidence(docker.args), blender: { ...BLENDER_CAP, peak: 0 } };
  // The approved image must already be on this machine. Nothing is pulled (--pull never), and for a local image id
  // the daemon must report exactly that id.
  try {
    const id = String(await fx.dockerFn(['image', 'inspect', '--format', '{{.Id}}', config.image])).trim();
    if (id !== config.image) throw new Error(`unexpected image id ${JSON.stringify(id.slice(0, 80))}`);
  } catch (e) {
    return { ...base, status: 'image_not_local', reason: String(e?.message ?? e), exitCode: null, started: false, cleanup: { verified: true, attempts: 0, error: null } };
  }

  const { pollMs = 1000, graceMs = 5000, maxWatchdogFailures = 3 } = config;
  const blenderCap = blenderCapFor(approval, config);
  base.blender.max = blenderCap;
  const list = fx.simulated && deps.listProcesses ? deps.listProcesses : async () => parseDockerTop(await fx.dockerFn(['top', docker.containerName]));
  const { spawnFn, dockerFn } = fx;
  const { containerName } = docker;

  return new Promise((resolve) => {
    let settled = false, stopping = false, polling = false, failures = 0, ready = false, clientDone = false, neverStarted = false;
    let child, pollTimer, limitTimer, onClosed, onAbort = () => {};
    let stderrTail = '';
    const startedAt = Date.now();
    const closed = new Promise(r => { onClosed = r; });
    const markClosed = () => { clientDone = true; onClosed(); };
    const clear = () => { clearInterval(pollTimer); clearTimeout(limitTimer); signal?.removeEventListener('abort', onAbort); };

    // Cleanup always runs, and is only believed when `docker ps -a` no longer lists the container. If the process
    // list was never read (the container may not exist YET) or the docker client is still running, a daemon that is
    // still creating the container could bring it up after one "not found": removal must then hold over ~2 s of
    // repeated checks, and a client that will not exit leaves the run unconfirmed (quarantined, never released).
    const finish = async (result) => {
      if (settled) return;
      settled = true;
      clear();
      const opts = (fx.simulated && deps.verify) || {};
      const uncertainStart = (!ready || !clientDone) && !neverStarted;
      const cleanup = await removeAndVerify(dockerFn, containerName, {
        ...opts, stableChecks: uncertainStart ? (opts.stableChecks ?? STABLE_CHECKS) : 0, stableMs: opts.stableMs ?? opts.backoffMs ?? STABLE_MS,
      });
      if (!clientDone && cleanup.verified) {
        cleanup.verified = false;
        cleanup.error = 'the docker client is still running: the container may still be created';
      }
      resolve({ ...base, started: true, watchdogReady: ready, ...result, cleanup });
    };

    const stop = async (status, reason) => {
      if (stopping || settled) return;
      stopping = true;
      clear();
      // Kill, and keep killing while the docker client runs: before the container exists the first kill finds
      // nothing, and the daemon may still create it. A pre-ready "not found" is not "gone".
      const killUntil = Date.now() + graceMs;
      do {
        try { await dockerFn(['kill', containerName]); } catch { /* container may not exist (yet) or already be gone */ }
        if (clientDone) break;
        await Promise.race([closed, sleep(Math.min(KILL_RETRY_MS, graceMs))]);
      } while (!clientDone && Date.now() < killUntil);
      let clientStillRunning = false;
      if (!clientDone) {
        try { child.kill('SIGKILL'); } catch { /* ignore */ }
        await Promise.race([closed, sleep(graceMs)]);
        clientStillRunning = !clientDone;
      }
      await finish({ status, reason, exitCode: null, clientStillRunning });
    };

    try {
      // stdin and stdout stay closed. stderr is read only to keep its last few KB: when generated code crashes, the Python
      // traceback is the one thing that lets the build model fix it (job mwf06gtw-069893, 2026-11-13: abs(Vector) crashed the
      // preview and nothing said why). The text is untrusted: it is only written as a small file beside the job's own files.
      child = spawnFn(docker.command, docker.args, { shell: false, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
      if (child?.stderr && typeof child.stderr.on === 'function') {
        child.stderr.on('data', (chunk) => { stderrTail = (stderrTail + String(chunk)).slice(-STDERR_TAIL_CHARS); });
        child.stderr.on('error', () => { /* a broken pipe only loses the diagnostic */ });
      }
    } catch (e) {
      neverStarted = true; markClosed(); // no docker client exists, so nothing can create the container
      finish({ status: 'spawn_failed', reason: String(e?.message ?? e), exitCode: null });
      return;
    }
    child.on('error', (e) => { if (!stopping) neverStarted = true; markClosed(); if (!stopping) finish({ status: 'spawn_failed', reason: String(e?.message ?? e), exitCode: null }); });
    child.on('close', (code, signal) => {
      markClosed();
      if (code !== 0) saveStderrTail(docker.jobDir, stderrTail);
      if (!stopping) finish({ status: code === 0 ? 'ok' : 'failed', exitCode: code, signal: signal ?? null });
    });

    onAbort = () => { void stop('aborted', 'abort_signal'); };
    if (signal) { if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true }); }
    limitTimer = setTimeout(() => stop('timeout', 'time_limit'), times.timeoutMs);
    pollTimer = setInterval(async () => {
      if (polling || stopping || settled) return;
      polling = true;
      try {
        const seen = countBlenderProcesses(await list());
        ready = true;
        failures = 0;
        base.blender.peak = Math.max(base.blender.peak, seen);
        if (seen > blenderCap) await stop('violation', 'third_blender'); // detect-only: a renamed binary is not counted
      } catch {
        // Before the first successful read the container may simply not exist yet (docker run is still creating
        // it): that is not a watchdog failure. The wait is bounded: no reading within the startup grace stops the job.
        if (!ready) { if (Date.now() - startedAt >= times.startupGraceMs) await stop('startup_timeout', 'watchdog_never_ready'); }
        // Once the process list has been read, losing it means the job runs unwatched: fail closed.
        else if (++failures >= maxWatchdogFailures) await stop('violation', 'watchdog_failed');
      } finally { polling = false; }
    }, pollMs);
  });
}
