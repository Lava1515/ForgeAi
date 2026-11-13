import fs from 'node:fs';
import path from 'node:path';
import { assertJobDirSafe, assertRealDir, assertJobId } from './jobPaths.js';

// Locks are outside container mounts. Uncertain cleanup forbids both reuse reads and host receipt writes.
export function jobWriteBlockedReason(jobsDir, id) {
  assertJobId(id);
  const directory = path.join(jobsDir, '.cb6-locks');
  try {
    try { fs.lstatSync(directory); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    assertRealDir(directory, 'lock directory');
    if (fs.readdirSync(directory).some(name => name === `${id}.lock` ||
      (name.startsWith(`${id}-pv`) && /^\d+\.lock$/.test(name.slice(id.length + 3))))) {
      return 'Job or preview lock is held; cleanup must be confirmed before resuming';
    }
    return null;
  } catch { return 'Job lock directory is unreadable; cleanup must be confirmed before resuming'; }
}

export function writeHostJobReceipt(jobsDir, id, name, bytes) {
  assertJobId(id);
  if (!['cost_calls.json', 'visual_loop.json'].includes(name)) throw new Error('Invalid host receipt');
  const blocked = jobWriteBlockedReason(jobsDir, id);
  if (blocked) throw new Error(blocked);
  const directory = assertJobDirSafe(path.resolve(jobsDir, id), { jobRoot: jobsDir });
  const target = path.join(directory, name);
  try { fs.lstatSync(target); fs.unlinkSync(target); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  // Do not follow a planted leaf. The container must already be gone and its lock released.
  fs.writeFileSync(target, bytes, { flag: 'wx' });
}
