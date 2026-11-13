const BASE_URL = import.meta.env?.VITE_API_BASE_URL || '';

let currentActiveChannelId = (() => {
  try {
    return localStorage.getItem('forgeai_active_channel_id') || 'default';
  } catch {
    return 'default';
  }
})();

export const getActiveChannelId = () => currentActiveChannelId;

export function setActiveChannelId(id) {
  currentActiveChannelId = id || 'default';
  try {
    localStorage.setItem('forgeai_active_channel_id', currentActiveChannelId);
  } catch {}
}

// KAN-438: the server wants X-Admin-Token on state-changing routes once ADMIN_TOKEN is set.
// The token lives in sessionStorage only (gone when the tab closes), is never put in localStorage and never logged.
const ADMIN_TOKEN_KEY = 'forgeai_admin_token';
export const getAdminToken = () => { try { return sessionStorage.getItem(ADMIN_TOKEN_KEY) || ''; } catch { return ''; } };
export const setAdminToken = (token) => {
  try { token ? sessionStorage.setItem(ADMIN_TOKEN_KEY, token) : sessionStorage.removeItem(ADMIN_TOKEN_KEY); } catch {}
};

function adminError(message) {
  const error = new Error(message);
  error.status = 401;
  return error;
}

// fetch that sends the saved admin token on every non-GET call. On a 401 "admin_token_required" it asks for the token once
// (window.prompt: shows the text as typed, ponytail: swap for a masked dialog if the dashboard is ever shared) and retries once.
export async function adminFetch(url, init = {}) {
  const method = String(init.method || 'GET').toUpperCase();
  if (method === 'GET' || method === 'HEAD') return fetch(url, init);
  const send = (token) => fetch(url, { ...init, headers: { ...init.headers, ...(token ? { 'X-Admin-Token': token } : {}) } });
  const needsToken = async (res) => {
    if (res.status !== 401) return false;
    try { return (await res.clone().json())?.code === 'admin_token_required'; } catch { return false; }
  };

  const sent = getAdminToken();
  const first = await send(sent);
  if (!(await needsToken(first))) return first;

  let token = getAdminToken();
  if (!token || token === sent) { // no one else stored a fresh token meanwhile: ask
    setAdminToken('');
    const answer = typeof globalThis.prompt === 'function'
      ? globalThis.prompt(sent ? 'The admin token was rejected. Enter the correct admin token (ADMIN_TOKEN):' : 'This action needs the admin token (ADMIN_TOKEN). Enter it:')
      : null;
    token = String(answer || '').trim();
    if (!token) throw adminError('Admin token required: this action was blocked. Try again and enter the admin token when asked.');
    setAdminToken(token);
  }
  const second = await send(token);
  if (await needsToken(second)) {
    setAdminToken('');
    throw adminError('Admin token rejected: it does not match ADMIN_TOKEN on the server. Try again with the right one.');
  }
  return second;
}

/**
 * Common fetch wrapper with JSON parsing and basic error handling
 */
async function request(endpoint, options = {}) {
  const url = `${BASE_URL}${endpoint}`;
  const { channelId, ...fetchOptions } = options;
  const activeId = channelId === undefined ? currentActiveChannelId : channelId;
  const headers = {
    'Content-Type': 'application/json',
    ...(activeId ? { 'x-channel-id': activeId } : {}),
    ...(options.headers || {})
  };

  const response = await adminFetch(url, { ...fetchOptions, headers });
  
  if (!response.ok) {
    let errorMsg = `HTTP ${response.status} ${response.statusText}`;
    let errData = null;
    try {
      errData = await response.json();
      if (errData && errData.error) {
        errorMsg = errData.error;
      }
    } catch (e) {
      // Ignore parse failure, use fallback
    }
    const error = new Error(errorMsg);
    error.status = response.status;
    error.data = errData;
    throw error;
  }

  return response.json();
}

export async function getStatus() {
  return request('/api/status');
}

export async function getNarrativeServiceStatus() {
  return request('/api/service/narrative');
}

export async function sendControl(action, payload = {}) {
  return request('/api/control', {
    method: 'POST',
    body: JSON.stringify({ action, ...payload })
  });
}

export async function dismissGeminiFallback() {
  return request('/api/gemini/dismiss-fallback', { method: 'POST' }).catch(() => ({}));
}

export async function getAgy() {
  return request('/api/agy');
}

export async function setAgy(email) {
  return request('/api/agy', { method: 'PUT', body: JSON.stringify({ email }) });
}

export async function getProducts() {
  return request('/api/products');
}

// flags: any of { liked, saved, future_upload } as booleans.
export async function updateProduct(draftId, flags) {
  return request(`/api/products/${encodeURIComponent(draftId)}`, { method: 'PATCH', body: JSON.stringify(flags) });
}

export async function deleteProduct(draftId) {
  return request(`/api/products/${draftId}`, {
    method: 'DELETE'
  });
}

export async function getPendingStillReviews() {
  return request('/api/studio/stills-pending');
}

export async function getStillsReview(runId) {
  return request(`/api/studio/${encodeURIComponent(runId)}/stills`);
}

export async function approveStill(runId, scene) {
  return request(`/api/studio/${encodeURIComponent(runId)}/stills/${encodeURIComponent(scene)}/approve`, {
    method: 'POST',
  });
}

export async function regenerateStill(runId, scene, { prompt } = {}) {
  return request(`/api/studio/${encodeURIComponent(runId)}/stills/${encodeURIComponent(scene)}/regenerate`, {
    method: 'POST',
    body: JSON.stringify({ prompt }),
  });
}

export async function animateApprovedScenes(runId, params = {}) {
  return request(`/api/studio/${encodeURIComponent(runId)}/animate`, {
    method: 'POST',
    body: JSON.stringify(params),
  });
}

// Standalone Voiceover Studio

// Channels Management & Psychology Research
export async function getChannels() {
  return request('/api/channels');
}

// Read-only: the server reports blockers for a Wan backend and never starts work.

export async function createChannel(channelData) {
  return request('/api/channels', {
    method: 'POST',
    body: JSON.stringify(channelData)
  });
}

export async function updateChannel(id, updates) {
  return request(`/api/channels/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify(updates)
  });
}

export async function deleteChannel(id) {
  return request(`/api/channels/${encodeURIComponent(id)}`, {
    method: 'DELETE'
  });
}

export async function switchChannel(channelId) {
  const result = await request('/api/channels/switch', {
    method: 'POST',
    body: JSON.stringify({ channel_id: channelId }),
  });
  if (result?.active_channel_id) {
    setActiveChannelId(result.active_channel_id);
  }
  return result;
}

export async function researchChannelRules({ genre, name, description }) {
  return request('/api/channels/research-rules', {
    method: 'POST',
    body: JSON.stringify({ genre, name, description })
  });
}

// replay: also receive the server's recent events first, so a reloaded page catches up on running jobs.
// KAN-789: once ADMIN_TOKEN is set the feed needs a session cookie (EventSource cannot send X-Admin-Token), so the stream opens only after
// POST /api/events/session (adminFetch sends the token and asks for it when missing). If the cookie expires the browser closes the
// EventSource (HTTP 401); renew the session and reopen once the user is still subscribed.
export function subscribeEvents(onEvent, onError, { replay = false } = {}) {
  const url = `${BASE_URL}/api/events${replay ? '?replay=1' : ''}`;
  let es = null;
  let closed = false;

  const open = async () => {
    try {
      const res = await adminFetch(`${BASE_URL}/api/events/session`, { method: 'POST' });
      if (!res.ok) throw new Error(`log feed session refused (${res.status})`);
    } catch (err) {
      if (!closed && onError) onError(err);
      return;
    }
    if (closed) return;
    es = new EventSource(url);

    es.onmessage = (event) => {
      try {
        const parsed = JSON.parse(event.data);
        const normalized = (parsed?.data && typeof parsed.data === 'object')
          ? { ...parsed.data, ...parsed }
          : parsed;
        if (onEvent) onEvent(normalized);
      } catch (err) {
        console.error('Failed to parse SSE event data:', err);
      }
    };

    es.onerror = (err) => {
      if (onError) onError(err);
      if (es.readyState === 2 && !closed) setTimeout(() => { if (!closed) open(); }, 5000); // CLOSED = the server refused: renew the session
    };
  };
  open();

  return () => {
    closed = true;
    if (es) es.close();
  };
}

export const youtubeConnectUrl = `${BASE_URL}/api/youtube/connect`;

export async function getYoutubeStatus() {
  return request('/api/youtube/status');
}

// publishAt (ISO): upload unlisted now, the server makes it public at that time.
export async function publishToYoutube(draftId, { privacy, madeForKids, tags, title, publishAt }) {
  return request(`/api/youtube/publish/${encodeURIComponent(draftId)}`, { method: 'POST', body: JSON.stringify({ privacy, madeForKids, tags, title, publishAt }) });
}

export async function getYoutubeDrafts() {
  return request('/api/youtube/drafts');
}

export async function suggestYoutubeTags(draftId) {
  return request(`/api/youtube/tags/${encodeURIComponent(draftId)}`, { method: 'POST' });
}

export async function getChannel() {
  return request('/api/channel');
}

export async function scanChannel() {
  return request('/api/channel/scan', { method: 'POST' });
}

export async function testAgy() {
  return request('/api/agy/test', { method: 'POST' });
}

// Growth module reports (KAN-245)
export async function getGrowthReport(channelId) {
  const qs = channelId ? `?channel_id=${encodeURIComponent(channelId)}` : '';
  return request(`/api/growth/report${qs}`);
}

export async function refreshGrowthReport({ channelId, force = false } = {}) {
  return request('/api/growth/report/refresh', {
    method: 'POST',
    body: JSON.stringify({ channel_id: channelId, force }),
  });
}

// Growth module strategy and topic picking (KAN-247)
export async function getGrowthStrategy(channelId) {
  const qs = channelId ? `?channel_id=${encodeURIComponent(channelId)}` : '';
  return request(`/api/growth/strategy${qs}`);
}

export async function saveGrowthStrategy({ channelId, content_pillar, upload_cadence, positioning } = {}) {
  return request('/api/growth/strategy', {
    method: 'POST',
    body: JSON.stringify({ channel_id: channelId, content_pillar, upload_cadence, positioning }),
  });
}

export async function generateGrowthStrategy({ channelId, force = true } = {}) {
  return request('/api/growth/strategy/generate', {
    method: 'POST',
    body: JSON.stringify({ channel_id: channelId, force }),
  });
}

export async function getGrowthIdeas(channelId) {
  const qs = channelId ? `?channel_id=${encodeURIComponent(channelId)}` : '';
  return request(`/api/growth/ideas${qs}`);
}

export async function generateGrowthIdeas({ channelId, force = true } = {}) {
  return request('/api/growth/ideas/generate', {
    method: 'POST',
    body: JSON.stringify({ channel_id: channelId, force }),
  });
}

// Growth module A/B target channel (KAN-251)
export async function getGrowthABChannel(channelId) {
  const qs = channelId ? `?channel_id=${encodeURIComponent(channelId)}` : '';
  return request(`/api/growth/ab-channel${qs}`);
}

export async function saveGrowthABChannel({ channelId, growth_ab_channel } = {}) {
  return request('/api/growth/ab-channel', {
    method: 'POST',
    body: JSON.stringify({ channel_id: channelId, growth_ab_channel }),
  });
}

// Generation Profile (Story3D T11 / KAN-299)

// Channel-explicit shared creator reads and revisioned preset mutations.

// Claude CLI account (data/claude): status, the manual login (link, then the pasted code) and a one-call test.
export async function getClaude() {
  return request('/api/claude');
}

export async function setClaudeUse(use) {
  return request('/api/claude', { method: 'PUT', body: JSON.stringify({ use }) });
}

export async function startClaudeLogin() {
  return request('/api/claude/login', { method: 'POST' });
}

export async function finishClaudeLogin(code) {
  return request('/api/claude/login/code', { method: 'POST', body: JSON.stringify({ code }) });
}

export async function testClaude() {
  return request('/api/claude/test', { method: 'POST' });
}

// Episodes (KAN-885 / KAN-824)

// Episode Room (KAN-886): run stages and decide the animatic gate through the existing admin-token routes.

// Code-built start (owner UI): queued background job, status poll, abort.
export async function startCodebuiltJob(body) {
  return request('/api/codebuilt/start', { method: 'POST', body: JSON.stringify(body) });
}

export async function getCodebuiltJob(id) {
  return request('/api/codebuilt/jobs/' + encodeURIComponent(id));
}

export async function listCodebuiltJobs() {
  return request('/api/codebuilt/jobs');
}

export async function abortCodebuiltJob(id) {
  return request('/api/codebuilt/jobs/' + encodeURIComponent(id) + '/abort', { method: 'POST' });
}

export async function resumeCodebuiltJob(id) {
  return request('/api/codebuilt/jobs/' + encodeURIComponent(id) + '/resume', { method: 'POST' });
}

// Code-built batch (KAN-928): one Start for 1..10 videos, a status poll, and an explicit run abort.
export async function startCodebuiltRun(body) {
  return request('/api/codebuilt/runs', { method: 'POST', body: JSON.stringify(body) });
}

export async function getCodebuiltRun(id) {
  return request('/api/codebuilt/runs/' + encodeURIComponent(id));
}

export async function abortCodebuiltRun(id) {
  return request('/api/codebuilt/runs/' + encodeURIComponent(id) + '/abort', { method: 'POST' });
}
