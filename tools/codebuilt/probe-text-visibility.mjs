// codex · gpt-6.1-sol, 2026-11-15. Approved CPU launcher, normal fence and shared lease.
import fs from 'node:fs';
process.env.FORGEAI_ROOT = 'C:/code/ForgeAi';
const { runIsolatedJob } = await import('../../dashboard/server/episode/codebuilt/runJob.js');
const { selectApprovedLaunch, GENERATED_EXECUTOR_ID } = await import('../../dashboard/server/episode/engines/codebuilt/launch.js');
const jobDir = 'C:/code/ForgeAi/output/agent-jobs/s1-qa-probe-1254';
for (const name of ['build', 'work', 'frames']) fs.mkdirSync(`${jobDir}/${name}`, { recursive: true });
fs.copyFileSync(new URL('./probe-text-visibility.py', import.meta.url), `${jobDir}/build/build.py`);
for (const [name, source] of Object.entries({
  m2: '.start/mwhcfnnw-361e8b/loop/r1/build.py',
  m4: '.start/mwhmj879-5a3396/loop/r1/build.py',
})) fs.copyFileSync(`C:/code/ForgeAi/output/agent-jobs/${source}`, `${jobDir}/build/${name}.py`);
const result = await runIsolatedJob({
  ...selectApprovedLaunch(GENERATED_EXECUTOR_ID), runtime: 'docker',
  jobId: 's1-qa-probe-1254', jobDir,
  limits: { memoryMb: 2048, cpus: 1, pids: 256 }, timeoutMs: 120000, gpuWaitMs: 1000,
});
fs.writeFileSync(`${jobDir}/work/fence.json`, JSON.stringify(result, null, 2));
console.log(JSON.stringify({ status: result.status, started: result.started, cleanup: result.cleanup }));
if (!result.started || result.run?.exitCode !== 0 || !result.cleanup?.verified) process.exitCode = 1;

