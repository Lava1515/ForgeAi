import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = process.env.FORGEAI_ROOT || path.resolve(__dirname, '../../../');

export function growthFile(channelId = 'default', repoRoot = DEFAULT_REPO_ROOT) {
  const id = String(channelId || 'default');
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`Invalid channel ID: ${id}`);
  return path.join(repoRoot, 'data/growth', `${id}.json`);
}
