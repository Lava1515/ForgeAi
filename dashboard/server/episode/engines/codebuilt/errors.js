// CB5 (KAN-914): typed failures of the build-job runner. Every failure the caller can act on has one stable code.
export const CODES = Object.freeze([
  'REAL_AGENT_REFUSED', 'INTEGRATION_PENDING', 'FENCE_REFUSED', 'FENCE_BAD_RESULT', 'FENCE_FAILED', 'TIMEOUT',
  'AGENT_EARLY_STOP', 'MISSING_OUTPUT', 'CONTAINED_VIOLATION', 'INPUT_CHANGED', 'RESUME_MISMATCH', 'BAD_JOB', 'ABORTED',
  'IO_FAILED', 'JOB_BUSY', 'FENCE_ORPHANED', 'LAUNCH_NOT_APPROVED', 'PRODUCER_FAILED',
  // The post kit refused a validated overlay whose layout blocks the video (detail.blocking); the frames stay for a post-only retry.
  'OVERLAY_LAYOUT_BLOCKED',
]);

export class CodebuiltError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    if (!CODES.includes(code)) throw new Error(`unknown codebuilt error code ${code}`);
    this.name = 'CodebuiltError';
    this.code = code;
    this.detail = detail;
  }
}
