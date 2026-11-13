import React, { useState } from 'react';
import { Play, Pause, OctagonAlert, ShieldAlert } from 'lucide-react';
import Modal from '../ui/Modal.jsx';
import Button from '../ui/Button.jsx';
import { StatusDot } from '../ui/Badge.jsx';

export default function PipelineControls({ status, isRunning, onControlAction }) {
  const [modal, setModal] = useState(null); // 'pause' | 'stop' | null
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const pipelineStatus = status?.status || 'running';
  const killSwitch = status?.kill_switch_engaged || status?.kill_switch_active;
  const tone = killSwitch ? 'error' : pipelineStatus === 'running' ? 'accent' : pipelineStatus === 'paused' ? 'warn' : 'error';

  const close = () => { setModal(null); setReason(''); };
  const run = async (action, payload) => {
    setBusy(true);
    await onControlAction(action, payload);
    setBusy(false);
    close();
  };

  return (
    <div className="space-y-2">
      <div data-cy="status-pill" className="flex items-center justify-center lg:justify-start gap-2 px-1" title={`Pipeline ${killSwitch ? 'HALTED' : pipelineStatus}`}>
        <StatusDot tone={tone} pulse={isRunning} />
        <span className="hidden lg:inline font-mono text-[11px] uppercase tracking-wider text-ink-300">{killSwitch ? 'HALTED' : pipelineStatus}</span>
      </div>

      <div className="flex flex-col lg:flex-row gap-1.5">
        {pipelineStatus === 'running' ? (
          <Button size="sm" icon={Pause} aria-label="Pause" title="Pause pipeline" onClick={() => setModal('pause')} className="flex-1 !text-amber-300 !border-amber-500/25 hover:!bg-amber-500/10">
            <span className="hidden lg:inline">Pause</span>
          </Button>
        ) : (
          <Button size="sm" variant="primary" icon={Play} aria-label={pipelineStatus === 'paused' ? 'Resume' : 'Start'} disabled={busy} onClick={() => run('start')} className="flex-1">
            <span className="hidden lg:inline">{pipelineStatus === 'paused' ? 'Resume' : 'Start'}</span>
          </Button>
        )}
        <Button size="sm" variant="danger" icon={OctagonAlert} aria-label="Kill Switch" title="Kill switch: emergency pipeline halt" disabled={killSwitch} onClick={() => setModal('stop')} className="flex-1">
          <span className="hidden lg:inline whitespace-nowrap">Stop</span>
        </Button>
      </div>

      <Modal
        open={modal === 'pause'}
        onClose={close}
        title={<><Pause className="w-5 h-5 text-amber-400" />Pause Autonomous Pipeline</>}
        footer={<>
          <Button onClick={close} disabled={busy}>Cancel</Button>
          <Button onClick={() => run('pause', { reason: reason || 'Manual pause from dashboard' })} disabled={busy} className="!bg-amber-500 !border-amber-500 hover:!bg-amber-400 !text-ink-950 font-semibold">
            {busy ? 'Pausing...' : 'Confirm Pause'}
          </Button>
        </>}
      >
        <p className="text-sm text-ink-300 mb-4">Enter an optional reason for audit logging. The pipeline will finish the currently generating item and pause before the next task.</p>
        <input type="text" aria-label="Pause reason (optional)" className="input w-full" placeholder="e.g. Inspecting draft quality..." value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
      </Modal>

      <Modal
        open={modal === 'stop'}
        onClose={close}
        tone="danger"
        title={<><ShieldAlert className="w-5 h-5 text-rose-500" /><span className="text-rose-400">Emergency Kill Switch</span></>}
        footer={<>
          <Button onClick={close} disabled={busy}>Cancel</Button>
          <Button variant="danger" onClick={() => run('stop', { reason: reason || 'Emergency halt from dashboard' })} disabled={busy || !reason.trim()}>
            {busy ? 'Halting...' : 'Engage Kill Switch'}
          </Button>
        </>}
      >
        <p className="text-sm text-ink-300 mb-4">This triggers immediate emergency halt across all worker processes. A reason is required for governance tracking.</p>
        <input type="text" aria-label="Emergency stop reason (required)" className="input w-full !border-rose-500/30 focus:!border-rose-500" placeholder="Reason for emergency stop (required)" value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
      </Modal>
    </div>
  );
}
