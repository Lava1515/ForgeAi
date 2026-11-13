// CB5: composition of the runner for the first real code-built job. Nothing registers this as a route, stage or UI and
// nothing calls it at import time: the dashboard (KAN-931 UI loop) calls composeCodebuiltRunner() when a code-built
// build is started, and it throws LAUNCH_NOT_APPROVED until the activation commit has added the reviewed launch entry.
//
//   selectApprovedLaunch (frozen CB6 approvals only) -> createCb6RunnerAdapter (observation policy) -> createBuildJobRunner
//   + confirmFenceStopped (CB6 reaper and container list) + host output producer (after the container is gone).
//
// Roles stay separate: the planner is the host CLI (subscription login, outside this module and outside the container);
// the generated code runs in the offline container, which gets no credential, no .env and network none.
import path from 'node:path';
import { JOB_ROOT, samePath } from '../../codebuilt/jobPaths.js';
import { hostExecFile } from '../../codebuilt/hostEffects.js';
import { runIsolatedJob as realRunIsolatedJob, reapOrphans as realReapOrphans } from '../../codebuilt/runJob.js';
import { createBuildJobRunner } from './runner.js';
import { createCb6RunnerAdapter } from './cb6Adapter.js';
import { selectApprovedLaunch, GENERATED_EXECUTOR_ID } from './launch.js';
import { createHostOutputProducer } from './producer.js';

/**
 * True only when the fence authoritatively knows that nothing of this job can still be running: the container list was
 * readable, no fenced container is unaccounted for, and this job has no uncertain, manual (live-owner) or busy lock.
 * `busy` is a lock this process holds for a run that is still in progress (reaper.busy is a list of job ids).
 */
export function makeConfirmFenceStopped(reapOrphans, jobRoot) {
  return async function confirmFenceStopped({ jobDir }) {
    const id = path.basename(jobDir).toLowerCase();
    const r = await reapOrphans({ jobRoot });
    if (!r || r.listError || (r.unowned?.length ?? 0) > 0) return false;
    const named = [...(r.uncertain ?? []), ...(r.manual ?? []), ...(r.busy ?? [])].map((x) => String(typeof x === 'string' ? x : x?.jobId ?? '').toLowerCase());
    return !named.includes(id);
  };
}

/**
 * Options: root (must be the CB6 job root for real runs), launchId, inputRoots (absolute read roots for vo.wav, words,
 * path pack), observationPolicy ('prevention-primary' by default, see acceptance.js and docs/codebuilt-cb5-cb6-contract.md).
 * `deps` exists for tests only: runIsolatedJob, reapOrphans, approvals, review, openDecisions, produceOutputs.
 */
export function composeCodebuiltRunner({ root = JOB_ROOT, launchId = GENERATED_EXECUTOR_ID, inputRoots = [], observationPolicy = 'prevention-primary', deps = {} } = {}) {
  const injected = deps.runIsolatedJob !== undefined;
  if (!injected && !samePath(root, JOB_ROOT)) throw new TypeError(`real runs use the fixed CB6 job root ${JOB_ROOT}`);
  const launch = selectApprovedLaunch(launchId, { approvals: deps.approvals, review: deps.review, openDecisions: deps.openDecisions });
  const runIsolatedJob = deps.runIsolatedJob ?? realRunIsolatedJob;
  const reapOrphans = deps.reapOrphans ?? realReapOrphans;
  const adapter = createCb6RunnerAdapter(runIsolatedJob, launch, { observationPolicy });
  const runner = createBuildJobRunner({
    root, inputRoots, runIsolatedJob: adapter, confirmFenceStopped: makeConfirmFenceStopped(reapOrphans, root),
    produceOutputs: deps.produceOutputs ?? createHostOutputProducer({ execFileFn: hostExecFile }),
  });
  return Object.freeze({ runner, launch, observationPolicy });
}
