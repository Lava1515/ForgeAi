// claude-pro · claude-sonnet-5-5, 2026-11-15 (lane M5p). Fenced CPU launcher for probe-stealth-jet-teardown.py.
// Usage (from the checkout):  node tools/codebuilt/probe-stealth-jet-teardown.mjs <label> [probe-stealth-jet-camera-search]
// The job folder is C:/code/ForgeAi/output/agent-jobs/m5p-stealth-<label> (the fence only accepts a direct child of the
// job root). The kit mounted read-only into the container is THIS checkout's blender_worker/codebuilt (dockerFence takes it
// from the location of the imported module), never main's. Normal fence: approved CPU executor image, no network, no GPU
// requested, 1 CPU, 2 GiB, job lock, watchdog, verified cleanup. Nothing renders and no scene is saved.
// Evidence is copied into <checkout>/output/agent-jobs/m5p-stealth-teardown/<label>/ .
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.FORGEAI_ROOT = 'C:/code/ForgeAi'; // shared GPU lease and job locks live under main's .superpowers
const label = process.argv[2];
if (!/^[a-z0-9][a-z0-9-]{0,30}$/.test(label ?? '')) { console.error('usage: node probe-stealth-jet-teardown.mjs <label>'); process.exit(2); }
const here = path.dirname(fileURLToPath(import.meta.url));
const probeName = process.argv[3] ?? 'probe-stealth-jet-teardown';
if (!/^probe-stealth-jet-[a-z-]+$/.test(probeName)) { console.error('probe name must be probe-stealth-jet-*'); process.exit(2); }
const checkout = path.resolve(here, '../..');
const { runIsolatedJob } = await import('../../dashboard/server/episode/codebuilt/runJob.js');
const { selectApprovedLaunch, GENERATED_EXECUTOR_ID, KIT_SRC } = await import('../../dashboard/server/episode/engines/codebuilt/launch.js');
if (path.resolve(KIT_SRC).toLowerCase() !== path.join(checkout, 'blender_worker', 'codebuilt').toLowerCase()) {
  console.error(`kit source is ${KIT_SRC}, not this checkout; refusing`); process.exit(2);
}
const jobId = `m5p-stealth-${label}`;
const jobDir = `C:/code/ForgeAi/output/agent-jobs/${jobId}`;
for (const name of ['build', 'work', 'frames']) fs.mkdirSync(`${jobDir}/${name}`, { recursive: true });
fs.copyFileSync(path.join(here, `${probeName}.py`), `${jobDir}/build/build.py`);
const result = await runIsolatedJob({
  ...selectApprovedLaunch(GENERATED_EXECUTOR_ID), runtime: 'docker',
  jobId, jobDir,
  limits: { memoryMb: 2048, cpus: 1, pids: 256 }, timeoutMs: 180000, gpuWaitMs: 1000,
});
fs.writeFileSync(`${jobDir}/work/fence.json`, JSON.stringify(result, null, 2));
const evidence = path.join(checkout, 'output', 'agent-jobs', 'm5p-stealth-teardown', label);
fs.mkdirSync(evidence, { recursive: true });
for (const f of ['fence.json', 'executor.json', 'teardown_probe.json', 'camera_search.json']) {
  if (fs.existsSync(`${jobDir}/work/${f}`)) fs.copyFileSync(`${jobDir}/work/${f}`, path.join(evidence, f));
}
console.log(JSON.stringify({ status: result.status, started: result.started, exit: result.run?.exitCode, cleanup: result.cleanup, evidence }));
if (!result.started || result.run?.exitCode !== 0 || !result.cleanup?.verified) process.exitCode = 1;
