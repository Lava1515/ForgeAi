import React from 'react';
import { navSectionsOf } from '../nav.js';
import ProductsCatalog from './ProductsCatalog.jsx';
import Drafts from './Drafts.jsx';

// Segmented control over one host's sections. Only the active section is mounted, except `kept` panels: they stay mounted and are hidden while inactive.
export function SectionHost({ label, sections, active, onSelect, panels, kept = {} }) {
  return (
    <div className="space-y-5">
      <div className="inline-flex flex-wrap gap-1 p-1 rounded-xl bg-ink-950 border border-ink-800" role="radiogroup" aria-label={label}>
        {sections.map((s) => (
          <button
            key={s.id}
            type="button"
            role="radio"
            aria-checked={active === s.id}
            onClick={() => onSelect(s.id)}
            className={`chip min-h-[36px] px-3 py-1.5 text-xs ${active === s.id ? 'chip-active' : ''}`}
          >
            {s.label}
          </button>
        ))}
      </div>
      {Object.entries(kept).map(([id, node]) => (
        <div key={id} data-section-root={id} hidden={active !== id} className="fade-page">{node}</div>
      ))}
      {panels[active] && <div key={active} className="fade-page">{panels[active]}</div>}
    </div>
  );
}

export default function Library({ section, onSection, channelSwitchCount }) {
  return (
    <SectionHost
      label="Library section"
      sections={navSectionsOf('products')}
      active={section}
      onSelect={onSection}
      panels={{
        products: <ProductsCatalog key={channelSwitchCount} />,
        drafts: <Drafts />,
      }}
    />
  );
}
