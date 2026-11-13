// Host dashboard launcher for the code-built path (KAN-931).
// Why host, not Docker: CB6 policy uses fixed Windows C:/code paths plus host Docker and Python, which a Linux
// dashboard container cannot compose. This starts only createApp() on 127.0.0.1; it never loads index.js, so the
// YouTube releaseDue timer (publishing) is not armed and nothing is scheduled or created on start.
// It reads no env files, prints no secrets and copies no credentials: it only points the existing CLI homes at
// directories that already hold the logins.
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_PORT = 3000;
export const DEFAULT_FACTORY_URL = 'http://127.0.0.1:5050';

const norm = (p) => path.resolve(p).replace(/\\/g, '/');

// The runtime root is the repo root of the script (not a worktree). A worktree checkout must name the production
// root explicitly with --root or FORGEAI_PRODUCTION_ROOT, because data/, output/ and the CLI logins live there.
export function resolveRoot({ root, env = process.env, scriptDir = HERE } = {}) {
  const explicit = root || env.FORGEAI_PRODUCTION_ROOT;
  if (explicit) return norm(explicit);
  const derived = norm(path.join(scriptDir, '..', '..'));
  let linkedCheckout = false;
  try { linkedCheckout = fs.statSync(path.join(derived, '.git')).isFile(); } catch { /* absent metadata */ }
  if (linkedCheckout || /\/\.t3\/worktrees\/|\/\.claude\/worktrees\//i.test(derived)) {
    throw new Error('This script runs from a worktree; pass --root <production repo root> or set FORGEAI_PRODUCTION_ROOT.');
  }
  return derived;
}

// Pure: the env this launcher sets, all paths under the root. Does not touch process.env.
export function buildEnv(root, { factoryUrl = DEFAULT_FACTORY_URL } = {}) {
  const r = norm(root);
  return {
    FORGEAI_ROOT: r,
    FORGEAI_AGENT_JOBS_DIR: `${r}/output/agent-jobs`,
    FORGEAI_DRAFTS_DIR: `${r}/output/drafts`,
    CLAUDE_HOME: `${r}/data/claude`,
    CLAUDE_CONFIG_DIR: `${r}/data/claude/.claude`, // the Windows CLI needs this to find its existing login
    AGY_HOME: `${r}/data/agy`,
    TTS_URL: factoryUrl,
    NARRATIVE_FACTORY_URL: factoryUrl,
  };
}

export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--root') out.root = argv[++i];
    else if (a === '--port') out.port = Number(argv[++i]);
    else if (a === '--factory-url') out.factoryUrl = argv[++i];
    else if (a === '--help' || a === '-h') out.help = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  return out;
}

// Options are injectable for tests: importApp, apply (env sink), exists, log. The host is fixed to loopback.
export async function startHostDashboard(opts = {}) {
  const {
    port = DEFAULT_PORT, factoryUrl = DEFAULT_FACTORY_URL, env = process.env,
    exists = fs.existsSync, log = console.log,
    importApp = (file) => import(pathToFileURL(file).href),
    apply = (vars) => Object.assign(process.env, vars),
  } = opts;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Bad port: ${port}`);
  const root = resolveRoot({ root: opts.root, env, scriptDir: opts.scriptDir });
  const vars = buildEnv(root, { factoryUrl });
  const appFile = `${root}/dashboard/server/app.js`;
  for (const dir of [vars.CLAUDE_CONFIG_DIR, vars.AGY_HOME, vars.FORGEAI_AGENT_JOBS_DIR, vars.FORGEAI_DRAFTS_DIR]) {
    if (!exists(dir)) throw new Error(`Required existing path is missing: ${dir}`); // never created or filled here
  }
  if (!exists(appFile)) throw new Error(`Dashboard app not found: ${appFile}`);
  apply(vars); // before the import: server modules read these at load time
  const { createApp } = await importApp(appFile);
  const app = createApp();
  return new Promise((resolve, reject) => {
    const server = app.listen(port, DEFAULT_HOST, () => {
      log(`Host dashboard ready on http://${DEFAULT_HOST}:${port} (root ${root}); no release timer, no scheduled creation`);
      resolve({ server, root, env: vars });
    });
    if (server && typeof server.on === 'function') server.on('error', reject);
  });
}

const HELP = `Usage: node scripts/supervisor/start_codebuilt_dashboard.mjs [--root <repo root>] [--port 3000] [--factory-url ${DEFAULT_FACTORY_URL}]`;

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) console.log(HELP);
    else await startHostDashboard(args);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
