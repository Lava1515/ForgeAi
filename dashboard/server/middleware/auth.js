// Service tier: the narrative factory calls POST /api/gemini/ask without a browser, so it sends X-Service-Token == SERVICE_TOKEN.
// SERVICE_TOKEN unset = that route stays open (one startup warning). There is no admin token: the dashboard is local only.
import crypto from 'node:crypto';

// Constant-time compare that does not leak the length: hash both sides, then timingSafeEqual the equal-length digests.
export function tokenMatches(given, expected) {
  const digest = (v) => crypto.createHash('sha256').update(String(v)).digest();
  return !!expected && crypto.timingSafeEqual(digest(given), digest(expected));
}

export const serviceAuthorized = (req) => tokenMatches(req.get('x-service-token') || '', process.env.SERVICE_TOKEN || '');

let serviceWarned = false;
export function warnIfServiceTokenMissing() {
  if (process.env.SERVICE_TOKEN || serviceWarned) return;
  serviceWarned = true;
  console.warn('[auth] SERVICE_TOKEN is not set: POST /api/gemini/ask (Gemini quota) is open to every caller that can reach the dashboard');
}

// One audit line for a blocked probe. console.warn is the existing feed: docker logs keep it and index.js mirrors it, redacted, into the log drawer.
// Never a header value; the detail is quoted and cut to 100 chars.
export function auditDenied(req, status, what, detail = '') {
  const tail = detail === '' ? '' : ` ${JSON.stringify(String(detail).slice(0, 100))}`;
  console.warn(`[audit] ${status} ${req.method} ${JSON.stringify(req.path)} from ${req.ip || req.socket?.remoteAddress || 'unknown'}: ${what}${tail}`);
}
