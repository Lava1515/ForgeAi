import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { readJson } from '../lib/objects.js';

// Antigravity CLI (agy) logged in with a Google account (AI Pro quota) is askGemini's main path; the API is the backup.
// Everything lives in AGY_HOME (data/agy in docker), used as agy's HOME: its .gemini/antigravity-cli/ login, plus
// forgeai.json with the account set in the dashboard. A call only runs when agy is logged in as exactly that account.
const home = () => process.env.AGY_HOME;
const agyDir = () => path.join(home(), '.gemini', 'antigravity-cli');
const norm = (email) => String(email || '').trim().toLowerCase();
const agyExecutable = () => {
  if (process.platform !== 'win32') return 'agy';
  const binDir = process.env.AGY_BIN_DIR || path.join(process.env.USERPROFILE || process.env.HOME || '', '.gemini', 'bin');
  const candidate = path.join(binDir, 'agy.exe');
  return fs.existsSync(candidate) ? candidate : 'agy';
};

export const getAgyEmail = () => (home() ? norm(readJson(path.join(home(), 'forgeai.json'))?.email) : '');

const quotaFile = () => (home() ? path.join(home(), 'quota_status.json') : null);

export function readAgyQuota() {
  const f = quotaFile();
  if (!f) return null;
  return readJson(f);
}

export function recordAgyQuota(message, account) {
  const f = quotaFile();
  if (!f) return;
  try {
    fs.writeFileSync(f, JSON.stringify({
      quotaExceeded: true,
      account: norm(account || getAgyEmail()),
      message: String(message || 'Out of tokens (Quota reached)'),
      recordedAt: new Date().toISOString()
    }, null, 2));
  } catch (err) {
    console.error('Failed to write quota status:', err);
  }
}

export function clearAgyQuota() {
  const f = quotaFile();
  if (!f) return;
  try {
    if (fs.existsSync(f)) fs.unlinkSync(f);
  } catch (err) {}
}

function idTokenEmail(idToken) {
  try {
    return norm(JSON.parse(Buffer.from(idToken.split('.')[1], 'base64url').toString()).email);
  } catch {
    return '';
  }
}

// The account agy will really call as: the email inside the id_token of its own login file.
export function getAgyAccount() {
  const login = readJson(path.join(agyDir(), 'antigravity-oauth-token'));
  if (!login?.token?.refresh_token) return { email: '', problem: 'Antigravity CLI is not logged in' };
  if (readJson(path.join(agyDir(), 'settings.json'))?.modelProvider) {
    return { email: '', problem: 'Antigravity CLI is set to use an API key, not the Google login' };
  }
  const email = norm(login.id_token_email) || idTokenEmail(login.id_token || login.token?.id_token);
  return email ? { email } : { email: '', problem: "Can't tell which account Antigravity CLI is logged in as; log in again" };
}

export function getAgyStatus() {
  if (!home()) return { available: false, configured: '', account: '', ready: false, quotaExceeded: false, quotaReason: null, reason: 'AGY_HOME is not set' };
  const configured = getAgyEmail();
  const { email, problem } = getAgyAccount();

  const quota = readAgyQuota();
  const isQuotaExceeded = Boolean(quota?.quotaExceeded && (!email || norm(quota?.account) === email));
  const quotaReason = isQuotaExceeded ? (quota.message || 'Out of tokens (Quota reached)') : null;

  const baseReason = !configured ? 'No account set'
    : problem || (email !== configured ? `Antigravity CLI is logged in as ${email}, not ${configured}` : '');

  const reason = baseReason || (isQuotaExceeded ? (quotaReason || 'Out of tokens') : '');

  return {
    available: true,
    configured,
    account: email,
    ready: !reason && !isQuotaExceeded,
    quotaExceeded: isQuotaExceeded,
    quotaReason,
    reason,
  };
}

// Anything that would make agy use an API key or a cloud project instead of the Google login.
const OTHER_AUTH_ENV = [
  'GEMINI_API_KEY', 'GEMINI_API_KEYS', 'GOOGLE_API_KEY', 'GOOGLE_GENAI_USE_VERTEXAI', 'GOOGLE_GEMINI_BASE_URL',
  'GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_CLOUD_PROJECT', 'GOOGLE_CLOUD_PROJECT_ID',
];
const AGY_TIMEOUT_S = Number(process.env.AGY_TIMEOUT_S) || 600;
// agy can't run at all (not set up, wrong account, not installed): the only agy failure askGemini hands to the API.
const unavailable = (message) => Object.assign(new Error(message), { unavailable: true });

// agy is an agent: headless mode denies every tool that needs approval, and a denied tool means an empty answer.
// search_web needs no approval but read_url does (checked 2026-10-14), so search requests may search and nothing else.
export const agyPrompt = (instruction, { search = false } = {}) => `${instruction}\n\n${search
  ? 'Check the facts with the search_web tool (at most 8 searches), then answer with only the JSON object described above. '
    + 'Do not open web pages (read_url) or use any other tool, and do not read or write files.'
  : 'Answer directly from your own knowledge with only the JSON object described above. Do not use any tools and do not read or write files.'}`;

// Resolves with the model's raw answer text. Rejects without starting agy when the account doesn't match.
// model (optional, KAN-930): one of the trusted flash ids, passed as --model; anything else is refused before agy starts.
const AGY_MODEL_RE = /^gemini-[0-9]+(\.[0-9]+)*-flash-(high|low)$/;
export function askAgy(instruction, { search = false, timeoutMs = (AGY_TIMEOUT_S + 10) * 1000, graceMs = 5000, spawnFn = spawn, model } = {}) {
  if (model !== undefined && (typeof model !== 'string' || !AGY_MODEL_RE.test(model))) return Promise.reject(new TypeError('Invalid agy model name'));
  const status = getAgyStatus();
  if (!status.ready) return Promise.reject(unavailable(status.reason));

  const env = { ...process.env, HOME: home() };
  for (const k of OTHER_AUTH_ENV) delete env[k];
  const prompt = agyPrompt(instruction, { search });
  const workspace = path.join(home(), 'workspace'); // empty folder: nothing for the agent to look at
  fs.mkdirSync(workspace, { recursive: true });

  const effectiveTimeoutS = Math.max(AGY_TIMEOUT_S, Math.ceil(timeoutMs / 1000));
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawnFn(agyExecutable(), ['-p', prompt, '--output-format', 'json', '--disable-slash-commands', '--print-timeout', `${effectiveTimeoutS}s`, ...(model ? ['--model', model] : [])], {
      cwd: workspace, env,
    });
    let out = '';
    let err = '';
    let timedOut = false;
    let graceTimer = null;
    let closed = false;

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      if (!closed) {
        try {
          child.kill('SIGTERM');
        } catch {}
        graceTimer = setTimeout(() => {
          if (!closed) {
            try {
              child.kill('SIGKILL');
            } catch {}
          }
        }, graceMs);
      }
    }, timeoutMs);

    const cleanup = () => {
      closed = true;
      clearTimeout(timeoutTimer);
      if (graceTimer) clearTimeout(graceTimer);
    };

    child.stdout?.on('data', (d) => { out += d; });
    child.stderr?.on('data', (d) => { err += d; });
    child.once('exit', cleanup);
    child.on('error', (e) => {
      cleanup();
      reject(unavailable(`Couldn't start Antigravity CLI (${e.code || e.message})`));
    });
    child.on('close', (code, signal) => {
      cleanup();
      const body = readAgyJson(out);
      if (code === 0 && body?.response?.trim()) return resolve(body.response);
      const lines = `${err}\n${out}`.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('{') && !l.startsWith('at '));
      const denied = body?.denied_actions?.length ? `it wanted tools (${body.denied_actions.map((a) => a.action).join(', ')})` : '';
      // At --print-timeout agy still exits 0 with status SUCCESS, just without an answer.
      const isTimeout = timedOut || (Date.now() - started >= effectiveTimeoutS * 1000);
      const timedOutMsg = isTimeout ? `timed out after ${effectiveTimeoutS}s` : '';
      const why = timedOutMsg || body?.error?.message || body?.error || lines.find((l) => /error|denied|not logged/i.test(l)) || denied
        || (body ? `empty answer (${body.status})` : '') || lines.pop() || (signal ? `stopped (${signal})` : `exit ${code}`);
      const failureErr = new Error(`Antigravity CLI failed: ${why}`);
      if (isTimeout) failureErr.timedOut = true;
      if (!body && code === 0) failureErr.badEnvelope = true; // exit 0 but unparseable JSON envelope: same as malformed JSON
      reject(failureErr);
    });
  });
}

// The JSON result is the last line of stdout; anything before it is agy's own notes.
function readAgyJson(out) {
  try {
    return JSON.parse(out.slice(out.lastIndexOf('\n{') + 1));
  } catch {
    return null;
  }
}

export function getAgyHandler(req, res) {
  res.json(getAgyStatus());
}

export function setAgyHandler(req, res) {
  if (!home()) return res.status(400).json({ error: 'AGY_HOME is not set on the dashboard' });
  const email = norm(req.body?.email);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Not an email address' });
  fs.mkdirSync(home(), { recursive: true });
  fs.writeFileSync(path.join(home(), 'forgeai.json'), JSON.stringify({ email }, null, 2));
  clearAgyQuota();
  res.json(getAgyStatus());
}

const AGY_CLIENT_ID = '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com';
const AGY_CLIENT_SECRET = process.env.AGY_OAUTH_CLIENT_SECRET || '';
const AGY_SCOPES = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/cclog',
  'https://www.googleapis.com/auth/experimentsandconfigs',
  'https://www.googleapis.com/auth/aicode',
  'openid',
].join(' ');

const pendingAuth = new Map();

function generatePkce() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

let onAgyLoginSuccess = () => {};
export const setOnAgyLoginSuccess = (fn) => { onAgyLoginSuccess = fn; };

export function agyLoginHandler(req, res) {
  if (!home()) return res.status(400).send('AGY_HOME is not set on the dashboard');
  const { verifier, challenge } = generatePkce();
  const state = crypto.randomBytes(16).toString('hex');
  pendingAuth.set(state, { verifier, createdAt: Date.now() });

  const now = Date.now();
  for (const [k, v] of pendingAuth.entries()) {
    if (now - v.createdAt > 15 * 60000) pendingAuth.delete(k);
  }

  const hostHeader = req.get('host') || 'localhost:3000';
  const host = hostHeader.includes('127.0.0.1') ? hostHeader : 'localhost:3000';
  const redirectUri = `http://${host}/api/agy/callback`;

  const authUrl = new URL('https://accounts.google.com/o/oauth2/auth');
  authUrl.searchParams.set('client_id', AGY_CLIENT_ID);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', AGY_SCOPES);
  authUrl.searchParams.set('access_type', 'offline');
  authUrl.searchParams.set('prompt', 'consent select_account');
  authUrl.searchParams.set('code_challenge', challenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  authUrl.searchParams.set('state', state);

  res.redirect(authUrl.toString());
}

// KAN-789 (logging audit E5): the callback answers text/html, so anything that came from the query string or from Google is escaped and cut.
const escapeHtml = (v) => String(v ?? '').slice(0, 200).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export async function agyCallbackHandler(req, res) {
  const { code, state, error } = req.query;
  if (!AGY_CLIENT_SECRET) return res.status(501).send('Antigravity login is not configured (AGY_OAUTH_CLIENT_SECRET is not set)');
  if (error) {
    return res.status(400).send(`Google authentication failed: ${escapeHtml(error)}. <a href="/">Return to Dashboard</a>`);
  }
  if (!code || !state || !pendingAuth.has(state)) {
    return res.status(400).send('Invalid or expired authentication session. <a href="/api/agy/login">Try again</a>');
  }

  const { verifier } = pendingAuth.get(state);
  pendingAuth.delete(state);

  const hostHeader = req.get('host') || 'localhost:3000';
  const host = hostHeader.includes('127.0.0.1') ? hostHeader : 'localhost:3000';
  const redirectUri = `http://${host}/api/agy/callback`;

  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: AGY_CLIENT_ID,
        client_secret: AGY_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        redirect_uri: redirectUri,
      }),
    });

    if (!tokenRes.ok) {
      const errBody = await tokenRes.text();
      return res.status(500).send(`Failed to exchange token with Google: ${escapeHtml(errBody)}. <a href="/api/agy/login">Try again</a>`);
    }

    const tokenData = await tokenRes.json();
    const tokenFilePath = path.join(agyDir(), 'antigravity-oauth-token');
    fs.mkdirSync(agyDir(), { recursive: true });

    const tokenPayload = {
      token: {
        access_token: tokenData.access_token,
        token_type: tokenData.token_type || 'Bearer',
        refresh_token: tokenData.refresh_token,
        expiry: new Date(Date.now() + (tokenData.expires_in || 3600) * 1000).toISOString(),
      },
      auth_method: 'consumer',
      id_token: tokenData.id_token,
    };

    fs.writeFileSync(tokenFilePath, JSON.stringify(tokenPayload, null, 2));

    const email = idTokenEmail(tokenData.id_token);
    if (email) {
      fs.writeFileSync(path.join(home(), 'forgeai.json'), JSON.stringify({ email }, null, 2));
    }

    clearAgyQuota();
    try {
      onAgyLoginSuccess();
    } catch {}

    res.redirect('/?agy_logged_in=1');
  } catch (err) {
    res.status(500).send(`Authentication error: ${escapeHtml(err.message)}. <a href="/">Return to Dashboard</a>`);
  }
}

export async function testAgyHandler(req, res) {
  const status = getAgyStatus();
  if (!status.available) return res.status(400).json({ ok: false, error: 'Antigravity CLI not available' });
  if (!status.account) return res.status(400).json({ ok: false, error: 'Antigravity CLI is not logged in' });

  const prevQuota = readAgyQuota();
  clearAgyQuota();

  try {
    const raw = await askAgy('Return ONLY this JSON object, nothing else: {"status": "ok"}', { timeoutMs: 30000 });
    clearAgyQuota();
    res.json({ ok: true, message: 'CLI is connected and quota is active!', status: getAgyStatus() });
  } catch (err) {
    const msg = String(err.message || '');
    const isQuota = /quota|429|limit reached|exhausted/i.test(msg);
    if (isQuota) {
      recordAgyQuota(msg, status.account);
    } else if (prevQuota?.quotaExceeded) {
      recordAgyQuota(prevQuota.message, status.account);
    }
    res.json({
      ok: false,
      quotaExceeded: isQuota,
      error: msg,
      status: getAgyStatus()
    });
  }
}
