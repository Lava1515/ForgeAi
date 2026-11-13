import React, { useState } from 'react';
import { Menu, X, Terminal } from 'lucide-react';
import { NAV_ITEMS, navHostOf } from '../nav.js';
import ChannelSwitcher from './ChannelSwitcher.jsx';
import AntigravityAccount from './AntigravityAccount.jsx';
import ClaudeAccount from './ClaudeAccount.jsx';

export default function MobileNav({
  activeTab, setActiveTab, channels, activeChannel, onSwitchChannel, onOpenChannelModal, logCount = 0, onOpenLogger,
}) {
  const [open, setOpen] = useState(false);
  const activeLabel = NAV_ITEMS.find((item) => item.id === navHostOf(activeTab))?.label || 'ForgeAI';

  return (
    <>
      <header className="mobile-header md:hidden">
        <button
          type="button"
          className="mobile-menu-button min-w-[40px] min-h-[40px]"
          onClick={() => setOpen(true)}
          aria-label="Open navigation"
          title="Open navigation"
          aria-expanded={open}
        >
          <Menu className="w-5 h-5" aria-hidden="true" />
        </button>
        <div className="min-w-0 flex-1">
          <button
            type="button"
            onClick={() => setActiveTab('shorts')}
            className="text-left group cursor-pointer focus:outline-none focus-visible:ring-1 focus-visible:ring-ember-500/50 rounded-lg p-0.5 -m-0.5 inline-block max-w-full"
            aria-label="ForgeAI home"
            title="ForgeAI - Home"
          >
            <div className="text-sm font-semibold text-ink-50 group-hover:text-ember-300 transition-colors">ForgeAI</div>
            <div className="text-xs text-ink-400 truncate">{activeLabel}</div>
          </button>
        </div>
        <button
          type="button"
          className="mobile-menu-button min-w-[40px] min-h-[40px]"
          onClick={onOpenLogger}
          aria-label={`Logs${logCount ? ` ${logCount}` : ''}`}
          title="Toggle live execution logs"
        >
          <Terminal className="w-5 h-5" aria-hidden="true" />
        </button>
        <div
          className="mobile-channel-switcher"
          title={`Switch channel (${activeChannel?.name || 'Default'})`}
          aria-label={`Switch channel (${activeChannel?.name || 'Default'})`}
        >
          <ChannelSwitcher channels={channels} activeChannel={activeChannel} onSwitchChannel={onSwitchChannel} onOpenChannelModal={onOpenChannelModal} />
        </div>
      </header>

      {open && (
        <div className="mobile-nav-backdrop md:hidden" onMouseDown={(event) => { if (event.target === event.currentTarget) setOpen(false); }}>
          <nav className="mobile-nav-panel" aria-label="Main navigation">
            <div className="flex items-center justify-between px-4 py-3 border-b border-ink-800">
              <span className="text-sm font-semibold text-ink-50">Navigation</span>
              <button
                type="button"
                className="mobile-menu-button min-w-[40px] min-h-[40px]"
                onClick={() => setOpen(false)}
                aria-label="Close navigation"
                title="Close navigation"
              >
                <X className="w-5 h-5" aria-hidden="true" />
              </button>
            </div>
            <div className="overflow-y-auto p-3">
              {NAV_ITEMS.map(({ id, label, icon: Icon, sections }) => {
                const selected = navHostOf(activeTab) === id;
                const go = (tab) => { setActiveTab(tab); setOpen(false); };
                return (
                  <div key={id} data-nav-group={id}>
                    <button
                      type="button"
                      data-nav-entry={id}
                      onClick={() => go(id)}
                      aria-current={selected ? 'page' : undefined}
                      className={`mobile-nav-item ${selected ? 'mobile-nav-item-active' : ''}`}
                    >
                      <Icon className="w-4 h-4" aria-hidden="true" />
                      <span>{label}</span>
                    </button>
                    {sections.length > 0 && (
                      <div className="ml-7 mb-2 border-l border-ink-800 pl-3 space-y-0.5">
                        {sections.map((s) => (
                          <button
                            key={s.id}
                            type="button"
                            data-nav-section={s.id}
                            onClick={() => go(s.id)}
                            aria-current={activeTab === s.id ? 'page' : undefined}
                            className={`w-full text-left min-h-[36px] px-2 rounded-lg text-sm transition-colors ${
                              activeTab === s.id ? 'text-ember-300 font-medium' : 'text-ink-400 hover:text-ink-100'
                            }`}
                          >
                            {s.label}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}

              <div className="border-t border-ink-800 pt-3 mt-4">
                <div className="label px-3 mb-2">CLI Connection</div>
                <AntigravityAccount variant="mobile" />
                <div className="mt-2"><ClaudeAccount variant="mobile" /></div>
              </div>
            </div>
          </nav>
        </div>
      )}
    </>
  );
}
