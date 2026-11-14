// KAN-928 (CB16): routes of the owner-started code-built batch; reads are open,
// like the single-job routes. The body is checked against a fixed key list and a size cap, errors are generic (no path, stack or model text), and the
// run belongs to the channel the owner has active unless the request names one. The single-job routes in episodes.js are untouched.
import { getActiveChannel } from './channelsManager.js';
import { codebuiltRunCoordinator, RunError } from '../episode/codebuilt/runCoordinator.js';
import { StartError } from '../episode/codebuilt/start.js';

const BODY_CAP = 4 * 1024;
export const RUN_BODY_KEYS = Object.freeze(['count', 'genre', 'theme', 'topic', 'type', 'voice', 'duration', 'buildModel', 'channelId']);

function runBody(req) {
  const value = req.body === undefined ? {} : req.body;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new RunError('bad_request');
  if (Buffer.byteLength(JSON.stringify(value)) > BODY_CAP) throw new RunError('bad_request', 413);
  if (Object.keys(value).some((key) => !RUN_BODY_KEYS.includes(key))) throw new RunError('bad_request');
  return value;
}
const fail = (res, error) => {
  if (error instanceof RunError || error instanceof StartError) return res.status(error.status).json({ error: error.message, code: error.code });
  console.error(`[codebuilt-run] request failed (${error && error.code ? error.code : 'unexpected'})`); // never the message: it can carry a path
  return res.status(500).json({ error: 'The run failed', code: 'internal' });
};
const wrap = (task) => async (req, res) => { try { await task(req, res); } catch (error) { fail(res, error); } };

export const startCodebuiltRunHandler = wrap(async (req, res) => {
  const input = runBody(req);
  res.status(202).json(codebuiltRunCoordinator().startRun({ ...input, channelId: input.channelId ?? getActiveChannel(req)?.id }));
});
export const listCodebuiltRunsHandler = wrap(async (req, res) => { res.json({ runs: codebuiltRunCoordinator().listRuns() }); });
export const getCodebuiltRunHandler = wrap(async (req, res) => { res.json(codebuiltRunCoordinator().getRun(String(req.params.runId))); });
export const abortCodebuiltRunHandler = wrap(async (req, res) => { runBody({ body: req.body === undefined ? {} : req.body }); if (Object.keys(req.body ?? {}).length) throw new RunError('bad_request'); res.json(codebuiltRunCoordinator().abortRun(String(req.params.runId))); });
