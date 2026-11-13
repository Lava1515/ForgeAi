import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Prefer the host's existing data, then the Docker mount, then this checkout's data.
const REPO_RELATIVE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../data/worlds');
const CANDIDATES = [path.join('C:\\', 'code', 'ForgeAi', 'data', 'worlds'), '/forgeai/data/worlds', REPO_RELATIVE];

export function resolveWorldsDir(env = process.env, candidates = CANDIDATES) {
  if (env.FORGEAI_WORLDS_DIR) return env.FORGEAI_WORLDS_DIR;
  return candidates.find((dir) => fs.existsSync(dir)) || candidates.at(-1);
}

export function generatedKitPath(id, worldsDir = resolveWorldsDir()) {
  if (typeof id !== 'string' || !id.startsWith('gen_') || !/^[A-Za-z0-9_-]+$/.test(id)) return null;
  return path.join(worldsDir, 'generated_kits', `${id}.json`);
}
