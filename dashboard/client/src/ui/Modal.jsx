import React, { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';

const FOCUSABLE = 'button:not([disabled]),[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
const SIZES = { md: '', lg: '!max-w-2xl', xl: '!max-w-4xl' };

export default function Modal({ open = true, onClose, title, footer, size = 'md', tone = 'default', children }) {
  const panelRef = useRef(null);
  const titleId = useId();
  // Callers pass inline arrows; a ref keeps the effect from re-running (and stealing focus) on every render.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return undefined;
    const previous = document.activeElement;
    const panel = panelRef.current;
    if (!panel.contains(document.activeElement)) (panel.querySelector(FOCUSABLE) || panel).focus();

    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCloseRef.current?.();
        return;
      }
      if (e.key !== 'Tab') return;
      const items = [...panel.querySelectorAll(FOCUSABLE)];
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      previous?.focus?.();
    };
  }, [open]);

  if (!open) return null;
  return createPortal(
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onCloseRef.current?.()}>
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        tabIndex={-1}
        className={`modal-panel ${SIZES[size]} ${tone === 'danger' ? '!border-rose-500/40' : ''}`}
      >
        {title && <h3 id={titleId} className="text-lg font-semibold text-ink-50 mb-2 flex items-center gap-2">{title}</h3>}
        {children}
        {footer && <div className="flex justify-end gap-3 mt-5">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}
