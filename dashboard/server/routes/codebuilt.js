// Code-built start routes (owner UI): queue, read and abort one job. The work runs in the background
// (episode/codebuilt/start.js). Errors are generic. The optional key route is passed through unchanged; start.js checks it.
import { getActiveChannel } from './channelsManager.js';
import { codebuiltStarter, StartError } from '../episode/codebuilt/start.js';

const BODY_CAP = 16 * 1024;

class BodyError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// The body must be absent or a small plain object whose keys are all in `allowed`.
function body(req, allowed) {
  const value = req.body === undefined ? {} : req.body;
  if (Buffer.byteLength(JSON.stringify(value)) > BODY_CAP) throw new BodyError(413, 'Request too large');
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new BodyError(400, 'Invalid request');
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new BodyError(400, 'Invalid request');
  return value;
}

function fail(res, error) {
  if (error instanceof StartError) return res.status(error.status).json({ error: error.message, code: error.code });
  if (error instanceof BodyError) return res.status(error.status).json({ error: error.message });
  console.error(`[codebuilt] request failed (${error && error.code ? error.code : 'unexpected'})`); // never the message: it can carry a path
  return res.status(500).json({ error: 'Code-built request failed' });
}

const handler = (task) => async (req, res) => { try { await task(req, res); } catch (error) { fail(res, error); } };

export const startCodebuiltHandler = handler(async (req, res) => {
  const input = body(req, ['topic', 'duration', 'voice', 'channelId', 'buildModel', 'route']);
  res.status(202).json(codebuiltStarter().start({ ...input, channelId: input.channelId ?? getActiveChannel(req)?.id }));
});
export const listCodebuiltHandler = handler(async (req, res) => {
  res.json({
    jobs: codebuiltStarter().list(),
    authorModeAvailable: process.env.FORGEAI_AUTHOR_MODE === '1',
  });
});
export const getCodebuiltHandler = handler(async (req, res) => { res.json(codebuiltStarter().get(String(req.params.jobId))); });
export const abortCodebuiltHandler = handler(async (req, res) => { body(req, []); res.json(codebuiltStarter().abort(String(req.params.jobId))); });
export const resumeCodebuiltHandler = handler(async (req, res) => { body(req, []); res.status(202).json(codebuiltStarter().resume(String(req.params.jobId))); });
