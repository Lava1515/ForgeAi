// KAN-439: Standard security response headers, CSP in report-only mode, and disable X-Powered-By.
// Sets defense-in-depth headers on all Express responses without breaking the frontend client.

export const DEFAULT_CSP_REPORT_ONLY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: https://i.ytimg.com blob:",
  "media-src 'self' blob:",
  "connect-src 'self'",
  "worker-src 'none'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

export const DEFAULT_X_CONTENT_TYPE_OPTIONS = 'nosniff';
export const DEFAULT_X_FRAME_OPTIONS = 'DENY';
export const DEFAULT_REFERRER_POLICY = 'no-referrer';
export const DEFAULT_PERMISSIONS_POLICY = 'camera=(), microphone=(), geolocation=()';

export const securityHeaders = (options = {}) => {
  const csp = options.contentSecurityPolicyReportOnly ?? DEFAULT_CSP_REPORT_ONLY;
  const xContentTypeOptions = options.xContentTypeOptions ?? DEFAULT_X_CONTENT_TYPE_OPTIONS;
  const xFrameOptions = options.xFrameOptions ?? DEFAULT_X_FRAME_OPTIONS;
  const referrerPolicy = options.referrerPolicy ?? DEFAULT_REFERRER_POLICY;
  const permissionsPolicy = options.permissionsPolicy ?? DEFAULT_PERMISSIONS_POLICY;

  return (req, res, next) => {
    if (csp) res.setHeader('Content-Security-Policy-Report-Only', csp);
    if (xContentTypeOptions) res.setHeader('X-Content-Type-Options', xContentTypeOptions);
    if (xFrameOptions) res.setHeader('X-Frame-Options', xFrameOptions);
    if (referrerPolicy) res.setHeader('Referrer-Policy', referrerPolicy);
    if (permissionsPolicy) res.setHeader('Permissions-Policy', permissionsPolicy);
    res.removeHeader('X-Powered-By');
    next();
  };
};
