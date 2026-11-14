import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getChannelById, getActiveChannel, safeChildDir } from './channelsManager.js';
import { escapeXml } from '../lib/objects.js';
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
      ...(isCodebuiltDraft({ meta }) && { codebuilt_links: safeLinks(draftId, meta.codebuilt.files) }), // KAN-923: editable code/audio/subtitles/contact sheets/report
      ...(generation.visual_check?.approved === false && { visual_check: generation.visual_check }),
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
  res.json(scanDrafts());
}

// Library toggles: { liked, saved, future_upload } (any subset). Publishing to YouTube clears future_upload.
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
  const { liked, saved, future_upload } = req.body || {};
  if (typeof liked === 'boolean') meta.liked = liked;
  if (typeof saved === 'boolean') meta.saved = saved;
  if (typeof future_upload === 'boolean') {
    if (future_upload && !meta.video_file) return res.status(400).json({ error: 'Only videos can be queued for upload.' });
    if (future_upload && meta.youtube) return res.status(409).json({ error: 'Already published to YouTube.' });
    if (future_upload) meta.future_upload_at ||= new Date().toISOString();
    else delete meta.future_upload_at;
  }
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
  res.json({ liked: Boolean(meta.liked), saved: Boolean(meta.saved), future_upload: Boolean(meta.future_upload_at) });
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
