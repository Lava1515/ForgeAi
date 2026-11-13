import React from 'react';

export default function PageHeader({ eyebrow, title, badge, subtitle, actions }) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
      <div className="min-w-0">
        {eyebrow && <span className="label">{eyebrow}</span>}
        <div className="flex items-center gap-3 flex-wrap">
          <h1 className="page-title">{title}</h1>
          {badge && <span className="mt-1">{badge}</span>}
        </div>
        {subtitle && <p className="mt-1.5 text-sm text-ink-400 max-w-prose leading-relaxed">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
    </div>
  );
}
