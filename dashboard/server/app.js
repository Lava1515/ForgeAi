import express from 'express';
import { securityHeaders } from './middleware/securityHeaders.js';
import { networkSecurity } from './middleware/networkSecurity.js';
import { requireAdmin, requireAdminOrService, requireFeedAccess, startFeedSession, warnIfAdminTokenMissing, warnIfServiceTokenMissing } from './middleware/auth.js';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { format } from 'node:util';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getStatusHandler, postControlHandler } from './routes/control.js';
import { getProductsHandler, getMediaHandler, deleteProductHandler, updateProductHandler } from './routes/products.js';
import { sseEventsHandler, activeRunsHandler, broadcastEvent } from './routes/runs.js';
import { onGeminiFallback, clearLastGeminiFallback, resetAgyBlock } from './routes/gemini.js';
import { getAgyHandler, setAgyHandler, agyLoginHandler, agyCallbackHandler, testAgyHandler, setOnAgyLoginSuccess } from './routes/antigravityCli.js';
import { getClaudeHandler, setClaudeHandler, startClaudeLoginHandler, claudeLoginCodeHandler, testClaudeHandler } from './routes/claudeCli.js';
import { getChannelHandler, scanChannelHandler } from './routes/channel.js';
import {
  getGrowthReportHandler,
  refreshGrowthReportHandler,
  getGrowthStrategyHandler,
  updateGrowthStrategyHandler,
  generateGrowthStrategyHandler,
  getGrowthIdeasHandler,
  generateGrowthIdeasHandler,
  getGrowthABChannelHandler,
  setGrowthABChannelHandler,
} from './routes/growthRoutes.js';
import { getServiceStatusHandler, testServiceUrlHandler } from './routes/services.js';
import { youtubeStatusHandler, youtubeConnectHandler, youtubeCallbackHandler, youtubeDisconnectHandler, youtubePublishHandler, youtubeSuggestTagsHandler, youtubeCancelScheduleHandler, youtubeDraftsHandler } from './routes/youtube.js';
import {
  getChannelsHandler,
  getSingleChannelHandler,
  createChannelHandler,
  updateChannelHandler,
  deleteChannelHandler,
  switchChannelHandler,
  researchRulesHandler,
} from './routes/channelsRoutes.js';
import { startCodebuiltHandler, listCodebuiltHandler, getCodebuiltHandler, abortCodebuiltHandler, resumeCodebuiltHandler } from './routes/codebuilt.js';
import { startCodebuiltRunHandler, listCodebuiltRunsHandler, getCodebuiltRunHandler, abortCodebuiltRunHandler } from './routes/codebuiltRuns.js';
import { mountJobArtifacts } from './routes/jobArtifacts.js';
import { researchCandidatesHandler } from './routes/videoResearch.js';

onGeminiFallback((fallback) => {
  broadcastEvent('gemini_fallback', fallback);
  broadcastEvent('log', {
    level: 'warn',
    source: 'GEMINI',
    message: fallback.message || `Gemini HTTP 503: fell back from ${fallback.from_model} to ${fallback.to_model}`,
  });
});
setOnAgyLoginSuccess(() => resetAgyBlock());

// ---- Logging and error hygiene (KAN-443) ----------------------------------------------------------------------
// Every console.warn/error line is mirrored into the log drawer, which any dashboard client can read: no stack
// frames, no file paths, no credential-looking values. docker logs keep the original line.
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

// An Error argument contributes "Name: message", never its stack.
export function formatLogArgs(args) {
  return redactLogText(format(...args.map((a) => (a instanceof Error ? `${a.name}: ${a.message}` : a))));
}

// Mirrors console.warn/error into the drawer (broadcast) and returns a function that puts the console back.
export function installConsoleMirror(broadcast, target = console) {
  let forwarding = false; // broadcast can itself console.error; don't loop
  const originals = {};
  for (const level of ['warn', 'error']) {
    const original = target[level].bind(target);
    originals[level] = target[level];
    target[level] = (...args) => {
      original(...args);
      if (forwarding) return;
      forwarding = true;
      try {
        broadcast('log', { level, source: 'SERVER', message: formatLogArgs(args) });
      } finally {
        forwarding = false;
      }
    };
  }
  return () => Object.assign(target, originals);
}

export const GENERIC_ERROR = 'Internal server error';

// Every request gets an id; a 500 answers only the generic message and that id, the cause goes to the server log.
function serverError(req, res, status, cause) {
  console.error(`[ForgeAI] ${status} requestId=${req.id} ${req.method} ${req.path}:`, cause);
  return res.status(status).json({ error: GENERIC_ERROR, requestId: req.id });
}

export function failClosed500(req, res, next) {
  req.id = crypto.randomBytes(6).toString('hex');
  res.setHeader('X-Request-Id', req.id);
  const answer = (body) => (body?.error === GENERIC_ERROR ? body : (console.error(`[ForgeAI] 500 requestId=${req.id} ${req.method} ${req.path}:`, body?.error ?? body), { error: GENERIC_ERROR, requestId: req.id }));
  const json = res.json.bind(res);
  res.json = (body) => json(res.statusCode === 500 ? answer(body) : body);
  const send = res.send.bind(res);
  res.send = (body) => {
    // res.json calls send with a JSON string; this catches the handlers that send HTML or text on a 500
    if (res.statusCode !== 500 || typeof body !== 'string' || /json/.test(String(res.get('Content-Type')))) return send(body);
    return json(answer(body));
  };
  next();
}

// Express's default handler prints the stack outside production; this one never does.
export function errorMiddleware(err, req, res, next) {
  if (res.headersSent) return next(err);
  const status = Number.isInteger(err?.status) && err.status >= 400 && err.status < 600 ? err.status : 500;
  if (status >= 500) return serverError(req, res, 500, err);
  res.status(status).json({ error: http.STATUS_CODES[status] || 'Bad request' });
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CLIENT_DIST = process.env.CLIENT_DIST || path.resolve(__dirname, '../client/dist');

export function createApp() {
  const app = express();

  app.disable('x-powered-by');
  app.use(failClosed500);
  app.use(securityHeaders());
  app.use(networkSecurity());
  warnIfAdminTokenMissing();
  warnIfServiceTokenMissing();
  app.use(express.json());

  // Channels
  app.get('/api/channels', getChannelsHandler);
  app.get('/api/channels/:id', getSingleChannelHandler);
  app.post('/api/channels', requireAdmin, createChannelHandler);
  app.put('/api/channels/:id', requireAdmin, updateChannelHandler);
  app.delete('/api/channels/:id', requireAdmin, deleteChannelHandler);
  app.post('/api/channels/switch', requireAdmin, switchChannelHandler);
  app.post('/api/channels/research-rules', requireAdmin, researchRulesHandler);
  app.get('/api/channel', getChannelHandler);
  app.post('/api/channel/scan', scanChannelHandler);

  // Code-built videos: one job, or an owner-started batch of 1..10 (background, sequential)
  app.post('/api/codebuilt/start', requireAdmin, startCodebuiltHandler);
  app.get('/api/codebuilt/jobs', listCodebuiltHandler);
  app.get('/api/codebuilt/jobs/:jobId', getCodebuiltHandler);
  app.post('/api/codebuilt/jobs/:jobId/abort', requireAdmin, abortCodebuiltHandler);
  app.post('/api/codebuilt/jobs/:jobId/resume', requireAdmin, resumeCodebuiltHandler);
  app.post('/api/codebuilt/runs', requireAdmin, startCodebuiltRunHandler);
  app.post('/api/video-research', requireAdmin, researchCandidatesHandler);
  app.get('/api/codebuilt/runs', listCodebuiltRunsHandler);
  app.get('/api/codebuilt/runs/:runId', getCodebuiltRunHandler);
  app.post('/api/codebuilt/runs/:runId/abort', requireAdmin, abortCodebuiltRunHandler);
  mountJobArtifacts(app);

  // Status, kill switch, and the model CLI logins
  app.get('/api/status', getStatusHandler);
  app.post('/api/control', requireAdmin, postControlHandler);
  app.post('/api/gemini/dismiss-fallback', (req, res) => {
    clearLastGeminiFallback();
    res.json({ ok: true });
  });
  app.get('/api/agy', getAgyHandler);
  app.put('/api/agy', setAgyHandler);
  app.get('/api/agy/login', agyLoginHandler);
  app.get('/api/agy/callback', agyCallbackHandler);
  app.post('/api/agy/test', testAgyHandler);
  app.get('/api/claude', getClaudeHandler);
  app.put('/api/claude', requireAdmin, setClaudeHandler);
  app.post('/api/claude/login', requireAdmin, startClaudeLoginHandler);
  app.post('/api/claude/login/code', requireAdmin, claudeLoginCodeHandler);
  app.post('/api/claude/test', requireAdmin, testClaudeHandler);

  // Voice and edit service health
  app.get('/api/service/narrative', getServiceStatusHandler);
  app.post('/api/service/test-url', testServiceUrlHandler);

  // Videos and drafts
  app.get('/api/products', getProductsHandler);
  app.delete('/api/products/:draftId', requireAdmin, deleteProductHandler);
  app.patch('/api/products/:draftId', requireAdmin, updateProductHandler);
  app.get('/api/drafts/media/:draftId/:filename', getMediaHandler);

  // Live log feed
  app.get('/api/runs/active', activeRunsHandler);
  app.get('/api/events', requireFeedAccess, sseEventsHandler);
  app.post('/api/events/session', requireAdmin, startFeedSession);

  // YouTube publishing (OAuth sign-in once, then upload drafts)
  app.get('/api/youtube/status', youtubeStatusHandler);
  app.get('/api/youtube/connect', youtubeConnectHandler);
  app.get('/api/youtube/callback', youtubeCallbackHandler);
  app.post('/api/youtube/disconnect', requireAdmin, youtubeDisconnectHandler);
  app.post('/api/youtube/publish/:draftId', requireAdmin, youtubePublishHandler);
  app.post('/api/youtube/tags/:draftId', requireAdmin, youtubeSuggestTagsHandler);
  app.post('/api/youtube/schedule/:draftId/cancel', requireAdmin, youtubeCancelScheduleHandler);
  app.get('/api/youtube/drafts', youtubeDraftsHandler);

  // Growth: per-channel report, strategy and topic ideas
  app.get('/api/growth/report', getGrowthReportHandler);
  app.post('/api/growth/report/refresh', refreshGrowthReportHandler);
  app.get('/api/growth/strategy', getGrowthStrategyHandler);
  app.post('/api/growth/strategy', updateGrowthStrategyHandler);
  app.post('/api/growth/strategy/generate', generateGrowthStrategyHandler);
  app.get('/api/growth/ideas', getGrowthIdeasHandler);
  app.post('/api/growth/ideas/generate', generateGrowthIdeasHandler);
  app.get('/api/growth/ab-channel', getGrowthABChannelHandler);
  app.post('/api/growth/ab-channel', setGrowthABChannelHandler);

  // Serve static client bundle if present
  if (fs.existsSync(CLIENT_DIST)) {
    app.use(express.static(CLIENT_DIST));
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api')) return next();
      res.sendFile(path.join(CLIENT_DIST, 'index.html'));
    });
  }

  app.use(errorMiddleware);

  return app;
}
