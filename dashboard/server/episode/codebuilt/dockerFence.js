// CB6: builds the `docker run` argv for one job. Pure function: it starts nothing.
// The container is the fence: read-only root filesystem, the job folder as the single writable bind mount,
// no repo / .env / socket mounts, no inherited environment, dropped capabilities, resource limits, no network,
// a content-addressed local image that is never pulled.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JOB_ROOT, assertJobDirSafe, assertJobId, assertRealDir, assertNoLinksInTree, samePath } from './jobPaths.js';
import { buildJobEnv } from './jobEnv.js';
import { IMAGE_REF_RE, IsolationRefused } from './policy.js';

export const CONTAINER_JOB_DIR = '/job';
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
// The complete list of host folders a job may see read-only. Today: the engine kit (code only). Nothing else on the
// host can be mounted, whatever its name. Adding a folder is a reviewed code change here.
export const READONLY_MOUNT_ALLOWLIST = Object.freeze([path.join(REPO_ROOT, 'blender_worker', 'codebuilt')]);
const RUN_TOKEN_RE = /^[a-f0-9]{12}$/;

/** One container name per run. A second run of the same job gets another name, so cleanup can only remove its own container. */
export function containerNameFor(jobId, runToken) {
  assertJobId(jobId);
  if (typeof runToken !== 'string' || !RUN_TOKEN_RE.test(runToken)) throw new Error(`run token must be 12 hex characters, got ${JSON.stringify(runToken)}`);
  return `forgeai-cb6-${jobId}-${runToken}`;
}

export const DEFAULT_LIMITS = Object.freeze({ memoryMb: 8192, cpus: 4, pids: 512 });
const LIMIT_BOUNDS = { memoryMb: [256, 65536, true], cpus: [0.5, 32, false], pids: [16, 4096, true] };

const BAD_PATH_CHARS = /[,"'\r\n\u0000=]/;

// Tags are mutable and can be re-pointed or pulled; only a sha256 content address names one exact image.
function checkImage(image) {
  if (typeof image !== 'string' || !IMAGE_REF_RE.test(image)) {
    throw new Error(`image must be a sha256 content address (sha256:<id> or name@sha256:<digest>), tags are refused: ${JSON.stringify(image)}`);
  }
  return image;
}

function checkLimits(over = {}) {
  const out = {};
  for (const [k, [lo, hi, integer]] of Object.entries(LIMIT_BOUNDS)) {
    const v = over[k] ?? DEFAULT_LIMITS[k];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi || (integer && !Number.isInteger(v))) {
      throw new Error(`limit ${k} must be ${integer ? 'an integer' : 'a number'} from ${lo} to ${hi}, got ${JSON.stringify(v)}`);
    }
    out[k] = v;
  }
  return out;
}

function checkDst(dst) {
  if (typeof dst !== 'string' || !/^\/[A-Za-z0-9._/-]+$/.test(dst) || dst.includes('..') || dst.endsWith('/')) {
    throw new Error(`mount dst must be a clean absolute container path: ${JSON.stringify(dst)}`);
  }
  if (dst === CONTAINER_JOB_DIR || dst.startsWith(`${CONTAINER_JOB_DIR}/`) || /^\/(proc|sys|dev|etc|root|tmp)(\/|$)/.test(dst)) {
    throw new Error(`mount dst may not overlap the job folder or system paths: ${dst}`);
  }
  return dst;
}

/**
 * A read-only bind mount. The source must be an existing real directory, written by its real path (no symlink,
 * junction or 8.3 alias in any component), that IS one of the allowlisted folders, and the folder may not contain
 * links. Everything else on the host is refused, so there is no list of "bad" names to get around.
 * The mount uses the resolved real path.
 */
export function validateReadonlyMount({ src, dst } = {}, { allowlist = READONLY_MOUNT_ALLOWLIST } = {}) {
  checkDst(dst);
  if (typeof src !== 'string' || !path.isAbsolute(src)) throw new Error(`mount src must be an absolute path (refused): ${src}`);
  if (BAD_PATH_CHARS.test(src)) throw new Error(`mount src contains a character not allowed in a mount (refused): ${src}`);
  let real;
  try { real = assertRealDir(src, 'mount src'); } catch (e) { throw new Error(`${e.message} (refused)`); }
  const allowed = allowlist.some((a) => {
    try { return samePath(assertRealDir(a, 'allowlisted mount'), real); } catch { return false; }
  });
  if (!allowed) throw new Error(`mount src is not on the read-only mount allowlist (refused): ${src}`);
  if (BAD_PATH_CHARS.test(real)) throw new Error(`mount src contains a character not allowed in a mount (refused): ${real}`);
  try { assertNoLinksInTree(real, 'mount src'); } catch (e) { throw new Error(`${e.message} (refused)`); }
  return `type=bind,src=${real},dst=${dst},readonly`;
}

// Network egress for the agent is an open owner decision (a bridge network reaches the host gateway and the LAN,
// and no egress filter exists). Until it is decided and built, only "none" can be asked for.
function networkMode(network) {
  if (network === undefined || network === 'none') return 'none';
  throw new IsolationRefused(`network must be "none": unfiltered egress is not available (open owner decision), got ${JSON.stringify(network)}`);
}

function gpuArg(gpu) {
  if (gpu === undefined || gpu === null || gpu === false) return null;
  const d = gpu.device;
  if (typeof d !== 'string' || !/^([0-9]+|GPU-[0-9a-fA-F-]+)$/.test(d)) throw new Error(`gpu device must be an index or GPU-uuid, got ${JSON.stringify(d)}`);
  return `device=${d}`;
}

/**
 * config: { jobId, jobDir, image, command: string[], jobRoot?, limits?, network?, gpu?, readonlyMounts?, env? }
 * options: { runToken (12 hex, names the container), mountAllowlist? }
 * returns { command: 'docker', args, containerName, jobDir }; jobDir is the resolved real path that is mounted.
 * This validates and builds only. Whether the launch is approved is decided in processGuard.runFenced.
 */
export function buildDockerArgv(config, { runToken, mountAllowlist } = {}) {
  const { jobId, image, command, jobRoot = JOB_ROOT } = config ?? {};
  assertJobId(jobId);
  const containerName = containerNameFor(jobId, runToken);
  const jobDir = assertJobDirSafe(config.jobDir, { jobRoot });
  if (path.basename(jobDir).toLowerCase() !== jobId.toLowerCase()) throw new Error(`job id does not match the job folder name: ${jobId} vs ${path.basename(jobDir)}`);
  if (BAD_PATH_CHARS.test(jobDir)) throw new Error(`job dir contains a character not allowed in a mount: ${jobDir}`);
  checkImage(image);
  if (!Array.isArray(command) || command.length === 0 || command.some(c => typeof c !== 'string' || c === '' || /[\u0000\r\n]/.test(c))) {
    throw new Error('command must be a non-empty argv array of strings (no shell string)');
  }
  const limits = checkLimits(config.limits);
  const net = networkMode(config.network);
  const gpu = gpuArg(config.gpu);
  const extraMounts = (config.readonlyMounts ?? []).map(m => validateReadonlyMount(m, mountAllowlist ? { allowlist: mountAllowlist } : {}));
  const env = buildJobEnv({ jobDir: CONTAINER_JOB_DIR, jobId, extra: config.env });

  const args = [
    'run', '--pull', 'never', '--rm', '--init', '--name', containerName,
    '--label', 'forgeai.fence=cb6',
    '--read-only',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--ipc', 'private',
    '--network', net,
    '--memory', `${limits.memoryMb}m`, '--memory-swap', `${limits.memoryMb}m`,
    '--cpus', String(limits.cpus), '--pids-limit', String(limits.pids),
    '--ulimit', 'nofile=4096:4096',
    '--user', '1000:1000',
    '--tmpfs', '/tmp:rw,noexec,nosuid,size=1024m',
    '--workdir', CONTAINER_JOB_DIR,
  ];
  if (gpu) args.push('--gpus', gpu);
  args.push('--mount', `type=bind,src=${jobDir},dst=${CONTAINER_JOB_DIR}`);
  for (const m of extraMounts) args.push('--mount', m);
  for (const [k, v] of Object.entries(env)) args.push('-e', `${k}=${v}`);
  args.push(image, ...command);
  return { command: 'docker', args, containerName, jobDir };
}
