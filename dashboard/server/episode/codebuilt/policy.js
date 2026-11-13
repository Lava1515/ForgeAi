// CB6: launch policy. Safe by default: only the Docker fence is accepted, only launches on the frozen approved
// list can start, and the real agent stays off until the independent security review is merged AND the open
// owner decisions are closed. Nothing in this file is configurable at run time.
export class IsolationRefused extends Error {
  constructor(message) { super(message); this.name = 'IsolationRefused'; this.code = 'ISOLATION_REFUSED'; }
}

/**
 * A prior container of the fence may still be running or holding the GPU/job folder (removal not confirmed, a fenced
 * container no lock accounts for, the container list unreadable). NOT an IsolationRefused: IsolationRefused means
 * "a pre-launch check failed, nothing exists, the caller may change its input and try again". This means something
 * MAY BE ALIVE. Callers must not rewrite inputs and retry: they stop, report an orphan and wait for reapOrphans() or
 * an operator. `code` is always 'ORPHAN_UNCERTAIN'; `started` is false for THIS request, `possiblyLive` is true.
 */
export class OrphanUncertain extends Error {
  constructor(message, detail = {}) {
    super(message); this.name = 'OrphanUncertain'; this.code = 'ORPHAN_UNCERTAIN';
    this.started = false; this.possiblyLive = true; this.retryable = false;
    this.jobIds = detail.jobIds ?? []; this.unowned = detail.unowned ?? []; this.listError = detail.listError ?? null;
  }
}

// Flip only in the commit that merges the independent Sonnet security review of CB6 (see docs/codebuilt-isolation.md).
export const SECURITY_REVIEW = Object.freeze({"merged": true, "reviewer": "codex ? gpt-6-luna", "ref": "b186312378a1d972c1b7e08b9703567b62b23b21"});

// Owner decisions that are still open. While any is listed the real agent cannot start, review merged or not.
// Remove an item only in the commit that records the owner's decision and implements it.
// EMPTY since owner order 2026-11-12 23:50 (thread "Review Open Threads and Progress"): the topology was taken on
// 2026-11-12 17:26 (ForgeBrain/decisions/2026-11-12-codebuilt-offline-execution-taken.md): host CLI planner, offline
// generated-code container with network none, no credential and a read-only kit. The earlier items (cli_credential,
// network_egress, cb5_topology) were about a CLI agent INSIDE the container; that agent is not part of this topology.
// Emptying the list does not enable anything by itself: the `real-agent` kind still needs the merged review, has no
// approved entry, and the build-job runner refuses it. This list is a gate for a future decision, not a record.
export const OPEN_OWNER_DECISIONS = Object.freeze([]);

/**
 * The only launches that may reach Docker. Each entry binds one exact image (content address), one exact command
 * argv and the review that approved it:
 *   { id, kind: 'stub' | 'real-agent', image, command: string[], gpu: boolean,
 *     review: { reviewer, ref }, acknowledges?: string[] }
 * Only the fixed MIT CPU probe is proposed here. Real agents remain disabled.
 * cb6-generated-blender-gpu-v1 (one GPU) is pinned to the exact-head cross-family review: checkApproval requires a generated-code
 * entry's review to equal the merged SECURITY_REVIEW, and this activation records the
 * exact-head cross-family security review (tools/codebuilt/generated-executor-image/README.md).
 * A stub entry must be a fixed program from the image; it must never execute or interpret a file from /job.
 */
export const APPROVED_LAUNCHES = Object.freeze([{"id": "cb6-mit-cpu-proof-v5", "kind": "stub", "image": "sha256:1e5b32276aa0dfed5a8e9fe267a28aa7ca8c23ead9780f315f4643852c9cf272", "command": ["/proof"], "gpu": false, "blender": {"max": 0}, "limits": {"memoryMb": 512, "cpus": 1, "pids": 64}, "review": {"reviewer": "claude-pro · claude-sonnet-5-5", "ref": "cb6-mit-cpu-proof-v5"}}, {"id": "cb6-blender-cpu-render-v1", "kind": "stub", "image": "sha256:395f1052b85c04ebcbea9c2e2f6ecd92604b82b094b9c56dbcfebe05eb6e1a2f", "command": ["/opt/forge/blender-proof"], "gpu": false, "blender": {"max": 2}, "limits": {"memoryMb": 2048, "cpus": 1, "pids": 256}, "review": {"reviewer": "claude-pro · claude-sonnet-5-5", "ref": "sol1940-blender-proof-review2-5d96054c"}}, {"id": "cb6-blender-cpu-denied-v1", "kind": "stub", "image": "sha256:395f1052b85c04ebcbea9c2e2f6ecd92604b82b094b9c56dbcfebe05eb6e1a2f", "command": ["/opt/forge/blender-proof-denied"], "gpu": false, "blender": {"max": 2}, "limits": {"memoryMb": 2048, "cpus": 1, "pids": 256}, "review": {"reviewer": "claude-pro · claude-sonnet-5-5", "ref": "sol1940-blender-proof-review2-5d96054c"}}, {"id": "cb6-generated-blender-v1", "kind": "generated-code", "image": "sha256:8d2b54c0c1309a8335b0e580d2e5f011398acef1b3ffc88cad3c3e37928381a0", "command": ["/opt/forge/blender-generated"], "gpu": false, "blender": {"max": 2}, "limits": {"memoryMb": 8192, "cpus": 12, "pids": 512}, "acknowledges": ["blender_cap_detect_only", "runs_generated_job_code"], "review": {"reviewer": "codex ? gpt-6-luna", "ref": "b186312378a1d972c1b7e08b9703567b62b23b21"}}, {"id": "cb6-generated-blender-gpu-v1", "kind": "generated-code", "image": "sha256:eb74788b589f9993c75d1154c8da2d1a2bca8e88dffc52ec39118d7b89b912b8", "command": ["/opt/forge/blender-generated-gpu"], "gpu": true, "blender": {"max": 2}, "limits": {"memoryMb": 8192, "cpus": 12, "pids": 512}, "acknowledges": ["blender_cap_detect_only", "runs_generated_job_code"], "review": {"reviewer": "codex ? gpt-6-luna", "ref": "b186312378a1d972c1b7e08b9703567b62b23b21"}}]);

// Exact local image IDs only (sha256:<64 hex>). Tags and name@sha256:<digest> forms are refused: a repo digest names
// a manifest, not the local object, and `docker image inspect` could not be bound to it with certainty. runFenced
// requires the daemon to report exactly this id.
export const IMAGE_REF_RE = /^sha256:[a-f0-9]{64}$/;

// Generated Blender Python runs INSIDE the offline Docker job, never unconfined on the host (owner decision, KAN-915).
// "At most two Blender processes" is DETECTION ONLY there: the watchdog counts blender-looking processes (processGuard.js)
// but code in the container can rename or copy the binary, so a hostile job can evade it. The hard bounds are the
// container's pids, memory and cpu limits, network none, the timeout and the single GPU lease. An approved entry states
// `blender: { max: 0..2 }` (the most Blender processes the watchdog tolerates). A real-agent entry must also
// acknowledge that the cap is detect-only.
export const BLENDER_MAX = 2;
export const BLENDER_CAP_ACK = 'blender_cap_detect_only';

// Third launch kind: the offline executor of agent-written ("generated") code. Topology decision (KAN-914/915, taken
// 2026-11-12 17:26): the planner is the host CLI, generated code runs HERE in an offline container with no credential,
// no .env and network none. Unlike a stub, its fixed launcher DOES run job content (the build script the planner wrote
// into the job folder), so it is never labelled `stub`. It is gated like the real agent on the independent security
// review (merged, same review identity, both acknowledgements); it never depended on OPEN_OWNER_DECISIONS (the former
// CLI-credential, egress and topology items concerned a CLI agent living inside the container, which this kind never is:
// network is forced to "none", nothing is mounted or injected). That list is empty since owner order 2026-11-12 23:50.
export const GENERATED_KIND = 'generated-code';
export const GENERATED_CODE_ACK = 'runs_generated_job_code';

const isReviewRef = (r) => Boolean(r) && typeof r.reviewer === 'string' && r.reviewer !== '' && typeof r.ref === 'string' && r.ref !== '';
// Programs that run another program or script, and tools that wrap/exec one. A stub is a fixed program, never one of these.
const INTERPRETER_RE = /^(?:(?:ba|da|a|k|z|c|tc|r)?sh|ksh\d*|fish|busybox|toybox|env|python[0-9.]*|pythonw[0-9.]*|pypy[0-9.]*|perl[0-9.]*|ruby[0-9.]*|node(?:js)?|bun|deno|php[0-9.]*|lua[0-9.]*|luajit|tclsh[0-9.]*|wish[0-9.]*|java|awk|gawk|mawk|nawk|sed|xargs|nohup|timeout|nice|ionice|stdbuf|setsid|chroot|su|sudo|doas|strace|ltrace|gdb|exec|command|eval|time|watch|script|expect|make|cmake|ld\.so[0-9.]*|ld-[A-Za-z0-9._-]*|ld|blender)$/;
const FORBIDDEN_ROOT_RE = /^\/(?:job|tmp|proc|dev|sys)(?:\/|$)/i;
const sameArgv = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => typeof x === 'string' && x === b[i]);

function realAgentState(review, openDecisions) {
  if (review?.merged !== true || !isReviewRef(review)) return 'real agent runs stay disabled until the CB6 security review is merged';
  if (openDecisions.length) return `real agent runs stay disabled while owner decisions are open: ${openDecisions.join(', ')}`;
  return null;
}

export function realAgentAllowed() { return realAgentState(SECURITY_REVIEW, OPEN_OWNER_DECISIONS) === null; }

function generatedCodeState(review) {
  if (review?.merged !== true || !isReviewRef(review)) return 'generated-code runs stay disabled until the independent security review of the launcher is merged';
  return null;
}

export function generatedCodeAllowed() { return generatedCodeState(SECURITY_REVIEW) === null; }

// A reviewed command is one exact absolute program from the image plus plain arguments. Nothing in argv may point at
// the job folder, tmp, or a /proc /dev /sys alias (those reach the writable job mount or a mutable file), and a stub
// may not be a shell or interpreter: the approved argv, not job content, must decide what runs.
function assertReviewedCommand(entry) {
  const cmd = entry.command;
  const fail = (why) => new IsolationRefused(`approved entry ${entry.id}: ${why}`);
  if (!Array.isArray(cmd) || cmd.length === 0 || cmd.some(a => typeof a !== 'string' || a === '' || /[\u0000\r\n]/.test(a))) throw fail('command must be a non-empty argv of non-empty strings');
  const exe = cmd[0];
  if (!/^\/[A-Za-z0-9._/-]+$/.test(exe) || exe.includes('..') || exe.includes('//') || exe.endsWith('/') || FORBIDDEN_ROOT_RE.test(exe)) {
    throw fail('the program must be a clean absolute path inside the image, never under /job, /tmp, /proc, /dev or /sys');
  }
  const fixedProgram = entry.kind !== 'real-agent';
  if (fixedProgram && INTERPRETER_RE.test(exe.split('/').pop().toLowerCase())) throw fail('a stub or generated-code launcher may not be a shell, interpreter or wrapper program');
  if (entry.kind === GENERATED_KIND && cmd.length !== 1) throw fail('the generated-code launcher takes no arguments: its argv is hard-coded inside the image');
  for (const arg of cmd) {
    if (fixedProgram && INTERPRETER_RE.test(arg.split('/').pop().toLowerCase())) throw fail(`a stub or generated-code argument names a shell or interpreter: ${JSON.stringify(arg)}`);
    if (/(^|[^A-Za-z0-9_.-])\/{1,}(?:job|tmp|proc|dev|sys)(?![A-Za-z0-9_.-])/i.test(arg)) throw fail(`argument refers to /job, /tmp, /proc, /dev or /sys: ${JSON.stringify(arg)}`);
    if (/(^|[^A-Za-z0-9_.-])(?:job|tmp|proc|dev|sys)\//i.test(arg) || /(^|\/)\.{1,2}(\/|$)/.test(arg) || /\/\//.test(arg)) throw fail(`argument is a relative or non-canonical path: ${JSON.stringify(arg)}`);
  }
}

/**
 * Pure check of one launch request against an approved list. Returns the matching entry or throws IsolationRefused.
 * `review` and `openDecisions` are parameters only so the binding rules can be unit tested; every launch path uses
 * assertApprovedLaunch, which passes the frozen constants.
 */
export function checkApproval(request, approvals, review, openDecisions) {
  const { kind, image, command } = request ?? {};
  if (kind !== 'stub' && kind !== 'real-agent' && kind !== GENERATED_KIND) throw new IsolationRefused(`unknown job kind ${JSON.stringify(kind)}: state "stub", "${GENERATED_KIND}" or "real-agent" explicitly`);
  if (kind === 'real-agent') {
    const why = realAgentState(review, openDecisions);
    if (why) throw new IsolationRefused(why);
  }
  if (kind === GENERATED_KIND) {
    const why = generatedCodeState(review);
    if (why) throw new IsolationRefused(why);
  }
  if (request.network !== undefined && request.network !== 'none') {
    throw new IsolationRefused('network egress is an open owner decision: only network "none" can launch');
  }
  const entry = (Array.isArray(approvals) ? approvals : []).find(e => e && e.kind === kind && e.image === image
    && sameArgv(e.command, command) && Boolean(e.gpu) === Boolean(request.gpu));
  if (!entry) {
    throw new IsolationRefused('launch is not on the approved list: kind, image digest, command argv and GPU use must match one approved entry exactly');
  }
  if (typeof entry.image !== 'string' || !IMAGE_REF_RE.test(entry.image)) throw new IsolationRefused(`approved entry ${entry.id}: image is not a sha256 content address`);
  if (!isReviewRef(entry.review)) throw new IsolationRefused(`approved entry ${entry.id}: no review identity (reviewer and ref)`);
  assertReviewedCommand(entry);
  if (kind === 'real-agent' || kind === GENERATED_KIND) {
    if (entry.review.ref !== review.ref || entry.review.reviewer !== review.reviewer) {
      throw new IsolationRefused(`approved entry ${entry.id}: not approved by the merged security review (${review.ref})`);
    }
  }
  const max = entry.blender?.max;
  if (!Number.isInteger(max) || max < 0 || max > BLENDER_MAX) {
    throw new IsolationRefused(`approved entry ${entry.id}: must state blender { max } as an integer from 0 to ${BLENDER_MAX}`);
  }
  if ((kind === 'real-agent' || kind === GENERATED_KIND) && (!Array.isArray(entry.acknowledges) || !entry.acknowledges.includes(BLENDER_CAP_ACK))) {
    throw new IsolationRefused(`approved entry ${entry.id}: the review must acknowledge "${BLENDER_CAP_ACK}" (the Blender cap is detect-only and a renamed binary evades it)`);
  }
  if (kind === GENERATED_KIND && !entry.acknowledges.includes(GENERATED_CODE_ACK)) {
    throw new IsolationRefused(`approved entry ${entry.id}: the review must acknowledge "${GENERATED_CODE_ACK}" (the fixed launcher runs the planner's build script from the job folder)`);
  }
  if (request.maxBlender !== undefined && (!Number.isInteger(request.maxBlender) || request.maxBlender < 0 || request.maxBlender > max)) {
    throw new IsolationRefused(`maxBlender must be an integer from 0 to the approved ${max}`);
  }
  // Absent per-entry limits use fixed reviewed defaults; callers may only lower them.
  const defaults = { memoryMb: 8192, cpus: 4, pids: 512 };
  for (const [key, fallback] of Object.entries(defaults)) {
    const ceiling = entry.limits?.[key] ?? fallback;
    const requested = request.limits?.[key] ?? fallback;
    if (!Number.isFinite(ceiling) || ceiling <= 0 || !Number.isFinite(requested) || requested <= 0 || requested > ceiling) {
      throw new IsolationRefused(`limit ${key} exceeds or invalidates approved maximum ${ceiling}`);
    }
  }
  return entry;
}

/** The Blender process cap of an approved launch: the request may lower it, never raise it. */
export const blenderCapFor = (entry, request) => request?.maxBlender ?? entry.blender.max;

/** The launch gate used by every path that can start a container. Not configurable. */
export function assertApprovedLaunch(request, approvals = APPROVED_LAUNCHES) {
  return checkApproval(request, approvals, SECURITY_REVIEW, OPEN_OWNER_DECISIONS);
}

/**
 * Local (host) execution is refused for every caller. On the host there is no mechanism in this repo that confines
 * agent-written Python or Blender to the job folder (no OS-level sandbox, no ACL/jail), and a Python-level
 * "sandbox" is not a security boundary. There is deliberately no flag that overrides this: a verified local
 * enforcement mechanism must be added here, with its own review, before it can be allowed.
 */
export function assertLaunchAllowed({ runtime } = {}) {
  if (runtime === 'docker') return;
  if (runtime === 'local') {
    throw new IsolationRefused('local execution is not enforced: nothing confines agent-written code to the job folder on the host. Use the Docker runtime.');
  }
  throw new IsolationRefused(`unknown runtime ${JSON.stringify(runtime)}: only the Docker fence is accepted`);
}
