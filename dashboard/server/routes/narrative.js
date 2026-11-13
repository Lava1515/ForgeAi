import { checkNarration, uncheckedFactoryStory } from './storyGate.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FACTORY_URL, factoryStatus, postFactory, toLocalPath } from './factoryClient.js';
import { DEFAULT_VOICE, WORDS_PER_SECOND, voiceLabel } from './studioPlan.js';
import { getActiveChannel, sanitizeVoiceoverPsychologyRules } from './channelsManager.js';
import { createTimings } from '../perf/stageTimings.js';
import { escapeXml } from '../lib/objects.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = process.env.FORGEAI_ROOT || path.resolve(__dirname, '../../../');
const DRAFTS_DIR = process.env.FORGEAI_DRAFTS_DIR || path.join(REPO_ROOT, 'output/drafts');

export const NARRATIVE_TOPIC_SUGGESTIONS = [
  'The Lost Cosmonaut of 1961',
  'The Dyatlov Pass Incident',
  'The Voynich Manuscript Mystery',
  'The Silurian Hypothesis: An Ancient Earth Civilization',
  'The Dark Flow: Anomaly Beyond the Visible Universe',
  'The Oak Island Money Pit Vault',
  'Cicada 3301: The Internet Unsolved Puzzle',
  'The Disappearance of the Flannan Isle Lighthouse Keepers'
];

export async function runNarrativePipeline({
  runId,
  topic,
  script,
  voice = DEFAULT_VOICE,
  seconds = 60,
  isAuto = false,
  captions = true,
  instruct,
  style = null,
  channel = null,
  contentMode = 'factual',
  broadcast = () => {},
  policy = null,
  postFactory: postFactoryArg = postFactory,
  factoryStatus: factoryStatusArg = factoryStatus,
}) {
  const emit = (source, message) => {
    broadcast('log', { run_id: runId, source, message });
  };

  const effectivePolicy = policy && typeof policy === 'object' ? policy : (channel?.policy && typeof channel.policy === 'object' ? channel.policy : {});
  const tm = createTimings({ enabled: effectivePolicy.timings_detail_v1 === true });
  let factoryPost = postFactoryArg;
  factoryPost = tm.wrap((route) => ({
    provider: 'factory',
    kind: route,
    note: (r) => (r?.timings_detail && typeof r.timings_detail === 'object' ? { detail: r.timings_detail } : null),
  }), factoryPost);
  const timingsDetail = tm.enabled ? { timings_detail: true } : {};
  const stage = (id, label) => {
    tm.stage(id);
    broadcast('stage_change', { run_id: runId, stage: id, label });
  };

  if (!(await factoryStatusArg())) {
    throw new Error(`Narrative Factory API is offline at ${FACTORY_URL}. Start it with: docker compose up -d narrative-factory`);
  }
  emit('DISPATCHER', `Connected to Narrative Factory API at ${FACTORY_URL}`);

  let customScript = (script || '').trim();
  let resolvedTopic = (topic || '').trim();
  if (!customScript && (isAuto || !resolvedTopic || resolvedTopic.toLowerCase() === 'auto')) {
    resolvedTopic = NARRATIVE_TOPIC_SUGGESTIONS[Math.floor(Math.random() * NARRATIVE_TOPIC_SUGGESTIONS.length)];
    emit('AUTO_PILOT', `Picked topic from the built-in list: "${resolvedTopic}".`);
  }

  stage('stage1_research', customScript ? '1. Your Script' : '1. Gemini Script');
  if (customScript) {
    const words = customScript.split(/\s+/).length;
    emit('SCRIPT', `Using your script: ${words} words (~${Math.round(words / WORDS_PER_SECOND)}s of voice-over). No Gemini call.`);
  } else {
    emit('SCRIPT', `Gemini is writing a ${seconds}s script for "${resolvedTopic}"...`);
  }


  const draftFolder = path.join(DRAFTS_DIR, runId);
  let verification;
  if (customScript) {
    const checked = await checkNarration({ script: customScript, title: resolvedTopic, contentMode, draftFolder, runId, broadcast });
    if (checked.review) return checked.review;
    customScript = checked.plan.script;
    verification = checked.verification;
  } else {
    verification = uncheckedFactoryStory(runId, broadcast);
  }

  stage('stage2_creative', '2. Voice-over & Frames');
  emit('FACTORY', `Rendering: ${voiceLabel(voice)} voice-over -> ComfyUI scene frames -> NVENC 9:16 video${captions ? ' + punch captions' : ''}. Longer scripts take several minutes.`);

  const activeChan = channel || getActiveChannel();
  const viralV1 = style === 'viral_v1' || (Boolean(style) ? false : activeChan?.style === 'viral_v1');
  const result = await factoryPost('/api/run-pipeline', {
    run_id: runId,
    topic: resolvedTopic || undefined,
    script: customScript || undefined,
    seconds,
    voice,
    captions,
    instruct: instruct || undefined,
    psychology_rules: sanitizeVoiceoverPsychologyRules(activeChan?.voiceover_psychology_rules) || undefined,
    video_rules: activeChan?.video_psychology_rules || undefined,
    genre: activeChan?.genre || undefined,
    ...(viralV1 && { style: 'viral_v1' }),
    ...timingsDetail,
  });
  const scriptData = result.script;
  const audioDuration = result.duration || seconds;
  const wordCount = (scriptData.full_script || '').split(/\s+/).length;
  emit('SCRIPT', `"${scriptData.title}" (${wordCount} words, ${result.scenes_count} scenes, ${audioDuration.toFixed(1)}s).`);

  stage('stage4_packager', '4. Packaging');
  fs.mkdirSync(draftFolder, { recursive: true });
  fs.copyFileSync(toLocalPath(result.video_path), path.join(draftFolder, 'video.mp4'));
  fs.copyFileSync(toLocalPath(result.audio_path), path.join(draftFolder, 'voiceover.wav'));
  fs.writeFileSync(path.join(draftFolder, 'script.json'), JSON.stringify(scriptData, null, 2));

  // Generate thumbnail graphic.svg
  const graphicPath = path.join(draftFolder, 'graphic.svg');
  const mockupPath = path.join(draftFolder, 'mockup_placeholder.svg');
  
  const thumbnailSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600" viewBox="0 0 600 600">
    <rect width="600" height="600" fill="#090d16"/>
    <rect x="20" y="20" width="560" height="560" rx="24" fill="#111827" stroke="#ff5a1f" stroke-width="2" stroke-opacity="0.4"/>
    <circle cx="300" cy="240" r="64" fill="#ff5a1f" fill-opacity="0.15"/>
    <polygon points="285,210 285,270 330,240" fill="#ff5a1f"/>
    <text x="300" y="360" fill="#ffffff" font-size="20" font-family="system-ui, sans-serif" font-weight="bold" text-anchor="middle">${escapeXml(scriptData.title)}</text>
    <text x="300" y="395" fill="#9ca3af" font-size="13" font-family="monospace" text-anchor="middle">1080x1920 (9:16) · ${escapeXml(voiceLabel(voice))}</text>
    <rect x="220" y="430" width="160" height="32" rx="16" fill="#ff5a1f" fill-opacity="0.2" stroke="#ff5a1f" stroke-width="1"/>
    <text x="300" y="451" fill="#ff7849" font-size="12" font-family="monospace" font-weight="bold" text-anchor="middle">${Math.round(audioDuration)}s VOICE-OVER</text>
  </svg>`;
  fs.writeFileSync(graphicPath, thumbnailSvg);
  fs.writeFileSync(mockupPath, thumbnailSvg);

  // Write complete metadata.json
  const metadata = {
    draft_id: runId,
    content_type: 'narrative_video',
    verification, contentMode,
    created_at: new Date().toISOString(),
    product: {
      title: scriptData.title,
      suggested_price: '$0.00',
      garment_type: 'video_short',
      visual_style: 'cinematic vertical 9:16',
      placement: 'tiktok_reels_shorts'
    },
    listing_copy: {
      title: scriptData.title,
      tags: ['#storytime', '#mystery', '#historicalmystery', '#scifi', '#fyp', '#shorts', '#viral'],
      description: scriptData.full_script,
      bullet_points: [
        `Hook: "${scriptData.hook}"`,
        `Spoken Word Count: ${wordCount} words`,
        `Voiceover: ${voiceLabel(voice)}`,
        `Target Duration: ${seconds}s`,
        `Resolution: 1080x1920 (9:16 Vertical)`
      ]
    },
    social: {
      caption: `${scriptData.hook} Full story in video! #mystery #history #fyp`,
      hashtags: ['#mystery', '#history', '#storytime', '#viral', '#fyp', '#shorts'],
      duration_seconds: audioDuration
    },
    video_file: 'video.mp4',
    audio_file: 'voiceover.wav',
    script: scriptData.full_script,
    hook: scriptData.hook,
    voice: voice,
    instruct: instruct || undefined,
    ...(viralV1 && { style: 'viral_v1' }),
  };
  fs.writeFileSync(path.join(draftFolder, 'metadata.json'), JSON.stringify(metadata, null, 2));
  tm.save(path.join(draftFolder, 'metadata.json'));

  emit('COMPLETE', `Finished "${scriptData.title}": video.mp4 + voiceover.wav.`);

  return {
    verification,
    draft_id: runId,
    title: scriptData.title,
    video_url: `/api/drafts/media/${runId}/video.mp4`,
    audio_url: `/api/drafts/media/${runId}/voiceover.wav`,
    graphic_url: `/api/drafts/media/${runId}/graphic.svg`,
    script: scriptData.full_script,
    hook: scriptData.hook,
    voice: voice,
    duration: audioDuration
  };
}
