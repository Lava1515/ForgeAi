import { verifyStoryPlan, storyPlanTextHash } from './storyVerification.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { postFactory, toLocalPath, factoryStatus } from './factoryClient.js';
import { splitSentences, DEFAULT_VOICE } from './studioPlan.js';
import { getChannelById, getActiveChannel, safeChildDir } from './channelsManager.js';
import { escapeXml } from '../lib/objects.js';
import { isSemanticDraft, semanticGate, semanticReviewOf, issueReceipt, withdrawReceipt } from './semanticReview.js'; // KAN-778
import { isEpisodeDraft, issueEpisodeReceipt, withdrawEpisodeReceipt } from './episodeReview.js'; // KAN-828
import { isCodebuiltDraft, safeLinks } from '../episode/codebuilt/bundle.js'; // KAN-923
import { readCostSummary } from '../perf/creationCost.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = process.env.FORGEAI_ROOT || (fs.existsSync('/forgeai') ? '/forgeai' : path.resolve(__dirname, '../../../'));
const DRAFTS_DIR = process.env.FORGEAI_DRAFTS_DIR || path.join(REPO_ROOT, 'output/drafts');

export function generateSvgPlaceholder(title = 'Preview Not Available', subtitle = 'ForgeAI Autonomous Asset') {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600" viewBox="0 0 600 600" fill="none">
    <rect width="600" height="600" fill="#09090b"/>
    <rect x="24" y="24" width="552" height="552" rx="16" stroke="#27272a" stroke-width="1.5" stroke-dasharray="6 6"/>
    <g transform="translate(300, 240)">
      <circle r="56" fill="#18181b" stroke="#3f3f46" stroke-width="2"/>
      <path d="M-24 -10 L0 -34 L24 -10 L16 26 L-16 26 Z" fill="#10b981" fill-opacity="0.15" stroke="#10b981" stroke-width="2.5" stroke-linejoin="round"/>
      <circle cx="0" cy="0" r="8" fill="#34d399"/>
    </g>
    <text x="300" y="340" fill="#f4f4f5" font-family="system-ui, -apple-system, sans-serif" font-size="16" font-weight="600" text-anchor="middle">${escapeXml(title)}</text>
    <text x="300" y="370" fill="#71717a" font-family="system-ui, -apple-system, sans-serif" font-size="12" font-mono="true" text-anchor="middle">${escapeXml(subtitle)}</text>
    <rect x="230" y="400" width="140" height="28" rx="6" fill="#18181b" stroke="#27272a"/>
    <text x="300" y="418" fill="#10b981" font-family="monospace" font-size="11" font-weight="bold" text-anchor="middle">COMFYUI READY</text>
  </svg>`;
}

export function scanDrafts() {
  if (!fs.existsSync(DRAFTS_DIR)) {
    return [];
  }

  const entries = fs.readdirSync(DRAFTS_DIR, { withFileTypes: true });
  const drafts = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const draftId = entry.name;
    const draftFolder = path.join(DRAFTS_DIR, draftId);
    const metaPath = path.join(draftFolder, 'metadata.json');

    // metadata.json is written last: without it the run is still rendering (or was abandoned), not a product yet
    if (!fs.existsSync(metaPath)) continue;
    let meta;
    try {
      // KAN-547: some writers prepend a UTF-8 BOM, which JSON.parse rejects; strip it, and skip (not crash on) anything unreadable.
      meta = JSON.parse(fs.readFileSync(metaPath, 'utf8').replace(/^﻿/, ''));
    } catch (err) {
      console.error(`Skipping draft ${draftId}: unreadable metadata.json (${err.message})`);
      continue;
    }

    if (meta.status === 'awaiting_review') continue;

    // A draft that names a video it does not have is a failed/test run, not a product: it would show a blank card that cannot play.
    if (meta.video_file) {
      let videoSize = 0;
      try { videoSize = fs.statSync(path.join(draftFolder, path.basename(meta.video_file))).size; } catch {}
      if (videoSize <= 50) continue;
    }

    const graphicFile = path.join(draftFolder, 'graphic.png');
    const graphicSvg = path.join(draftFolder, 'graphic.svg');
    const mockupFile = path.join(draftFolder, 'mockup_placeholder.png');
    const mockupSvg = path.join(draftFolder, 'mockup_placeholder.svg');

    const hasGraphicSvg = fs.existsSync(graphicSvg);
    const hasMockupSvg = fs.existsSync(mockupSvg);
    let hasGraphicPng = false;
    try { hasGraphicPng = fs.statSync(graphicFile).size > 300; } catch {}
    let hasMockupPng = false;
    try { hasMockupPng = fs.statSync(mockupFile).size > 300; } catch {}

    const hasGraphic = hasGraphicPng || hasGraphicSvg;
    const hasMockup = hasMockupPng || hasMockupSvg;

    const product = meta.product || {};
    const listing = meta.listing_copy || {};
    const generation = meta.generation_details || {};

    const isVideo = ['video', 'narrative_video', 'studio_video', 'cutaway3d_video', 'director_video', 'fiction'].includes(meta.content_type) || Boolean(meta.video_file);
    const isAudio = ['voiceover', 'narrative_audio', 'audio'].includes(meta.content_type) || meta.media === 'audio' || Boolean(meta.audio_file);

    let engine = generation.model || meta.engine;
    if (isAudio || meta.content_type === 'voiceover') {
      if (!engine || engine.includes('0.6b') || engine.includes('0.6B') || engine.toLowerCase().includes('qwen3') || engine.includes('1.7B')) {
        engine = 'Qwen3-TTS 1.7B';
      }
    } else if (!engine || engine === 'flux2_klein' || engine === 'turbo') {
      engine = isVideo ? 'Wan2.1' : 'z_image_turbo';
    }

    const hasAudioTrack = Boolean(meta.audio_file) || fs.existsSync(path.join(draftFolder, 'voiceover.wav'));

    drafts.push({
      id: meta.draft_id || draftId,
      cost: readCostSummary(draftFolder),
      folder_name: draftId,
      created_at: meta.created_at || new Date().toISOString(),
      title: listing.title || product.title || draftId,
      price: product.suggested_price || '$28.00',
      garment_type: product.garment_type || (isAudio ? 'audio' : 'apparel'),
      garment_colorway: product.garment_colorway || 'vintage black',
      placement: product.placement || 'front chest',
      visual_style: product.visual_style || (isAudio ? 'studio voiceover' : 'streetwear vector'),
      materials: product.materials || '100% cotton',
      tags: listing.tags || [],
      bullet_points: listing.bullet_points || [],
      description: listing.description || '',
      engine: engine,
      media: isVideo ? 'video' : isAudio ? 'audio' : 'image',
      is_narrative: ['narrative_video', 'studio_video', 'cutaway3d_video', 'director_video', 'fiction'].includes(meta.content_type) || isAudio,
      is_voiceover: isAudio && !isVideo,
      video_url: meta.video_file ? `/api/drafts/media/${draftId}/${meta.video_file}` : null,
      audio_url: hasAudioTrack ? `/api/drafts/media/${draftId}/${meta.audio_file || 'voiceover.wav'}` : null,
      verification: meta.verification || { status: 'not_checked' },
      script: meta.script || '',
      hook: meta.hook || '',
      voice: meta.voice || '',
      instruct: meta.instruct || '',
      dynamic_tone: meta.dynamic_tone !== false,
      tone: meta.tone || '',
      tone_label: meta.tone_label || '',
      sentences: meta.sentences || [],
      caption: meta.social?.caption || '',
      duration_seconds: meta.social?.duration_seconds || meta.duration || null,
      youtube: meta.youtube || null,
      style: meta.style || undefined,
      liked: Boolean(meta.liked),
      saved: Boolean(meta.saved),
      future_upload: Boolean(meta.future_upload_at && !meta.youtube),
      ...(isSemanticDraft({ folder: draftFolder, meta }) && (isEpisodeDraft({ meta }) ? { episode_draft: true } : { semantic_explainer: true })), // KAN-778: only semantic drafts get the key; KAN-828: Episode drafts get episode_draft
      ...(isCodebuiltDraft({ meta }) && { codebuilt_links: safeLinks(draftId, meta.codebuilt.files) }), // KAN-923: editable code/audio/subtitles/contact sheets/report
      comfyui_prompt: generation.comfyui_prompt || '',
      negative_prompt: generation.negative_prompt || '',
      has_graphic: hasGraphic,
      has_mockup: hasMockup,
      graphic_url: hasGraphicSvg ? `/api/drafts/media/${draftId}/graphic.svg` : `/api/drafts/media/${draftId}/graphic.png`,
      mockup_url: hasMockupSvg
        ? `/api/drafts/media/${draftId}/mockup_placeholder.svg`
        : hasMockup 
          ? `/api/drafts/media/${draftId}/mockup_placeholder.png` 
          : `/api/drafts/media/${draftId}/graphic.png`,
      export_status: meta.export_status || { local_disk: true, etsy_draft_created: false }
    });
  }

  // Sort newest first
  return drafts.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
}

export function getProductsHandler(req, res) {
  const drafts = scanDrafts();
  if (!drafts.some((d) => d.semantic_explainer || d.episode_draft)) return res.json(drafts);
  // KAN-778: semantic explainers carry their review status, blockers and source/evidence/preview/QA links.
  return Promise.all(drafts.map(async (d) => (d.semantic_explainer || d.episode_draft ? { ...d, semantic_review: await semanticReviewOf(semanticDraft(d.folder_name)) } : d))).then((all) => res.json(all));
}
function semanticDraft(folderName) {
  const folder = safeChildDir(DRAFTS_DIR, folderName);
  let meta = null;
  try { meta = JSON.parse(fs.readFileSync(path.join(folder, 'metadata.json'), 'utf8').replace(/^﻿/, '')); } catch {}
  return { draftId: folderName, folder, meta };
}

// Library toggles: { liked, saved, future_upload } (any subset). Publishing to YouTube clears future_upload.
// KAN-778: a semantic explainer's future_upload=true needs a current review receipt; { semantic_review: {reviewer, checks} } records one (null withdraws it).
export async function updateProductHandler(req, res) {
  const draftDir = safeChildDir(DRAFTS_DIR, req.params.draftId);
  if (!draftDir) return res.status(400).json({ error: 'Invalid draft id' });
  const metaPath = path.join(draftDir, 'metadata.json');
  let meta;
  try {
    meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  } catch {
    return res.status(404).json({ error: `Draft "${req.params.draftId}" not found` });
  }
  const { liked, saved, future_upload, semantic_review } = req.body || {};
  const draft = { draftId: req.params.draftId, folder: draftDir, meta };
  let semantic;
  if (semantic_review !== undefined) {
    if (!isSemanticDraft(draft)) return res.status(400).json({ error: 'Only a semantic explainer or Episode draft takes a semantic_review.' });
    if (semantic_review === null) (isEpisodeDraft(draft) ? withdrawEpisodeReceipt : withdrawReceipt)(draft);
    else {
      const issued = isEpisodeDraft(draft) ? issueEpisodeReceipt(draft, semantic_review) : await issueReceipt(draft, semantic_review); // KAN-828: Episode dispatch
      if (!issued.ok) return res.status(issued.status).json({ error: issued.error, ...(issued.blockers && { blockers: issued.blockers }) });
    }
    semantic = await semanticReviewOf(draft);
  }
  if (typeof liked === 'boolean') meta.liked = liked;
  if (typeof saved === 'boolean') meta.saved = saved;
  if (typeof future_upload === 'boolean') {
    if (future_upload && !meta.video_file) return res.status(400).json({ error: 'Only videos can be queued for upload.' });
    if (future_upload && meta.youtube) return res.status(409).json({ error: 'Already published to YouTube.' });
    const refusal = future_upload && isSemanticDraft(draft) ? await semanticGate(draft) : null;
    if (refusal) return res.status(409).json(refusal);
    if (future_upload) meta.future_upload_at ||= new Date().toISOString();
    else delete meta.future_upload_at;
  }
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
  res.json({ liked: Boolean(meta.liked), saved: Boolean(meta.saved), future_upload: Boolean(meta.future_upload_at), ...(semantic && { semantic_review: semantic }) });
}

export function deleteProductHandler(req, res) {
  const { draftId } = req.params;
  if (!draftId) {
    return res.status(400).json({ error: 'Draft ID is required' });
  }

  const directPath = safeChildDir(DRAFTS_DIR, draftId);
  if (!directPath) return res.status(400).json({ error: 'Invalid draft id' });
  const safeDraftId = draftId;

  // Check direct folder match
  if (fs.existsSync(directPath) && fs.statSync(directPath).isDirectory()) {
    try {
      fs.rmSync(directPath, { recursive: true, force: true });
      return res.json({ success: true, deleted: safeDraftId });
    } catch (err) {
      console.error(`Error deleting draft directory ${safeDraftId}:`, err);
      return res.status(500).json({ error: 'Failed to delete draft from disk' });
    }
  }

  // If not matched by folder name, scan DRAFTS_DIR for matching metadata.json draft_id
  if (fs.existsSync(DRAFTS_DIR)) {
    const entries = fs.readdirSync(DRAFTS_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const folderPath = path.join(DRAFTS_DIR, entry.name);
      const metaPath = path.join(folderPath, 'metadata.json');
      if (fs.existsSync(metaPath)) {
        try {
          const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
          if (meta.draft_id === safeDraftId) {
            fs.rmSync(folderPath, { recursive: true, force: true });
            return res.json({ success: true, deleted: safeDraftId, folder: entry.name });
          }
        } catch {
          // ignore json parse error
        }
      }
    }
  }

  return res.status(404).json({ error: `Draft "${safeDraftId}" not found` });
}

export function getMediaHandler(req, res) {
  const { draftId, filename } = req.params;

  // Sanitize path to prevent directory traversal
  const safeFilename = path.basename(filename);
  const draftDir = safeChildDir(DRAFTS_DIR, draftId);
  if (!draftDir) return res.status(400).json({ error: 'Invalid draft id' });
  const safeDraftId = draftId;
  const targetFile = path.join(draftDir, safeFilename);

  // If client asks for mockup but the mockup file is empty/placeholder, try graphic.png or svg
  if (safeFilename === 'mockup_placeholder.png' || safeFilename === 'mockup_placeholder.svg') {
    const isMockupValid = fs.existsSync(targetFile) && fs.statSync(targetFile).size > 100;
    if (!isMockupValid) {
      const graphicPng = path.join(draftDir, 'graphic.png');
      const graphicSvg = path.join(draftDir, 'graphic.svg');
      if (fs.existsSync(graphicPng) && fs.statSync(graphicPng).size > 300) {
        res.setHeader('Content-Type', 'image/png');
        res.setHeader('Cache-Control', 'public, max-age=3600');
        return fs.createReadStream(graphicPng).pipe(res);
      }
      if (fs.existsSync(graphicSvg)) {
        res.setHeader('Content-Type', 'image/svg+xml');
        res.setHeader('Cache-Control', 'public, max-age=3600');
        return fs.createReadStream(graphicSvg).pipe(res);
      }
    }
  }

  if (fs.existsSync(targetFile)) {
    const stat = fs.statSync(targetFile);
    if (stat.size > 50) {
      return res.sendFile(targetFile, { maxAge: 3600 * 1000 });
    }
  }

  // Fallback: Send styled dark SVG placeholder with draft title
  res.setHeader('Content-Type', 'image/svg+xml');
  return res.send(generateSvgPlaceholder(safeDraftId.replace(/^draft_\d+_/, ''), safeFilename));
}

/**
 * Regenerates only the voiceover for an unpublished draft.
 * Accepts voice actor selection, custom/preset instruct settings, and dynamic tone flag.
 * If draft contains a video, remuxes video with the new voiceover track.
 */
const regenerating = new Set(); // draft ids with a regenerate in flight

export async function regenerateVoiceoverHandler(req, res) {
  const lockId = path.basename(String(req.params.draftId || ''));
  if (regenerating.has(lockId)) {
    return res.status(409).json({ error: 'A voiceover regeneration is already running for this short.' });
  }
  regenerating.add(lockId);
  try {
    return await regenerateVoiceover(req, res);
  } finally {
    regenerating.delete(lockId);
  }
}

async function regenerateVoiceover(req, res) {
  const { draftId } = req.params;
  if (!draftId) {
    return res.status(400).json({ error: 'Draft ID is required' });
  }

  let draftFolder = safeChildDir(DRAFTS_DIR, draftId);
  if (!draftFolder) return res.status(400).json({ error: 'Invalid draft id' });
  const safeDraftId = draftId;
  let metaPath = path.join(draftFolder, 'metadata.json');

  // If direct folder doesn't exist, search by meta.draft_id
  if (!fs.existsSync(metaPath) && fs.existsSync(DRAFTS_DIR)) {
    const entries = fs.readdirSync(DRAFTS_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const fPath = path.join(DRAFTS_DIR, entry.name);
      const mPath = path.join(fPath, 'metadata.json');
      if (fs.existsSync(mPath)) {
        try {
          const testMeta = JSON.parse(fs.readFileSync(mPath, 'utf8'));
          if (testMeta.draft_id === safeDraftId) {
            draftFolder = fPath;
            metaPath = mPath;
            break;
          }
        } catch {}
      }
    }
  }

  if (!fs.existsSync(metaPath)) {
    return res.status(404).json({ error: `Draft "${safeDraftId}" not found.` });
  }

  let meta;
  try {
    meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  } catch (err) {
    return res.status(500).json({ error: `Failed to read metadata for draft "${safeDraftId}".` });
  }

  // Only allow unpublished drafts (user requirement: "shorts we generated and haven't published yet")
  if (meta.youtube?.video_id) {
    return res.status(409).json({
      error: 'Cannot regenerate voiceover for already published shorts. This short has already been published to YouTube.'
    });
  }

  const isVideo = ['video', 'narrative_video', 'studio_video', 'cutaway3d_video', 'director_video', 'fiction'].includes(meta.content_type) || Boolean(meta.video_file);
  const isAudio = ['voiceover', 'narrative_audio', 'audio'].includes(meta.content_type) || meta.media === 'audio' || Boolean(meta.audio_file);

  if (!isVideo && !isAudio && !fs.existsSync(path.join(draftFolder, 'voiceover.wav')) && !fs.existsSync(path.join(draftFolder, 'video.mp4'))) {
    return res.status(400).json({ error: 'This draft does not contain a video or voiceover track to regenerate.' });
  }

  // Parse and validate voice
  const VOICE_SYNTAX = /^((qwen|fish):)?[A-Za-z0-9_-]+$/;
  let voice = String(req.body.voice || meta.voice || DEFAULT_VOICE).trim().toLowerCase();
  if (voice && !voice.startsWith('qwen:') && !voice.startsWith('fish:')) {
    voice = `qwen:${voice}`;
  }
  if (!VOICE_SYNTAX.test(voice)) {
    return res.status(400).json({ error: `Invalid voice "${voice}".` });
  }

  const instruct = typeof req.body.instruct === 'string' ? req.body.instruct.trim().slice(0, 300) : (meta.instruct || '');
  const dynamicTone = typeof req.body.dynamicTone === 'boolean' ? req.body.dynamicTone : (meta.dynamic_tone !== false);

  const planPath = path.join(draftFolder, 'plan.json');
  const verificationPath = path.join(draftFolder, 'verification.json');
  let storedPlan = null;
  try { storedPlan = JSON.parse(fs.readFileSync(planPath, 'utf8')); } catch {}

  const isFiction = meta.content_type === 'fiction'
    && storedPlan?.video_kind === 'story'
    && Boolean(storedPlan?.story && typeof storedPlan.story === 'object' && !Array.isArray(storedPlan.story));
  const contentMode = isFiction ? 'fiction' : (meta.contentMode || 'factual');
  // A mismatching checkpoint means the current draft has changed outside this
  // operation. Never silently repair that badge while replacing finished media.
  if (fs.existsSync(verificationPath)) {
    let saved;
    try { saved = JSON.parse(fs.readFileSync(verificationPath, 'utf8')); } catch {}
    if (!storedPlan || saved?.textHash !== storyPlanTextHash(storedPlan, { contentMode })) {
      return res.status(409).json({ error: 'Stored verification hash does not match the current text. Recheck the draft in Studio before regenerating voiceover.' });
    }
  }

  // Extract script text / scenes
  let scenes = [];
  if (typeof req.body.script === 'string' && req.body.script.trim()) {
    scenes = splitSentences(req.body.script.trim());
  } else {
    // Try plan.json first
    const planPath = path.join(draftFolder, 'plan.json');
    if (fs.existsSync(planPath)) {
      try {
        const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
        if (Array.isArray(plan.scenes) && plan.scenes.length > 0) {
          scenes = plan.scenes.map((s) => s.text).filter(Boolean);
        }
      } catch {}
    }
    if (scenes.length === 0 && Array.isArray(meta.sentences) && meta.sentences.length > 0) {
      scenes = meta.sentences.map((s) => s.text).filter(Boolean);
    }
    if (scenes.length === 0 && meta.script) {
      scenes = splitSentences(meta.script);
    }
    if (scenes.length === 0 && meta.listing_copy?.description) {
      scenes = splitSentences(meta.listing_copy.description);
    }
    if (scenes.length === 0 && meta.product?.description) {
      scenes = splitSentences(meta.product.description);
    }
  }

  if (scenes.length === 0) {
    return res.status(400).json({ error: 'No script text found for this short to regenerate.' });
  }

  const edited = typeof req.body.script === 'string' && req.body.script.trim();
  const checkedPlan = { ...(storedPlan || {}), contentMode,
    ...(isFiction && { engine: storedPlan?.engine || 'director' }),
    title: storedPlan?.title || meta.listing_copy?.title || meta.product?.title || '',
    script: edited || storedPlan?.script || scenes.join(' '),
    scenes: scenes.map((text, i) => ({ ...(storedPlan?.scenes?.[i] || {}), text })),
  };
  delete checkedPlan.verification;
  const verifyOptions = isFiction ? { contentMode: 'fiction', fictionPolicy: true } : { contentMode };
  const verification = await verifyStoryPlan(checkedPlan, verifyOptions);
  if (verification.status !== 'verified') {
    return res.status(422).json({ error: 'Voiceover text needs story review.', verification, reasons: verification.reasons });
  }
  checkedPlan.verification = verification;

  // Check if narrative factory is available
  const online = await factoryStatus();
  if (!online) {
    return res.status(503).json({
      error: 'Narrative Factory API is offline. Start it with: docker compose up -d narrative-factory'
    });
  }

  // Perform TTS generation
  const targetAudioPath = path.join(draftFolder, 'voiceover.wav');
  const tmpAudioPath = path.join(draftFolder, 'voiceover.tmp.wav');
  const tmpVideoPath = path.join(draftFolder, 'video.tmp.mp4');
  const cleanTmp = () => { for (const f of [tmpAudioPath, tmpVideoPath]) fs.rmSync(f, { force: true }); };
  cleanTmp();
  const channel = meta.channel_id ? getChannelById(meta.channel_id) : getActiveChannel(req);
  const viralV1 = req.body.style === 'viral_v1' || (req.body.style === undefined && (meta.style === 'viral_v1' || channel?.style === 'viral_v1'));
  let ttsResult;
  try {
    ttsResult = await postFactory('/api/tts-timed', {
      run_id: `regen_vo_${path.basename(draftFolder)}_${Date.now()}`,
      scenes,
      voice,
      instruct: instruct || undefined,
      dynamic_tone: dynamicTone,
      ...(viralV1 && { style: 'viral_v1' }),
      output_path: tmpAudioPath,
    });
  } catch (err) {
    cleanTmp();
    console.error(`TTS generation failed for draft ${safeDraftId}:`, err);
    return res.status(502).json({ error: `TTS generation failed: ${err.message}` });
  }

  if (ttsResult.file) {
    const localAudio = toLocalPath(ttsResult.file);
    if (localAudio !== tmpAudioPath && fs.existsSync(localAudio)) {
      try {
        fs.copyFileSync(localAudio, tmpAudioPath);
      } catch (err) {
        console.warn(`Could not copy audio file to ${tmpAudioPath}:`, err);
      }
    }
  }

  // Ensure tmpAudioPath exists if audio was generated remotely
  if (!fs.existsSync(tmpAudioPath) && ttsResult.audio_base64) {
    try {
      fs.writeFileSync(tmpAudioPath, Buffer.from(ttsResult.audio_base64, 'base64'));
    } catch (err) {
      console.warn(`Could not save remote audio_base64 to ${tmpAudioPath}:`, err);
    }
  }
  if (!fs.existsSync(tmpAudioPath)) {
    cleanTmp();
    return res.status(502).json({ error: 'TTS finished but no audio file was produced.' });
  }

  // If draft has video, remux with new audio
  const videoFile = meta.video_file || (fs.existsSync(path.join(draftFolder, 'video.mp4')) ? 'video.mp4' : null);
  const videoPath = videoFile ? path.join(draftFolder, videoFile) : null;
  const hasVideo = Boolean(videoPath) && fs.existsSync(videoPath);
  if (hasVideo) {
    try {
      await postFactory('/api/remux-voiceover', {
        video_path: videoPath,
        audio_path: tmpAudioPath,
        output_path: tmpVideoPath,
        words: ttsResult.words || [],
        title: meta.listing_copy?.title || meta.product?.title || '',
        ...(viralV1 && { style: 'viral_v1' }),
      });
      if (!fs.existsSync(tmpVideoPath)) throw new Error('no remuxed video was produced');
    } catch (err) {
      cleanTmp();
      console.error(`Remux failed for draft ${safeDraftId}:`, err);
      return res.status(502).json({ error: `Video remux failed: ${err.message}. The existing voiceover and video were left unchanged.` });
    }
  }

  // Both steps succeeded: swap the new files in
  try {
    if (hasVideo) fs.renameSync(tmpVideoPath, videoPath);
    fs.renameSync(tmpAudioPath, targetAudioPath);
  } catch (err) {
    cleanTmp();
    return res.status(500).json({ error: `Could not replace the draft files: ${err.message}` });
  }

  // Update metadata
  meta.verification = verification;
  meta.contentMode = contentMode;
  meta.script = checkedPlan.script;
  if (edited && meta.listing_copy) meta.listing_copy.description = checkedPlan.script;
  meta.voice = voice;
  meta.instruct = instruct;
  meta.dynamic_tone = dynamicTone;
  if (ttsResult.duration) {
    meta.duration = ttsResult.duration;
    if (!meta.social) meta.social = {};
    meta.social.duration_seconds = ttsResult.duration;
  }
  if (ttsResult.words) meta.words = ttsResult.words;
  if (ttsResult.sentences) meta.sentences = ttsResult.sentences;
  if (typeof req.body.script === 'string' && req.body.script.trim()) {
    meta.script = req.body.script.trim();
  }
  meta.voiceover_regenerated_at = new Date().toISOString();
  if (Array.isArray(meta.bullet_points)) {
    meta.bullet_points = meta.bullet_points.map((b) =>
      b.startsWith('Voice:') || b.startsWith('Voice: ') ? `Voice: ${voice}` : b
    );
  }
  if (viralV1) {
    meta.style = 'viral_v1';
  } else if (req.body.style !== undefined) {
    delete meta.style;
  }

  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));

  // Commit the checked text/evidence only after TTS and remux succeeded.
  fs.writeFileSync(planPath, JSON.stringify(checkedPlan, null, 2));
  fs.writeFileSync(verificationPath, JSON.stringify(verification, null, 2));

  const folderName = path.basename(draftFolder);
  const allDrafts = scanDrafts();
  const updatedProduct = allDrafts.find((d) => d.id === meta.draft_id || d.folder_name === folderName);

  return res.json({
    status: 'success',
    draftId: meta.draft_id || folderName,
    voice,
    instruct,
    dynamicTone,
    duration: ttsResult.duration,
    audio_url: `/api/drafts/media/${folderName}/voiceover.wav?t=${Date.now()}`,
    video_url: videoFile ? `/api/drafts/media/${folderName}/${videoFile}?t=${Date.now()}` : null,
    product: updatedProduct,
  });
}
