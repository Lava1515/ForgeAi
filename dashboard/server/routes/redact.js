import crypto from 'node:crypto';

export const GENERIC_ERROR = 'Internal server error';

const SENSITIVE_PATTERNS = [
  [/^[ \t]+at .*$/gm, ''], // Node stack frames
  [/^[ \t]+File ".*", line \d+.*$/gm, ''], // Python traceback frames
  [/file:\/\/\/?\S+/g, '<path>'],
  [/\b[A-Za-z]:\\[^\s"'<>)]+/g, '<path>'],
  [/(?<![\w:/.])\/(?:app|forgeai|usr|home|root|var|tmp|opt|mnt|etc|data|output|Users)\/[^\s"'<>)]*/g, '<path>'],
  [/\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'bearer [redacted]'],
  [/\bbasic\s+(?=[A-Za-z0-9+/]*\d)[A-Za-z0-9+/]{8,}={0,2}/gi, 'basic [redacted]'], // the digit keeps "basic information" readable
  [/\b([\w-]*(?:token|secret|password|passwd|api[_-]?key|authorization))(["']?\s*[=:]\s*["']?)[^\s"',}]+/gi, '$1$2[redacted]'],
  [/AIza[0-9A-Za-z_-]{20,}/g, '[redacted]'],
  [/([?&]key=)[^&\s"']+/gi, '$1[redacted]'],
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[email]'],
];

export function redactLogText(value) {
  let text = String(value ?? '');
  for (const [pattern, replacement] of SENSITIVE_PATTERNS) text = text.replace(pattern, replacement);
  return text.replace(/\n{2,}/g, '\n').trimEnd();
}

/**
 * Handles 5xx errors (500, 502, etc.) generically:
 * - Logs the real cause server-side with status code, request ID, method, and path.
 * - Responds with a generic error message and the request ID, preventing sensitive leaks.
 */
export function sendGeneric5xx(req, res, status, cause, defaultMessage = GENERIC_ERROR) {
  const code = Number.isInteger(status) && status >= 500 ? status : 500;
  if (!req) req = {};
  if (!req.id) {
    req.id = crypto.randomBytes(6).toString('hex');
    try {
      if (res?.setHeader && !res.headersSent) {
        res.setHeader('X-Request-Id', req.id);
      }
    } catch {
      // ignore header write issues
    }
  }
  const requestId = req.id;
  console.error(`[ForgeAI] ${code} requestId=${requestId} ${req.method || ''} ${req.path || ''}:`, cause);
  return res.status(code).json({ error: defaultMessage, requestId });
}
