// Visual loop (KAN-934): the host controller that replaces the blind one-reply build. Per round: preview the current build.py in
// the SAME offline executor (a few small frames), make contact sheets with a fresh pixel code, show them to the model in ONE fresh
// CLI call, apply its scoped edits, and look again. Each resume gets a fresh budget of at most 3 looks (the first plus two fix rounds).
// The caller gets an accepted script or the newest successfully previewed and looked-at script, explicitly marked unapproved.
//
// Honest limits: this is a controller around a model call, not an agent session with tools; the model process runs on the host on
// the existing subscription login, and every line of generated code still runs only in the offline container. A receipt proves what
// pixels and which prompt reached which call, not that the model judged well. Numeric QA (shotcheck.run_qa) is a separate gate and
// is never recorded as a look. Nothing here publishes anything: preview jobs and sheets stay in the host stage folder.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pickPreviewFrames } from './previewFrames.js';
import { buildLookPrompt, parseLookReply, applyScopedEdits, LOOK_FIX_ROUNDS } from './visualLoopPrompts.js';
import { LoopError } from './loopErrors.js';

export const MAX_FIX_ROUNDS = LOOK_FIX_ROUNDS; // 3 since 2026-11-14: two fix rounds left real P0s in every draft of the night of 11-13
export const MAX_LOOKS = MAX_FIX_ROUNDS + 1;
export const MAX_REPLY_RETRIES = 3; // shared across the whole loop: invalid replies, refused edits and failed attempts
export const MAX_CALLS = 16;
// A preview that ends without frames (the generated code raised, or the kit's own QA refused the scene) is fixed from its
// error text alone. Those fix rounds are cheap and do not use up a look: job mwf9bowk-8ff1e1 (2026-11-13) spent two of its
// three looks on "shots share one composition" and ended with nothing rendered.
export const MAX_CRASH_FIXES = 4;
export const MAX_CONSECUTIVE_CRASHES = 3;
export const PREVIEW_SCALE = 50; // half of the final resolution (final profile 1080x1920, hold=1; preview 540x960)
export const LOOK_TIMEOUT_MS = 10 * 60 * 1000;
export const LOOP_TIMEOUT_MS = 90 * 60 * 1000;
export const MAX_LOOP_INPUT_TOKENS = 900000;
const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,50}$/;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
// Failures of the script itself (the model can fix those from text); anything else is an infrastructure failure and stops the job.
// A TIMEOUT counts as the script's only when the container ran past its limit; a backstop timeout (the fence did not return, e.g. it was
// still waiting for the GPU lease) is infrastructure.
const CRASH_CODES = new Set(['FENCE_FAILED', 'AGENT_EARLY_STOP', 'MISSING_OUTPUT', 'TIMEOUT']);
const isScriptCrash = (error) => CRASH_CODES.has(error?.code) && !(error.code === 'TIMEOUT' && error.detail?.backstop === true);

export const LOOP_MESSAGES = Object.freeze({
  look_unavailable: 'The visual check could not run (the Claude CLI could not look at pictures, is not logged in, or hit its usage limit). Nothing was rendered.',
  look_failed: 'The visual check did not approve the build within its looks. Nothing was rendered.',
  loop_timeout: 'The visual check ran out of time. Nothing was rendered.',
  preview_failed: 'The preview render could not be made. Nothing was rendered.',
  aborted: 'The job was cancelled during the visual check.',
  bad_input: 'The visual check was given something it cannot run on.',
  sheet_failed: 'The preview sheets could not be made.',
  bad_edit: 'A fix was refused.',
  bad_reply: 'The visual check reply was not valid.',
});

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
export const newSheetCode = () => Array.from({ length: 5 }, () => CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]).join('');

function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
function writeJson(file, value) { fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`); }

function checkInput(input, deps) {
  const bad = (m) => new LoopError('bad_input', m);
  if (!input || typeof input !== 'object') throw bad('input must be an object');
  if (typeof input.jobId !== 'string' || !JOB_ID.test(input.jobId) || /-pv[1-9][0-9]?$/.test(input.jobId)) throw bad('jobId is invalid or reserved for a preview job');
  if (typeof input.stageDir !== 'string' || !path.isAbsolute(input.stageDir)) throw bad('stageDir must be absolute');
  for (const key of ['brief', 'script', 'buildScript', 'kitContract']) if (typeof input[key] !== 'string' || !input[key].trim()) throw bad(`${key} is required`);
  if (!Array.isArray(input.shots) || input.shots.length < 1 || input.shots.some((s) => !s || typeof s.subject !== 'string' || typeof s.narration !== 'string')) throw bad('shots must be a list of { subject, narration }');
  if (!Array.isArray(input.shotStarts) || input.shotStarts.length !== input.shots.length) throw bad('shotStarts must have one start per shot');
  if (!Number.isInteger(input.nframes) || input.nframes < 24) throw bad('nframes is invalid');
  if (typeof input.validate !== 'function') throw bad('validate(code) -> reasons[] is required');
  for (const key of ['runPreview', 'makeSheets', 'askLook']) if (typeof deps?.[key] !== 'function') throw bad(`deps.${key} is required`);
}

/**
 * Runs the loop. Resolves { accepted: true, buildScript, sha256, rounds, receipt, calls }; rejects with a LoopError (and leaves
 * loop-error.json with a fixed sentence). Input: { jobId, stageDir, brief, script, shots: [{subject, narration}], shotStarts (s),
 * nframes, buildScript, kitContract, validate(code) -> reasons[], probe (a passed probe result), lookModel, signal, fps }.
 * Deps: runPreview({jobId, buildScript, spec, signal}), makeSheets({framesDir, outDir, code, signal}), askLook(prompt, images, opts),
 * askText(prompt, opts) (only for a round whose preview crashed), onCall(entry), onPhase('previewing' | 'looking'), now(), newCode().
 */
export async function runVisualBuildLoop(input, deps = {}) {
  checkInput(input, deps);
  const now = deps.now ?? (() => Date.now());
  const newCode = deps.newCode ?? newSheetCode;
  const stage = path.join(input.stageDir, 'loop');
  fs.mkdirSync(stage, { recursive: true });
  const fail = (error) => {
    const typed = error instanceof LoopError ? error : new LoopError('look_failed', 'the visual loop stopped on an unexpected error', { reason: 'internal', cause: String(error?.message ?? error).slice(0, 200) });
    try { writeJson(path.join(stage, 'loop-error.json'), { code: typed.code, message: LOOP_MESSAGES[typed.code] ?? LOOP_MESSAGES.look_failed, reason: typeof typed.detail?.reason === 'string' ? typed.detail.reason.slice(0, 60) : (typeof typed.reason === 'string' ? typed.reason.slice(0, 60) : null), at: new Date(now()).toISOString() }); } catch { /* the typed error is what matters */ }
    return typed;
  };
  try {
    return await loop(input, deps, { now, newCode, stage });
  } catch (error) {
    throw fail(error);
  }
}

async function loop(input, deps, { now, newCode, stage }) {
  const { signal, fps = 30, jobId, nframes, shotStarts } = input;
  const started = now();
  const lookModel = input.lookModel ?? 'sonnet';
  const lookTimeoutMs = input.lookTimeoutMs ?? LOOK_TIMEOUT_MS;
  const loopTimeoutMs = input.loopTimeoutMs ?? LOOP_TIMEOUT_MS;
  const maxInputTokens = input.maxInputTokens ?? MAX_LOOP_INPUT_TOKENS;
  const shots = input.shots.map((s, i) => ({ id: `shot-${i}`, subject: s.subject, narration: s.narration }));

  const aborted = () => new LoopError('aborted', 'the job was aborted');
  const phase = (name) => { if (typeof deps.onPhase === 'function') { try { deps.onPhase(name); } catch { /* progress reporting never breaks the loop */ } } };
  const guard = () => {
    if (signal?.aborted) throw aborted();
    if (now() - started > loopTimeoutMs) throw new LoopError('loop_timeout', 'the visual loop ran out of time', { reason: 'loop' });
  };
  guard();
  if (!input.probe || input.probe.passed !== true) throw new LoopError('look_unavailable', 'the vision probe has not passed', { reason: 'probe' });

  let frames;
  try { frames = pickPreviewFrames({ nframes, shotStarts, fps }); } catch (error) {
    if (error?.code === 'PREVIEW_COVERAGE_IMPOSSIBLE') throw new LoopError('preview_failed', 'the shots cannot all be previewed in 24 frames', { reason: 'coverage' });
    throw new LoopError('bad_input', 'the shot starts cannot be previewed');
  }
  const frameListSha256 = sha256(JSON.stringify(frames));

  const savedHistory = Array.isArray(input.resumeHistory) ? input.resumeHistory.slice(-12) : [];
  const state = { version: 1, jobId, startedAt: new Date(started).toISOString(), status: 'running', rounds: [], ...(savedHistory.length ? { resumedHistory: savedHistory.map(({ round, findings, buildSha256 }) => ({ round, findings, buildSha256 })) } : {}) };
  const saveState = (extra = {}) => writeJson(path.join(stage, 'loop.json'), { ...state, ...extra, updatedAt: new Date(now()).toISOString() });
  saveState();

  const calls = [];
  const emit = (entry) => { calls.push(entry); if (typeof deps.onCall === 'function') { try { deps.onCall(entry); } catch { /* recorder failures never break a call */ } } };
  let retriesLeft = MAX_REPLY_RETRIES;
  let usedTokens = 0;
  let consecutiveCrashes = 0;
  let script = input.buildScript;
  const previous = savedHistory.map(({ round, findings }) => ({ round, findings }));
  const rounds = [];
  const looked = savedHistory.filter((x) => typeof x.buildScript === 'string' && sha256(x.buildScript) === x.buildSha256).map((x) => ({ buildScript: x.buildScript, buildSha256: x.buildSha256, findings: x.findings }));

  let looks = 0;
  let crashFixes = 0;
  const unapprovedResult = () => {
    const newest = looked.at(-1);
    const receipt = buildReceipt({ input, rounds, calls, accepted: null });
    writeJson(path.join(stage, 'receipt.json'), receipt);
    saveState({ status: 'unapproved', unapprovedSha256: newest.buildSha256 });
    return { accepted: false, unapproved: true, buildScript: newest.buildScript, sha256: newest.buildSha256, findings: newest.findings, rounds, receipt, calls };
  };
  for (let n = 0; looks < MAX_LOOKS; n += 1) {
    const r = (Number.isInteger(input.startRound) && input.startRound >= 0 ? input.startRound : 0) + n;
    if (n >= MAX_LOOKS + MAX_CRASH_FIXES) {
      if (looked.length) return unapprovedResult();
      throw new LoopError('look_failed', 'the visual loop used all its rounds', { reason: 'rounds_exhausted' });
    }
    let finalRound = looks === MAX_LOOKS - 1; // the last LOOK cannot ask for a fix; a text-only crash round never is the last look
    guard();
    if (usedTokens > maxInputTokens) throw new LoopError('look_failed', 'the input token budget of the visual loop is used up', { reason: 'budget' });
    const buildSha256 = sha256(script);
    const dir = path.join(stage, `r${r}`);
    fs.mkdirSync(dir, { recursive: true });
    const previewJobId = `${jobId}-pv${r + 1}`;

    // ---- replay: a round already looked at for this exact script is read back, never asked or previewed again
    let record = replayRound(dir, { buildSha256, shots, finalRound, script, input });
    if (record) {
      consecutiveCrashes = record.crashed ? consecutiveCrashes + 1 : 0;
      if (record.crashed) { crashFixes += 1; finalRound = false; }
    } else {
      fs.writeFileSync(path.join(dir, 'build.py'), script);
      // ---- preview
      let preview = null; let crash = null;
      phase('previewing');
      try {
        preview = await deps.runPreview({ jobId: previewJobId, buildScript: script, spec: { frames, scale: PREVIEW_SCALE }, signal });
        if (!preview || !Array.isArray(preview.frames) || typeof preview.dir !== 'string') throw new LoopError('preview_failed', 'the preview returned no frames', { reason: 'empty' });
      } catch (error) {
        if (signal?.aborted || error?.code === 'ABORTED') throw aborted();
        if (error instanceof LoopError) throw error;
        const code = error?.code ?? 'error';
        if (!isScriptCrash(error)) throw new LoopError('preview_failed', 'the preview job failed', { reason: code });
        crash = {
          code,
          text: `The preview job for this script ended without frames (${code}${error?.detail?.status ? `, ${error.detail.status}` : ''}).${typeof error?.diagnostic === 'string' && error.diagnostic ? `\n${error.diagnostic}` : ''}`,
        };
      }
      if (crash) {
        if (crashFixes >= MAX_CRASH_FIXES || consecutiveCrashes >= MAX_CONSECUTIVE_CRASHES) {
          if (looked.length) return unapprovedResult();
          throw new LoopError('preview_failed', 'the preview kept ending without frames', { reason: 'repeated', code: crash.code });
        }
        consecutiveCrashes += 1;
        crashFixes += 1;
        finalRound = false;
      } else {
        consecutiveCrashes = 0;
      }
      guard();
      // ---- sheets
      let sheets = [];
      let code = null;
      if (preview) {
        code = newCode();
        try { sheets = await deps.makeSheets({ framesDir: preview.dir, outDir: path.join(dir, 'sheets'), code, signal }); } catch (error) {
          if (signal?.aborted) throw aborted();
          throw new LoopError('preview_failed', 'the preview sheets could not be made', { reason: 'sheets', cause: String(error?.code ?? error?.message ?? error).slice(0, 80) });
        }
        writeJson(path.join(dir, 'preview.json'), {
          jobId: previewJobId, scale: PREVIEW_SCALE, frames, frameListSha256, rendered: preview.frames.map((f) => ({ name: f.name, sha256: f.sha256 })),
        });
      }
      // ---- the look (or, when the preview crashed, a text-only fix round)
      record = await askRound({
        r, finalRound, script, buildSha256, sheets, code, crash, previous, shots, previewJobId, preview, dir, frameListSha256,
      });
    }
    rounds.push(record.summary);
    if (!record.crashed) looked.push({ buildScript: script, buildSha256, findings: record.reply.findings });
    state.rounds.push({ round: r, buildSha256, verdict: record.reply.verdict, crashed: record.crashed });
    saveState();

    if (record.reply.verdict === 'pass') {
      const acceptedPath = path.join(stage, 'accepted.build.py');
      fs.writeFileSync(acceptedPath, script);
      const receipt = buildReceipt({ input, rounds, calls, accepted: { round: r, buildSha256 } });
      writeJson(path.join(stage, 'receipt.json'), receipt);
      saveState({ status: 'accepted', acceptedSha256: buildSha256 });
      return { accepted: true, buildScript: script, sha256: buildSha256, rounds, receipt, calls };
    }
    if (finalRound) {
      if (looked.length) return unapprovedResult();
      throw new LoopError('look_failed', 'the last look still found a problem', { reason: 'rounds_exhausted' });
    }
    if (!record.crashed) looks += 1;
    previous.push({ round: r, findings: record.reply.findings });
    script = record.nextScript;
  }
  throw new LoopError('look_failed', 'the visual check did not approve the build', { reason: 'rounds_exhausted' });

  // ---------------------------------------------------------------------------------------------------------------------------
  async function askRound({ r, finalRound, script: current, buildSha256, sheets, code, crash, previous: prior, shots: planned, previewJobId, preview, dir, frameListSha256: frameHash }) {
    const textOnly = sheets.length === 0;
    const sheetCodes = textOnly ? [] : [code];
    const images = sheets.map((s) => ({ bytes: fs.readFileSync(s.path), mediaType: 'image/jpeg' }));
    const prompt = buildLookPrompt({
      brief: input.brief, script: input.script, shots: planned, buildScript: current, kitContract: input.kitContract,
      sheets: sheets.map((s) => ({ code: s.code, tiles: s.tiles })), shotStarts, fps, round: r, finalRound, qaText: crash?.text, previous: prior,
      guides: typeof input.lookGuides === 'string' ? input.lookGuides : '', fixRoundsLeft: Math.max(0, MAX_LOOKS - 1 - looks),
    });
    const flatTiles = sheets.flatMap((s) => s.tiles.filter((t) => t.flag === 'flat').map((t) => t.n));
    const roundCalls = [];
    let feedback = '';
    for (let attempt = 0; ; attempt += 1) {
      guard();
      if (calls.length >= MAX_CALLS) throw new LoopError('look_failed', 'too many model calls in one visual loop', { reason: 'calls' });
      const text = feedback ? `${prompt}\n\nYour previous reply was refused: ${feedback}\nFix every point and answer again in full, as one JSON object.` : prompt;
      const t0 = now();
      let answer;
      phase('looking');
      try {
        const options = { model: lookModel, timeoutMs: lookTimeoutMs, signal };
        answer = textOnly ? await deps.askText(text, options) : await deps.askLook(text, images, options);
      } catch (error) {
        const entry = callEntry({ r, attempt, model: lookModel, wallS: (now() - t0) / 1000, usage: null, status: 'error', images: images.length, validation: error?.timedOut ? 'timed out' : error?.quota ? 'quota' : `call failed: ${String(error?.message ?? error).replace(/[A-Za-z]:[^ ]*/g, '<path>').slice(0, 160)}` });
        emit(entry); roundCalls.push(entry);
        if (signal?.aborted || error?.aborted) throw aborted();
        if (error?.timedOut) throw new LoopError('loop_timeout', 'a look call timed out', { reason: 'call' });
        if (error?.quota) throw new LoopError('look_unavailable', 'the Claude usage limit was reached', { reason: 'quota' });
        if (error?.unavailable) throw new LoopError('look_unavailable', 'the Claude CLI is unavailable', { reason: 'unavailable' });
        if (error?.code === 'tools_offered') throw new LoopError('look_failed', 'the CLI offered tools to the look call', { reason: 'receipt' });
        if (error instanceof TypeError) throw new LoopError('look_failed', 'the look call was given invalid input', { reason: 'input' });
        if (retriesLeft <= 0) throw new LoopError('look_failed', 'the look call kept failing', { reason: 'call' });
        retriesLeft -= 1; feedback = ''; continue;
      }
      const wallS = answer.wallMs !== undefined ? answer.wallMs / 1000 : (now() - t0) / 1000;
      const tokens = tokensOf(answer.usage);
      if (tokens !== null) usedTokens += tokens;
      // delivery receipt: the proof that THIS prompt and THESE image bytes went to a no-tools, no-session call
      if (!textOnly) {
        const rc = answer.receipt ?? {};
        const sentHashes = images.map((i) => sha256(i.bytes));
        const ok = rc.noSessionPersistence === true && rc.toolsOffered === 0 && rc.transport === 'stdin-image-blocks' && rc.imageCount === images.length
          && JSON.stringify(rc.imageSha256) === JSON.stringify(sentHashes) && rc.promptSha256 === sha256(text);
        if (!ok) {
          const entry = callEntry({ r, attempt, model: answer.model ?? lookModel, wallS, usage: answer.usage, status: 'error', images: images.length, validation: 'delivery receipt does not match' });
          emit(entry); roundCalls.push(entry);
          throw new LoopError('look_failed', 'the look call has no matching delivery receipt', { reason: 'receipt' });
        }
      }
      let reply = null; let nextScript = null; let refusal = null;
      try {
        reply = parseLookReply(answer.text, { shots: planned, sheetCodes, finalRound, flatTiles });
        if (reply.verdict === 'fix' && !finalRound) {
          const edited = applyScopedEdits(current, reply, { validate: input.validate });
          nextScript = edited.source;
        }
      } catch (error) {
        if (!(error instanceof LoopError)) throw error;
        refusal = error.detail?.reasons?.length ? error.detail.reasons.join('; ') : error.message;
      }
      const entry = callEntry({ r, attempt, model: answer.model ?? lookModel, wallS, usage: answer.usage, status: 'ok', images: images.length, validation: refusal ? `refused: ${refusal}`.slice(0, 300) : 'accepted' });
      emit(entry); roundCalls.push(entry);
      if (refusal) {
        if (retriesLeft <= 0) throw new LoopError('look_failed', 'the look replies kept being refused', { reason: 'reply', reasons: [refusal] });
        retriesLeft -= 1; feedback = refusal.slice(0, 600); continue;
      }
      const summary = {
        round: r, buildSha256, nextBuildSha256: nextScript ? sha256(nextScript) : null, previewJobId, verdict: reply.verdict, crashed: textOnly,
        p0: reply.findings.filter((f) => f.severity === 'P0').length, p1: reply.findings.filter((f) => f.severity === 'P1').length, p2: reply.findings.filter((f) => f.severity === 'P2').length,
        shotsDescribed: reply.shots.length, shotsOk: reply.shots.filter((s) => s.ok).length, attempts: roundCalls.length, model: answer.model ?? lookModel, usage: answer.usage ?? null,
        sheets: sheets.map((s) => ({ sha256: s.sha256, bytes: s.bytes, code: s.code, tiles: s.tiles.length })), sheetCodes, frameListSha256: frameHash,
        previewFrames: preview ? preview.frames.map((f) => ({ name: f.name, sha256: f.sha256 })) : [], receipt: textOnly ? null : answer.receipt, promptSha256: sha256(text),
      };
      writeJson(path.join(dir, 'look.json'), { version: 1, status: 'complete', ...summary, shotIds: planned.map((s) => s.id), reply });
      writeJson(path.join(dir, 'call.json'), roundCalls);
      return { reply, nextScript, crashed: textOnly, summary: publicSummary(summary) };
    }
  }

  function replayRound(dir, { buildSha256, shots: planned, finalRound, script: current, input: inp }) {
    const stored = readJson(path.join(dir, 'look.json'));
    if (!stored || stored.version !== 1 || stored.status !== 'complete' || stored.buildSha256 !== buildSha256 || !Array.isArray(stored.sheetCodes)) return null;
    try {
      const reply = parseLookReply(JSON.stringify(stored.reply), { shots: planned, sheetCodes: stored.sheetCodes, finalRound });
      let nextScript = null;
      if (reply.verdict === 'fix' && !finalRound) {
        nextScript = applyScopedEdits(current, reply, { validate: inp.validate }).source;
        if (sha256(nextScript) !== stored.nextBuildSha256) return null;
      }
      const { reply: _drop, shotIds: _ids, version: _v, status: _s, ...summary } = stored;
      return { reply, nextScript, crashed: stored.crashed === true, summary: publicSummary({ ...summary, replayed: true }) };
    } catch { return null; }
  }
}

function tokensOf(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const parts = ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'].map((k) => usage[k]).filter((n) => typeof n === 'number' && Number.isFinite(n));
  return parts.length ? parts.reduce((a, b) => a + b, 0) : null;
}

function callEntry({ r, attempt, model, wallS, usage, status, images, validation }) {
  return {
    step: 'build_look', provider: 'claude', model, tier: 'look', wall_s: Math.round(wallS * 100) / 100, input_tokens: usage?.input_tokens ?? null, output_tokens: usage?.output_tokens ?? null,
    retries: attempt, escalated: false, trigger: null, status, round: r, image_count: images, validation,
  };
}

/** What may travel into the draft metadata: hashes, counts and verdicts. No model sentence, no prompt, no path. */
function publicSummary(s) {
  return {
    round: s.round, buildSha256: s.buildSha256, nextBuildSha256: s.nextBuildSha256 ?? null, previewJobId: s.previewJobId, verdict: s.verdict, crashed: s.crashed === true,
    p0: s.p0, p1: s.p1, p2: s.p2, shotsDescribed: s.shotsDescribed, shotsOk: s.shotsOk, attempts: s.attempts, model: s.model, usage: s.usage ?? null,
    sheets: s.sheets, sheetCodes: s.sheetCodes, frameListSha256: s.frameListSha256, previewFrames: s.previewFrames, receipt: s.receipt ?? null, promptSha256: s.promptSha256, replayed: s.replayed === true,
  };
}

function buildReceipt({ input, rounds, calls, accepted }) {
  return {
    version: 1, jobId: input.jobId, maxFixRounds: MAX_FIX_ROUNDS, previewScale: PREVIEW_SCALE,
    probe: { passed: true, cliVersion: input.probe.cliVersion ?? null, transport: input.probe.transport ?? null, argvSha256: input.probe.argvSha256 ?? null, imageSha256: input.probe.imageSha256 ?? null },
    rounds: rounds.map((x) => ({ ...x })), accepted, callCount: rounds.reduce((n, x) => n + (x.attempts ?? 0), 0), callsThisRun: calls.length,
  };
}
