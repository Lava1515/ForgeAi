// Device enumeration of the GPU executor image through the REAL fence argv (dockerFence.buildDockerArgv). It runs a build script
// that only prints a line, so nothing is rendered; what it proves is what Blender itself saw: /job/work/gpu.json written by
// /opt/forge/entry_gpu.py (selected device type, enabled devices, the GL renderer EEVEE would get).
// It takes the one GPU lock (.superpowers/supervisor/gpu.lock, a mkdir mutex) for the few seconds it runs and releases it.
//   node tools/codebuilt/generated-executor-image/enumerate-gpu.mjs [--image sha256:...] [--digest-only]
// Exit 0: a CUDA or OptiX device was selected. Exit 1: not. Exit 2: usage/precondition.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const mod = (rel) => import(pathToFileURL(path.join(repo, rel)).href);
const { APPROVED_LAUNCHES } = await mod('dashboard/server/episode/codebuilt/policy.js');
const { buildDockerArgv } = await mod('dashboard/server/episode/codebuilt/dockerFence.js');
const { JOB_ROOT } = await mod('dashboard/server/episode/codebuilt/jobPaths.js');
const { KIT_SRC, KIT_MOUNT_DST, GENERATED_GPU_EXECUTOR_ID } = await mod('dashboard/server/episode/engines/codebuilt/launch.js');

const entry = APPROVED_LAUNCHES.find((e) => e.id === GENERATED_GPU_EXECUTOR_ID);
const args = process.argv.slice(2);
const image = args.includes('--image') ? args[args.indexOf('--image') + 1] : entry.image;
const LOCK = 'C:/code/ForgeAi/.superpowers/supervisor/gpu.lock';

const local = spawnSync('docker', ['image', 'inspect', image, '--format', '{{.Id}}'], { encoding: 'utf8' });
const localId = local.status === 0 ? local.stdout.trim() : null;
console.log(JSON.stringify({ policyImage: entry.image, requestedImage: image, localImageId: localId, digestMatchesPolicy: localId === entry.image }));
if (localId !== image) { console.error('the local image id does not match'); process.exit(2); }
if (args.includes('--digest-only')) process.exit(localId === entry.image ? 0 : 1);

const jobId = 'gpu-enum';
const jobDir = path.join(JOB_ROOT, jobId);
for (const d of ['build', 'home', 'tmp', 'work', 'frames']) fs.mkdirSync(path.join(jobDir, d), { recursive: true });
fs.writeFileSync(path.join(jobDir, 'build', 'build.py'), 'print("gpu-enum: build script reached, nothing is rendered")\n');
fs.rmSync(path.join(jobDir, 'work', 'gpu.json'), { force: true });
const { args: dockerArgs } = buildDockerArgv({
  jobId, jobDir, image, command: [...entry.command], gpu: { device: '0' }, limits: { ...entry.limits },
  readonlyMounts: [{ src: KIT_SRC, dst: KIT_MOUNT_DST }],
}, { runToken: 'e0e0e0e0e0e0' });

try { fs.mkdirSync(LOCK); fs.writeFileSync(path.join(LOCK, 'owner'), `gpu-enum ${new Date().toISOString()}\n`); } catch { console.error('GPU lock is held; not running'); process.exit(2); }
let run;
try { run = spawnSync('docker', dockerArgs, { encoding: 'utf8', timeout: 180000 }); } finally { fs.rmSync(LOCK, { recursive: true, force: true }); }
let evidence = null;
try { evidence = JSON.parse(fs.readFileSync(path.join(jobDir, 'work', 'gpu.json'), 'utf8')); } catch { /* none written */ }
console.log(JSON.stringify({ exit: run.status, gpu: evidence }, null, 1));
process.exit(run.status === 0 && evidence?.ok === true && evidence.enabled?.length > 0 ? 0 : 1);
