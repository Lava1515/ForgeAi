// ForgeAi uploader: a small server with one page. It takes finished videos from the hand-over folder and puts them on
// YouTube at each channel's slot times. Run: node --env-file-if-exists=../.env server/index.js   (from uploader/)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createEngine } from './engine.js';
import { createYouTube } from './youtube.js';
import { releaseShare } from './share.js';
import { isChannelId } from './rules.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const PORT = Number(process.env.UPLOADER_PORT) || 3100;
const HOST = process.env.UPLOADER_HOST || '127.0.0.1';
const UI_KEY = process.env.UPLOADER_UI_KEY || '';
const SHARE = path.resolve(process.env.UPLOADER_SHARE || path.join(REPO, 'output/uploader-share'));
const STATE_DIR = path.resolve(process.env.UPLOADER_STATE || path.join(REPO, 'data/uploader'));
const REDIRECT = process.env.UPLOADER_REDIRECT_URI || `http://localhost:${PORT}/api/youtube/callback`;
const AHEAD_H = Math.min(24, Math.max(1, Number(process.env.UPLOADER_AHEAD_HOURS) || 6));

const loopback = ['127.0.0.1', 'localhost', '::1'].includes(HOST);
if (!loopback && UI_KEY.length < 16) {
  console.error('UPLOADER_HOST is not this machine only, so UPLOADER_UI_KEY (16 characters or more) must be set. Not starting.');
  process.exit(1);
}
const allowedHosts = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`, `[::1]:${PORT}`,
  ...(loopback ? [] : [`${HOST}:${PORT}`]), ...String(process.env.UPLOADER_PUBLIC_HOSTS || '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean)]);

const youtube = createYouTube({ clientId: process.env.YOUTUBE_CLIENT_ID, clientSecret: process.env.YOUTUBE_CLIENT_SECRET, redirectUri: REDIRECT });
const engine = createEngine({ share: SHARE, stateDir: STATE_DIR, youtube, aheadMs: AHEAD_H * 60 * 60 * 1000 });
const pendingStates = new Map(); // OAuth state -> expiry

const STATIC = { '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'] };
const SECURITY = { 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; base-uri 'none'" };

const send = (res, status, body, type = 'application/json; charset=utf-8', extra = {}) => {
  res.writeHead(status, { 'Content-Type': type, ...SECURITY, ...extra });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};
const sameKey = (given) => {
  const a = crypto.createHash('sha256').update(String(given)).digest();
  const b = crypto.createHash('sha256').update(UI_KEY).digest();
  return crypto.timingSafeEqual(a, b);
};
function authorised(req) {
  if (!UI_KEY) return true;
  const header = String(req.headers.authorization || '');
  if (!header.startsWith('Basic ')) return false;
  const text = Buffer.from(header.slice(6), 'base64').toString('utf8');
  return sameKey(text.slice(text.indexOf(':') + 1));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > 20000) { reject(new Error('Request too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(new Error('Not JSON')); } });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const host = String(req.headers.host || '').toLowerCase();
    if (!allowedHosts.has(host)) return send(res, 403, { error: 'Unknown host name' }); // a page on another site cannot reach us by a made-up name
    if (!authorised(req)) return send(res, 401, { error: 'Key needed' }, undefined, { 'WWW-Authenticate': 'Basic realm="ForgeAi uploader"' });
    const url = new URL(req.url, `http://${host}`);
    const route = url.pathname;

    if (req.method === 'GET' && STATIC[route]) {
      const [file, type] = STATIC[route];
      return send(res, 200, fs.readFileSync(path.join(HERE, '../client', file)), type);
    }
    if (req.method === 'GET' && route === '/api/state') return send(res, 200, engine.view());

    if (req.method === 'GET' && route === '/api/youtube/connect') {
      if (!youtube.configured) return send(res, 400, 'Set YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET, then start the uploader again.', 'text/plain; charset=utf-8');
      const state = crypto.randomBytes(16).toString('hex');
      for (const [k, exp] of pendingStates) if (exp < Date.now()) pendingStates.delete(k);
      pendingStates.set(state, Date.now() + 10 * 60 * 1000);
      return send(res, 302, '', 'text/plain', { Location: youtube.connectUrl(state) });
    }
    if (req.method === 'GET' && route === '/api/youtube/callback') {
      const state = url.searchParams.get('state');
      if (url.searchParams.get('error')) return send(res, 302, '', 'text/plain', { Location: '/?youtube=refused' });
      if (!state || !pendingStates.has(state) || pendingStates.get(state) < Date.now()) return send(res, 400, 'This sign-in link expired. Press "Connect a channel" again.', 'text/plain; charset=utf-8');
      pendingStates.delete(state);
      try { engine.connect(await youtube.finishConnect(String(url.searchParams.get('code') || ''))); } catch (err) { return send(res, 502, String(err.message || err).slice(0, 300), 'text/plain; charset=utf-8'); }
      return send(res, 302, '', 'text/plain', { Location: '/?youtube=connected' });
    }

    if (req.method === 'POST') {
      // Changes come only from our own page: JSON, and no other site as the sender.
      if (!String(req.headers['content-type'] || '').startsWith('application/json')) return send(res, 415, { error: 'JSON only' });
      const origin = req.headers.origin;
      if (origin) { let o = ''; try { o = new URL(origin).host.toLowerCase(); } catch { /* not a URL */ } if (o !== host) return send(res, 403, { error: 'Wrong origin' }); }
      const body = await readBody(req);
      try {
        const pkgHit = route.match(/^\/api\/packages\/([A-Za-z0-9_-]{1,120})\/(remove|retry|up|down|cancel)$/);
        const chHit = route.match(/^\/api\/channels\/(UC[A-Za-z0-9_-]{22})$/);
        if (route === '/api/pause') {
          if (body.channel !== undefined && !isChannelId(body.channel)) throw new Error('Unknown channel');
          engine.setPaused(body.paused === true, body.channel);
        } else if (pkgHit) await engine.packageAction(pkgHit[1], pkgHit[2]);
        else if (chHit) engine.setChannel(chHit[1], { slots: body.slots, daily_limit: body.daily_limit });
        else if (route === '/api/youtube/disconnect') engine.disconnect(String(body.channel || ''));
        else if (route === '/api/check') await engine.tick();
        else return send(res, 404, { error: 'Not found' });
      } catch (err) { return send(res, 400, { error: String(err.message || err).slice(0, 300) }); }
      return send(res, 200, engine.view());
    }
    return send(res, 404, { error: 'Not found' });
  } catch (err) {
    console.error('request failed:', err.message);
    if (!res.headersSent) send(res, 500, { error: 'Server error' });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`ForgeAi uploader: http://${loopback ? 'localhost' : HOST}:${PORT}   folder: ${SHARE}   state: ${STATE_DIR}`);
  engine.tick();
  setInterval(() => engine.tick(), 60 * 1000);
});
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { try { releaseShare(engine.dirs); } catch { /* leaving anyway */ } process.exit(0); });
