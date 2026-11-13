import React, { useEffect, useRef, useState } from 'react';
import { ChevronDown, Check, Tv, Settings, Plus } from 'lucide-react';

export default function ChannelSwitcher({ channels = [], activeChannel, onSwitchChannel, onOpenChannelModal }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        data-cy="channel-switcher"
        aria-label="Switch channel"
        aria-expanded={open}
        className="w-full flex items-center gap-2.5 p-2 rounded-xl border border-transparent hover:border-ink-800 hover:bg-ink-850 transition-colors text-left"
      >
        <span className="h-7 w-7 rounded-md bg-ember-500 flex items-center justify-center shadow-[0_0_24px_-4px_rgba(255,90,31,0.6)] shrink-0">
          <span className="block h-2.5 w-2.5 rounded-[2px] bg-ink-950" />
        </span>
        <span className="hidden lg:block min-w-0 flex-1">
          <span className="block text-[13px] font-semibold text-ink-50 leading-tight">ForgeAI</span>
          <span className="block text-[11px] text-ink-400 truncate leading-tight">
            {activeChannel?.name || 'No channel'}{activeChannel?.genre ? ` · ${activeChannel.genre}` : ''}
          </span>
        </span>
        <ChevronDown className={`hidden lg:block w-3.5 h-3.5 text-ink-500 transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden="true" />
      </button>

      {open && (
        <div className="absolute z-50 mt-2 w-72 left-0 top-full max-lg:left-full max-lg:top-0 max-lg:ml-2 max-lg:mt-0 bg-ink-900 border border-ink-800 rounded-xl shadow-2xl p-2 space-y-1 animate-in">
          <div className="px-2 py-1.5 flex items-center justify-between border-b border-ink-800 label">
            <span>Channels ({channels.length})</span>
          </div>
          <div className="max-h-60 overflow-y-auto space-y-0.5 py-1">
            {channels.map((chan) => {
              const isActive = chan.id === (activeChannel?.id || 'default');
              const boundAccount = chan.bound_account || chan.token;
              const boundName = boundAccount?.channel;
              const boundId = boundAccount?.channel_id;

              return (
                <div key={chan.id} className={`group flex items-center gap-2 px-2.5 py-2 rounded-lg text-xs ${isActive ? 'bg-ember-500/10 text-ember-300 font-medium' : 'text-ink-300 hover:bg-ink-850 hover:text-ink-100'}`}>
                  <button type="button" onClick={() => { onSwitchChannel?.(chan.id); setOpen(false); }} className="flex items-center gap-2.5 flex-1 min-w-0 text-left">
                    {isActive ? <Check className="w-3.5 h-3.5 text-ember-400 shrink-0" /> : <Tv className="w-3.5 h-3.5 text-ink-500 shrink-0" />}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate leading-tight font-medium">{chan.name}</span>
                      <span className="block text-[10px] text-ink-400 capitalize leading-tight">
                        {chan.genre || 'General'}{chan.youtube_channel_id ? ` · ${chan.youtube_channel_id.slice(0, 8)}...` : ''}
                      </span>
                      {boundName ? (
                        <span className="block text-[10px] text-emerald-400 truncate leading-tight mt-0.5" title={`Bound Account: ${boundName}${boundId ? ` (${boundId})` : ''}`}>
                          Bound: {boundName}{boundId ? ` (${boundId})` : ''}
                        </span>
                      ) : (
                        <span className="block text-[10px] text-ink-500 truncate leading-tight mt-0.5">
                          Bound: Not connected
                        </span>
                      )}
                    </span>
                  </button>
                  <button type="button" onClick={() => { setOpen(false); onOpenChannelModal?.(chan); }} className="p-1.5 rounded-md text-ink-400 hover:text-ink-100 hover:bg-ink-800" aria-label={`Configure ${chan.name}`} title={`Configure ${chan.name}`}>
                    <Settings className="w-3.5 h-3.5" />
                  </button>
                </div>
              );
            })}
          </div>
          <div className="pt-1 border-t border-ink-800">
            <button type="button" onClick={() => { setOpen(false); onOpenChannelModal?.(null); }} className="btn btn-secondary w-full">
              <Plus className="w-3.5 h-3.5 text-ember-400" /> Add New Channel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
