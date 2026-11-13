// Visual loop (KAN-934): typed failures. A code is stable and safe to show; a message is short and never holds model text,
// a prompt or a host path (the loop writes only the code and a fixed sentence to loop-error.json).
export const LOOP_CODES = Object.freeze([
  'look_unavailable', // the vision probe failed, the CLI is missing, logged out or at its usage limit: nothing was built on it
  'look_failed', // the look rounds ended with a P0 open, or a reply never became valid
  'loop_timeout', // the whole loop (or one call) ran out of time
  'preview_failed', // the preview job or its frames could not be produced twice in a row
  'aborted', // the job was cancelled
  'bad_input', // the caller passed something the loop cannot run on
  'sheet_failed', // the host could not make the contact sheets
  'bad_edit', // a scoped edit was refused (outside targets, locked names, too large, does not validate)
  'bad_reply', // the look reply did not follow the schema
]);

export class LoopError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    if (!LOOP_CODES.includes(code)) throw new Error(`unknown visual loop error code ${code}`);
    this.name = 'LoopError';
    this.code = code;
    this.detail = detail;
  }
}
