import React, { useState, useEffect } from 'react';
import { 
  X, 
  Shirt, 
  Tag, 
  Check, 
  Copy, 
  FileText, 
  Trash2,
  Volume2,
  Download,
  Mic,
  RefreshCw
} from 'lucide-react';
import * as api from '../services/api.js';
import PublishYouTube from './PublishYouTube.jsx';

const formatLength = (seconds) => (seconds >= 60 ? `${seconds / 60} min` : `${seconds}s`);

export default function ProductModal({ product, onClose, onDelete, onUpdate }) {
  if (!product) return null;

  const [currentProduct, setCurrentProduct] = useState(product);
  const [activeView, setActiveView] = useState('graphic');
  const [copiedTags, setCopiedTags] = useState(false);
  const [copiedBullets, setCopiedBullets] = useState(false);
  const [copiedPrompt, setCopiedPrompt] = useState(false);
  const [copiedScript, setCopiedScript] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const [showRegenModal, setShowRegenModal] = useState(false);

  useEffect(() => {
    setCurrentProduct(product);
  }, [product]);

  const isVideo = currentProduct.media === 'video';
  // A video always carries a voiceover track, so is_voiceover alone must never pull it into the audio view.
  const isAudio = !isVideo && (currentProduct.media === 'audio' || currentProduct.is_voiceover);
  const isPublished = Boolean(currentProduct.youtube?.video_id);
  const canRegenerate = false; // the regenerate-voiceover dialog was removed with the Voices page (2026-11-13)

  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose?.();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const handleCopy = (text, setFn) => {
    navigator.clipboard.writeText(text);
    setFn(true);
    setTimeout(() => setFn(false), 2000);
  };

  const handleDelete = async () => {
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    setDeleting(true);
    setDeleteError('');
    try {
      await api.deleteProduct(currentProduct.folder_name || currentProduct.id);
      if (onDelete) {
        onDelete(currentProduct.id);
      }
      onClose();
    } catch (err) {
      setDeleteError(`Couldn't delete this draft: ${err.message}`);
      setDeleting(false);
    }
  };

  const handleVoiceoverRegenerated = (updated) => {
    setCurrentProduct(updated);
    if (onUpdate) {
      onUpdate(updated);
    }
  };

  return (
    <div 
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-ink-950/80 backdrop-blur-sm animate-in fade-in duration-200"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose?.();
      }}
    >
      <div 
        role="dialog"
        aria-modal="true"
        aria-labelledby="product-modal-title"
        className="bg-ink-900 border border-ink-800 rounded-2xl max-w-4xl w-full max-h-[90vh] flex flex-col shadow-2xl overflow-hidden"
      >
        {/* Modal Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-ink-800 bg-ink-950/50">
          <div className="flex items-center gap-2.5">
            <span className="p-1.5 rounded-md bg-ember-500/10 text-ember-400 border border-ember-500/20">
              {isAudio ? <Mic className="w-4 h-4" /> : <Shirt className="w-4 h-4" />}
            </span>
            <div>
              <h2 id="product-modal-title" className="text-sm font-semibold text-ink-100 line-clamp-1">{currentProduct.title}</h2>
              <span className="text-[11px] font-mono text-ink-400">ID: {currentProduct.id}</span>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            data-cy="modal-x-close"
            className="p-1.5 rounded-lg text-ink-400 hover:text-ink-100 hover:bg-ink-800 transition"
            aria-label="Close dialog"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Modal Body */}
        <div className="flex-1 overflow-y-auto p-6 grid grid-cols-1 md:grid-cols-12 gap-6">
          {/* Left Column: Visual Asset Preview */}
          <div className="md:col-span-5 flex flex-col space-y-3">
            {isAudio ? (
              <>
                <div className="aspect-square bg-ink-950 border border-ink-800 rounded-xl p-4 flex items-center justify-center relative overflow-hidden">
                  <img
                    src={currentProduct.graphic_url}
                    alt={currentProduct.title}
                    className="max-h-full max-w-full object-contain rounded-lg"
                  />
                </div>

                {currentProduct.audio_url && (
                  <div className="bg-ink-950/80 border border-ink-800 rounded-xl p-3 space-y-2">
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-ember-400 font-mono font-medium flex items-center gap-1.5">
                        <Volume2 className="w-3.5 h-3.5" />
                        Voiceover Audio
                      </span>
                      <div className="flex items-center gap-2">
                        {currentProduct.voice && <span className="text-[11px] text-ink-400 font-mono">{currentProduct.voice}</span>}
                        {canRegenerate && (
                          <button
                            type="button"
                            onClick={() => setShowRegenModal(true)}
                            className="text-[11px] text-ember-400 hover:text-ember-300 flex items-center gap-1 font-mono transition"
                            title="Regenerate Voiceover"
                          >
                            <RefreshCw className="w-3 h-3" />
                            Regen
                          </button>
                        )}
                      </div>
                    </div>
                    <audio controls key={currentProduct.audio_url} src={currentProduct.audio_url} className="w-full h-8" />
                  </div>
                )}

                <div className="bg-ink-950/60 border border-ink-800/80 rounded-xl p-3.5 space-y-2 text-xs">
                  <div className="flex justify-between items-center text-ink-300">
                    <span className="text-ink-400">Media Type:</span>
                    <span className="font-mono font-medium text-ember-400">Standalone Voiceover</span>
                  </div>
                  <div className="flex justify-between items-center text-ink-300">
                    <span className="text-ink-400">Duration:</span>
                    <span className="font-mono font-medium">{currentProduct.duration_seconds ? `${Math.round(currentProduct.duration_seconds)}s` : 'N/A'}</span>
                  </div>
                  <div className="flex justify-between items-center text-ink-300">
                    <span className="text-ink-400">Engine / Model:</span>
                    <span className="font-mono text-ink-400 flex items-center gap-1.5">
                      {currentProduct.engine || 'Qwen3-TTS 1.7B'}
                      {currentProduct.style === 'viral_v1' && (
                        <span className="px-1.5 py-0.5 rounded text-[10px] font-mono font-semibold bg-ember-500/10 text-ember-400 border border-ember-500/20">viral_v1</span>
                      )}
                    </span>
                  </div>
                </div>
              </>
            ) : isVideo ? (
              <>
                <video
                  key={currentProduct.video_url}
                  src={currentProduct.video_url}
                  controls
                  autoPlay
                  loop
                  playsInline
                  className="w-full max-h-[50vh] aspect-[9/16] object-contain bg-ink-950 border border-ink-800 rounded-xl"
                />

                {/* Audio Player if available */}
                {currentProduct.audio_url && (
                  <div className="bg-ink-950/80 border border-ink-800 rounded-xl p-3 space-y-1.5">
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-ember-400 font-mono font-medium flex items-center gap-1.5">
                        <Volume2 className="w-3.5 h-3.5" />
                        Voiceover Audio
                      </span>
                      <div className="flex items-center gap-2">
                        {currentProduct.voice && <span className="text-[11px] text-ink-400 font-mono">{currentProduct.voice}</span>}
                        {canRegenerate && (
                          <button
                            type="button"
                            onClick={() => setShowRegenModal(true)}
                            className="text-[11px] text-ember-400 hover:text-ember-300 flex items-center gap-1 font-mono transition"
                            title="Regenerate Voiceover"
                          >
                            <RefreshCw className="w-3 h-3" />
                            Regen
                          </button>
                        )}
                      </div>
                    </div>
                    <audio controls key={currentProduct.audio_url} src={currentProduct.audio_url} className="w-full h-8" />
                  </div>
                )}

                <div className="bg-ink-950/60 border border-ink-800/80 rounded-xl p-3.5 space-y-2 text-xs">
                  <div className="flex justify-between items-center text-ink-300">
                    <span className="text-ink-400">Format:</span>
                    <span className="font-mono font-medium">9:16 · {formatLength(currentProduct.duration_seconds || 60)} · Audio Sync</span>
                  </div>
                  <div className="flex justify-between items-center text-ink-300">
                    <span className="text-ink-400">Platforms:</span>
                    <span className="font-mono font-medium">TikTok · Shorts · Reels</span>
                  </div>
                  <div className="flex justify-between items-center text-ink-300">
                    <span className="text-ink-400">Engine / Model:</span>
                    <span className="font-mono text-ink-400 flex items-center gap-1.5">
                      {currentProduct.engine}
                      {currentProduct.style === 'viral_v1' && (
                        <span className="px-1.5 py-0.5 rounded text-[10px] font-mono font-semibold bg-ember-500/10 text-ember-400 border border-ember-500/20">viral_v1</span>
                      )}
                    </span>
                  </div>
                </div>
              </>
            ) : (
            <>
            {/* View Switcher */}
            <div className="flex rounded-lg bg-ink-950 p-1 border border-ink-800">
              <button
                type="button"
                onClick={() => setActiveView('graphic')}
                className={`flex-1 py-1.5 text-xs font-medium rounded-md transition ${
                  activeView === 'graphic'
                    ? 'bg-ink-800 text-ink-50 shadow'
                    : 'text-ink-400 hover:text-ink-200'
                }`}
              >
                Cutout PNG
              </button>
              <button
                type="button"
                onClick={() => setActiveView('mockup')}
                className={`flex-1 py-1.5 text-xs font-medium rounded-md transition ${
                  activeView === 'mockup'
                    ? 'bg-ink-800 text-ink-50 shadow'
                    : 'text-ink-400 hover:text-ink-200'
                }`}
              >
                Mockup Preview
              </button>
            </div>

            {/* Canvas */}
            <div className="aspect-square bg-ink-950 border border-ink-800 rounded-xl p-4 flex items-center justify-center relative overflow-hidden">
              {activeView === 'mockup' ? (
                <div className="w-[90%] h-[90%] rounded-2xl bg-gradient-to-b from-ink-900 to-ink-950 border border-ink-800 shadow-2xl flex items-center justify-center p-4 relative overflow-hidden">
                  <div className="absolute top-3 w-16 h-3.5 border-b-2 border-ink-700/60 rounded-b-full"></div>
                  <img
                    src={currentProduct.graphic_url}
                    alt={currentProduct.title}
                    className="max-h-[75%] max-w-[75%] object-contain drop-shadow-[0_16px_32px_rgba(0,0,0,0.9)]"
                  />
                  <div className="absolute bottom-2.5 right-2.5 text-[10px] font-mono text-ink-400 uppercase tracking-widest bg-ink-900/90 border border-ink-800 px-2 py-0.5 rounded">
                    {currentProduct.garment_type}
                  </div>
                </div>
              ) : (
                <img
                  src={currentProduct.graphic_url}
                  alt={currentProduct.title}
                  className="max-h-full max-w-full object-contain"
                />
              )}
            </div>

            {/* Quick Garment Specs */}
            <div className="bg-ink-950/60 border border-ink-800/80 rounded-xl p-3.5 space-y-2 text-xs">
              <div className="flex justify-between items-center text-ink-300">
                <span className="text-ink-400">Garment Type:</span>
                <span className="font-mono font-medium capitalize">{currentProduct.garment_type}</span>
              </div>
              <div className="flex justify-between items-center text-ink-300">
                <span className="text-ink-400">Colorway:</span>
                <span className="font-mono font-medium capitalize">{currentProduct.garment_colorway}</span>
              </div>
              <div className="flex justify-between items-center text-ink-300">
                <span className="text-ink-400">Placement:</span>
                <span className="font-mono font-medium capitalize">{currentProduct.placement}</span>
              </div>
              <div className="flex justify-between items-center text-ink-300">
                <span className="text-ink-400">Price Target:</span>
                <span className="font-mono font-semibold text-ember-400">{currentProduct.price}</span>
              </div>
              <div className="flex justify-between items-center text-ink-300">
                <span className="text-ink-400">Engine / Model:</span>
                <span className="font-mono text-ink-400">{currentProduct.engine}</span>
              </div>
            </div>
            </>
            )}
          </div>

          {/* Right Column: Listing Copy & SEO Dossier */}
          <div className="md:col-span-7 flex flex-col space-y-5">
            {/* Title & Price */}
            <div>
              <div className="text-[11px] font-mono text-ink-400 uppercase tracking-wider mb-1 flex items-center gap-1.5">
                <FileText className="w-3.5 h-3.5 text-ember-400" />
                {isAudio ? 'Narration Title' : isVideo ? 'Social Caption' : 'Etsy Listing Copy'}
              </div>
              <h3 className="text-2xl font-light tracking-tight text-ink-50">{currentProduct.title}</h3>
              {isVideo && currentProduct.caption && (
                <p className="mt-2 text-sm text-ink-300 leading-relaxed">{currentProduct.caption}</p>
              )}
            </div>

            {isVideo && currentProduct.video_url && <PublishYouTube product={currentProduct} />}

            {/* Spoken Script (for narrative shorts & voiceover) */}
            {currentProduct.script && (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-ink-300 flex items-center gap-1.5">
                    <Volume2 className="w-3.5 h-3.5 text-ember-400" />
                    Spoken Script
                  </span>
                  <button
                    type="button"
                    onClick={() => handleCopy(currentProduct.script, setCopiedScript)}
                    className="text-[11px] text-ink-400 hover:text-ink-200 font-mono flex items-center gap-1"
                  >
                    {copiedScript ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                    <span>{copiedScript ? 'Copied' : 'Copy'}</span>
                  </button>
                </div>
                <div className="p-3 rounded-xl bg-ink-950/70 border border-ink-800 text-xs text-ink-200 leading-relaxed max-h-48 overflow-y-auto font-mono">
                  {currentProduct.hook && (
                    <div className="text-ember-400 font-medium mb-1">🎣 {currentProduct.hook}</div>
                  )}
                  {currentProduct.script}
                </div>
              </div>
            )}

            {/* Bullet Points / Feature Highlights */}
            {currentProduct.bullet_points && currentProduct.bullet_points.length > 0 && (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-ink-300">
                    {isAudio ? 'Audio Specifications' : isVideo ? 'Video Highlights' : 'Feature Bullets'}
                  </span>
                  <button
                    type="button"
                    onClick={() => handleCopy(currentProduct.bullet_points.join('\n'), setCopiedBullets)}
                    className="text-[11px] text-ink-400 hover:text-ink-200 font-mono flex items-center gap-1"
                  >
                    {copiedBullets ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                    <span>{copiedBullets ? 'Copied' : 'Copy'}</span>
                  </button>
                </div>
                <ul className="space-y-1.5 text-xs text-ink-300 bg-ink-950/40 p-3 rounded-xl border border-ink-800/80">
                  {currentProduct.bullet_points.map((bullet, idx) => (
                    <li key={idx} className="flex items-start gap-2">
                      <span className="text-ember-500 font-mono">•</span>
                      <span>{bullet}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* Tags / Search Terms */}
            {currentProduct.tags && currentProduct.tags.length > 0 && (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-ink-300 flex items-center gap-1.5">
                    <Tag className="w-3.5 h-3.5 text-ember-400" />
                    <span>Search Tags ({currentProduct.tags.length})</span>
                  </span>
                  <button
                    type="button"
                    onClick={() => handleCopy(currentProduct.tags.join(', '), setCopiedTags)}
                    className="text-[11px] text-ink-400 hover:text-ink-200 font-mono flex items-center gap-1"
                  >
                    {copiedTags ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                    <span>{copiedTags ? 'Copied' : 'Copy All'}</span>
                  </button>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {currentProduct.tags.map((tag, idx) => (
                    <span
                      key={idx}
                      className="px-2 py-0.5 rounded-md bg-ink-950 border border-ink-800 text-[11px] text-ink-300 font-mono"
                    >
                      {tag}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* ComfyUI / Generation Prompt (Expandable) */}
            {currentProduct.comfyui_prompt && (
              <div className="space-y-1.5 pt-2 border-t border-ink-800/60">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-mono text-ink-400 uppercase tracking-wider">Raw Image Prompt</span>
                  <button
                    type="button"
                    onClick={() => handleCopy(currentProduct.comfyui_prompt, setCopiedPrompt)}
                    className="text-[10px] text-ink-400 hover:text-ink-200 font-mono flex items-center gap-1"
                  >
                    {copiedPrompt ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                    <span>{copiedPrompt ? 'Copied' : 'Copy Prompt'}</span>
                  </button>
                </div>
                <p className="text-[11px] font-mono text-ink-400 bg-ink-950 p-2.5 rounded-lg border border-ink-800 line-clamp-3 hover:line-clamp-none transition-all">
                  {currentProduct.comfyui_prompt}
                </p>
              </div>
            )}
          </div>
        </div>

        {/* Modal Footer Controls */}
        <div className="px-6 py-4 border-t border-ink-800 bg-ink-950/50 flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleDelete}
              disabled={deleting}
              className={`btn text-xs flex items-center gap-1.5 ${
                confirmDelete 
                  ? 'bg-rose-500 text-ink-950 hover:bg-rose-400 font-semibold' 
                  : 'btn-secondary text-rose-400 hover:text-rose-300 hover:border-rose-500/40'
              }`}
            >
              <Trash2 className="w-3.5 h-3.5" />
              <span>{deleting ? 'Deleting...' : confirmDelete ? 'Confirm Delete' : 'Delete Draft'}</span>
            </button>
            {deleteError && <span className="text-xs text-rose-400">{deleteError}</span>}
          </div>

          <div className="flex items-center gap-3">
            {canRegenerate && (
              <button
                type="button"
                onClick={() => setShowRegenModal(true)}
                className="btn btn-secondary text-xs flex items-center gap-1.5 border-ember-500/30 text-ember-300 hover:border-ember-500/60"
              >
                <Mic className="w-3.5 h-3.5 text-ember-400" />
                <span>Regenerate Voiceover</span>
              </button>
            )}
            {isAudio && currentProduct.audio_url && (
              <a
                href={currentProduct.audio_url}
                download={`${(currentProduct.title || 'voiceover').toLowerCase().replace(/\s+/g, '_')}.wav`}
                className="btn btn-secondary text-xs flex items-center gap-1.5"
              >
                <Download className="w-3.5 h-3.5" />
                <span>Download WAV</span>
              </a>
            )}
            <a
              href={currentProduct.video_url || currentProduct.audio_url || currentProduct.graphic_url}
              download
              target="_blank"
              rel="noopener noreferrer"
              className="btn btn-primary text-xs flex items-center gap-1.5"
            >
              <span>Download Primary Asset</span>
            </a>
          </div>
        </div>
      </div>

    </div>
  );
}
