import { getFactoryUrl, getWorkerAuthHeaders } from './factoryClient.js';
import { readLocalState, isHttpUrl } from './control.js';
import { auditDenied } from '../middleware/auth.js';

const norm = (u) => String(u || '').trim().replace(/\/+$/, '');

// Only URLs the operator already configured, or hosts listed in REMOTE_WORKER_HOSTS (comma-separated), may be probed.
// A REMOTE_WORKER_HOSTS entry is "host:port" (that port only) or a bare "host", which is pinned to the worker ports
// (factory 5050, ComfyUI 8188, Blender worker 8190) and the scheme's default port: no other port of the host is probed (R1).
const WORKER_PORTS = new Set(['5050', '8188', '8190', '']);
const MAX_REDIRECTS = 3;
function isAllowedTestUrl(url) {
  const state = readLocalState() || {};
  const configured = [state.tts_url, state.comfyui_url, state.narrative_factory_url,
    process.env.TTS_URL, process.env.COMFYUI_URL, process.env.NARRATIVE_FACTORY_URL, getFactoryUrl()].map(norm).filter(Boolean);
  if (configured.includes(url)) return true;
  const target = new URL(url);
  return (process.env.REMOTE_WORKER_HOSTS || '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean).some((entry) => {
    try {
      const e = new URL(`http://${entry}`); // an entry without a port parses with port ''
      return e.hostname === target.hostname.toLowerCase() && (e.port ? e.port === target.port : WORKER_PORTS.has(target.port));
    } catch { return false; }
  });
}

// fetch /status without following redirects blindly: every hop is re-checked against the same allowlist (R2), like storySources.js.
async function fetchStatus(baseUrl) {
  let target = `${baseUrl}/status`;
  for (let hop = 0; ; hop++) {
    const r = await fetch(target, { signal: AbortSignal.timeout(3500), redirect: 'manual' });
    if (r.status < 300 || r.status >= 400) return r;
    let next;
    try { next = new URL(r.headers.get('location') || '', target); } catch { next = null; }
    if (!next || hop >= MAX_REDIRECTS) throw new Error('too many or malformed redirects');
    if (!isHttpUrl(next.href) || !isAllowedTestUrl(next.origin)) throw new Error('redirect to a URL that is not allowed');
    target = next.href;
  }
}

export async function getServiceStatusHandler(req, res) {
  const url = getFactoryUrl();
  try {
    // The factory asks for its token (TTS_TOKEN). Without the header it answered 401 and the sidebar said "Offline" while it was up.
    const r = await fetch(`${url}/status`, { signal: AbortSignal.timeout(3000), headers: getWorkerAuthHeaders(url) });
    if (r.ok) {
      const data = await r.json();
      if (!res.headersSent) {
        return res.json({ ok: true, online: true, url, ...data });
      }
      return;
    }
    // It answered, so it is up; this dashboard just has no token for the details.
    if ((r.status === 401 || r.status === 403) && !res.headersSent) return res.json({ ok: true, online: true, url, status: 'online', locked: true });
  } catch {
    // offline
  }
  if (!res.headersSent) {
    res.json({ ok: false, online: false, url, status: 'offline' });
  }
}
export const narrativeStatusHandler = getServiceStatusHandler;

export async function testServiceUrlHandler(req, res) {
  if (typeof req.body?.url !== 'string') {
    return res.status(400).json({ ok: false, error: 'Provide a server URL to test (e.g. http://192.168.1.50:5050)' });
  }
  const testUrl = req.body.url.trim().replace(/\/+$/, '');
  if (!testUrl) {
    return res.status(400).json({ ok: false, error: 'Provide a server URL to test (e.g. http://192.168.1.50:5050)' });
  }

  if (!isHttpUrl(testUrl)) {
    return res.status(400).json({ ok: false, error: 'URL must start with http:// or https://' });
  }
  if (!isAllowedTestUrl(testUrl)) {
    auditDenied(req, 403, 'probe blocked, host is not a configured worker', (() => { try { return new URL(testUrl).host; } catch { return ''; } })()); // host only: no userinfo, path or query
    return res.status(403).json({ ok: false, error: 'URL is not a configured worker URL or in REMOTE_WORKER_HOSTS' });
  }

  try {
    const r = await fetchStatus(testUrl);
    if (r.ok) {
      const data = await r.json();
      return res.json({
        ok: true,
        online: true,
        url: testUrl,
        tested_url: testUrl,
        tts_engine: data.tts_engine,
        tts_model: data.tts_model,
        tts_version: data.tts_version,
        device_name: data.device_name || data.tts_device,
        cuda_available: data.cuda_available,
        voices: data.voices,
        voices_count: Array.isArray(data.voices) ? data.voices.length : 0,
      });
    } else {
      return res.json({
        ok: false,
        online: false,
        url: testUrl,
        error: `Server responded with HTTP ${r.status}`,
      });
    }
  } catch (err) {
    return res.json({
      ok: false,
      online: false,
      url: testUrl,
      error: `Could not connect to ${testUrl} (${err.cause?.code || err.message}). Make sure the worker is running on the remote PC.`,
    });
  }
}
