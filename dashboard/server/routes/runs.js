import { readLocalState } from './control.js';
import { runVideoPipeline, videoStatus } from './video.js';
import { runNarrativePipeline } from './narrative.js';
import { DEFAULT_VOICE } from './studioPlan.js';
import { getActiveChannel } from './channelsManager.js';
import { redactLogText } from './redact.js';

const sseClients = new Set();
const MAX_SCRIPT_CHARS = 6000;
const N8N_BASE_URL = process.env.N8N_URL || 'http://localhost:5678';
const N8N_RESEARCH_URL = `${N8N_BASE_URL}/webhook/forgeai/research`;
const N8N_GENERATE_URL = `${N8N_BASE_URL}/webhook/forgeai/generate`;
const N8N_PACKAGE_URL = `${N8N_BASE_URL}/webhook/forgeai/package`;

export const ALLOWED_IMAGE_ENGINES = ['z_image_turbo'];

export function resolveImageEngine(engine) {
  if (!engine || engine === 'flux2_klein' || engine === 'flux2_dev' || engine === 'turbo') {
    return 'z_image_turbo';
  }
  return ALLOWED_IMAGE_ENGINES.includes(engine) ? engine : 'z_image_turbo';
}

// Ring buffer of recent events so late-connecting or reconnecting clients don't miss anything.
const RECENT_EVENTS = 1000;
const recentEvents = [];
let lastEventId = 0;

// Active runs tracking across all pipelines (merch, video, narrative, voiceover, studio)
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

export const videoStatusHandler = (req, res) => res.json(videoStatus());


export async function triggerRunHandler(req, res) {
  const { niche, garment = 'hoodie', engine = 'z_image_turbo', auto = false, media = 'image', audience = 'general', duration, voice = DEFAULT_VOICE, script, captions, instruct } = req.body || {};
  const isVideo = media === 'video';
  const isNarrative = media === 'narrative';

  // Legacy alias: flux2_klein and turbo resolve to z_image_turbo; image engine validated against allow-list
  const resolvedEngine = (!isVideo && !isNarrative)
    ? resolveImageEngine(engine)
    : ((!engine || engine === 'flux2_klein' || engine === 'flux2_dev' || engine === 'turbo') ? 'z_image_turbo' : engine);

  const isAutoNiche = auto === true || (typeof niche === 'string' && niche.trim().toLowerCase() === 'auto');

  // Narrative: a user-supplied script replaces Gemini; ~5 min of speech is ~700 words / ~4500 chars
  if (script !== undefined && (typeof script !== 'string' || script.length > MAX_SCRIPT_CHARS)) {
    return res.status(400).json({ error: `Script must be text of at most ${MAX_SCRIPT_CHARS} characters.` });
  }
  const customScript = isNarrative && typeof script === 'string' ? script.trim() : '';
  const requested = duration == null || duration === '' ? NaN : Number(duration);
  const narrativeSeconds = Number.isFinite(requested) ? Math.min(300, Math.max(1, Math.round(requested))) : 60;

  if (!customScript && !isAutoNiche && (!niche || typeof niche !== 'string' || !niche.trim())) {
    return res.status(400).json({ error: 'Niche search phrase is required.' });
  }

  const resolvedNiche = isAutoNiche ? 'auto' : (niche || '').trim();
  const isAutoGarment = !garment || garment.trim().toLowerCase() === 'auto';
  const resolvedGarment = isAutoGarment ? 'auto' : garment.trim();

  const state = readLocalState();
  if (state.status === 'stopped' || state.kill_switch_active) {
    return res.status(403).json({ error: 'Pipeline is currently STOPPED. Clear kill switch or resume to run.' });
  }

  if (isVideo && !videoStatus().minimax_h3_enabled) {
    return res.status(503).json({ error: videoStatus().message, ...videoStatus() });
  }

  const runId = `run_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  const activeChannel = isVideo ? getActiveChannel(req) : null;

  registerActiveRun(runId, {
    run_id: runId,
    type: isNarrative ? 'narrative' : isVideo ? 'video' : 'merch',
    title: resolvedNiche || resolvedGarment,
    channel_id: activeChannel?.id,
    params: { niche: resolvedNiche, garment: resolvedGarment, engine: resolvedEngine, auto: isAutoNiche, media }
  });

  // Immediately respond to client
  res.json({
    run_id: runId,
    status: 'started',
    params: { niche: resolvedNiche, garment: resolvedGarment, engine: resolvedEngine, auto: isAutoNiche, media,
      ...(isNarrative && { seconds: narrativeSeconds, custom_script: Boolean(customScript), captions: captions !== false }) }
  });

  // Execute full 4-stage pipeline in background asynchronously
  (async () => {
    try {
      // NARRATIVE SHORTS FACTORY: Gemini 150w -> Local Qwen3 TTS -> ComfyUI frames -> FFmpeg NVENC 9:16 short
      if (isNarrative) {
        const result = await runNarrativePipeline({
          runId,
          topic: resolvedNiche,
          script: customScript,
          contentMode: req.body.contentMode || 'factual',
          seconds: narrativeSeconds,
          voice,
          instruct,
          captions: captions !== false,
          style: req.body.style,
          channel: getActiveChannel(req),
          broadcast: broadcastEvent,
        });

        if (result.status === 'awaiting_review') return;
        broadcastEvent('stage_change', { run_id: runId, stage: 'completed', label: 'All Stages Complete', status: 'completed' });
        broadcastEvent('complete', { run_id: runId, ...result, message: `Successfully rendered narrative short "${result.title}".` });
        return;
      }

      // VIDEO PIPELINE: concept -> prompt/caption -> ComfyUI MiniMax H3 -> social draft
      if (isVideo) {
        const result = await runVideoPipeline({ runId, idea: resolvedNiche, isAuto: isAutoNiche, engine: resolvedEngine, audience, duration, channel: activeChannel, broadcast: broadcastEvent });

        broadcastEvent('stage_change', { run_id: runId, stage: 'completed', label: 'All Stages Complete', status: 'completed' });
        broadcastEvent('complete', { run_id: runId, ...result, message: `Successfully rendered "${result.title}".` });
        return;
      }

      // IMAGE PIPELINE: standard 4-stage print-on-demand flow via n8n
      broadcastEvent('stage_change', { run_id: runId, stage: 'stage1_research', label: '1. Market Research' });
      broadcastEvent('log', { run_id: runId, source: 'DISPATCHER', message: `Triggering n8n Stage 1 Research for niche: "${resolvedNiche}"...` });

      const researchPayload = {
        run_id: runId,
        theme: resolvedNiche,
        product_type: resolvedGarment,
        auto: isAutoNiche
      };

      const researchRes = await fetch(N8N_RESEARCH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(researchPayload)
      }).catch(() => { throw new Error('n8n is not running. Start it with: docker compose --profile merch up -d n8n'); });

      if (!researchRes.ok) {
        const errBody = await researchRes.text().catch(() => '');
        throw new Error(`n8n Research Webhook failed with status ${researchRes.status}${errBody ? ': ' + errBody : ''}`);
      }

      const researchData = await researchRes.json();
      const firstConcept = researchData.research_dossier?.sub_niches?.[0] || {};
      const conceptTitle = firstConcept.title || firstConcept.theme_title || researchData.theme || 'Market trend identified';
      const promptToGenerate = firstConcept.comfyui_prompt || firstConcept.title || resolvedNiche;

      broadcastEvent('stage_change', { run_id: runId, stage: 'stage2_creative', label: '2. Creative Direction' });
      broadcastEvent('log', { run_id: runId, source: 'RESEARCH', message: `Stage 1 complete: ${conceptTitle}. Starting Stage 2...` });

      broadcastEvent('stage_change', { run_id: runId, stage: 'stage3_comfyui', label: '3. ComfyUI Diffusion' });
      broadcastEvent('log', { run_id: runId, source: 'COMFYUI', message: `Dispatching to ComfyUI via n8n: "${promptToGenerate.slice(0, 70)}..."` });

      const generateModel = ALLOWED_IMAGE_ENGINES.includes(resolvedEngine) ? resolvedEngine : 'z_image_turbo';

      const generateRes = await fetch(N8N_GENERATE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          run_id: runId,
          idea: promptToGenerate,
          prompt: promptToGenerate,
          comfyui_prompt: promptToGenerate,
          model: generateModel,
          listing_metadata: firstConcept,
          ...researchData
        })
      });

      if (!generateRes.ok) {
        const genErr = await generateRes.text().catch(() => '');
        throw new Error(`n8n Generate Webhook failed with status ${generateRes.status}${genErr ? ': ' + genErr : ''}`);
      }

      const generateData = await generateRes.json();
      broadcastEvent('log', { run_id: runId, source: 'COMFYUI', message: 'Stage 2 & 3 complete: ComfyUI rendered artwork. Finalizing packager...' });

      broadcastEvent('stage_change', { run_id: runId, stage: 'stage4_packager', label: '4. Packaging Draft' });

      const packageRes = await fetch(N8N_PACKAGE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          run_id: runId,
          draft_id: `draft_${runId}`,
          listing_metadata: firstConcept,
          metadata: firstConcept,
          image_base64: generateData.image,
          image: generateData.image,
          garment: resolvedGarment,
          dry_run_etsy: true
        })
      });

      if (!packageRes.ok) {
        const packErr = await packageRes.text().catch(() => '');
        throw new Error(`n8n Package Webhook failed with status ${packageRes.status}${packErr ? ': ' + packErr : ''}`);
      }

      const finalDraft = await packageRes.json();
      const finalTitle = finalDraft.metadata_summary?.title || finalDraft.etsy_draft?.title || conceptTitle;

      broadcastEvent('stage_change', { run_id: runId, stage: 'completed', label: 'All Stages Complete', status: 'completed' });
      broadcastEvent('complete', {
        run_id: runId,
        ...finalDraft,
        title: finalTitle,
        image: generateData.image || finalDraft.image,
        message: `Successfully published draft "${finalTitle}".`
      });

    } catch (err) {
      console.error(`Pipeline run ${runId} error:`, err);
      broadcastEvent('stage_change', { run_id: runId, stage: 'failed', label: 'Pipeline Failed', error: err.message });
      broadcastEvent('log', { run_id: runId, source: 'ERROR', message: `Pipeline aborted: ${err.message}` });
    }
  })();
}

