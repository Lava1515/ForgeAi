import React, { useEffect, useState } from 'react';

const stateLabel = (item) => item?.status ?? 'pending';

function ArtifactText({ artifacts, name, title }) {
  const item = artifacts[name];
  return (
    <details className="rounded border border-ink-800 p-2">
      <summary className="cursor-pointer">{title} - {stateLabel(item)}</summary>
      <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap text-ink-300">{item?.text ?? 'Not recorded for this job.'}</pre>
    </details>
  );
}

function ArtifactImage({ item, label }) {
  return item?.url ? <img src={item.url} alt={label} loading="lazy" className="max-h-80 max-w-full rounded border border-ink-800" /> : null;
}

export function JobArtifactView({ job, artifacts = {} }) {
  const final = artifacts.finalVideo?.url ? artifacts.finalVideo : artifacts.video;
  const sheet = artifacts.finalSheet?.url ? artifacts.finalSheet : artifacts.contactSheet;
  const rounds = Object.keys(artifacts).filter((key) => /^round\d+$/.test(key)).map((key) => Number(key.slice(5))).sort((a, b) => a - b);
  return (
    <section aria-label={`Job ${job.id} artifacts`} className="space-y-2 pt-2 text-xs text-ink-200">
      <ArtifactText artifacts={artifacts} name="script" title="Script" />
      <ArtifactText artifacts={artifacts} name="shots" title="Shot list" />
      <div className="rounded border border-ink-800 p-2">
        <p className="mb-2">Preview sheets</p>
        {rounds.map((round) => (
          <details key={round} className="mb-2">
            <summary className="cursor-pointer">Preview round {round} - {stateLabel(artifacts[`round${round}`])}</summary>
            <ArtifactText artifacts={artifacts} name={`round${round}`} title="Review result" />
            <div className="mt-2 flex flex-wrap gap-2">
              {Array.from({ length: 9 }, (_, index) => <ArtifactImage key={index} item={artifacts[`round${round}sheet${index + 1}`]} label={`Preview round ${round}, sheet ${index + 1}`} />)}
            </div>
          </details>
        ))}
        {!rounds.some((round) => artifacts[`round${round}sheet1`]?.url) && <p className="text-ink-400">No preview sheets recorded yet.</p>}
      </div>
      <div className="rounded border border-ink-800 p-2">
        <p>Final - {final?.status ?? 'pending'}</p>
        {final?.url ? <video controls preload="metadata" src={final.url} aria-label="Final video" className="mt-2 max-h-96 max-w-full" /> : <p className="text-ink-400">Final video not recorded yet.</p>}
        {sheet?.url && <ArtifactImage item={sheet} label="Final contact sheet" />}
        <ArtifactText artifacts={artifacts} name={artifacts.finalReport?.status === 'available' ? 'finalReport' : 'report'} title="Final report" />
      </div>
      <div className="rounded border border-ink-800 p-2">
        <p>{artifacts.cost?.summary ?? `Cost: ${stateLabel(artifacts.cost)}; no usable call record.`}</p>
        <ArtifactText artifacts={artifacts} name="cost" title="Recorded cost calls" />
      </div>
    </section>
  );
}

export default function JobDetailArtifacts({ job }) {
  const [state, setState] = useState({});
  useEffect(() => {
    let live = true;
    setState({});
    const load = async () => {
      try {
        const response = await fetch(`/api/codebuilt/jobs/${encodeURIComponent(job.id)}/artifacts`);
        if (!response.ok) throw new Error('unavailable');
        const data = await response.json();
        if (live) setState(data);
      } catch { if (live) setState({ error: true }); }
    };
    load();
    const timer = setInterval(load, 5000);
    return () => { live = false; clearInterval(timer); };
  }, [job.id]);
  return <div>{state.error && <p role="status">Artifacts unavailable; retrying.</p>}<JobArtifactView job={job} artifacts={state.artifacts} /></div>;
}
