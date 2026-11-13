import { redactLogText } from './redact.js';

const sseClients = new Set();
// Ring buffer of recent events so late-connecting or reconnecting clients don't miss anything.
const RECENT_EVENTS = 1000;
const recentEvents = [];
let lastEventId = 0;

// Active runs tracking
const activeRuns = new Map();
const recentTasks = [];
const MAX_RECENT_TASKS = 50;

export function registerActiveRun(runId, info = {}) {
  const task = {
    run_id: runId,
    title: info.title || runId,
    type: info.type || 'pipeline',
    stage: info.stage || 'started',
    stageLabel: info.stageLabel || info.stage || 'Started',
    started_at: info.started_at || new Date().toISOString(),
    updated_at: new Date().toISOString(),
    channel_id: info.channel_id || null,
    params: info.params || null,
    status: 'running',
  };
  activeRuns.set(runId, task);

  const existingIdx = recentTasks.findIndex((t) => t.run_id === runId);
  if (existingIdx >= 0) {
    recentTasks[existingIdx] = { ...recentTasks[existingIdx], ...task };
  } else {
    recentTasks.unshift(task);
    if (recentTasks.length > MAX_RECENT_TASKS) recentTasks.pop();
  }
  return task;
}

export function updateActiveRun(runId, patch = {}) {
  const existing = activeRuns.get(runId);
  if (existing) {
    const updated = {
      ...existing,
      ...patch,
      updated_at: new Date().toISOString(),
    };
    activeRuns.set(runId, updated);

    const rIdx = recentTasks.findIndex((t) => t.run_id === runId);
    if (rIdx >= 0) recentTasks[rIdx] = { ...recentTasks[rIdx], ...updated };
  }
}

export function completeActiveRun(runId, patch = {}) {
  activeRuns.delete(runId);

  const rIdx = recentTasks.findIndex((t) => t.run_id === runId);
  if (rIdx >= 0) {
    recentTasks[rIdx] = {
      ...recentTasks[rIdx],
      ...patch,
      status: patch.status || (patch.stage === 'failed' ? 'failed' : 'completed'),
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
  }
}

export function getActiveRuns() {
  return Array.from(activeRuns.values());
}

export function getRecentTasks() {
  return recentTasks;
}

export function activeRunsHandler(req, res) {
  res.json({
    active_runs: getActiveRuns(),
    recent_tasks: getRecentTasks(),
  });
}

export function broadcastEvent(type, data = {}) {
  // Redact credentials, e-mail addresses, absolute file paths and stack frames before storing or broadcasting
  if (data) {
    if (typeof data.message === 'string') {
      data = { ...data, message: redactLogText(data.message) };
    } else if (data.message instanceof Error) {
      data = { ...data, message: redactLogText(`${data.message.name}: ${data.message.message}`) };
    }
    if (typeof data.error === 'string') {
      data = { ...data, error: redactLogText(data.error) };
    } else if (data.error instanceof Error) {
      data = { ...data, error: redactLogText(`${data.error.name}: ${data.error.message}`) };
    }
  }

  const runId = data?.run_id || data?.draft_id;
  if (runId) {
    if (data.verification) updateActiveRun(runId, { verification: data.verification });
    if (type === 'stage_change') {
      if (data.stage === 'completed' || data.stage === 'failed' || data.stage === 'awaiting_review' || data.stage === 'awaiting_still_review') {
        completeActiveRun(runId, { stage: data.stage, stageLabel: data.label || data.stage, error: data.error, status: data.stage });
      } else {
        updateActiveRun(runId, { stage: data.stage, stageLabel: data.label || data.stage });
      }
    } else if (type === 'complete') {
      completeActiveRun(runId, { status: 'completed', stage: 'completed', stageLabel: 'Complete', ...data });
    } else if (type === 'error') {
      completeActiveRun(runId, { status: 'failed', stage: 'failed', stageLabel: 'Failed', error: data.message || data.error });
    }
  }

  // Log lines carry a level (debug | info | warn | error); the drawer hides debug unless asked.
  if (type === 'log' && !data.level) {
    data = { ...data, level: data.source === 'ERROR' ? 'error' : data.source === 'WARN' ? 'warn' : 'info' };
  }
  // Forwarded factory lines keep the time they were logged, not the time the poll picked them up.
  const payload = JSON.stringify({ type, ...data, data, timestamp: data.timestamp || new Date().toISOString() });
  const id = ++lastEventId;
  recentEvents.push({ id, payload });
  if (recentEvents.length > RECENT_EVENTS) recentEvents.shift();
  for (const client of sseClients) {
    try {
      client.write(`id: ${id}\ndata: ${payload}\n\n`);
    } catch (err) {
      console.error('Error writing to SSE client:', err);
    }
  }
}

export function sseEventsHandler(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });

  res.write(`data: ${JSON.stringify({ type: 'connected', message: 'ForgeAI SSE stream connected' })}\n\n`);
  // A reconnecting EventSource sends Last-Event-ID: resend what it missed.
  const seen = Number(req.headers['last-event-id']);
  const after = seen > 0 ? (seen > lastEventId ? 0 : seen) : (req.query?.replay ? 0 : lastEventId);
  for (const event of recentEvents) {
    if (event.id > after) res.write(`id: ${event.id}\ndata: ${event.payload}\n\n`);
  }
  sseClients.add(res);

  const heartbeat = setInterval(() => {
    res.write(': keepalive\n\n');
  }, 15000);

  req.on('close', () => {
    clearInterval(heartbeat);
    sseClients.delete(res);
  });
}
