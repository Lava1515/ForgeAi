import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sleep } from '../lib/objects.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = process.env.FORGEAI_ROOT || (fs.existsSync('/forgeai') ? '/forgeai' : path.resolve(__dirname, '../../../'));
const STATE_FILE = process.env.FORGEAI_STATE_FILE || path.join(REPO_ROOT, 'data/pipeline_state.json');

function readState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    }
  } catch {}
  return null;
}

export function getFactoryUrl() {
  const localState = readState();
  const stateUrl = localState?.tts_url || localState?.narrative_factory_url;
  const envUrl = process.env.TTS_URL || process.env.NARRATIVE_FACTORY_URL;
  if (stateUrl || envUrl) {
    return (stateUrl || envUrl).replace(/\/+$/, '');
  }
  const comfyUrl = localState?.comfyui_url || process.env.COMFYUI_URL;
  if (comfyUrl) {
    try {
      const parsed = new URL(comfyUrl);
      if (parsed.hostname && !['localhost', '127.0.0.1', '::1'].includes(parsed.hostname)) {
        return `${parsed.protocol}//${parsed.hostname}:5050`;
      }
    } catch {}
  }
  return 'http://127.0.0.1:5050';
}

// For backwards compatibility with static imports
export const FACTORY_URL = process.env.TTS_URL || process.env.NARRATIVE_FACTORY_URL || 'http://127.0.0.1:5050';

export function shouldSendToken(targetUrl) {
  if (!process.env.TTS_TOKEN) return false;
  try {
    const parsed = new URL(targetUrl);
    const h = parsed.hostname.toLowerCase();
    if (['localhost', '127.0.0.1', '::1'].includes(h)) return true;
    const composeUrl = process.env.NARRATIVE_FACTORY_URL || 'http://narrative-factory:5050';
    try {
      const composeHost = new URL(composeUrl).hostname.toLowerCase();
      if (h === composeHost) return true;
    } catch {}
    if (h === 'narrative-factory') return true;
    const remoteHosts = (process.env.REMOTE_WORKER_HOSTS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (remoteHosts.includes(h)) return true;
    return false;
  } catch {
    return false;
  }
}

export function getWorkerAuthHeaders(targetUrl) {
  return (shouldSendToken(targetUrl) && process.env.TTS_TOKEN)
    ? { 'X-TTS-Token': process.env.TTS_TOKEN }
    : {};
}

// The factory's /status JSON (includes comfyui_online), or null when it is unreachable.
export async function factoryStatus() {
  const url = getFactoryUrl();
  for (let i = 0; i < 3; i++) {
    try {
      const headers = getWorkerAuthHeaders(`${url}/status`);
      const res = await fetch(`${url}/status`, { headers, signal: AbortSignal.timeout(10000) });
      if (!res.ok) return null;
      const data = await res.json();
      return { ...data, factory_url: url };
    } catch {
      if (i < 2) await sleep(1000);
    }
  }
  return null;
}

// node:http / node:https rather than fetch: fetch aborts after 5 min without response headers, and renders, long
// voice-overs and edits can take longer than that.
export function postFactory(endpoint, body = {}) {
  return new Promise((resolve, reject) => {
    const factoryUrl = getFactoryUrl();
    let parsedUrl;
    try {
      parsedUrl = new URL(`${factoryUrl}${endpoint}`);
    } catch (err) {
      return reject(new Error(`Invalid factory URL: ${factoryUrl} (${err.message})`));
    }

    const isHttps = parsedUrl.protocol === 'https:';
    const client = isHttps ? https : http;

    // If client is targeting a remote factory for remuxing, attach base64 video/audio if files are on local disk
    const requestBody = { ...body };
    const isRemote = !['localhost', '127.0.0.1', '::1'].includes(parsedUrl.hostname);

    if (endpoint === '/api/remux-voiceover' && isRemote) {
      if (requestBody.video_path && !requestBody.video_base64) {
        const localVid = toLocalPath(requestBody.video_path);
        if (fs.existsSync(localVid)) {
          try {
            requestBody.video_base64 = fs.readFileSync(localVid).toString('base64');
          } catch {}
        }
      }
      if (requestBody.audio_path && !requestBody.audio_base64) {
        const localAud = toLocalPath(requestBody.audio_path);
        if (fs.existsSync(localAud)) {
          try {
            requestBody.audio_base64 = fs.readFileSync(localAud).toString('base64');
          } catch {}
        }
      }
    }

    const payload = JSON.stringify(requestBody);
    const req = client.request({
      protocol: parsedUrl.protocol,
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (isHttps ? 443 : 80),
      path: `${parsedUrl.pathname}${parsedUrl.search}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        // the worker refuses POSTs without its shared secret
        ...(process.env.TTS_TOKEN ? { 'X-TTS-Token': process.env.TTS_TOKEN } : {}),
      },
    }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('aborted', () => reject(new Error(`Factory ${endpoint} connection dropped`)));
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', async () => {
        try {
          const data = JSON.parse(raw);
          if (data.status !== 'success') return reject(new Error(data.error || `Factory ${endpoint} failed`));

          // Auto-save remote audio file locally if an output_path was requested
          if (body?.output_path && typeof body.output_path === 'string') {
            const localTarget = toLocalPath(body.output_path);
            if (!fs.existsSync(localTarget)) {
              try {
                if (data.audio_base64) {
                  fs.mkdirSync(path.dirname(localTarget), { recursive: true });
                  fs.writeFileSync(localTarget, Buffer.from(data.audio_base64, 'base64'));
                } else if (data.audio_url) {
                  const audioFetchUrl = `${factoryUrl}${data.audio_url.startsWith('/') ? '' : '/'}${data.audio_url}`;
                  const audioRes = await fetch(audioFetchUrl, {
                    headers: getWorkerAuthHeaders(audioFetchUrl),
                  });
                  if (audioRes.ok) {
                    fs.mkdirSync(path.dirname(localTarget), { recursive: true });
                    fs.writeFileSync(localTarget, Buffer.from(await audioRes.arrayBuffer()));
                  }
                }
              } catch (saveErr) {
                console.warn(`Failed to auto-save remote audio to ${localTarget}:`, saveErr);
              }
            }
          }

          // Auto-save remote remuxed video locally if output_path was requested
          if (endpoint === '/api/remux-voiceover' && body?.output_path && typeof body.output_path === 'string') {
            const localTarget = toLocalPath(body.output_path);
            if (data.video_base64 && (!fs.existsSync(localTarget) || isRemote)) {
              try {
                fs.mkdirSync(path.dirname(localTarget), { recursive: true });
                fs.writeFileSync(localTarget, Buffer.from(data.video_base64, 'base64'));
              } catch (saveErr) {
                console.warn(`Failed to auto-save remuxed video to ${localTarget}:`, saveErr);
              }
            }
          }

          resolve(data);
        } catch {
          reject(new Error(`Factory ${endpoint} returned invalid JSON (HTTP ${res.statusCode})`));
        }
      });
    });
    req.on('error', reject);
    // ponytail: one hour of socket silence = stuck factory; raise if 5-min renders ever need longer
    req.setTimeout(60 * 60e3, () => req.destroy(new Error(`Factory ${endpoint} timed out`)));
    req.end(payload);
  });
}

// Polls the factory's log buffer (GET /api/logs) and hands each new line to onLog. The first poll only
// records where the buffer is, so a dashboard restart doesn't replay old lines. Silent while the factory is down.
export function forwardFactoryLogs(onLog, intervalMs = 1000) {
  let after = null;
  const poll = async () => {
    try {
      const factoryUrl = getFactoryUrl();
      const logsUrl = `${factoryUrl}/api/logs?after=${after ?? 0}`;
      const res = await fetch(logsUrl, {
        headers: getWorkerAuthHeaders(logsUrl),
        signal: AbortSignal.timeout(5000),
      });
      const { latest, logs } = await res.json();
      if (after !== null) logs.forEach(onLog);
      after = latest;
    } catch {
      // factory offline or restarting
    }
    setTimeout(poll, intervalMs).unref();
  };
  poll();
}

// Factory paths are container paths (/forgeai/...); map them onto this process's repo root.
export const toLocalPath = (p) => (p && typeof p === 'string' && p.startsWith('/forgeai/') ? path.join(REPO_ROOT, p.slice('/forgeai/'.length)) : p);
