import React, { useEffect, useRef, useState } from 'react';
import { Play, Square } from 'lucide-react';
import * as api from '../../services/api.js';
import Panel from '../../ui/Panel.jsx';
import Button from '../../ui/Button.jsx';
import Banner from '../../ui/Banner.jsx';

function TypeChannelResearch({ disabled, duration, onCreated }) {
  const [channels, setChannels] = useState([]), [channelId, setChannelId] = useState(''), [type, setType] = useState('what-if');
  const [query, setQuery] = useState(''), [result, setResult] = useState(null), [picked, setPicked] = useState(''), [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  useEffect(() => { api.getChannels().then((r) => setChannels(Array.isArray(r?.channels) ? r.channels : Array.isArray(r) ? r : [])).catch(() => {}); }, []);
  const research = async (e) => { e.preventDefault(); setBusy(true); setMessage(''); setResult(null); try { const r = await api.researchVideoCandidates({ channelId, type, query }); setResult(r); setPicked(r.candidates?.[0]?.id || ''); } catch (err) { setMessage(err?.data?.error || err.message); } finally { setBusy(false); } };
  const create = async (auto) => { setBusy(true); setMessage(''); try { const r = await api.createResearchedVideo({ action: 'create', researchId: result.id, duration, ...(auto ? { auto: true } : { candidateId: picked }) }); onCreated(r.job); setMessage(`Run queued for review: ${r.job?.id || 'ready'}.`); } catch (err) { setMessage(err?.data?.error || err.message); } finally { setBusy(false); } };
  return <section className="space-y-3 rounded-lg border border-ink-800 p-3" data-video-research>
    <h3 className="text-sm font-semibold">Research a video topic</h3>
    <p className="text-xs text-ink-400">Choose a channel first, then a type. Review the cited candidates before creating a draft run.</p>
    <fieldset disabled={disabled || busy} className="space-y-3">
    <p className="text-xs text-ink-400">Draft length: {duration} seconds (selected below).</p>
    <form onSubmit={research} className="space-y-2">
      <label className="block text-xs">Channel<select className="ml-2 rounded bg-ink-900 border border-ink-700 px-2 py-1" aria-label="Research channel" value={channelId} onChange={(e) => { setChannelId(e.target.value); setResult(null); }}><option value="">Choose channel</option>{channels.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
      <label className="block text-xs">Type<select className="ml-2 rounded bg-ink-900 border border-ink-700 px-2 py-1" aria-label="Research type" value={type} onChange={(e) => { setType(e.target.value); setResult(null); }}><option value="what-if">What if</option><option value="history">History</option><option value="teardown">Teardown</option></select></label>
      <input className="w-full rounded bg-ink-900 border border-ink-700 px-2 py-1 text-xs" aria-label="Research direction" maxLength={200} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Optional direction" />
      <Button type="submit" disabled={busy || !channelId}>{busy ? 'Researching…' : 'Find candidates'}</Button>
    </form>
    {message && <p role="status" className="text-xs text-ink-300">{message}</p>}
    {result && <div className="space-y-2" aria-label="Research candidates"><p className="text-xs text-ink-400">{result.provenance}</p>{result.candidates.map((c) => <article key={c.id} className="rounded border border-ink-800 p-2 text-xs"><label><input type="radio" name="research-candidate" checked={picked === c.id} onChange={() => setPicked(c.id)} /> <span className="ml-1">{c.topic}</span></label><p className="my-1 text-ink-300">{c.why}</p><ul className="list-disc pl-5">{c.sources.map((s) => <li key={s.url}><a className="underline" href={s.url} target="_blank" rel="noopener noreferrer">{s.title || s.url}</a></li>)}</ul></article>)}<div className="flex gap-2"><Button disabled={busy || !picked} onClick={() => create(false)}>Create selected</Button><Button disabled={busy} onClick={() => create(true)}>Auto then Create</Button></div></div>}
    </fieldset>
  </section>;
}

// --- Pure functions and constants (exported for testing) ---
export const CODEBUILT_DURATIONS = Object.freeze([30, 45, 60, 90]);
export const BUILD_MODELS = Object.freeze(['Auto', 'Sonnet', 'Opus', 'Fable', 'Codex Sol']);
export const ACTIVE_STATUSES = Object.freeze(['queued', 'scripting', 'factchecking', 'voicing', 'planning', 'previewing', 'looking', 'building', 'drafting']);
// The visual check between planning and building (KAN-934): a small preview render in the offline sandbox, then a look at its pictures. Up to three rounds.
export const STEP_LABELS = Object.freeze({ previewing: 'rendering a small preview to check', looking: 'looking at the preview pictures and fixing what is wrong' });
export const isActiveJob = (job) => !!job && ACTIVE_STATUSES.includes(job.status);

// KAN-928 (CB16): one Start can run 1..10 videos. Count 1 with a typed topic and no advanced choice keeps using the single-job route.
export const CODEBUILT_COUNTS = Object.freeze([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
export const CODEBUILT_TYPES = Object.freeze(['Auto', 'factual', 'whatif']);
export const CODEBUILT_VOICES = Object.freeze(['Auto', 'aiden', 'dylan', 'eric', 'ono_anna', 'ryan', 'serena', 'sohee', 'uncle_fu', 'vivian']);
export const RUN_ACTIVE_STATUSES = Object.freeze(['queued', 'running', 'aborting']);
export const isActiveRun = (run) => !!run && RUN_ACTIVE_STATUSES.includes(run.status);
const TEXT_CHOICE = /^[\p{L}\p{N} ,.'&/+()-]{1,60}$/u;

/** Body of POST /api/codebuilt/start. Throws on a bad topic or duration; the server checks both again. */
export function buildCodebuiltStartBody({ topic, duration, buildModel }) {
  const text = typeof topic === 'string' ? topic.trim() : '';
  if (!text || text.length > 200 || /[\x00-\x1F\x7F]/.test(text)) throw new Error('Topic must be between 1 and 200 characters');
  if (!CODEBUILT_DURATIONS.includes(duration)) throw new Error('Duration must be 30, 45, 60 or 90 seconds');
  if (buildModel !== undefined && !BUILD_MODELS.includes(buildModel)) throw new Error('Invalid build model');
  return { topic: text, duration, ...(buildModel !== undefined ? { buildModel } : {}) };
}

const blankOrAuto = (v) => v === undefined || v === null || (typeof v === 'string' && (!v.trim() || v.trim().toLowerCase() === 'auto'));

/** True when the request needs the batch route: several videos, an Auto topic, or a choice the single-job route does not have. */
export function usesRunRoute({ count = 1, topic, genre, theme, type, autoDuration } = {}) {
  return count > 1 || blankOrAuto(topic) || !blankOrAuto(genre) || !blankOrAuto(theme) || !blankOrAuto(type) || autoDuration === true;
}

const isWhatIfTopic = (t) => /^what if\b/i.test(t) && t.endsWith('?');

/**
 * The reason the current form cannot be started, or null. Shown inline and blocks Start, so a combination the server refuses never has to be sent.
 * A typed topic is one video (a longer run would be the same video again): use a theme for several. The type and a typed topic must agree.
 */
export function runFormProblem({ count = 1, topic, type } = {}) {
  const typed = typeof topic === 'string' ? topic.trim() : '';
  if (typed && count > 1) return 'A typed topic is one video. Set the number of videos to 1, or clear the topic and give a theme to get several different videos.';
  if (typed && type === 'whatif' && !isWhatIfTopic(typed)) return 'The video type is What if, so the topic must be a "What if ...?" question.';
  if (typed && type === 'factual' && isWhatIfTopic(typed)) return 'The video type is Factual, but the topic is a "What if ...?" question. Set the type to What if or Auto.';
  return null;
}

/** Body of POST /api/codebuilt/runs. Auto and blank fields are left out (the server resolves them for every video). The server checks everything again. */
export function buildCodebuiltRunBody({ count = 1, topic, genre, theme, type, voice, duration, autoDuration, buildModel } = {}) {
  if (!CODEBUILT_COUNTS.includes(count)) throw new Error('Number of videos must be a whole number from 1 to 10');
  const body = { count };
  const typed = typeof topic === 'string' ? topic.trim() : '';
  if (typed) {
    if (typed.length > 200 || /[\x00-\x1F\x7F]/.test(typed)) throw new Error('Topic must be between 1 and 200 characters');
    body.topic = typed;
  }
  for (const [key, value] of [['genre', genre], ['theme', theme]]) {
    if (blankOrAuto(value)) continue;
    if (typeof value !== 'string' || !TEXT_CHOICE.test(value.trim())) throw new Error(`${key[0].toUpperCase()}${key.slice(1)} must be 1 to 60 letters, numbers or simple punctuation`);
    body[key] = value.trim();
  }
  if (!blankOrAuto(type)) {
    if (!CODEBUILT_TYPES.includes(type)) throw new Error('Invalid video type');
    body.type = type;
  }
  const problem = runFormProblem({ count, topic: typed, type: blankOrAuto(type) ? undefined : type });
  if (problem) throw new Error(problem);
  if (!blankOrAuto(voice)) {
    if (!CODEBUILT_VOICES.includes(voice)) throw new Error('Invalid voice');
    body.voice = voice;
  }
  if (!autoDuration) {
    if (!CODEBUILT_DURATIONS.includes(duration)) throw new Error('Duration must be 30, 45, 60 or 90 seconds');
    body.duration = duration;
  }
  if (buildModel !== undefined && buildModel !== 'Auto') {
    if (!BUILD_MODELS.includes(buildModel)) throw new Error('Invalid build model');
    body.buildModel = buildModel;
  }
  return body;
}

export function jobLabel(job) {
  if (!job) return '';
  if (job.status === 'done') return 'Draft ready for review';
  if (job.status === 'failed' || job.status === 'interrupted') return job.error?.message || 'The job failed';
  if (job.status === 'aborted') return 'Aborted';
  const step = job.step || job.status;
  return `Running: ${STEP_LABELS[step] ?? step}`;
}

/** One line per video of a run: "1. Why bridges sway - draft ready". Failures show the named reason. */
export function videoLabel(video) {
  if (!video) return '';
  const name = video.topic || 'Topic not picked yet';
  const n = (video.index ?? 0) + 1;
  if (video.status === 'done') return `${n}. ${name} - draft ready${video.draftId ? ` (${video.draftId})` : ''}`;
  if (video.status === 'failed') return `${n}. ${name} - failed: ${video.error?.message || 'unknown reason'}${video.error?.stage ? ` (${video.error.stage})` : ''}`;
  if (video.status === 'aborted') return `${n}. ${name} - not made (${video.error?.message || 'aborted'})`;
  if (video.status === 'pending') return `${n}. waiting`;
  return `${n}. ${name} - ${video.step || video.status}`;
}

/** Headline for a run: where it is, how many drafts so far, how many failed. */
export function runLabel(run) {
  if (!run) return '';
  const s = run.summary || {};
  const parts = [`${s.drafts ?? 0} of ${run.count} drafts`];
  if (s.failed) parts.push(`${s.failed} failed`);
  if (s.aborted) parts.push(`${s.aborted} not made`);
  if (run.status === 'queued' || run.status === 'running') {
    const current = (run.videos || []).find((v) => v.status === 'resolving' || v.status === 'running');
    return `Running video ${current ? current.index + 1 : (s.done ?? 0) + (s.failed ?? 0) + 1} of ${run.count}: ${parts.join(', ')}`;
  }
  if (run.status === 'aborting') return `Stopping after the current step: ${parts.join(', ')}`;
  if (run.status === 'aborted') return `Run aborted: ${parts.join(', ')}`;
  if (run.status === 'interrupted') return `The server restarted during the run: ${parts.join(', ')}`;
  return `Run finished: ${parts.join(', ')}`;
}

// --- React Component ---
export default function CodebuiltStart() {
  const [topic, setTopic] = useState('');
  const [duration, setDuration] = useState(60);
  const [autoDuration, setAutoDuration] = useState(false);
  const [buildModel, setBuildModel] = useState('Auto');
  const [count, setCount] = useState(1);
  const [genre, setGenre] = useState('');
  const [theme, setTheme] = useState('');
  const [type, setType] = useState('Auto');
  const [voice, setVoice] = useState('Auto');
  const [job, setJob] = useState(null);
  const [jobs, setJobs] = useState([]);
  const [run, setRun] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const timer = useRef(null);

  useEffect(() => {
    const poll = async () => { try { const result = await api.listCodebuiltJobs(); setJobs(Array.isArray(result?.jobs) ? result.jobs : []); } catch {} };
    void poll(); const id = setInterval(poll, 3000); return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (!isActiveJob(job)) return undefined;
    timer.current = setInterval(async () => {
      try { setJob(await api.getCodebuiltJob(job.id)); } catch { /* keep the last status; the next poll retries */ }
    }, 3000);
    return () => clearInterval(timer.current);
  }, [job?.id, job?.status]);

  useEffect(() => {
    if (!isActiveRun(run)) return undefined;
    const poll = setInterval(async () => {
      try { setRun(await api.getCodebuiltRun(run.id)); } catch { /* keep the last status; the next poll retries */ }
    }, 3000);
    return () => clearInterval(poll);
  }, [run?.id, run?.status]);

  const start = async (e) => {
    if (e) e.preventDefault();
    setError(null);
    const form = { count, topic, genre, theme, type, voice, duration, autoDuration, buildModel };
    setBusy(true);
    try {
      if (usesRunRoute(form)) {
        const body = buildCodebuiltRunBody(form);
        setJob(null);
        setRun(await api.startCodebuiltRun(body));
      } else {
        const body = buildCodebuiltStartBody({ topic, duration, buildModel });
        setRun(null);
        setJob(await api.startCodebuiltJob(voice !== 'Auto' ? { ...body, voice } : body));
      }
    } catch (err) { setError(err?.data?.error || err.message || 'Could not start'); } finally { setBusy(false); }
  };
  const abort = async () => {
    try { setJob(await api.abortCodebuiltJob(job.id)); } catch (err) { setError(err?.data?.error || err.message || 'Could not abort'); }
  };
  const resume = async (id) => {
    setError(null);
    try { const resumed = await api.resumeCodebuiltJob(id); setJob(resumed); setJobs((rows) => [resumed, ...rows.filter((row) => row.id !== id)]); }
    catch (err) { setError(err?.data?.error || err.message || 'Could not resume'); }
  };
  const abortRun = async () => {
    try { setRun(await api.abortCodebuiltRun(run.id)); } catch (err) { setError(err?.data?.error || err.message || 'Could not abort'); }
  };

  const otherActive = jobs.some((row) => row.id !== job?.id && isActiveJob(row));
  const active = isActiveJob(job) || isActiveRun(run) || otherActive;
  const several = count > 1;
  const problem = runFormProblem({ count, topic, type: blankOrAuto(type) ? undefined : type });
  return (
    <Panel title="Code-built video" className="space-y-4" data-codebuilt-start>
      <TypeChannelResearch disabled={active} duration={duration} onCreated={setRun} />
      <p className="text-xs text-ink-400">
        Builds the video with generated code in the isolated runner, then hands it to review as a draft. Press Start to begin; nothing runs until you do.
      </p>
      {error && <Banner tone="error" title="Error:" onDismiss={() => setError(null)}>{error}</Banner>}
      <form onSubmit={start} className="space-y-3">
        <input
          type="text" value={topic} onChange={(e) => setTopic(e.target.value)} maxLength={200} disabled={active}
          placeholder={several ? 'Topic (Auto: each video gets its own topic)' : 'Topic (leave empty for Auto)'} aria-label="Code-built topic" data-codebuilt-topic
          className="w-full rounded-lg bg-ink-900 border border-ink-700 px-3 py-2 text-sm text-ink-100"
        />
        <div className="flex items-center gap-4" role="radiogroup" aria-label="Duration">
          {CODEBUILT_DURATIONS.map((d) => (
            <label key={d} className="flex items-center gap-1.5 text-sm text-ink-200">
              <input type="radio" name="codebuilt-duration" checked={duration === d} disabled={active || autoDuration} onChange={() => setDuration(d)} data-codebuilt-duration={d} />
              {d} s
            </label>
          ))}
        </div>
        <label className="flex items-center gap-2 text-xs text-ink-300">
          <span>Number of videos</span>
          <select
            value={count} onChange={(e) => setCount(Number(e.target.value))} disabled={active} aria-label="Number of videos" data-codebuilt-count
            className="rounded bg-ink-900 border border-ink-700 px-2 py-1 text-xs text-ink-100"
          >
            {CODEBUILT_COUNTS.map((n) => (<option key={n} value={n}>{n}</option>))}
          </select>
          {several && <span className="text-ink-400">made one after another; a failed video does not stop the rest</span>}
        </label>
        {problem && <p className="text-xs text-amber-300" role="alert" data-codebuilt-form-problem>{problem}</p>}
        <details className="text-xs text-ink-300" data-codebuilt-advanced>
          <summary className="cursor-pointer select-none">Advanced choices (everything left on Auto is decided for each video)</summary>
          <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="flex flex-col gap-1">
              <span>Genre</span>
              <input type="text" value={genre} onChange={(e) => setGenre(e.target.value)} maxLength={60} disabled={active} placeholder="Auto" aria-label="Genre" data-codebuilt-genre
                className="rounded bg-ink-900 border border-ink-700 px-2 py-1 text-xs text-ink-100" />
            </label>
            <label className="flex flex-col gap-1">
              <span>Theme</span>
              <input type="text" value={theme} onChange={(e) => setTheme(e.target.value)} maxLength={60} disabled={active} placeholder="Auto" aria-label="Theme" data-codebuilt-theme
                className="rounded bg-ink-900 border border-ink-700 px-2 py-1 text-xs text-ink-100" />
            </label>
            <label className="flex flex-col gap-1">
              <span>Video type</span>
              <select value={type} onChange={(e) => setType(e.target.value)} disabled={active} aria-label="Video type" data-codebuilt-type
                className="rounded bg-ink-900 border border-ink-700 px-2 py-1 text-xs text-ink-100">
                {CODEBUILT_TYPES.map((t) => (<option key={t} value={t}>{t === 'whatif' ? 'What if' : t === 'factual' ? 'Factual' : 'Auto'}</option>))}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span>Voice</span>
              <select value={voice} onChange={(e) => setVoice(e.target.value)} disabled={active} aria-label="Voice" data-codebuilt-voice
                className="rounded bg-ink-900 border border-ink-700 px-2 py-1 text-xs text-ink-100">
                {CODEBUILT_VOICES.map((v) => (<option key={v} value={v}>{v}</option>))}
              </select>
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={autoDuration} disabled={active} onChange={(e) => setAutoDuration(e.target.checked)} data-codebuilt-duration-auto />
              <span>Auto length (decided for each video)</span>
            </label>
            <label className="flex items-center gap-2">
              <span>Build model</span>
              <select
                value={buildModel}
                onChange={(e) => setBuildModel(e.target.value)}
                disabled={active}
                aria-label="Build model"
                data-codebuilt-build-model
                className="rounded bg-ink-900 border border-ink-700 px-2 py-1 text-xs text-ink-100"
              >
                {BUILD_MODELS.map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            </label>
          </div>
        </details>
        <div className="flex items-center gap-3">
          <Button type="submit" variant="primary" icon={Play} loading={busy} disabled={active || busy || !!problem} data-codebuilt-start-button>{several ? `Start ${count} code-built videos` : 'Start code-built video'}</Button>
          {isActiveJob(job) && <Button type="button" variant="secondary" icon={Square} onClick={abort} data-codebuilt-abort>Abort</Button>}
          {isActiveRun(run) && <Button type="button" variant="secondary" icon={Square} onClick={abortRun} disabled={run.status === 'aborting'} data-codebuilt-abort-run>Abort run</Button>}
        </div>
      </form>
      {job && (
        <div className="text-xs text-ink-300 space-y-1" data-codebuilt-job={job.id} data-codebuilt-status={job.status}>
          <div>{jobLabel(job)}</div>
          {job.status === 'done' && job.draftId && <div>Draft: <code className="text-ink-200">{job.draftId}</code> (review it in Drafts)</div>}
          {job.visual_check?.approved === false && <div className="text-amber-300">Visual check not approved: {(job.visual_check.findings || []).map((f) => f.issue).filter(Boolean).join('; ')}</div>}
        </div>
      )}
      {jobs.length > 0 && <div className="space-y-2" data-codebuilt-job-rows>{jobs.map((row) => <div key={row.id} className="rounded-lg border border-ink-800 p-3 text-xs text-ink-300" data-codebuilt-job={row.id} data-codebuilt-status={row.status}>
        <div className="flex items-center justify-between gap-3"><span>{row.topic} · {jobLabel(row)}</span>{(row.status === 'failed' || row.status === 'aborted') && <Button type="button" size="sm" variant="secondary" disabled={!row.resumable || otherActive || busy} onClick={() => resume(row.id)} data-codebuilt-resume={row.id}>Resume</Button>}</div>
        {((row.status === 'failed' || row.status === 'aborted') || row.resumes?.length > 0) && <p className="mt-1 text-ink-400">Resumes from {row.resumeFrom || 'the first missing step'}{row.reuses?.length ? ` · reuses ${row.reuses.join(', ')}` : ''}{row.resumeBlockedReason ? ` · ${row.resumeBlockedReason}` : ''}</p>}
        {row.visual_check?.approved === false && <p className="mt-1 text-amber-300">Visual check not approved: {(row.visual_check.findings || []).map((f) => f.issue).filter(Boolean).join('; ')}</p>}
      </div>)}</div>}
      {run && (
        <div className="text-xs text-ink-300 space-y-1" data-codebuilt-run={run.id} data-codebuilt-run-status={run.status}>
          <div className="text-ink-200">{runLabel(run)}</div>
          <ul className="space-y-0.5">
            {run.videos.map((v) => (<li key={v.index} data-codebuilt-video={v.index} data-codebuilt-video-status={v.status}>{videoLabel(v)}</li>))}
          </ul>
          {!isActiveRun(run) && run.summary?.drafts > 0 && <div>Review the drafts in Drafts. Nothing is published automatically.</div>}
        </div>
      )}
    </Panel>
  );
}
