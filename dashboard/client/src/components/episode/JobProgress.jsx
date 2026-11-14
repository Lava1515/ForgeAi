// What a running code-built video is doing, at the top of the New Video page (owner, 2026-11-14: "I don't see anything in
// progress in the UI"; the running job used to be one grey line under the whole form).
// Everything comes from data the server already gives: the job's step history (GET /api/codebuilt/jobs) and, when the server has
// the route, the frame count and preview sheets (GET /api/codebuilt/jobs/:id/progress). Without that route the panel still works.
import React, { useEffect, useRef, useState } from 'react';
import { Check, Square } from 'lucide-react';
import Button from '../../ui/Button.jsx';

export const PHASES = Object.freeze([
  { id: 'script', label: 'Script', steps: ['queued', 'scripting', 'factchecking'], hint: 'Writing the narration.' },
  { id: 'voice', label: 'Voice', steps: ['voicing'], hint: 'Recording the voice and measuring every word. About 2 minutes.' },
  { id: 'plan', label: 'Plan', steps: ['planning'], hint: 'Planning the places and shots, then writing the Blender scene. This is the slowest thinking step: usually 10 to 30 minutes, and the PC looks idle while it runs.' },
  { id: 'check', label: 'Preview and check', steps: ['visual_loop', 'previewing', 'looking'], hint: 'Rendering small preview pictures, then looking at them and fixing what is wrong. Up to 4 rounds.' },
  { id: 'render', label: 'Render', steps: ['building'], hint: 'Rendering every frame of the video.' },
  { id: 'finish', label: 'Finish', steps: ['drafting'], hint: 'Adding captions, music and sound, then saving the draft.' },
]);
const phaseOf = (step) => PHASES.findIndex((p) => p.steps.includes(step));

/** mm:ss, or h:mm:ss from an hour on. */
export function clock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600); const m = Math.floor((s % 3600) / 60); const r = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
}

/**
 * Time spent per phase from the job's step history. Each history entry runs until the next one (the last until `now`); entries that
 * are not a working step ('resume', 'done', 'failed') only close the one before. Returns { ms: [per phase], current, startedAt, looks }.
 */
export function phaseTimes(job, now) {
  const steps = Array.isArray(job?.steps) ? job.steps : [];
  const ms = PHASES.map(() => 0);
  let looks = 0;
  steps.forEach((entry, i) => {
    const k = phaseOf(entry?.step);
    const from = Date.parse(entry?.at);
    if (entry?.step === 'looking') looks += 1;
    if (k < 0 || !Number.isFinite(from)) return;
    const next = steps[i + 1];
    const to = next ? Date.parse(next.at) : now;
    if (Number.isFinite(to) && to > from) ms[k] += to - from;
  });
  const startedAt = Date.parse(steps[0]?.at ?? job?.createdAt);
  return { ms, current: phaseOf(job?.step ?? job?.status), startedAt: Number.isFinite(startedAt) ? startedAt : now, looks };
}

export default function JobProgress({ job, onAbort, fetchProgress }) {
  const [now, setNow] = useState(() => Date.now());
  const [progress, setProgress] = useState(null);
  const [zoom, setZoom] = useState(false);
  const rate = useRef({ at: 0, done: 0, perMin: null });

  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id); }, []);
  useEffect(() => {
    if (!job?.id || typeof fetchProgress !== 'function') return undefined;
    let alive = true;
    rate.current = { at: 0, done: 0, perMin: null };
    const poll = async () => {
      try {
        const next = await fetchProgress(job.id);
        if (!alive || !next) return;
        const done = next.frames?.done;
        if (Number.isFinite(done)) {
          const r = rate.current; const t = Date.now();
          if (r.at && done > r.done && t - r.at >= 20000) { r.perMin = ((done - r.done) / (t - r.at)) * 60000; r.at = t; r.done = done; }
          else if (!r.at || done < r.done) { r.at = t; r.done = done; r.perMin = null; }
        }
        setProgress(next);
      } catch { /* an older server has no progress route: the panel shows the steps only */ }
    };
    void poll();
    const id = setInterval(poll, 5000);
    return () => { alive = false; clearInterval(id); };
  }, [job?.id, fetchProgress]);

  if (!job) return null;
  const { ms, current, startedAt, looks } = phaseTimes(job, now);
  const phase = PHASES[current] ?? null;
  const frames = progress?.frames && Number.isFinite(progress.frames.total) && progress.frames.total > 0 ? progress.frames : null;
  const pct = frames ? Math.min(100, Math.round((frames.done / frames.total) * 100)) : null;
  const perMin = rate.current.perMin;
  const eta = frames && perMin > 0 ? ((frames.total - frames.done) / perMin) * 60000 : null;
  const sheet = progress?.sheets?.length ? progress.sheets[progress.sheets.length - 1] : null;

  return (
    <section className="rounded-xl border border-amber-500/40 bg-amber-500/5 p-4 space-y-3" aria-label="Video in progress" data-job-progress={job.id} data-job-progress-step={job.step ?? job.status}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-amber-300">
            <span className="relative flex h-2 w-2"><span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-400 opacity-75" /><span className="relative inline-flex h-2 w-2 rounded-full bg-amber-400" /></span>
            In progress
          </div>
          <h3 className="mt-1 text-base font-semibold text-ink-100 break-words">{job.topic || 'Topic not picked yet'}</h3>
          <p className="text-xs text-ink-400">{job.duration ? `${job.duration} s video` : 'Video'}{progress?.plan?.shots ? ` · ${progress.plan.shots} shots in ${progress.plan.places ?? '?'} places` : ''}</p>
        </div>
        <div className="flex items-center gap-3">
          <div className="text-right"><div className="text-xl font-semibold tabular-nums text-ink-100" data-job-progress-elapsed>{clock(now - startedAt)}</div><div className="text-[11px] text-ink-400">since it started</div></div>
          {typeof onAbort === 'function' && <Button type="button" size="sm" variant="secondary" icon={Square} onClick={() => onAbort(job.id)} data-job-progress-abort>Abort</Button>}
        </div>
      </div>

      <ol className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6" data-job-progress-phases>
        {PHASES.map((p, i) => {
          const state = current < 0 ? 'todo' : i < current ? 'done' : i === current ? 'now' : 'todo';
          const tone = state === 'now' ? 'border-amber-400 bg-amber-400/10 text-ink-100' : state === 'done' ? 'border-emerald-500/40 text-ink-200' : 'border-ink-800 text-ink-500';
          return (
            <li key={p.id} className={`rounded-lg border px-2.5 py-2 text-xs ${tone}`} data-job-progress-phase={p.id} data-job-progress-phase-state={state} aria-current={state === 'now' ? 'step' : undefined}>
              <div className="flex items-center gap-1.5 font-medium">{state === 'done' && <Check className="h-3.5 w-3.5 text-emerald-400" aria-hidden="true" />}{p.label}</div>
              <div className="mt-0.5 tabular-nums text-[11px] opacity-80">{ms[i] > 0 ? clock(ms[i]) : state === 'now' ? '0:00' : ' '}</div>
            </li>
          );
        })}
      </ol>

      {phase && <p className="text-sm text-ink-200" data-job-progress-hint>
        {phase.hint}
        {phase.id === 'check' && looks > 0 ? ` Look ${looks} now.` : ''}
      </p>}

      {phase?.id === 'render' && frames && (
        <div className="space-y-1" data-job-progress-frames>
          <div className="h-2.5 w-full overflow-hidden rounded-full bg-ink-800" role="progressbar" aria-valuemin={0} aria-valuemax={frames.total} aria-valuenow={frames.done}>
            <div className="h-full rounded-full bg-amber-400 transition-all" style={{ width: `${pct}%` }} />
          </div>
          <div className="flex flex-wrap justify-between gap-2 text-xs tabular-nums text-ink-300">
            <span>{frames.done.toLocaleString()} of {frames.total.toLocaleString()} frames ({pct}%)</span>
            <span>{perMin > 0 ? `${Math.round(perMin)} frames a minute${eta !== null ? ` · about ${clock(eta)} left` : ''}` : 'measuring speed…'}</span>
          </div>
        </div>
      )}

      {sheet && (
        <div className="space-y-1" data-job-progress-sheet>
          <div className="text-xs text-ink-400">Latest preview pictures (round {sheet.round + 1}). Tap to enlarge.</div>
          <button type="button" className="block w-full overflow-hidden rounded-lg border border-ink-800" onClick={() => setZoom((z) => !z)} aria-label="Enlarge the preview pictures">
            <img src={sheet.url} alt={`Preview pictures of look round ${sheet.round + 1}`} className={zoom ? 'w-full' : 'max-h-64 w-full object-cover object-top'} loading="lazy" />
          </button>
        </div>
      )}
    </section>
  );
}
