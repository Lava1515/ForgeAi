import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { askGemini } from './gemini.js';
import { readLocalState } from './control.js';
import { AUDIENCES, KIDS_SAFETY, freshKidsTrends } from './trends.js';
import { BASE_VIDEO_RULES } from './psychologyResearch.js';
import { getActiveChannel, minimaxH3Enabled, MINIMAX_H3_DISABLED_MESSAGE } from './channelsManager.js';
import { sleep } from '../lib/objects.js';

// Text-to-video pipeline: MiniMax Video-01 (via ComfyUI) rendered directly into the Drafts tab.
// Single scenes (5s/10s) or multi-scene plans (15s-60s) stitched together with ffmpeg.
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = process.env.FORGEAI_ROOT || path.resolve(__dirname, '../../../');
const DRAFTS_DIR = process.env.FORGEAI_DRAFTS_DIR || path.join(REPO_ROOT, 'output/drafts');
export const WORKFLOW_PATH = path.join(REPO_ROOT, 'workflows/comfyui/retired-not-for-public/video_minimax_h3_t2v.json');
const COMFYUI_URL = process.env.COMFYUI_URL || 'http://localhost:8188';
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';

// MiniMax H3 is trained on ~124-362 frames at 24fps (~5-15s); longer single clips are untested by the model authors.
export const VIDEO_LENGTHS = [5, 10, 15];
// Long-form: rendered as consecutive 15s scenes, then joined with ffmpeg.
const LONG_LENGTHS = [60, 120, 180];
export const SCENE_SECONDS = 15;
const POLL_MS = 3000;

export const resolveSeconds = (duration) => {
  const n = Number(duration);
  return VIDEO_LENGTHS.includes(n) || LONG_LENGTHS.includes(n) ? n : VIDEO_LENGTHS[0];
};

export const sceneCount = (seconds) => (seconds > SCENE_SECONDS ? Math.ceil(seconds / SCENE_SECONDS) : 1);

// 5s took ~230s on this GPU and cost grows faster than linearly, plus time queued behind other jobs.
export const renderTimeoutMs = (seconds) => (10 + seconds * 2.5) * 60 * 1000;

export const VIDEO_ENGINES = {
  minimax_h3: { turbo: false, label: 'MiniMax H3 (20 steps)' },
  minimax_h3_turbo: { turbo: true, label: 'MiniMax H3 Turbo (8 steps)' },
};

// Read by the client and the run route; engines are empty while the licence guard is on.
export const videoStatus = () => (minimaxH3Enabled()
  ? { minimax_h3_enabled: true, status: 'ok', message: '', engines: Object.keys(VIDEO_ENGINES) }
  : { minimax_h3_enabled: false, status: 'minimax_h3_disabled', message: MINIMAX_H3_DISABLED_MESSAGE, engines: [] });

// Fills the MiniMax H3 text-to-video graph: prompt, vertical 9:16, length, fresh seed, optional 8-step LoRA.
export function buildVideoWorkflow(prompt, { turbo = false, seed, seconds = VIDEO_LENGTHS[0] } = {}) {
  let wf = {};
  if (fs.existsSync(WORKFLOW_PATH)) {
    wf = JSON.parse(fs.readFileSync(WORKFLOW_PATH, 'utf8'));
  } else {
    wf = {
      '140:131': { inputs: {} },
      '115': { inputs: {} },
      '140:133': { inputs: {} },
      '140:129': { inputs: {} },
      '140:139': { inputs: {} },
      '92': { class_type: 'SaveVideo', inputs: {} },
    };
  }
  wf['140:131'] = wf['140:131'] || { inputs: {} };
  wf['140:131'].inputs.prompt = prompt;
  wf['115'] = wf['115'] || { inputs: {} };
  wf['115'].inputs.aspect_ratio = '9:16 (Portrait Widescreen)';
  wf['140:133'] = wf['140:133'] || { inputs: {} };
  wf['140:133'].inputs.value = seconds;
  wf['140:129'] = wf['140:129'] || { inputs: {} };
  wf['140:129'].inputs.noise_seed = seed ?? Math.floor(Math.random() * 2 ** 48);
  wf['140:139'] = wf['140:139'] || { inputs: {} };
  wf['140:139'].inputs.value = turbo;
  wf['92'] = wf['92'] || { class_type: 'SaveVideo', inputs: {} };
  wf['92'].inputs.filename_prefix = 'video/forgeai';
  return wf;
}

// SaveVideo's history entry shape varies across ComfyUI versions; take the first file it reports.
export function findOutputFile(outputs = {}) {
  if (!outputs) return null;
  for (const value of Object.values(outputs['92'] || {})) {
    if (Array.isArray(value)) {
      const file = value.find((f) => f && typeof f === 'object' && f.filename);
      if (file) return file;
    }
  }
  return null;
}

// ffmpeg concat-demuxer list; single quotes in paths are escaped the way the demuxer expects.
export function buildConcatList(clipPaths) {
  return clipPaths.map((p) => `file '${p.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n') + '\n';
}

// All scenes come from the same workflow (same codec, size, fps), so a stream copy is enough: fast, no re-encode.
async function joinClips(clipPaths, outPath) {
  const listPath = path.join(path.dirname(outPath), 'clips', 'concat.txt');
  fs.writeFileSync(listPath, buildConcatList(clipPaths));
  try {
    await promisify(execFile)(FFMPEG, ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', outPath]);
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error('ffmpeg is not installed. Rebuild the dashboard container, or install ffmpeg / set FFMPEG_PATH when running outside Docker.');
    }
    throw new Error(`ffmpeg join failed: ${(err.stderr || err.message).toString().slice(0, 300)}`);
  }
}

const COPY_RULES = `- caption: max 150 characters, punchy, no hashtags inside.
- hashtags: 5-8 items, each starting with #, mix broad (#fyp, #shorts) and niche.`;

const PROMPT_SHAPE = (seconds) => `visual style line; "Scene overview:" paragraph; "Storyboard:" with timed shots covering 0s-${seconds}s; "Camera:" line; "Audio:" line; end with "No text, subtitles, logos or watermarks of any kind."`;

const conceptBrief = (seconds, videoRules = '') => `You write concepts for ${seconds}-second vertical (9:16) short-form videos for TikTok, YouTube Shorts and Instagram Reels, rendered by the MiniMax H3 text-to-video model (it also generates audio).
Return JSON: {"title": string, "video_prompt": string, "caption": string, "hashtags": string[]}.
- video_prompt: one rich English prompt in this structure: ${PROMPT_SHAPE(seconds)} Strong hook in the first second, framed for vertical 9:16.
- VISUAL & VIDEO PSYCHOLOGICAL RETENTION DIRECTIVES:
${videoRules || BASE_VIDEO_RULES}
Incorporate visual anticipation withholding, delay of visual satisfaction (e.g. keeping uncleaned soap or incomplete motion before resolution), and sensory habituation breakers into the video prompt!
${COPY_RULES}`;

const longBrief = (seconds, scenes, videoRules = '') => `You plan a ${seconds}-second vertical (9:16) video for YouTube Shorts, TikTok and Instagram Reels. It is made of ${scenes} consecutive ${SCENE_SECONDS}-second scenes; each scene is rendered SEPARATELY by the MiniMax H3 text-to-video model (it also generates audio) and the clips are then joined in order.
Because every scene is rendered independently, continuity depends entirely on the prompts.
Return JSON: {"title": string, "caption": string, "hashtags": string[], "style_bible": string, "scenes": [{"summary": string, "video_prompt": string}] (exactly ${scenes} items)}.
- style_bible: 2-4 sentences fixing EXACTLY how the main characters look (species, colors, size, clothing, distinctive features), the setting, the art style, the color palette and the music style.
- Each scenes[i].video_prompt: begins with the style_bible text copied word-for-word, then: ${PROMPT_SHAPE(SCENE_SECONDS)}
- Story: scene 1 hooks within the first second; a clear beginning, middle and satisfying ending across all scenes; each scene ends in a state the next scene picks up from; the music style stays the same throughout.
- VISUAL & VIDEO PSYCHOLOGICAL RETENTION DIRECTIVES:
${videoRules || BASE_VIDEO_RULES}
Incorporate visual anticipation withholding, delay of visual satisfaction, and tension holding before payoff into the storyboard shots!
${COPY_RULES}`;

// Stage 1+2: turn the user's idea (or a trend, in auto mode) into prompt(s) + social copy.
async function writeConcept(idea, isAuto, audience, seconds, emit, channel = null) {
  const kids = AUDIENCES[audience];
  const scenes = sceneCount(seconds);
  const videoRules = channel?.video_psychology_rules || BASE_VIDEO_RULES;
  const brief = scenes > 1 ? longBrief(seconds, scenes, videoRules) : conceptBrief(seconds, videoRules);
  const audienceRules = kids ? `\nAudience: ${kids.brief}\n${KIDS_SAFETY}` : '';
  let instruction;

  let trends = null;
  if (isAuto && kids) {
    trends = await freshKidsTrends(audience).catch((err) => {
      emit('WARN', `Kids trend scan unavailable (${err.message}) Inventing a kid-safe concept instead.`);
      return null;
    });
  }

  if (trends?.concepts?.length) {
    const pick = trends.concepts[Math.floor(Math.random() * trends.concepts.length)];
    emit('RESEARCH', `Kids trend scan (${trends.source === 'youtube' ? 'YouTube data' : 'Gemini web search'}, ${new Date(trends.scanned_at).toLocaleString()}): picked "${pick.title}".`);
    instruction = `${brief}${audienceRules}\nBuild the video from this trend-based concept: "${pick.title}: ${pick.idea}".\nWhat works right now: ${trends.patterns.join('; ')}`;
  } else if (isAuto) {
    instruction = `${brief}${audienceRules}\nInvent ONE concept in a niche that is trending right now on short-form video and is satisfying to rewatch (loops, visual payoff, ASMR-like sound). Be specific and original.`;
  } else {
    instruction = `${brief}${audienceRules}\nThe creator's idea: "${idea}". Stay faithful to it.`;
  }

  try {
    const concept = await askGemini(instruction, scenes > 1 ? { maxTokens: 2048 * Math.ceil(scenes / 3) } : {});
    if (scenes > 1 && concept?.scenes?.length >= scenes) return { ...concept, scenes: concept.scenes.slice(0, scenes) };
    if (scenes === 1 && concept?.video_prompt) return concept;
    if (concept) emit('WARN', `Gemini returned an incomplete plan (${concept.scenes?.length ?? 0}/${scenes} scenes).`);
  } catch (err) {
    emit('WARN', `Gemini concept writer failed: ${err.message}.`);
  }

  if (isAuto || scenes > 1) {
    throw new Error(`${scenes > 1 ? 'Long-form scene plans' : 'Auto video concepts'} need Gemini. Check GEMINI_API_KEY in .env and try again.`);
  }
  emit('WARN', 'GEMINI_API_KEY not set: using your idea as the raw video prompt.');
  return {
    title: idea,
    video_prompt: `${idea}. Vertical 9:16 short-form video, cinematic, natural motion, strong hook in the first second, ${seconds} seconds. No text, subtitles, logos or watermarks of any kind.`,
    caption: idea,
    hashtags: ['#fyp', '#shorts', '#reels', '#aivideo'],
  };
}

// Stage 3: queue on ComfyUI, poll until the clip exists, download it.
export async function renderVideo(prompt, turbo, seconds, runId, emit) {
  if (!minimaxH3Enabled()) throw new Error(MINIMAX_H3_DISABLED_MESSAGE);
  const queued = await fetch(`${COMFYUI_URL}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: buildVideoWorkflow(prompt, { turbo, seconds }), client_id: runId }),
  }).catch(() => {
    throw new Error(`Can't reach ComfyUI at ${COMFYUI_URL}. Is it running?`);
  });
  const queuedData = await queued.json().catch(() => ({}));
  if (!queued.ok || !queuedData.prompt_id) {
    const detail = queuedData.error?.message || JSON.stringify(queuedData.node_errors || queuedData).slice(0, 200);
    throw new Error(`ComfyUI rejected the video workflow: ${detail}`);
  }

  const promptId = queuedData.prompt_id;
  const started = Date.now();
  let lastNotice = started;
  const timeoutMs = renderTimeoutMs(seconds);

  while (Date.now() - started < timeoutMs) {
    const currentState = readLocalState();
    if (currentState?.kill_switch_active || currentState?.status === 'stopped') {
      fetch(`${COMFYUI_URL}/interrupt`, { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } }).catch(() => {});
      throw new Error('Pipeline stopped: Kill switch engaged during ComfyUI rendering.');
    }

    await sleep(POLL_MS);
    const historyRes = await fetch(`${COMFYUI_URL}/history/${promptId}`).catch(() => null);
    if (!historyRes?.ok) continue;
    const history = await historyRes.json();
    const entry = history[promptId];

    const status = entry?.status;
    if (status?.status_str === 'error') {
      const msg = status.messages?.find((m) => m[0] === 'execution_error')?.[1]?.exception_message || 'ComfyUI execution error';
      throw new Error(`ComfyUI video render failed: ${msg}`);
    }

    const file = entry && findOutputFile(entry.outputs);
    if (file) {
      const params = new URLSearchParams({ filename: file.filename, subfolder: file.subfolder || '', type: file.type || 'output' });
      const video = await fetch(`${COMFYUI_URL}/view?${params}`);
      if (!video.ok) throw new Error(`Could not download rendered video: HTTP ${video.status}`);
      emit('COMFYUI', `Render took ${Math.round((Date.now() - started) / 1000)}s (including queue time).`);
      return { buffer: Buffer.from(await video.arrayBuffer()), ext: path.extname(file.filename) || '.mp4' };
    }

    if (Date.now() - lastNotice > 30000) {
      lastNotice = Date.now();
      emit('COMFYUI', `Queued or rendering on ComfyUI... ${Math.round((Date.now() - started) / 1000)}s elapsed.`);
    }
  }
  throw new Error(`Video render timed out after ${timeoutMs / 60000} minutes.`);
}

const formatLength = (seconds) => (seconds >= 60 ? `${seconds / 60} min` : `${seconds}s`);

export async function runVideoPipeline({ runId, idea, isAuto, engine, audience = 'general', duration, channel = null, broadcast }) {
  const emit = (source, message) => broadcast('log', { run_id: runId, source, message });
  const stage = (id, label) => broadcast('stage_change', { run_id: runId, stage: id, label, status: 'in_progress' });
  const turbo = (VIDEO_ENGINES[engine] || VIDEO_ENGINES.minimax_h3).turbo;
  const seconds = resolveSeconds(duration);
  const scenes = sceneCount(seconds);
  const resolvedChannel = channel || getActiveChannel();

  stage('stage1_research', 'Stage 1: Concept Discovery');
  emit('RESEARCH', isAuto
    ? `Auto-Pilot: Inventing a trending ${formatLength(seconds)} video concept${AUDIENCES[audience] ? ` for ${AUDIENCES[audience].label}` : ''}...`
    : `Developing ${formatLength(seconds)} video concept for "${idea}"...`);
  if (scenes > 1) emit('RESEARCH', `Long-form: planning ${scenes} scenes of ${SCENE_SECONDS}s, to be rendered one by one and joined.`);
  const concept = await writeConcept(idea, isAuto, audience, seconds, emit, resolvedChannel);

  stage('stage2_creative', 'Stage 2: Creative Direction');
  emit('CREATIVE', `Concept: "${concept.title}"`);
  if (concept.style_bible) emit('CREATIVE', `Style bible: ${concept.style_bible}`);
  (concept.scenes || []).forEach((s, i) => emit('CREATIVE', `Scene ${i + 1}/${scenes}: ${s.summary}`));
  emit('CREATIVE', `Caption: ${concept.caption}`);
  emit('CREATIVE', `Hashtags: ${(concept.hashtags || []).join(' ')}`);

  const slug = concept.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 25);
  const draftId = `video_${Date.now()}_${slug || 'clip'}`;
  const folder = path.join(DRAFTS_DIR, draftId);
  fs.mkdirSync(folder, { recursive: true });

  stage('stage3_comfyui', 'Stage 3: ComfyUI Video Render');
  let videoFile;
  try {
    if (scenes === 1) {
      emit('COMFYUI', `Queuing MiniMax H3${turbo ? ' Turbo' : ''} (${seconds}s, 9:16) on ComfyUI...`);
      emit('COMFYUI', `Prompt: "${concept.video_prompt.substring(0, 120)}..."`);
      const { buffer, ext } = await renderVideo(concept.video_prompt, turbo, seconds, runId, emit);
      emit('COMFYUI', `Video rendered (${(buffer.length / 1024 / 1024).toFixed(1)} MB).`);
      videoFile = `video${ext}`;
      fs.writeFileSync(path.join(folder, videoFile), buffer);
    } else {
      const clipsDir = path.join(folder, 'clips');
      fs.mkdirSync(clipsDir, { recursive: true });
      const clipPaths = [];
      let ext = '.mp4';
      for (let i = 0; i < scenes; i++) {
        const currentState = readLocalState();
        if (currentState?.kill_switch_active || currentState?.status === 'stopped') {
          throw new Error('Pipeline stopped: Kill switch engaged during scene rendering.');
        }
        emit('COMFYUI', `Scene ${i + 1}/${scenes}: queuing MiniMax H3${turbo ? ' Turbo' : ''} (${SCENE_SECONDS}s)...`);
        const clip = await renderVideo(concept.scenes[i].video_prompt, turbo, SCENE_SECONDS, runId, emit);
        ext = clip.ext;
        const clipPath = path.join(clipsDir, `scene_${String(i + 1).padStart(2, '0')}${clip.ext}`);
        fs.writeFileSync(clipPath, clip.buffer);
        clipPaths.push(clipPath);
        emit('COMFYUI', `Scene ${i + 1}/${scenes} done (${(clip.buffer.length / 1024 / 1024).toFixed(1)} MB).`);
      }
      videoFile = `video${ext}`;
      emit('PACKAGER', `Joining ${scenes} scenes with ffmpeg...`);
      await joinClips(clipPaths, path.join(folder, videoFile));
      emit('PACKAGER', `Joined into one ${formatLength(seconds)} video (${(fs.statSync(path.join(folder, videoFile)).size / 1024 / 1024).toFixed(1)} MB).`);
    }
  } catch (err) {
    const clipsDir = path.join(folder, 'clips');
    const hasClips = fs.existsSync(clipsDir) && fs.readdirSync(clipsDir).some((f) => f.startsWith('scene_'));
    if (hasClips) {
      const failedDir = path.join(DRAFTS_DIR, '..', 'failed', draftId);
      fs.mkdirSync(path.dirname(failedDir), { recursive: true });
      fs.renameSync(folder, failedDir);
      emit('WARN', `Finished scenes kept in output/failed/${draftId}/clips.`);
    } else {
      fs.rmSync(folder, { recursive: true, force: true });
    }
    throw err;
  }

  stage('stage4_packager', 'Stage 4: Social Draft Packager');
  fs.writeFileSync(path.join(folder, 'metadata.json'), JSON.stringify({
    draft_id: draftId,
    channel_id: resolvedChannel?.id || 'default',
    genre: resolvedChannel?.genre || '',
    content_type: 'video',
    video_file: videoFile,
    created_at: new Date().toISOString(),
    listing_copy: { title: concept.title, description: concept.caption, tags: concept.hashtags || [] },
    social: {
      caption: concept.caption,
      hashtags: concept.hashtags || [],
      platforms: ['tiktok', 'youtube_shorts', 'instagram_reels'],
      duration_seconds: seconds,
      audience,
      made_for_kids: Boolean(AUDIENCES[audience]),
      aspect_ratio: '9:16',
    },
    generation_details: {
      model: engine,
      comfyui_prompt: concept.video_prompt || concept.style_bible,
      ...(concept.scenes ? { style_bible: concept.style_bible, scenes: concept.scenes } : {}),
    },
  }, null, 2));
  emit('PACKAGER', `Social draft saved to output/drafts/${draftId} (${videoFile}, metadata.json${scenes > 1 ? ', clips/' : ''}).`);

  return {
    draft_id: draftId,
    channel_id: resolvedChannel?.id || 'default',
    media: 'video',
    duration_seconds: seconds,
    title: concept.title,
    tags: concept.hashtags || [],
    video_url: `/api/drafts/media/${draftId}/${videoFile}`,
  };
}
