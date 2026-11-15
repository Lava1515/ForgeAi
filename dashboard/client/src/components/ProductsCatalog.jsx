import React, { useState, useEffect } from 'react';
import { 
  Shirt, 
  Image as ImageIcon, 
  Tag, 
  Copy, 
  Check, 
  Search, 
  RefreshCw,
  Package,
  Trash2,
  Heart,
  Bookmark,
  CalendarClock
} from 'lucide-react';
import ProductModal from './ProductModal.jsx';
import * as api from '../services/api.js';
import PageHeader from '../ui/PageHeader.jsx';
import Panel from '../ui/Panel.jsx';
import Button from '../ui/Button.jsx';
import Badge from '../ui/Badge.jsx';
import EmptyState from '../ui/EmptyState.jsx';
import Banner from '../ui/Banner.jsx';

const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'saved', label: 'Saved' },
  { id: 'liked', label: 'Liked' },
  { id: 'future_upload', label: 'Future uploads' },
];

const FLAGS = [
  { key: 'liked', icon: Heart, on: 'text-rose-400', label: 'Like' },
  { key: 'saved', icon: Bookmark, on: 'text-amber-300', label: 'Save' },
  { key: 'future_upload', icon: CalendarClock, on: 'text-ember-400', label: 'Future upload', videoOnly: true },
];

const PAGE_SIZE = 24;

export default function ProductsCatalog() {
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const [globalView, setGlobalView] = useState('graphic');
  const [selectedProduct, setSelectedProduct] = useState(null);
  const [copiedId, setCopiedId] = useState(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);
  const [deletingId, setDeletingId] = useState(null);
  const [deleteError, setDeleteError] = useState('');
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [loadError, setLoadError] = useState('');

  const loadProducts = async () => {
    setLoading(true);
    setLoadError('');
    try {
      const data = await api.getProducts();
      setProducts(Array.isArray(data) ? data : []);
    } catch (err) {
      console.error('Failed to load library:', err);
      setLoadError(`Couldn't load the library: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadProducts();
  }, []);

  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
  }, [filter, search]);

  const handleCopyTags = (e, product) => {
    e.stopPropagation();
    const tagsString = (product.tags || []).join(', ');
    navigator.clipboard.writeText(tagsString);
    setCopiedId(product.id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const handleDeleteProduct = async (e, product) => {
    e.stopPropagation();
    if (confirmDeleteId !== product.id) {
      setConfirmDeleteId(product.id);
      return;
    }

    setDeletingId(product.id);
    setDeleteError('');
    try {
      await api.deleteProduct(product.folder_name || product.id);
      setProducts((prev) => prev.filter((p) => p.id !== product.id));
      if (selectedProduct?.id === product.id) {
        setSelectedProduct(null);
      }
    } catch (err) {
      setDeleteError(`Couldn't delete "${product.title || product.id}": ${err.message}`);
    } finally {
      setDeletingId(null);
      setConfirmDeleteId(null);
    }
  };

  const toggleFlag = async (e, product, key) => {
    e.stopPropagation();
    setDeleteError('');
    try {
      const flags = await api.updateProduct(product.folder_name || product.id, { [key]: !product[key] });
      setProducts((prev) => prev.map((p) => (p.id === product.id ? { ...p, ...flags } : p)));
    } catch (err) {
      setDeleteError(`Couldn't update "${product.title || product.id}": ${err.message}`);
    }
  };

  const handleProductDeleted = (deletedId) => {
    setProducts((prev) => prev.filter((p) => p.id !== deletedId));
    if (selectedProduct?.id === deletedId) {
      setSelectedProduct(null);
    }
  };

  const filtered = products.filter((p) => {
    if (filter !== 'all' && !p[filter]) return false;
    const q = search.toLowerCase();
    const titleMatch = (p.title || '').toLowerCase().includes(q);
    const garmentMatch = (p.garment_type || '').toLowerCase().includes(q);
    const tagMatch = (p.tags || []).some((t) => t.toLowerCase().includes(q));
    return titleMatch || garmentMatch || tagMatch;
  });

  const displayed = filtered.slice(0, visibleCount);

  return (
    <div className="space-y-6">
      {/* PageHeader */}
      <PageHeader
        eyebrow="Everything you've made"
        title="Library"
        badge={
          <Badge tone="neutral">
            {loading && products.length === 0 ? 'Loading...' : filtered.length}
          </Badge>
        }
        actions={
          <Button
            variant="ghost"
            size="sm"
            icon={RefreshCw}
            loading={loading}
            onClick={loadProducts}
            title="Refresh library"
            aria-label="Refresh library"
            className="min-h-[36px] h-9"
          >
            Refresh
          </Button>
        }
      />

      {loadError && (
        <Banner tone="error" action={<button type="button" onClick={loadProducts} className="chip min-h-[32px] h-8 text-xs">Retry</button>}>
          {loadError}
        </Banner>
      )}

      {deleteError && (
        <Banner tone="danger" action={<button type="button" onClick={() => setDeleteError('')} className="chip min-h-[32px] h-8 text-xs">Dismiss</button>}>
          {deleteError}
        </Banner>
      )}

      {/* Filter and Search Bar */}
      <Panel className="p-4 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex flex-wrap items-center gap-2" role="radiogroup" aria-label="Filter library">
            {FILTERS.map((f) => (
              <button
                key={f.id}
                type="button"
                role="radio"
                aria-checked={filter === f.id}
                onClick={() => setFilter(f.id)}
                className={`chip min-h-[36px] px-3 py-1.5 text-xs ${filter === f.id ? 'chip-active' : ''}`}
              >
                {f.label}
                <span className="font-mono text-xs text-ink-400">
                  {f.id === 'all' ? products.length : products.filter((p) => p[f.id]).length}
                </span>
              </button>
            ))}
          </div>

          {products.some((p) => p.media !== 'video') && (
            <div className="flex items-center rounded-xl bg-ink-950 p-1 border border-ink-800">
              <button
                type="button"
                aria-pressed={globalView === 'graphic'}
                onClick={() => setGlobalView('graphic')}
                className={`flex items-center gap-1.5 px-3 py-2 min-h-[36px] rounded-lg text-xs font-medium transition ${
                  globalView === 'graphic'
                    ? 'bg-ink-800 text-ink-50 shadow-sm'
                    : 'text-ink-400 hover:text-ink-200'
                }`}
              >
                <ImageIcon className="w-4 h-4" />
                <span>Cutouts</span>
              </button>
              <button
                type="button"
                aria-pressed={globalView === 'mockup'}
                onClick={() => setGlobalView('mockup')}
                className={`flex items-center gap-1.5 px-3 py-2 min-h-[36px] rounded-lg text-xs font-medium transition ${
                  globalView === 'mockup'
                    ? 'bg-ink-800 text-ink-50 shadow-sm'
                    : 'text-ink-400 hover:text-ink-200'
                }`}
              >
                <Shirt className="w-4 h-4" />
                <span>Mockups</span>
              </button>
            </div>
          )}
        </div>

        {/* Search Input */}
        <div className="relative">
          <Search className="w-4 h-4 absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-500" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search library"
            placeholder="Search by title, tag or garment"
            className="w-full bg-ink-950 border border-ink-800 rounded-xl pl-10 pr-4 h-11 text-sm text-ink-100 placeholder-ink-500 focus:outline-none focus:border-ember-500/70 focus:ring-1 focus:ring-ember-500/30 transition shadow-inner"
          />
        </div>
      </Panel>

      {/* Grid of Draft Cards */}
      {loading && products.length === 0 ? (
        <div className="space-y-4">
          <div className="flex items-center gap-2 text-xs text-ink-400 font-mono py-1" role="status" aria-live="polite">
            <RefreshCw className="w-3.5 h-3.5 animate-spin text-ember-400" />
            <span>Loading items...</span>
          </div>
          <div aria-busy="true" aria-label="Loading library" className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
            {Array.from({ length: 8 }, (_, i) => (
              <div key={i} className="space-y-3">
                <div className="skeleton aspect-square !rounded-2xl" />
                <div className="skeleton h-3.5 w-4/5" />
                <div className="skeleton h-3 w-2/5" />
              </div>
            ))}
          </div>
        </div>
      ) : filtered.length === 0 ? (
        <Panel className="p-12">
          <EmptyState
            icon={Package}
            title={loadError ? "Couldn't load the library" : search ? `Nothing matches "${search}"` : filter !== 'all' ? `No ${FILTERS.find((f) => f.id === filter)?.label.toLowerCase()} yet` : 'No items yet'}
            description={loadError ? 'Check that the dashboard server is running, then retry.' : search ? 'Try a shorter search or clear the filter.' : filter !== 'all' ? `No items marked as ${FILTERS.find((f) => f.id === filter)?.label.toLowerCase()}.` : 'Videos from Shorts and Studio, and voiceovers from Voiceover studio, land here.'}
            action={
              loadError ? (
                <Button variant="secondary" size="sm" onClick={loadProducts}>
                  Retry
                </Button>
              ) : search ? (
                <Button variant="secondary" size="sm" onClick={() => setSearch('')}>
                  Clear search
                </Button>
              ) : filter !== 'all' ? (
                <Button variant="secondary" size="sm" onClick={() => setFilter('all')}>
                  Show all
                </Button>
              ) : null
            }
          />
        </Panel>
      ) : (
        <div className="space-y-6">
          {loading && products.length > 0 && (
            <div className="flex items-center gap-2 text-xs text-ink-400 font-mono py-1" role="status" aria-live="polite">
              <RefreshCw className="w-3.5 h-3.5 animate-spin text-ember-400" />
              <span>Loading {products.length} items...</span>
            </div>
          )}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
            {displayed.map((product) => {
              return (
                <Panel
                  key={product.id}
                  data-cy="product-card"
                  onClick={() => setSelectedProduct(product)}
                  className="group flex flex-col cursor-pointer relative overflow-hidden transition-all duration-200 hover:border-ink-600 hover:shadow-lg"
                >
                  {/* Media Container */}
                  <div className="relative aspect-square w-full bg-ink-950 flex items-center justify-center p-4 border-b border-ink-800/80 overflow-hidden">
                    {product.media === 'video' ? (
                      <video
                        src={product.video_url}
                        poster={product.video_url?.replace(/[^/]+$/, 'cover.jpg')}
                        muted
                        loop
                        playsInline
                        preload="metadata"
                        onMouseEnter={(e) => e.currentTarget.play().catch(() => {})}
                        onMouseLeave={(e) => e.currentTarget.pause()}
                        className="h-full aspect-[9/16] object-cover rounded-lg"
                      />
                    ) : globalView === 'mockup' ? (
                      <div className="relative w-full h-full flex items-center justify-center">
                        <div className="w-[88%] h-[88%] rounded-2xl bg-gradient-to-b from-ink-900 to-ink-950 border border-ink-800 shadow-xl flex items-center justify-center p-3 relative overflow-hidden">
                          <div className="absolute top-2 w-14 h-3 border-b-2 border-ink-700/60 rounded-b-full"></div>
                          <img
                            src={product.graphic_url}
                            alt={product.title}
                            className="max-h-[72%] max-w-[72%] object-contain drop-shadow-[0_12px_24px_rgba(0,0,0,0.9)] group-hover:scale-105 transition-transform duration-300"
                            loading="lazy"
                          />
                          <div className="absolute bottom-2 right-2 text-xs font-mono text-ink-300 uppercase tracking-wider bg-ink-900/90 border border-ink-800 px-2 py-0.5 rounded">
                            {product.garment_type}
                          </div>
                        </div>
                      </div>
                    ) : (
                      <img
                        src={product.graphic_url}
                        alt={product.title}
                        className="max-h-full max-w-full object-contain group-hover:scale-105 transition-transform duration-300"
                        loading="lazy"
                      />
                    )}

                    {/* Top-left Quick Delete icon badge */}
                    <div className="absolute top-2.5 left-2.5 z-10">
                      <button
                        type="button"
                        onClick={(e) => handleDeleteProduct(e, product)}
                        disabled={deletingId === product.id}
                        className={`min-w-[36px] min-h-[36px] w-9 h-9 flex items-center justify-center rounded-xl backdrop-blur-md transition ${
                          confirmDeleteId === product.id
                            ? 'bg-rose-950 text-rose-300 border border-rose-700 animate-pulse'
                            : 'bg-ink-950/80 opacity-90 sm:opacity-0 sm:group-hover:opacity-100 hover:!opacity-100 focus:opacity-100 hover:bg-rose-950/90 text-ink-400 hover:text-rose-400 border border-ink-800 hover:border-rose-800/80'
                        }`}
                        aria-label={confirmDeleteId === product.id ? `Confirm delete "${product.title || product.id}"` : `Delete "${product.title || product.id}"`}
                        title={confirmDeleteId === product.id ? `Click again to confirm deletion of "${product.title || product.id}"` : `Delete "${product.title || product.id}" from disk & local storage`}
                      >
                        {deletingId === product.id ? (
                          <RefreshCw className="w-4 h-4 animate-spin text-rose-400" />
                        ) : (
                          <Trash2 className="w-4 h-4" />
                        )}
                      </button>
                    </div>

                    {product.media !== 'video' && product.price && (
                      <div className="absolute top-2.5 right-2.5 flex items-center gap-1">
                        <span className="text-xs font-mono px-2 py-0.5 rounded-full bg-ink-950/80 border border-ink-800 text-ember-300 backdrop-blur-sm">
                          {product.price}
                        </span>
                      </div>
                    )}

                    <div className="absolute bottom-2.5 left-2.5">
                      <Badge tone="neutral" className="!bg-ink-950/90 !backdrop-blur-sm">
                        {product.media === 'video' ? 'Video · 9:16' : product.garment_type || 'Asset'}
                      </Badge>
                    </div>
                  </div>

                  {/* Card Details */}
                  <div className="p-4 flex-1 flex flex-col justify-between space-y-3">
                    <div>
                      <h3 data-cy="product-title" className="text-sm font-medium text-ink-100 group-hover:text-ember-300 transition line-clamp-2 leading-snug">
                        {product.title}
                      </h3>
                      <div className="flex items-center gap-1.5 flex-wrap mt-1">
                        <p className="text-xs text-ink-400 font-mono">
                          {new Date(product.created_at).toLocaleDateString()} • {product.engine}
                        </p>
                        {product.visual_check?.approved === false && <Badge tone="error">Visual check failed</Badge>}
                        {product.style === 'viral_v1' && (
                          <Badge tone="accent" className="!text-xs !py-0.5 !px-2">viral_v1</Badge>
                        )}
                      </div>
                    </div>

                    {product.visual_check?.approved === false && <div className="rounded-lg border border-amber-800 bg-amber-950/30 p-3 text-xs text-amber-200" data-testid="visual-check-warning"><p className="font-semibold">Visual check not approved</p><ul className="mt-1 list-disc pl-4 text-amber-100">{(product.visual_check.findings || []).map((finding, index) => <li key={index}>{finding.severity}: {finding.issue}{finding.fix ? ` — ${finding.fix}` : ''}</li>)}</ul></div>}

                    {/* Tags Preview & Actions */}
                    <div className="flex flex-wrap items-center gap-y-1 pt-2 border-t border-ink-800/50">
                      <span className="shrink-0 text-xs font-mono text-ink-400 flex items-center gap-1.5 whitespace-nowrap">
                        <Tag className="w-3.5 h-3.5 text-ember-400" />
                        {product.tags?.length || 0} tags
                      </span>
                      <div className="ml-auto flex shrink-0 items-center gap-0.5">
                        {FLAGS.filter((f) => !f.videoOnly || (product.media === 'video' && !product.youtube)).map(({ key, icon: Icon, on, label }) => {
                          const isSet = Boolean(product[key]);
                          const accessibleLabel = `${isSet ? 'Remove' : 'Add'} ${label.toLowerCase()} for "${product.title || product.id}"`;
                          return (
                            <button
                              key={key}
                              type="button"
                              onClick={(e) => toggleFlag(e, product, key)}
                              aria-pressed={isSet}
                              aria-label={accessibleLabel}
                              title={accessibleLabel}
                              className={`min-w-[32px] min-h-[32px] w-8 h-8 flex items-center justify-center rounded-lg hover:bg-ink-800 transition focus:outline-none focus:ring-1 focus:ring-ember-500/50 ${
                                isSet ? on : 'text-ink-400 hover:text-ink-100'
                              }`}
                            >
                              <Icon className="w-4 h-4 shrink-0" fill={isSet && key !== 'future_upload' ? 'currentColor' : 'none'} />
                            </button>
                          );
                        })}
                        <button
                          type="button"
                          onClick={(e) => handleCopyTags(e, product)}
                          className="min-w-[32px] min-h-[32px] w-8 h-8 flex items-center justify-center rounded-lg text-ink-400 hover:text-ink-50 hover:bg-ink-800 transition focus:outline-none focus:ring-1 focus:ring-ember-500/50"
                          title={`Copy tags for "${product.title || product.id}"`}
                          aria-label={`Copy tags for "${product.title || product.id}"`}
                        >
                          {copiedId === product.id ? (
                            <Check className="w-4 h-4 text-emerald-400 shrink-0" />
                          ) : (
                            <Copy className="w-4 h-4 shrink-0" />
                          )}
                        </button>
                      </div>
                    </div>
                  </div>
                </Panel>
              );
            })}
          </div>

          {/* Pagination / Show more controls */}
          {filtered.length > PAGE_SIZE && (
            <div className="flex flex-col sm:flex-row items-center justify-between gap-3 pt-6 border-t border-ink-800/40">
              <p className="text-xs text-ink-400 font-mono">
                Showing {Math.min(visibleCount, filtered.length)} of {filtered.length} items
              </p>
              <div className="flex items-center gap-2">
                {visibleCount < filtered.length ? (
                  <>
                    <Button
                      variant="secondary"
                      size="sm"
                      className="min-h-[36px] text-xs px-4"
                      onClick={() => setVisibleCount((prev) => Math.min(prev + PAGE_SIZE, filtered.length))}
                    >
                      Show more
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="min-h-[36px] text-xs px-3 text-ink-400 hover:text-ink-200"
                      onClick={() => setVisibleCount(filtered.length)}
                    >
                      Show all ({filtered.length})
                    </Button>
                  </>
                ) : (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="min-h-[36px] text-xs px-3 text-ink-400 hover:text-ink-200"
                    onClick={() => setVisibleCount(PAGE_SIZE)}
                  >
                    Show less
                  </Button>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Details & Copy Dossier Modal */}
      {selectedProduct && (
        <ProductModal
          product={selectedProduct}
          onClose={() => setSelectedProduct(null)}
          onDelete={handleProductDeleted}
        />
      )}
    </div>
  );
}
