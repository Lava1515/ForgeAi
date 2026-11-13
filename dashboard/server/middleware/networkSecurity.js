// KAN-437: Host allowlist (DNS rebinding), cross-site rejection on state-changing methods (CSRF), strict CORS.
// No cookies or login exist, so the controls are reachability controls. Callers that send no Origin (curl, scripts, n8n, the factory,
// the Blender worker) pass untouched: only browsers send Origin / Sec-Fetch-Site, and they are what these checks are for.
import cors from 'cors';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
// dashboard = the compose service name the factory calls (DASHBOARD_URL=http://dashboard:3000); forgeai-dashboard = the container name
const BUILTIN_HOSTS = ['localhost', '127.0.0.1', '[::1]', 'host.docker.internal', 'forgeai-dashboard', 'dashboard'];

// 'Host:Port' or 'host' -> lowercase hostname, or null when it is not a plain host (userinfo, path, junk)
const hostnameOf = (hostHeader) => {
  try { const u = new URL(`http://${hostHeader}`); return u.username || u.password || u.pathname !== '/' ? null : u.hostname; } catch { return null; }
};

// the env list is read per request (ALLOWED_HOSTS=dash.lan,other.example:8080) so it can change without rebuilding the app
const allowedHosts = () => new Set([...BUILTIN_HOSTS, ...(process.env.ALLOWED_HOSTS || '').split(',').map((h) => hostnameOf(h.trim())).filter(Boolean)]);

export const isAllowedHost = (hostHeader) => { const h = hostnameOf(hostHeader); return !!h && allowedHosts().has(h); };

// http(s) Origin whose host is allowlisted, any port ("null", other schemes and foreign hosts fail)
export const isAllowedOrigin = (origin) => {
  try { const u = new URL(origin); return (u.protocol === 'http:' || u.protocol === 'https:') && u.origin === origin && allowedHosts().has(u.hostname); } catch { return false; }
};

function hostGuard(req, res, next) {
  // no Host header at all (HTTP/1.0 scripts) cannot be a browser rebinding attack
  if (req.headers.host === undefined || isAllowedHost(req.headers.host)) return next();
  res.status(421).json({ error: 'Misdirected Request: Host not allowed' });
}

function crossSiteGuard(req, res, next) {
  if (!MUTATING.has(req.method)) return next();
  const { origin } = req.headers;
  if ((origin !== undefined && !isAllowedOrigin(origin)) || req.headers['sec-fetch-site'] === 'cross-site') {
    return res.status(403).json({ error: 'Forbidden: cross-site request' });
  }
  next();
}

const corsOptions = { origin: (origin, cb) => cb(null, !!origin && isAllowedOrigin(origin)) }; // reflect an allowlisted Origin, never '*'

// order matters: Host first (stops rebinding for every method, preflight included), CORS headers, then the state-changing check
export const networkSecurity = () => [hostGuard, cors(corsOptions), crossSiteGuard];
