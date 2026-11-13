// KAN-932: what one video cost to create. Written as cost.json beside metadata.json when the draft's timings are
// saved (perf/stageTimings.js save()). Only usage a provider REPORTED is counted; a call with no usage says
// tokens_not_reported and is never guessed. Dollars are a list-price estimate (subscription work is not billed) and only
// exist for models whose price is dated and sourced in model-prices.json. Nothing here may block or fail a creation run:
// every exported function that touches disk swallows its own errors.
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { redactLogText } from '../routes/redact.js';
import { resolvePriceTier } from './priceTiers.js';

export const COST_FILE = 'cost.json';
export const ESTIMATE_LABEL = 'estimate at list price';
const PRICES_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'model-prices.json');
const isCount = (n) => Number.isInteger(n) && n >= 0;
const isNum = (n) => typeof n === 'number' && Number.isFinite(n);
const round = (n, d = 6) => Math.round(n * 10 ** d) / 10 ** d;

export function loadPrices(file = PRICES_FILE) {
  try {
    const p = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { schema: 1, currency: 'USD', models: p?.models && typeof p.models === 'object' ? p.models : {}, aliases: p?.aliases && typeof p.aliases === 'object' ? p.aliases : {} };
  } catch { return { schema: 1, currency: 'USD', models: {}, aliases: {} }; }
}

// A price exists only for a model id (or an alias that points at one) whose entry has numbers, a https source and a date.
export function resolvePrice(model, prices) {
  if (typeof model !== 'string' || !prices) return null;
  const id = Object.hasOwn(prices.aliases ?? {}, model) ? prices.aliases[model] : model;
  if (!Object.hasOwn(prices.models ?? {}, id)) return null;
  const m = prices.models[id];
  if (!isNum(m?.input_per_mtok) || !isNum(m?.output_per_mtok) || m.input_per_mtok < 0 || m.output_per_mtok < 0) return null;
  if (typeof m.source_url !== 'string' || !m.source_url.startsWith('https://') || !/^\d{4}-\d\d-\d\d$/.test(m.verified_on ?? '')) return null;
  return { model_id: id, input_per_mtok: m.input_per_mtok, output_per_mtok: m.output_per_mtok, source_url: m.source_url, verified_on: m.verified_on };
}

function resolveCallPrice(model, inputCount, date, prices) {
  if (typeof model !== 'string' || !prices) return null;
  const id = Object.hasOwn(prices.aliases ?? {}, model) ? prices.aliases[model] : model;
  if (!Object.hasOwn(prices.models ?? {}, id)) return null;
  const entry = prices.models[id];
  if (typeof entry?.source_url !== 'string' || !entry.source_url.startsWith('https://') || !/^\d{4}-\d\d-\d\d$/.test(entry.verified_on ?? '')) return null;
  const rate = resolvePriceTier(entry, inputCount, date);
  return rate ? { model_id: id, ...rate, source_url: entry.source_url, verified_on: entry.verified_on } : null;
}

function utcDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT/.test(value)) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString().slice(0, 10) : null;
}

const usd = (n) => (n < 0.01 ? n.toFixed(4) : n.toFixed(2));

export function buildCostRecord(detail, { prices = loadPrices(), peakVramMb = null, pricingDate } = {}) {
  const rawCalls = Array.isArray(detail?.calls) ? detail.calls : [];
  const stages = Array.isArray(detail?.stages) ? detail.stages : [];
  const byModel = {};
  const calls = rawCalls.map((c) => {
    const reported = c.tokens && isCount(c.tokens.input) && isCount(c.tokens.output);
    const modelId = (typeof c.model === 'string' && Object.hasOwn(prices.aliases ?? {}, c.model) ? prices.aliases[c.model] : c.model) ?? null;
    const callDate = utcDate(c.started_at) ?? pricingDate;
    const price = reported ? resolveCallPrice(c.model, c.tokens.input, callDate, prices) : null;
    const partial = reported && isCount(c.tokens_missing) && c.tokens_missing > 0;
    const estimate = reported && price ? round((c.tokens.input * price.input_per_mtok + c.tokens.output * price.output_per_mtok) / 1e6, 8) : null;
    const entry = {
      step: c.step ?? c.kind ?? null, provider: c.provider ?? null, model: modelId, wall_s: isNum(c.wall_s) ? c.wall_s : null,
      input_tokens: reported ? c.tokens.input : null, output_tokens: reported ? c.tokens.output : null,
      tokens_status: reported ? (partial ? 'partly_reported' : 'reported') : 'tokens_not_reported',
      retries: isCount(c.retries) ? c.retries : 0, escalated: c.escalated === true, escalation_trigger: c.trigger ?? null,
      ...(c.escalation_denied ? { escalation_denied: c.escalation_denied } : {}),
      fallback_from: c.fallback_from ?? null, status: c.status ?? null,
      price_status: price ? 'list_price' : 'price_unverified', estimate_usd: estimate,
      price_asof: price ? callDate : null,
      ...(price ? { price_input_per_mtok: price.input_per_mtok, price_output_per_mtok: price.output_per_mtok, price_source_url: price.source_url, price_verified_on: price.verified_on } : {}),
    };
    const key = modelId ?? 'unknown';
    const m = byModel[key] ??= { calls: 0, input_tokens: 0, output_tokens: 0, calls_without_usage: 0, estimate_usd: null, price_status: price ? 'list_price' : 'price_unverified' };
    m.calls += 1;
    if (reported) { m.input_tokens += c.tokens.input; m.output_tokens += c.tokens.output; } else m.calls_without_usage += 1;
    if (estimate !== null) m.estimate_usd = round((m.estimate_usd ?? 0) + estimate, 8);
    return entry;
  });
  const modelRows = Object.values(byModel);
  const reportedTokens = modelRows.reduce((n, m) => n + m.input_tokens + m.output_tokens, 0);
  const estimates = modelRows.map((m) => m.estimate_usd).filter((v) => v !== null);
  const estimateTotal = estimates.length ? round(estimates.reduce((a, b) => a + b, 0), 8) : null;
  const renderStages = stages.filter((s) => /render/i.test(String(s.id)) && isNum(s.wall_s));
  const totals = {
    reported_tokens: reportedTokens,
    input_tokens: modelRows.reduce((n, m) => n + m.input_tokens, 0),
    output_tokens: modelRows.reduce((n, m) => n + m.output_tokens, 0),
    calls: calls.length,
    calls_without_usage: calls.filter((c) => c.tokens_status === 'tokens_not_reported').length,
    retries: calls.reduce((n, c) => n + c.retries, 0),
    estimate_usd: estimateTotal, estimate_label: ESTIMATE_LABEL,
    render_duration_s: renderStages.length ? round(renderStages.reduce((n, s) => n + s.wall_s, 0), 3) : null,
    peak_vram_mb: isNum(peakVramMb) ? peakVramMb : null,
    by_model: byModel,
  };
  const summary = reportedTokens === 0 ? 'Cost: no tokens reported'
    : estimateTotal === null ? `Cost: ${reportedTokens} reported tokens` : `Cost: ${reportedTokens} reported tokens / about $${usd(estimateTotal)} estimate`;
  const notes = Array.isArray(detail?.notes) ? detail.notes.filter((n) => typeof n === 'string' && n.trim()).slice(0, 10) : [];
  return { schema: 1, currency: 'USD', summary, totals, calls, prices_used: pricesUsed(calls), ...(notes.length ? { notes } : {}) };
}

function pricesUsed(calls) {
  const out = {};
  for (const c of calls) {
    if (c.estimate_usd === null || !c.model) continue;
    const key = `${c.model}@${c.price_asof}:${c.price_input_per_mtok}/${c.price_output_per_mtok}`;
    out[key] = { input_per_mtok: c.price_input_per_mtok, output_per_mtok: c.price_output_per_mtok, source_url: c.price_source_url, verified_on: c.price_verified_on };
  }
  return out;
}

const SECRET_KEY = /secret|password|passwd|api[_-]?key|authorization|credential|bearer|^(?:access_|refresh_|auth_|id_)?token$/i;
// Server-safe copy: secret-named keys dropped, every string redacted (absolute paths, bearer/basic, key=..., emails), bounded size.
export function scrubCost(value, depth = 0) {
  if (depth > 8) return null;
  if (typeof value === 'string') return redactLogText(value).slice(0, 300);
  if (Array.isArray(value)) return value.slice(0, 500).map((v) => scrubCost(v, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).filter(([k]) => !SECRET_KEY.test(k)).map(([k, v]) => [redactLogText(k).slice(0, 100), scrubCost(v, depth + 1)]));
  }
  return value;
}

// Calls a runner or agent wrote as plain JSON ([{step, provider, model, wall_s, input_tokens, output_tokens, retries, escalated}]).
// Anything that is not a clean non-negative integer count becomes "tokens not reported"; nothing is guessed or defaulted to 0.
export function normalizeJobCalls(raw) {
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.calls) ? raw.calls : [];
  const str = (v) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 120) : null);
  return list.slice(0, 500).filter((c) => c && typeof c === 'object' && !Array.isArray(c)).map((c) => {
    const both = isCount(c.input_tokens) && isCount(c.output_tokens);
    return {
      step: str(c.step) ?? str(c.kind), provider: str(c.provider), model: str(c.model), wall_s: isNum(c.wall_s) && c.wall_s >= 0 ? c.wall_s : null,
      tokens: both ? { input: c.input_tokens, output: c.output_tokens } : null,
      retries: isCount(c.retries) ? c.retries : 0, escalated: c.escalated === true, trigger: str(c.trigger), status: str(c.status), ...(c.forced === true ? { forced: true } : {}),
      ...validationOf(c.validation),
    };
  });
}

// Planner reply-check diagnosis: { ok, code?, reasons? } with bounded short strings only; anything else is dropped.
function validationOf(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v) || typeof v.ok !== 'boolean') return {};
  if (v.ok) return { validation: { ok: true } };
  const reasons = (Array.isArray(v.reasons) ? v.reasons : []).filter((r) => typeof r === 'string').slice(0, 20).map((r) => r.slice(0, 200));
  return { validation: { ok: false, code: typeof v.code === 'string' ? v.code.slice(0, 60) : null, reasons } };
}

export function writeCreationCost(draftFolder, detail, opts = {}) {
  try {
    const record = scrubCost({ ...buildCostRecord(detail, opts), created_at: new Date().toISOString() });
    const file = path.join(draftFolder, COST_FILE);
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(record, null, 2));
    fs.renameSync(temp, file);
    return true;
  } catch { return false; }
}

// Host-side handoff for a codebuilt producer: write raw per-call records outside the sealed bundle.
export function writeCodebuiltCallRecords(file, records) {
  let temp;
  try {
    if (typeof file !== 'string' || !Array.isArray(records) || records.length > 500) return false;
    temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(scrubCost(records), null, 2));
    fs.renameSync(temp, file);
    return true;
  } catch { return false; }
  finally { if (temp) { try { fs.unlinkSync(temp); } catch { /* already renamed or inaccessible */ } } }
}

// Rows for the expandable table: one per model, tokens null (not 0) when the model never reported.
export function costTableRows(record) {
  const by = record?.totals?.by_model && typeof record.totals.by_model === 'object' ? record.totals.by_model : {};
  return Object.entries(by).map(([model, m]) => {
    const none = m.calls_without_usage >= m.calls;
    return {
      model, calls: m.calls, input_tokens: none ? null : m.input_tokens, output_tokens: none ? null : m.output_tokens,
      reported_tokens: none ? null : m.input_tokens + m.output_tokens,
      tokens_status: none ? 'tokens_not_reported' : m.calls_without_usage ? 'partly_reported' : 'reported',
      estimate_usd: m.estimate_usd ?? null, price_status: m.price_status,
    };
  });
}

// What the draft card and the episode report show. Reads and re-scrubs the saved file; null when the draft has none.
export function readCostSummary(draftFolder) {
  try {
    const record = scrubCost(JSON.parse(fs.readFileSync(path.join(draftFolder, COST_FILE), 'utf8')));
    if (!record?.totals) return null;
    const t = record.totals;
    return {
      summary: String(record.summary ?? ''), estimate_label: ESTIMATE_LABEL, reported_tokens: t.reported_tokens ?? 0, estimate_usd: t.estimate_usd ?? null,
      calls_without_usage: t.calls_without_usage ?? 0, render_duration_s: t.render_duration_s ?? null, peak_vram_mb: t.peak_vram_mb ?? null, rows: costTableRows(record),
      steps: (Array.isArray(record.calls) ? record.calls : []).map((c) => ({ step: c.step ?? c.kind ?? 'unknown', provider: c.provider ?? 'unknown', model: c.model ?? 'unknown', wall_s: c.wall_s ?? null, input_tokens: c.input_tokens ?? null, output_tokens: c.output_tokens ?? null, tokens_status: c.tokens_status ?? 'tokens_not_reported', estimate_usd: c.estimate_usd ?? null, retries: c.retries ?? 0, escalated: c.escalated === true })),
    };
  } catch { return null; }
}

const cell = (v) => String(v ?? '').replace(/\|/g, '/').replace(/\s+/g, ' ');
export function renderCostReport(entries, { date = '' } = {}) {
  const head = `# Video creation costs${date ? ` ${date}` : ''}\n\nOne row per generated video. Tokens are only what the providers reported; dollars are an ${ESTIMATE_LABEL} (subscription work is not billed). Blank means not reported.\n\n`;
  if (!entries.length) return `${head}No videos with a cost record yet.\n`;
  const rows = entries.map((e) => `| ${cell(e.id)} | ${cell(e.title)} | ${e.reported_tokens} | ${e.estimate_usd === null ? '' : `$${usd(e.estimate_usd)}`} | ${e.calls_without_usage} | ${e.render_duration_s ?? ''} | ${e.peak_vram_mb ?? ''} |`);
  return `${head}| draft | title | reported tokens | ${ESTIMATE_LABEL} | calls without usage | render s | peak VRAM MB |\n|---|---|---|---|---|---|---|\n${rows.join('\n')}\n`;
}

// Rebuilds the report from every draft folder that has a cost record (idempotent: one row per draft). The caller picks
// reportFile; this never guesses a vault or repo path.
export function updateVideoCostReport(reportFile, draftsDir, { date = '' } = {}) {
  try {
    const entries = [];
    for (const d of fs.readdirSync(draftsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
      const folder = path.join(draftsDir, d.name);
      const s = readCostSummary(folder);
      if (!s) continue;
      let title = d.name;
      try { const m = JSON.parse(fs.readFileSync(path.join(folder, 'metadata.json'), 'utf8')); title = m.listing_copy?.title || m.product?.title || m.title || d.name; } catch { /* no metadata */ }
      entries.push({ id: d.name, title: redactLogText(title), ...s });
    }
    fs.mkdirSync(path.dirname(reportFile), { recursive: true });
    const temp = `${reportFile}.${process.pid}.tmp`;
    fs.writeFileSync(temp, renderCostReport(entries, { date }));
    fs.renameSync(temp, reportFile);
    return entries.length;
  } catch { return -1; }
}

// node perf/creationCost.js <reportFile> <draftsDir>
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [reportFile, draftsDir] = process.argv.slice(2);
  if (!reportFile || !draftsDir) { console.error('usage: node creationCost.js <reportFile> <draftsDir>'); process.exit(2); }
  const n = updateVideoCostReport(path.resolve(reportFile), path.resolve(draftsDir));
  console.log(n < 0 ? 'report failed' : `${n} video rows written`);
  process.exit(n < 0 ? 1 : 0);
}
