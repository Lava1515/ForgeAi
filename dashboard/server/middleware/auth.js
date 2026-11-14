// One audit line for a blocked probe. console.warn is the existing feed: docker logs keep it and index.js mirrors it, redacted, into the log drawer.
// Never a header value; the detail is quoted and cut to 100 chars. There are no tokens: the dashboard is local only.
export function auditDenied(req, status, what, detail = '') {
  const tail = detail === '' ? '' : ` ${JSON.stringify(String(detail).slice(0, 100))}`;
  console.warn(`[audit] ${status} ${req.method} ${JSON.stringify(req.path)} from ${req.ip || req.socket?.remoteAddress || 'unknown'}: ${what}${tail}`);
}
