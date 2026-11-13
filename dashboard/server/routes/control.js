import { adminAuthorized, auditDenied } from '../middleware/auth.js';
import { getActiveRuns, getRecentTasks } from './runs.js';
import { getLastGeminiFallback, clearLastGeminiFallback } from './gemini.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = process.env.FORGEAI_ROOT || path.resolve(__dirname, '../../../');
const STATE_FILE = process.env.FORGEAI_STATE_FILE || path.join(REPO_ROOT, 'data/pipeline_state.json');

const N8N_BASE_URL = process.env.N8N_URL || 'http://localhost:5678';
const N8N_CONTROL_URL = `${N8N_BASE_URL}/webhook/forgeai/control`;
const N8N_STATUS_URL = `${N8N_BASE_URL}/webhook/forgeai/status`;
const COMFYUI_URL = process.env.COMFYUI_URL || 'http://localhost:8188';

const killHooks = new Set();

/**
 * Register a callback to execute immediately when the kill switch is triggered.
 * Returns an unregister function.
 */
export function isHttpUrl(value) {
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

// Worker URLs (tts_url, comfyui_url) may be loopback, compose names, host.docker.internal or a private LAN address, but never a
// link-local or cloud-metadata target: those would receive the X-TTS-Token. WHATWG parsing already turns decimal/hex/octal IPv4
// into dotted form; IPv4-mapped IPv6 is unwrapped here.
const METADATA_NAMES = new Set(['metadata', 'metadata.google.internal', 'metadata.goog', 'instance-data', 'instance-data.ec2.internal', 'metadata.tencentyun.com']);
export function isBlockedWorkerHost(hostname) {
  let h = String(hostname).toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  const mapped = h.match(/^::ffff:(?:(\d+\.\d+\.\d+\.\d+)|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/);
  if (mapped) {
    h = mapped[1] || [parseInt(mapped[2], 16) >> 8, parseInt(mapped[2], 16) & 255, parseInt(mapped[3], 16) >> 8, parseInt(mapped[3], 16) & 255].join('.');
  }
  return METADATA_NAMES.has(h)
    || /^169\.254\./.test(h) || h === '100.100.100.200' // link-local (AWS/GCP/Azure metadata) and Alibaba metadata
    || /^fe[89ab][0-9a-f]?:/.test(h) || /^fd00:ec2:/.test(h); // IPv6 link-local fe80::/10 and AWS IPv6 metadata
}
export function isWorkerUrl(value) {
  try { return isHttpUrl(value) && !isBlockedWorkerHost(new URL(value).hostname); } catch { return false; }
}

export function onKillSwitch(hook) {
  killHooks.add(hook);
  return () => killHooks.delete(hook);
}

/**
 * Actively aborts any generation running on ComfyUI, purges pending queues, and unloads models.
 */
export async function interruptComfyUI(url = COMFYUI_URL) {
  const result = { interrupted: false, queue_cleared: false, memory_freed: false };
  const target = (url || 'http://localhost:8188').replace(/\/+$/, '');

  // 1. Interrupt running generation prompt immediately
  try {
    const res = await fetch(`${target}/interrupt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(2000),
    });
    result.interrupted = res.ok;
  } catch {
    // ComfyUI may be offline or unreachable
  }

  // 2. Clear all queued prompts
  try {
    const res = await fetch(`${target}/queue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clear: true }),
      signal: AbortSignal.timeout(2000),
    });
    result.queue_cleared = res.ok;
  } catch {
    // best-effort
  }

  // 3. Free ComfyUI VRAM and unload models
  try {
    const res = await fetch(`${target}/free`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ unload_models: true, free_memory: true }),
      signal: AbortSignal.timeout(2000),
    });
    result.memory_freed = res.ok;
  } catch {
    // best-effort
  }

  return result;
}

export function readLocalState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const content = fs.readFileSync(STATE_FILE, 'utf8');
      return JSON.parse(content);
    }
  } catch (err) {
    console.error('Error reading pipeline state:', err);
  }
  return {
    status: 'running',
    kill_switch_active: false,
    mode: 'autonomous',
    circuit_breaker: { tripped: false, consecutive_failures: 0, failure_threshold: 3 },
    emergency_stop_reason: null,
    last_state_change: new Date().toISOString(),
    updated_by: 'fallback'
  };
}

function writeLocalState(state) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
  } catch (err) {
    console.error('Error writing pipeline state:', err);
  }
}

// The UI polls status every 4s per open tab. Each failed n8n lookup parks one of Node's 4 DNS threads for seconds,
// which starves every other fetch (YouTube scan, Gemini) into "fetch failed". After a failure, skip n8n for a minute.
// ponytail: fixed 60s backoff; make it exponential if n8n flaps.
let n8nSkipUntil = 0;

export async function getStatusHandler(req, res) {
  try {
    let state = null;
    // Try n8n status first if reachable within 800ms
    if (Date.now() >= n8nSkipUntil) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 800);
        const response = await fetch(N8N_STATUS_URL, { signal: controller.signal });
        clearTimeout(timeout);
        if (response.ok) {
          const data = await response.json();
          state = data.state || data;
        }
      } catch {
        n8nSkipUntil = Date.now() + 60_000; // fallback to local file
      }
    }

    if (!state) {
      state = readLocalState();
    }

    // Ensure normalized properties for client convenience
    const normalized = {
      ...(typeof state === 'object' && state !== null ? state : {}),
      kill_switch_engaged: state?.kill_switch_active ?? false,
      reason: state?.emergency_stop_reason ?? '',
      tts_url: state?.tts_url || process.env.TTS_URL || process.env.NARRATIVE_FACTORY_URL || 'http://127.0.0.1:5050',
      comfyui_url: state?.comfyui_url || process.env.COMFYUI_URL || 'http://localhost:8188',
      active_runs: getActiveRuns(),
      recent_tasks: getRecentTasks(),
      last_gemini_fallback: getLastGeminiFallback()
    };

    return res.json(normalized);
  } catch (err) {
    console.error('Error handling getStatus:', err);
    return res.json({
      status: 'running',
      kill_switch_active: false,
      kill_switch_engaged: false,
      reason: `Fallback state (Error: ${err.message})`,
      active_runs: getActiveRuns(),
      recent_tasks: getRecentTasks(),
      last_gemini_fallback: getLastGeminiFallback()
    });
  }
}

// Same opt-in rule as middleware/auth.js: config-changing actions need X-Admin-Token only when ADMIN_TOKEN is set (403 if wrong).

export async function postControlHandler(req, res) {
  const { action, reason = '' } = req.body || {};

  if ((action === 'set_urls' || action === 'set_tts_url') && process.env.ADMIN_TOKEN && !adminAuthorized(req)) {
    auditDenied(req, 403, `admin action rejected: ${JSON.stringify(String(action).slice(0, 40))}, X-Admin-Token does not match`);
    return res.status(403).json({ error: 'Forbidden: X-Admin-Token must match ADMIN_TOKEN' });
  }

  if (action === 'dismiss_fallback' || action === 'dismiss_gemini_fallback') {
    clearLastGeminiFallback();
    return res.json({ ok: true, status: readLocalState(), last_gemini_fallback: null });
  }

  // Try relaying to n8n webhook if available
  let n8nSuccess = false;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1200);
    const n8nRes = await fetch(N8N_CONTROL_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, reason, user: 'Dashboard (UI)' }),
      signal: controller.signal
    });
    clearTimeout(timeout);
    if (n8nRes.ok) {
      n8nSuccess = true;
    }
  } catch {
    // n8n is offline or unreachable; fall back to direct file update
  }

  // Local state update
  const state = readLocalState();
  const now = new Date().toISOString();
  let comfyAborted = null;

  switch (action) {
    case 'start':
    case 'resume':
      state.status = 'running';
      state.kill_switch_active = false;
      state.emergency_stop_reason = null;
      if (state.circuit_breaker) state.circuit_breaker.tripped = false;
      break;

    case 'pause':
      state.status = 'paused';
      state.emergency_stop_reason = reason || 'Paused via Dashboard';
      break;

    case 'stop':
    case 'kill':
      state.status = 'stopped';
      state.kill_switch_active = true;
      state.emergency_stop_reason = reason || 'Emergency stop via Dashboard';
      if (state.circuit_breaker) state.circuit_breaker.tripped = true;

      // 1. Actively interrupt ComfyUI generation, clear queue, and unload VRAM
      comfyAborted = await interruptComfyUI().catch(() => null);

      // 2. Fire registered kill switch hooks (e.g. abort in-flight studio auto-batches)
      for (const hook of killHooks) {
        try {
          hook(reason);
        } catch (err) {
          console.error('Error executing kill switch hook:', err);
        }
      }
      break;

    case 'set_urls':
    case 'set_tts_url':
      for (const key of ['tts_url', 'comfyui_url']) {
        if (req.body[key] === undefined) continue;
        const value = req.body[key] ? String(req.body[key]).trim().replace(/\/+$/, '') : null;
        if (value && !isHttpUrl(value)) return res.status(400).json({ error: `${key} must be an http(s) URL` });
        if (value && !isWorkerUrl(value)) return res.status(400).json({ error: `${key} must not point at a link-local or cloud-metadata address` });
        state[key] = value;
      }
      break;

    default:
      return res.status(400).json({ error: `Unknown action: ${action}` });
  }

  state.last_state_change = now;
  state.updated_by = 'dashboard-bridge';
  writeLocalState(state);

  const responsePayload = {
    ...state,
    kill_switch_engaged: state.kill_switch_active,
    n8n_synced: n8nSuccess,
    ...(comfyAborted ? { comfy_aborted: comfyAborted } : {})
  };

  return res.json(responsePayload);
}
