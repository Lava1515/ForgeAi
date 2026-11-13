import React, { useEffect, useRef, useState } from 'react';
import { Bot, LogIn, RefreshCw, AlertTriangle, CheckCircle2, ChevronDown } from 'lucide-react';
import * as api from '../services/api.js';

// The Google account Antigravity CLI (agy) must be logged in as. The server only runs agy when its login matches this
// exact account; otherwise every Gemini call goes to the API keys.
export default function AntigravityAccount({ variant = 'sidebar' }) {
  const [status, setStatus] = useState(null);
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const detailsRef = useRef(null);
  const [isOpen, setIsOpen] = useState(false);

  const load = () => api.getAgy().then(setStatus).catch(() => {});

  useEffect(() => {
    load();
    const params = new URLSearchParams(window.location.search);
    if (params.has('agy_logged_in')) {
      params.delete('agy_logged_in');
      const newUrl = window.location.pathname + (params.toString() ? `?${params.toString()}` : '') + window.location.hash;
      window.history.replaceState({}, '', newUrl);
    }
    const id = setInterval(() => { if (!document.hidden) load(); }, 30000);
    return () => clearInterval(id);
  }, []);

  // Close popover when clicking outside in sidebar mode
  useEffect(() => {
    if (!isOpen || variant === 'mobile') return undefined;
    const onDown = (e) => {
      if (detailsRef.current && !detailsRef.current.contains(e.target)) {
        detailsRef.current.removeAttribute('open');
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [isOpen, variant]);

  if (!status?.available) return null;

  const save = async (value) => {
    setError('');
    setTestResult(null);
    try {
      setStatus(await api.setAgy(value));
      setEmail('');
    } catch (err) {
      setError(err.message);
    }
  };

  const handleTest = async () => {
    setTesting(true);
    setError('');
    setTestResult(null);
    try {
      const res = await api.testAgy();
      if (res.status) setStatus(res.status);
      setTestResult(res);
    } catch (err) {
      setError(err.message);
    } finally {
      setTesting(false);
    }
  };

  const { ready, configured, account, reason, quotaExceeded, quotaReason } = status;

  // Tooltip hover message:
  const hoverTitle = quotaExceeded
    ? `Out of tokens: ${quotaReason || 'Individual quota reached'}. Using Gemini API fallback.`
    : ready
    ? `Antigravity CLI on ${account}`
    : reason || (configured ? 'Antigravity CLI blocked' : 'Antigravity CLI off');

  // Status visual states
  const statusTone = quotaExceeded
    ? 'rose'
    : ready
    ? 'emerald'
    : configured
    ? 'rose'
    : 'ink';

  const statusLabel = quotaExceeded
    ? 'Out of tokens'
    : ready
    ? `Connected as ${account}`
    : configured
    ? 'Blocked'
    : 'Off';

  const isMobile = variant === 'mobile';

  return (
    <details
      ref={detailsRef}
      onToggle={(e) => setIsOpen(e.currentTarget.open)}
      className={`${isMobile ? 'w-full' : 'relative'} group`}
    >
      <summary
        className={`cursor-pointer list-none select-none transition-all outline-none focus-visible:ring-2 focus-visible:ring-ember-500/70 [&::-webkit-details-marker]:hidden ${
          isMobile
            ? 'w-full min-h-[44px] px-3 py-2.5 rounded-xl border border-ink-800 bg-ink-850/60 hover:bg-ink-850 flex items-center justify-between gap-3'
            : 'w-full min-h-[40px] px-1 lg:px-2.5 py-2 rounded-xl border border-transparent hover:border-ink-800 hover:bg-ink-850/80 flex items-center justify-center lg:justify-between gap-2.5 group-open:bg-ink-850/90 group-open:border-ink-800'
        }`}
        title={hoverTitle}
      >
        <div className="flex items-center gap-2.5 min-w-0">
          <div
            className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 relative transition-colors ${
              statusTone === 'emerald'
                ? 'bg-emerald-500/15 text-emerald-400 ring-1 ring-emerald-500/30'
                : statusTone === 'rose'
                ? 'bg-rose-500/15 text-rose-400 ring-1 ring-rose-500/30'
                : 'bg-ink-800 text-ink-400'
            }`}
          >
            <Bot className="w-4 h-4 shrink-0" aria-hidden="true" />
            {/* Small status dot badge for compact rail mode */}
            {!isMobile && (
              <span
                className={`lg:hidden absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full ring-2 ring-ink-900 ${
                  quotaExceeded
                    ? 'bg-rose-500 animate-pulse'
                    : ready
                    ? 'bg-emerald-400'
                    : configured
                    ? 'bg-rose-400'
                    : 'bg-ink-600'
                }`}
              />
            )}
          </div>

          <div className={`${isMobile ? 'block' : 'hidden lg:block'} min-w-0 text-left`}>
            <div className="text-[13px] font-medium text-ink-100 leading-snug truncate">
              Gemini CLI
            </div>
            <div
              className={`text-xs leading-snug truncate ${
                quotaExceeded
                  ? 'text-rose-400 font-semibold'
                  : ready
                  ? 'text-emerald-400 font-mono'
                  : configured
                  ? 'text-rose-400'
                  : 'text-ink-500'
              }`}
            >
              {quotaExceeded
                ? 'Out of tokens'
                : ready
                ? account
                : configured
                ? 'CLI blocked'
                : 'Off (API only)'}
            </div>
          </div>
        </div>

        <ChevronDown
          className={`${
            isMobile ? 'block' : 'hidden lg:block'
          } w-4 h-4 text-ink-500 transition-transform duration-200 group-open:rotate-180 shrink-0`}
          aria-hidden="true"
        />
      </summary>

      {/* Main Connection Panel Card */}
      <div
        className={`${
          isMobile
            ? 'mt-2.5 w-full'
            : 'absolute z-50 left-full bottom-0 ml-2.5 w-[330px] max-w-[calc(100vw-5rem)]'
        } card bg-ink-900 border border-ink-750 p-4 space-y-3.5 shadow-2xl animate-in text-ink-100`}
      >
        {/* Status Header */}
        <div className="flex items-center justify-between gap-2 pb-3 border-b border-ink-800">
          <div className="flex items-center gap-2 min-w-0">
            <span
              className={`w-2.5 h-2.5 rounded-full shrink-0 ${
                quotaExceeded
                  ? 'bg-rose-500 animate-pulse'
                  : ready
                  ? 'bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.8)]'
                  : configured
                  ? 'bg-rose-400'
                  : 'bg-ink-500'
              }`}
              aria-hidden="true"
            />
            <span className="text-[13px] font-semibold text-ink-100 truncate">
              {statusLabel}
            </span>
          </div>
          <span className="font-mono text-[11px] px-2 py-0.5 rounded-md bg-ink-800/90 text-ink-300 border border-ink-700/60 shrink-0">
            Antigravity
          </span>
        </div>

        {/* Plain-words explanation */}
        <p className="text-xs text-ink-300 leading-relaxed">
          When connected, Gemini calls route through your Google account via the Antigravity CLI. When disconnected or out of tokens, calls fall back to Gemini API keys.
        </p>

        {/* Quota Exceeded Alert Card */}
        {quotaExceeded && (
          <div className="p-3 rounded-xl bg-rose-950/40 border border-rose-500/30 text-rose-200 space-y-1.5 animate-in">
            <div className="font-semibold flex items-center gap-1.5 text-rose-300 text-xs">
              <AlertTriangle className="w-4 h-4 shrink-0 text-rose-400" />
              <span>Out of Tokens (Quota Reached)</span>
            </div>
            <p className="text-xs text-ink-200 break-words leading-relaxed">
              {quotaReason || 'Individual quota reached on this account.'}
            </p>
            <p className="text-[11px] text-ink-400 pt-0.5">
              Generations will automatically use Gemini API keys until quota resets.
            </p>
          </div>
        )}

        {/* Reason when blocked/not ready */}
        {configured && !ready && !quotaExceeded && (
          <div className="p-3 rounded-xl bg-rose-950/30 border border-rose-500/30 text-xs text-rose-200 flex items-start gap-2 animate-in">
            <AlertTriangle className="w-4 h-4 shrink-0 text-rose-400 mt-0.5" />
            <p className="leading-relaxed">
              {reason || 'Antigravity CLI is not logged in'}. Using API keys fallback.
            </p>
          </div>
        )}

        {/* Primary OAuth Action Button */}
        <div>
          <a
            href="/api/agy/login"
            className={`${
              account
                ? 'btn btn-secondary w-full min-h-[40px] px-4 text-[13px] font-medium'
                : 'btn btn-ember w-full min-h-[40px] px-4 text-[13px] font-semibold shadow-md'
            } inline-flex items-center justify-center gap-2 rounded-xl transition-all active:scale-[0.98]`}
            title="Log in with Google to authenticate Antigravity CLI or switch account"
          >
            <LogIn className="w-4 h-4 shrink-0" />
            <span>{account ? 'Switch Google Account' : 'Log in with Google'}</span>
          </a>
        </div>

        {/* Terminal fallback command when not logged in */}
        {!account && (
          <div className="p-2.5 rounded-xl bg-ink-950 border border-ink-800 text-xs text-ink-400 space-y-1">
            <p>Or authenticate in terminal:</p>
            <code className="block p-1.5 rounded bg-ink-900 border border-ink-750 text-ink-200 font-mono text-[11px] select-all break-all">
              docker exec -it -e HOME=/forgeai/data/agy forgeai-dashboard agy
            </code>
          </div>
        )}

        {/* Email form to set authorized account */}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            save(email);
          }}
          className="space-y-2 pt-2 border-t border-ink-800/80"
        >
          <label htmlFor="agy-email-input" className="block text-xs font-medium text-ink-300">
            Authorized Google Account
          </label>
          <div className="flex gap-2">
            <input
              id="agy-email-input"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="pro-account@gmail.com"
              aria-label="Google account for Antigravity CLI"
              className="input !h-10 !px-3.5 !text-[13px] flex-1 min-w-0"
            />
            <button
              type="submit"
              className="btn btn-secondary !h-10 !px-4 text-[13px] font-medium shrink-0 active:scale-[0.98]"
            >
              Save
            </button>
          </div>
          <p className="text-[11px] text-ink-400">
            Target account:{' '}
            <span className="text-ink-200 font-mono">
              {configured || 'nobody (API keys fallback)'}
            </span>
          </p>
        </form>

        {/* Secondary Actions: Check Quota and Turn Off */}
        <div className="flex items-center gap-2 pt-1">
          <button
            type="button"
            disabled={testing}
            onClick={handleTest}
            className="btn btn-secondary min-h-[36px] h-9 px-3.5 text-xs font-medium inline-flex items-center justify-center gap-2 rounded-lg flex-1 active:scale-[0.98]"
            title="Probe CLI to test token/quota status"
          >
            <RefreshCw
              className={`w-3.5 h-3.5 shrink-0 ${
                testing ? 'animate-spin text-ember-400' : 'text-ink-400'
              }`}
            />
            <span>{testing ? 'Checking...' : 'Check Quota'}</span>
          </button>
          {configured && (
            <button
              type="button"
              onClick={() => save('')}
              className="btn btn-danger min-h-[36px] h-9 px-3.5 text-xs font-medium rounded-lg shrink-0 transition-colors active:scale-[0.98]"
              title="Disconnect Antigravity CLI and use API keys only"
            >
              Turn off
            </button>
          )}
        </div>

        {/* Quota Test Result feedback */}
        {testResult && (
          <div
            className={`p-2.5 rounded-xl border text-xs flex items-start gap-2 animate-in ${
              testResult.ok
                ? 'bg-emerald-950/40 border-emerald-500/30 text-emerald-300'
                : 'bg-rose-950/40 border-rose-500/30 text-rose-300'
            }`}
          >
            {testResult.ok ? (
              <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
            ) : (
              <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
            )}
            <span className="break-words leading-relaxed">
              {testResult.ok ? testResult.message : testResult.error}
            </span>
          </div>
        )}

        {/* Error notification */}
        {error && (
          <div className="p-2.5 rounded-xl bg-rose-950/40 border border-rose-500/30 text-rose-300 text-xs flex items-start gap-2 animate-in">
            <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
            <span className="break-words leading-relaxed">{error}</span>
          </div>
        )}
      </div>
    </details>
  );
}
