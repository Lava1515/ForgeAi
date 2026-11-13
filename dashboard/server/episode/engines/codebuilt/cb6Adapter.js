// CB5 -> CB6 call-shape adapter. Callers inject the committed runIsolatedJob export and a selected launch.
// CB6 owns its job lock and GPU lease. Do not wrap this call in CB5's withGpu dependency.
// The selected launch is the ONLY source of image, command, GPU use, limits and mounts: the job request supplies none of
// them. CB6's frozen approval list still decides at the execution boundary, whatever this adapter sends.
import path from 'node:path';
import { applyObservationPolicy, OBSERVATION_POLICIES } from './acceptance.js';

export const ADAPTER_KINDS = Object.freeze(['stub', 'generated-code']);
const MOUNT_DST_RE = /^\/[A-Za-z0-9._/-]+$/;

function checkMounts(mounts) {
  if (mounts === undefined) return undefined;
  if (!Array.isArray(mounts) || mounts.some((m) => !m || typeof m.src !== 'string' || !path.isAbsolute(m.src) || typeof m.dst !== 'string' || !MOUNT_DST_RE.test(m.dst))) {
    throw new TypeError('readonlyMounts must be a list of { src: absolute path, dst: absolute container path }');
  }
  return mounts.map((m) => ({ src: m.src, dst: m.dst }));
}

/**
 * Translate CB5's job-folder call into the current CB6 runIsolatedJob contract.
 * `launch`: { kind: 'stub' | 'generated-code', image, command, gpu, limits, readonlyMounts? } chosen by trusted
 * composition code (launch.js), never by the job request. No secret values, test effects or leak-scan exemption are
 * forwarded. `observationPolicy` ('strict' | 'prevention-primary') decides whether an audit_incomplete report whose only
 * gaps are in the supplementary host snapshot is accepted (acceptance.js); the default keeps today's strict behaviour.
 */
// The one GPU of this PC. Not configurable by a job.
export const GPU_DEVICE = '0';

export function createCb6RunnerAdapter(runIsolatedJob, launch, { observationPolicy = 'strict' } = {}) {
  if (typeof runIsolatedJob !== 'function') throw new TypeError('runIsolatedJob must be a function');
  if (!OBSERVATION_POLICIES.includes(observationPolicy)) throw new TypeError(`observationPolicy must be one of ${OBSERVATION_POLICIES.join(', ')}`);
  if (!launch || !ADAPTER_KINDS.includes(launch.kind) || typeof launch.image !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(launch.image)
      || !Array.isArray(launch.command) || !launch.command.length || launch.command.some(v => typeof v !== 'string' || !v)
      || typeof launch.gpu !== 'boolean' || !launch.limits || typeof launch.limits !== 'object') {
    throw new TypeError('a selected stub or generated-code launch with image, command, gpu and limits is required');
  }
  const selected = {
    kind: launch.kind, image: launch.image, command: [...launch.command], gpu: launch.gpu, limits: { ...launch.limits },
    readonlyMounts: checkMounts(launch.readonlyMounts),
  };

  return function runCb6Job(config, deps = {}) {
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw new TypeError('CB5 fence config must be an object');
    if (config.kind !== selected.kind) throw new TypeError(`CB6 adapter was composed for ${selected.kind} jobs; got ${JSON.stringify(config.kind)}`);
    if (typeof config.jobDir !== 'string' || !path.isAbsolute(config.jobDir)) throw new TypeError('jobDir must be absolute');
    if (config.jobDir.split(/[\\/]/).includes('..')) throw new TypeError('jobDir may not contain .. segments');
    if (typeof config.timeoutMs !== 'number' || !Number.isFinite(config.timeoutMs) || config.timeoutMs <= 0) throw new TypeError('timeoutMs must be positive');

    const jobDir = path.resolve(config.jobDir);
    const jobRoot = path.dirname(jobDir);
    const jobId = path.basename(jobDir);
    if (!jobId || jobDir === jobRoot || path.resolve(jobRoot, jobId) !== jobDir) throw new TypeError('jobDir must be one direct child of the CB6 job root');

    // CB6 runIsolatedJob validates runtime, jobRoot/jobId, exact launch approval and its own GPU lease.
    // Passing withGpu would be ignored by CB6 (and could invite an accidental nested lease), so only signal crosses.
    return Promise.resolve().then(() => runIsolatedJob({
      jobDir,
      jobRoot,
      jobId,
      kind: selected.kind,
      runtime: 'docker',
      timeoutMs: config.timeoutMs,
      image: selected.image,
      command: [...selected.command],
      gpu: selected.gpu ? { device: GPU_DEVICE } : false, // the fence builds `--gpus device=0`; no other device can be asked for
      limits: { ...selected.limits },
      useGpuQueue: selected.gpu,
      ...(selected.readonlyMounts ? { readonlyMounts: selected.readonlyMounts.map((m) => ({ ...m })) } : {}),
    }, { signal: deps.signal })).then((report) => applyObservationPolicy(report, { policy: observationPolicy, expectGpu: selected.gpu }));
  };
}
