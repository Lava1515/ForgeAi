// claude-pro · claude-sonnet-5-5, 2026-11-15. V1 diagram probe: approved CPU generated-code executor, normal job lock, resource limits,
// watchdog and verified container cleanup. Differences from probe-text-visibility.mjs: it mounts the kit of THIS checkout (the branch kit with
// diagram.py) and writes only to its own folder under the fixed shared job root.
// It requests no GPU and never renders or saves a scene. It still takes the shared GPU lease (the executor approval always does), so run it
// only when no video run holds the lease: with gpuWaitMs 1000 it returns status gpu_unavailable without starting a container while a run does.
//
//   node tools/codebuilt/v1-diagram-probe/run-probe.mjs        (from the checkout root)
// Result: <job dir>/work/diagram.json (measurements) and work/fence.json (executor evidence). Exit code 1 when the container did not exit 0.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.FORGEAI_ROOT = 'C:/code/ForgeAi'; // the shared lease directory of the real runs
const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');
const { runIsolatedJob } = await import(new URL('../../../dashboard/server/episode/codebuilt/runJob.js', import.meta.url));
const { selectApprovedLaunch, GENERATED_EXECUTOR_ID } = await import(new URL('../../../dashboard/server/episode/engines/codebuilt/launch.js', import.meta.url));

const jobRoot = path.join(process.env.FORGEAI_ROOT, 'output', 'agent-jobs');
const jobDir = path.join(jobRoot, 'v1-readable-diagrams-probe');
for (const name of ['build', 'work', 'frames']) fs.mkdirSync(path.join(jobDir, name), { recursive: true });
fs.copyFileSync(path.join(here, 'probe.py'), path.join(jobDir, 'build', 'build.py'));
const result = await runIsolatedJob({
  ...selectApprovedLaunch(GENERATED_EXECUTOR_ID), runtime: 'docker',
  jobId: 'v1-readable-diagrams-probe', jobDir, jobRoot,
  limits: { memoryMb: 2048, cpus: 1, pids: 256 }, timeoutMs: 120000, gpuWaitMs: 1000,
});
fs.writeFileSync(path.join(jobDir, 'work', 'fence.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify({ status: result.status, started: result.started, exitCode: result.run?.exitCode, cleanup: result.cleanup }));
if (!result.started || result.run?.exitCode !== 0 || !result.cleanup?.verified) process.exitCode = 1;
