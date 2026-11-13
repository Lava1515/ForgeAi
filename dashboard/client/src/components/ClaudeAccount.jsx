import React, { useEffect, useRef, useState } from 'react';
import { Sparkles, LogIn, RefreshCw, AlertTriangle, ChevronDown, ExternalLink } from 'lucide-react';
import * as api from '../services/api.js';

// The Claude subscription login the server's `claude -p` calls run on (data/claude). Manual login: the server starts it and
// returns a link; you open it, approve, and paste the code the page shows back here.
export default function ClaudeAccount({ variant = 'sidebar' }) {
  const [status, setStatus] = useState(null);
  const [url, setUrl] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [testResult, setTestResult] = useState(null);
  const detailsRef = useRef(null);

  const load = () => api.getClaude().then(setStatus).catch(() => {});
  useEffect(() => {
    load();
    const id = setInterval(() => { if (!document.hidden) load(); }, 30000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (variant === 'mobile') return undefined;
    const onDown = (e) => { if (detailsRef.current && !detailsRef.current.contains(e.target)) detailsRef.current.removeAttribute('open'); };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [variant]);

  if (!status?.available) return null;

  const act = (name, fn) => async () => {
    setBusy(name); setError('');
    try { await fn(); } catch (err) { setError(err.message); } finally { setBusy(''); }
  };
  const start = act('start', async () => { setTestResult(null); setUrl((await api.startClaudeLogin()).url); });
  const finish = act('finish', async () => { setStatus(await api.finishClaudeLogin(code.trim())); setUrl(''); setCode(''); });
  const toggle = act('toggle', async () => { setStatus(await api.setClaudeUse(!status.use)); });
  const test = act('test', async () => { const r = await api.testClaude(); if (r.status) setStatus(r.status); setTestResult(r); });

  const { loggedIn, account, reason } = status;
  const isMobile = variant === 'mobile';
  const tone = loggedIn ? 'bg-emerald-500/15 text-emerald-400 ring-1 ring-emerald-500/30' : 'bg-ink-800 text-ink-400';

  return (
    <details ref={detailsRef} className={`${isMobile ? 'w-full' : 'relative'} group`}>
      <summary
        className={`cursor-pointer list-none select-none transition-all outline-none focus-visible:ring-2 focus-visible:ring-ember-500/70 [&::-webkit-details-marker]:hidden ${
          isMobile
            ? 'w-full min-h-[44px] px-3 py-2.5 rounded-xl border border-ink-800 bg-ink-850/60 hover:bg-ink-850 flex items-center justify-between gap-3'
            : 'w-full min-h-[40px] px-1 lg:px-2.5 py-2 rounded-xl border border-transparent hover:border-ink-800 hover:bg-ink-850/80 flex items-center justify-center lg:justify-between gap-2.5'
        }`}
        title={loggedIn ? `Claude CLI on ${account || 'your subscription'}` : reason || 'Claude CLI off'}
      >
        <div className="flex items-center gap-2.5 min-w-0">
          <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${tone}`}>
            <Sparkles className="w-4 h-4 shrink-0" aria-hidden="true" />
          </div>
          <div className={`${isMobile ? 'block' : 'hidden lg:block'} min-w-0 text-left`}>
            <div className="text-[13px] font-medium text-ink-100 leading-snug truncate">Claude CLI</div>
            <div className={`text-xs leading-snug truncate ${loggedIn ? 'text-emerald-400 font-mono' : 'text-ink-500'}`}>
              {loggedIn ? `${account || 'Connected'}${status.use ? ' (in use)' : ''}` : 'Not logged in'}
            </div>
          </div>
        </div>
        <ChevronDown className={`${isMobile ? 'block' : 'hidden lg:block'} w-4 h-4 text-ink-500 transition-transform duration-200 group-open:rotate-180 shrink-0`} aria-hidden="true" />
      </summary>

      <div className={`${isMobile ? 'mt-2.5 w-full' : 'absolute z-50 left-full bottom-0 ml-2.5 w-[330px] max-w-[calc(100vw-5rem)]'} card bg-ink-900 border border-ink-750 p-4 space-y-3.5 shadow-2xl animate-in text-ink-100`}>
        <p className="text-xs text-ink-300 leading-relaxed">
          Lets the server run <span className="font-mono">claude -p</span> on your Claude subscription (no API key). When switched on, plans and model code go to Claude first; if Claude fails, Gemini takes over.
        </p>

        {!loggedIn && !url && (
          <div className="p-3 rounded-xl bg-ink-950 border border-ink-800 text-xs text-ink-300 flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0 text-ink-500 mt-0.5" />
            <p className="leading-relaxed">{reason || 'Claude CLI is not logged in'}.</p>
          </div>
        )}

        {url && (
          <ol className="text-xs text-ink-300 space-y-2 list-decimal pl-4">
            <li>
              <a href={url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-ember-400 underline">
                Open the Claude sign-in page <ExternalLink className="w-3 h-3" />
              </a>{' '}and approve.
            </li>
            <li>Copy the code the page shows and paste it here:</li>
          </ol>
        )}
        {url && (
          <form onSubmit={(e) => { e.preventDefault(); finish(); }} className="flex gap-2">
            <input
              value={code} onChange={(e) => setCode(e.target.value)} placeholder="Paste the code" aria-label="Claude login code"
              autoComplete="off" spellCheck={false} className="input !h-10 !px-3.5 !text-[13px] flex-1 min-w-0 font-mono"
            />
            <button type="submit" disabled={busy === 'finish' || code.trim().length < 8} className="btn btn-ember !h-10 !px-4 text-[13px] font-semibold shrink-0">
              {busy === 'finish' ? 'Checking...' : 'Finish'}
            </button>
          </form>
        )}

        {!url && (
          <button
            type="button" onClick={start} disabled={busy === 'start'}
            className={`${loggedIn ? 'btn btn-secondary' : 'btn btn-ember'} w-full min-h-[40px] px-4 text-[13px] font-medium inline-flex items-center justify-center gap-2 rounded-xl active:scale-[0.98]`}
          >
            <LogIn className="w-4 h-4 shrink-0" />
            <span>{busy === 'start' ? 'Starting...' : loggedIn ? 'Switch Claude account' : 'Log in with Claude'}</span>
          </button>
        )}

        {loggedIn && !url && (
          <label className="flex items-center gap-2.5 text-[13px] text-ink-100 cursor-pointer select-none">
            <input type="checkbox" checked={Boolean(status.use)} disabled={busy === 'toggle'} onChange={toggle} className="w-4 h-4 accent-emerald-500" />
            <span>Use Claude for plans and model code</span>
          </label>
        )}

        {loggedIn && !url && (
          <button
            type="button" onClick={test} disabled={busy === 'test'}
            className="btn btn-secondary w-full min-h-[36px] h-9 px-3.5 text-xs font-medium inline-flex items-center justify-center gap-2 rounded-lg active:scale-[0.98]"
          >
            <RefreshCw className={`w-3.5 h-3.5 shrink-0 ${busy === 'test' ? 'animate-spin text-ember-400' : 'text-ink-400'}`} />
            <span>{busy === 'test' ? 'Asking Claude...' : 'Test with one call'}</span>
          </button>
        )}

        {testResult && (
          <p className={`text-xs ${testResult.ok ? 'text-emerald-400' : 'text-rose-300'}`}>
            {testResult.ok ? `Claude answered "${testResult.reply}" in ${(testResult.ms / 1000).toFixed(1)} s.` : `Test failed: ${testResult.error}`}
          </p>
        )}
        {error && <p className="text-xs text-rose-300 break-words" role="alert">{error}</p>}
      </div>
    </details>
  );
}
