// KAN-438: admin tier. State-changing, spending and deleting routes need X-Admin-Token == ADMIN_TOKEN.
// No ADMIN_TOKEN configured = routes behave as before (one startup warning), so a fresh checkout keeps working.
// Read-only routes stay open: EventSource and media tags cannot send a header.
import crypto from 'node:crypto';

// Constant-time compare that does not leak the length: hash both sides, then timingSafeEqual the equal-length digests.
export function tokenMatches(given, expected) {
  const digest = (v) => crypto.createHash('sha256').update(String(v)).digest();
  return !!expected && crypto.timingSafeEqual(digest(given), digest(expected));
}

export const adminAuthorized = (req) => tokenMatches(req.get('x-admin-token') || '', process.env.ADMIN_TOKEN || '');

let warned = false;
export function warnIfAdminTokenMissing() {
  if (process.env.ADMIN_TOKEN || warned) return;
  warned = true;
  console.warn('[auth] ADMIN_TOKEN is not set: admin routes (publish, delete, run, control...) are open to every caller that can reach the dashboard');
}

// KAN-525: service tier. The narrative factory calls POST /api/gemini/ask without a browser, so it sends X-Service-Token == SERVICE_TOKEN.
// SERVICE_TOKEN unset = that route stays open as before (one startup warning).
export const serviceAuthorized = (req) => tokenMatches(req.get('x-service-token') || '', process.env.SERVICE_TOKEN || '');

let serviceWarned = false;
export function warnIfServiceTokenMissing() {
  if (process.env.SERVICE_TOKEN || serviceWarned) return;
  serviceWarned = true;
  console.warn('[auth] SERVICE_TOKEN is not set: POST /api/gemini/ask (Gemini quota) is open to every caller that can reach the dashboard');
}

export function requireAdminOrService(req, res, next) {
  if (!process.env.SERVICE_TOKEN || serviceAuthorized(req) || adminAuthorized(req)) return next();
  console.warn(`[auth] 401 ${req.method} ${JSON.stringify(req.path)} from ${req.ip || req.socket?.remoteAddress || 'unknown'}: bad or missing X-Service-Token / X-Admin-Token`);
  res.status(401).json({ error: 'Unauthorized: X-Service-Token or X-Admin-Token required', code: 'service_token_required' });
}

export function requireAdmin(req, res, next) {
  if (!process.env.ADMIN_TOKEN || adminAuthorized(req)) return next();
  // method, path and client address only: never the header value. JSON.stringify keeps control characters out of the log.
  console.warn(`[auth] 401 ${req.method} ${JSON.stringify(req.path)} from ${req.ip || req.socket?.remoteAddress || 'unknown'}: bad or missing X-Admin-Token`);
  res.status(401).json({ error: 'Unauthorized: X-Admin-Token required', code: 'admin_token_required' });
}

// KAN-789 (logging audit M3): one audit line for a rejected admin action or a blocked probe. console.warn is the existing feed:
// docker logs keep it and index.js mirrors it, redacted, into the log drawer. Never a header value; the detail is quoted and cut to 100 chars.
export function auditDenied(req, status, what, detail = '') {
  const tail = detail === '' ? '' : ` ${JSON.stringify(String(detail).slice(0, 100))}`;
  console.warn(`[audit] ${status} ${req.method} ${JSON.stringify(req.path)} from ${req.ip || req.socket?.remoteAddress || 'unknown'}: ${what}${tail}`);
}

// KAN-789 (logging audit M1): the log feed (GET /api/events, replay of the last 1000 events) needs the admin credential once ADMIN_TOKEN is set.
// EventSource cannot send X-Admin-Token and no login or cookie existed, so the smallest safe mechanism is one cookie: POST /api/events/session
// (behind requireAdmin) answers Set-Cookie with expiry + HMAC(ADMIN_TOKEN, expiry): HttpOnly, SameSite=Strict, Path=/api/events, 12 h.
// The raw token never leaves the sessionStorage; rotating ADMIN_TOKEN invalidates every cookie. ADMIN_TOKEN unset = feed stays open (same rule as requireAdmin).
const FEED_COOKIE = 'forgeai_feed';
const FEED_TTL_S = 12 * 60 * 60;
const feedSignature = (exp) => crypto.createHmac('sha256', process.env.ADMIN_TOKEN).update(`events-feed.${exp}`).digest('hex');

function feedCookieValid(req) {
  const raw = String(req.headers.cookie || '').split(';').map((c) => c.trim()).find((c) => c.startsWith(`${FEED_COOKIE}=`));
  if (!raw) return false;
  const [exp, signature = ''] = raw.slice(FEED_COOKIE.length + 1).split('.');
  return /^\d{1,12}$/.test(exp) && Number(exp) > Date.now() / 1000 && tokenMatches(signature, feedSignature(exp));
}

export function requireFeedAccess(req, res, next) {
  if (!process.env.ADMIN_TOKEN || adminAuthorized(req) || feedCookieValid(req)) return next();
  console.warn(`[auth] 401 ${req.method} ${JSON.stringify(req.path)} from ${req.ip || req.socket?.remoteAddress || 'unknown'}: bad or missing X-Admin-Token or feed cookie`);
  res.status(401).json({ error: 'Unauthorized: X-Admin-Token or the log feed session required', code: 'admin_token_required' });
}

export function startFeedSession(req, res) {
  if (process.env.ADMIN_TOKEN) {
    const exp = Math.floor(Date.now() / 1000) + FEED_TTL_S;
    res.setHeader('Set-Cookie', `${FEED_COOKIE}=${exp}.${feedSignature(exp)}; Path=/api/events; HttpOnly; SameSite=Strict; Max-Age=${FEED_TTL_S}`);
  }
  res.json({ ok: true });
}
