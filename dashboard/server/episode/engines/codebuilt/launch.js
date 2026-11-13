// CB5: the only way a launch for the runner is chosen. Trusted composition code calls selectApprovedLaunch with the id of
// an entry in CB6's frozen APPROVED_LAUNCHES; a job request has no say in image, command, limits or mounts.
//
// GENERATED_EXECUTOR_CANDIDATE is the shape of the one entry that will let the first real code-built job run: the fixed
// launcher of the generated-code executor image (tools/codebuilt/generated-executor-image). It carries NO image and NO
// review. Both come from the activation commit, which adds exactly this entry (candidateEntry) to APPROVED_LAUNCHES and
// flips SECURITY_REVIEW, only after the image is built and its launch is independently security reviewed. Until then
// selectApprovedLaunch throws LAUNCH_NOT_APPROVED, so nothing here can start a container.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { APPROVED_LAUNCHES, SECURITY_REVIEW, OPEN_OWNER_DECISIONS, GENERATED_KIND, BLENDER_CAP_ACK, GENERATED_CODE_ACK, checkApproval } from '../../codebuilt/policy.js';
import { READONLY_MOUNT_ALLOWLIST } from '../../codebuilt/dockerFence.js';
import { CodebuiltError } from './errors.js';

export const GENERATED_EXECUTOR_ID = 'cb6-generated-blender-v1';
export const GENERATED_GPU_EXECUTOR_ID = 'cb6-generated-blender-gpu-v1';
export const KIT_MOUNT_DST = '/kit/blender_worker/codebuilt'; // generated code imports blender_worker.codebuilt with /kit on sys.path
export const KIT_SRC = READONLY_MOUNT_ALLOWLIST[0];

/** Template of the approved entry. `image` and `review` are the two things the activation commit fills in. */
export const GENERATED_EXECUTOR_CANDIDATE = Object.freeze({
  id: GENERATED_EXECUTOR_ID,
  kind: GENERATED_KIND,
  command: Object.freeze(['/opt/forge/blender-generated']),
  gpu: false, // CPU only: the GPU launcher is its own entry, GENERATED_GPU_EXECUTOR_CANDIDATE
  blender: Object.freeze({ max: 2 }),
  limits: Object.freeze({ memoryMb: 8192, cpus: 12, pids: 512 }),
  acknowledges: Object.freeze([BLENDER_CAP_ACK, GENERATED_CODE_ACK]),
});

/**
 * The GPU twin: same image recipe, a second fixed launcher (`blender-generated-gpu`) whose entry script selects the CUDA/OptiX device and
 * exits 3 without one. One GPU only (the fence passes `--gpus device=0`), and the run takes the single GPU lease like every GPU job.
 */
export const GENERATED_GPU_EXECUTOR_CANDIDATE = Object.freeze({
  ...GENERATED_EXECUTOR_CANDIDATE,
  id: GENERATED_GPU_EXECUTOR_ID,
  command: Object.freeze(['/opt/forge/blender-generated-gpu']),
  gpu: true,
});

/** The complete approved entry for one built image. Used by the activation commit and by tests; does not approve anything itself. */
export function candidateEntry({ image, reviewer, ref }, template = GENERATED_EXECUTOR_CANDIDATE) {
  return {
    ...template, command: [...template.command], blender: { ...template.blender },
    limits: { ...template.limits }, acknowledges: [...template.acknowledges],
    image, review: { reviewer, ref },
  };
}

/**
 * The launch for the adapter, taken from an approved entry and re-checked with the policy's own gate (kind, review,
 * acknowledgements, limits). `approvals`, `review` and `openDecisions` default to the frozen constants; they are
 * parameters only so tests can exercise a hypothetical activation. Throws CodebuiltError LAUNCH_NOT_APPROVED.
 */
export function selectApprovedLaunch(id, { approvals = APPROVED_LAUNCHES, review = SECURITY_REVIEW, openDecisions = OPEN_OWNER_DECISIONS, kitSrc = KIT_SRC } = {}) {
  const entry = (Array.isArray(approvals) ? approvals : []).find((e) => e && e.id === id);
  if (!entry) throw new CodebuiltError('LAUNCH_NOT_APPROVED', `no approved launch with id ${JSON.stringify(id)}`);
  if (entry.kind !== GENERATED_KIND && entry.kind !== 'stub') throw new CodebuiltError('LAUNCH_NOT_APPROVED', `launch ${id} has kind ${entry.kind}; only stub and generated-code launches can be selected here`);
  if (!entry.limits || typeof entry.limits !== 'object') throw new CodebuiltError('LAUNCH_NOT_APPROVED', `launch ${id} states no limits`);
  const request = { kind: entry.kind, runtime: 'docker', image: entry.image, command: [...entry.command], gpu: Boolean(entry.gpu), network: 'none', limits: { ...entry.limits } };
  try { checkApproval(request, approvals, review, openDecisions); } catch (error) {
    throw new CodebuiltError('LAUNCH_NOT_APPROVED', `launch ${id} is refused by the policy: ${String(error?.message ?? error).slice(0, 240)}`);
  }
  return {
    kind: entry.kind, image: entry.image, command: [...entry.command], gpu: Boolean(entry.gpu), limits: { ...entry.limits },
    ...(entry.kind === GENERATED_KIND ? { readonlyMounts: [{ src: path.resolve(kitSrc), dst: KIT_MOUNT_DST }] } : {}),
  };
}

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
