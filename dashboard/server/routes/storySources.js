import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';

// Reviewed official-source verification for a finite set of exact scripts (KAN-265).
// Trust lives ONLY in the server-side manifest below: never in a request, a plan
// flag, request research or model-authored citations. Anything unexpected throws,
// and verifyStoryPlan turns a throw into needs_review.
export const OFFICIAL_MANIFEST = JSON.parse(fs.readFileSync(new URL('./officialStorySources.manifest.json', import.meta.url), 'utf8'));
export const OFFICIAL_MODE = 'official_manifest';
const EXCERPT_JOIN = ' [...] ';
export const FETCH_TIMEOUT_MS = 15000;
export const MAX_REDIRECTS = 3;
export const DEFAULT_MAX_SOURCE_BYTES = 2 * 1024 * 1024;

// Provenance authority: only officialSourceSearch, after a real pinned retrieval, can mint a receipt. The
// per-process secret never leaves this module, so copied metadata (any hash, any injected search, any saved
// record from an earlier process) cannot be accepted: it must be re-retrieved.
const RECEIPT_KEY = randomBytes(32);
const receiptOf = (s) => createHmac('sha256', RECEIPT_KEY)
  .update(JSON.stringify([s.manifestId, s.entryId, s.url, s.passage, s.excerptSha256, s.sourceSha256, s.retrievedAt])).digest('hex');
const receiptValid = (s) => typeof s.receipt === 'string' && /^[0-9a-f]{64}$/.test(s.receipt)
  && timingSafeEqual(Buffer.from(s.receipt, 'hex'), Buffer.from(receiptOf(s), 'hex'));

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const key = (text) => (typeof text === 'string' ? text : '').replace(/\s+/g, ' ').trim().toLowerCase();

const NORM_TEXT_CACHE = new Map();
const MAX_NORM_CACHE_SIZE = 1000;

function computeNormalizedText(raw) {
  return String(raw)
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ').trim();
}

// Canonical text for comparing an excerpt with retrieved text: tags, entities,
// curly quotes and whitespace removed. Pure, so tests and runtime agree.
export function normalizeSourceText(raw) {
  const str = String(raw ?? '');
  if (str.length > 5000) return computeNormalizedText(str);
  let norm = NORM_TEXT_CACHE.get(str);
  if (norm === undefined) {
    if (NORM_TEXT_CACHE.size >= MAX_NORM_CACHE_SIZE) NORM_TEXT_CACHE.clear();
    norm = computeNormalizedText(str);
    NORM_TEXT_CACHE.set(str, norm);
  }
  return norm;
}

export const manifestDigest = (entries) => sha256(JSON.stringify(entries));
export const manifestApproved = (manifest) => manifest?.review?.status === 'approved'
  && typeof manifest.review.reviewer === 'string' && manifest.review.reviewer !== ''
  && manifest.review.approvedDigest === manifestDigest(manifest.entries);

export const excerptOf = (claim) => claim.excerpts.join(EXCERPT_JOIN);

// null: not an official script (use the normal Gemini grounding).
// { entry }: exact script AND context match. { mismatch }: exact script, wrong context.
export function matchOfficialEntry(plan, { topic, contentMode } = {}, manifest = OFFICIAL_MANIFEST) {
  if (!manifestApproved(manifest) || typeof plan?.script !== 'string') return null;
  const entry = manifest.entries.find((e) => e.scriptSha256 === sha256(plan.script));
  if (!entry) return null;
  if ((contentMode ?? plan.contentMode ?? 'factual') !== 'factual') return { mismatch: 'content mode is not factual' };
  if (!entry.titleSha256s.includes(sha256(key(plan.title)))) return { mismatch: 'title does not match the reviewed script' };
  if (key(topic) && sha256(key(topic)) !== entry.topicSha256) return { mismatch: 'topic does not match the reviewed script' };
  return { entry };
}

// A source object is official only if it reproduces a manifest claim exactly.
// This also gates saved verification records on resume.
export function isTrustedOfficialSource(s, manifest = OFFICIAL_MANIFEST) {
  if (!manifestApproved(manifest) || s?.providerMode !== OFFICIAL_MODE || s.manifestId !== manifest.id) return false;
  const entry = manifest.entries.find((e) => e.id === s.entryId);
  const claim = entry?.claims.find((c) => c.text === s.passage);
  if (!claim) return false;
  const final = s.url === entry.source.url || entry.source.allowedRedirects.includes(s.url);
  return final && s.title === entry.source.title && s.excerpt === excerptOf(claim) && s.excerptSha256 === sha256(s.excerpt)
    && /^[0-9a-f]{64}$/.test(s.sourceSha256) && (entry.source.kind !== 'pdf' || s.sourceSha256 === entry.source.sha256)
    && Number.isFinite(Date.parse(s.retrievedAt)) && receiptValid(s);
}

// Global URL cache for production runtime when fetchImpl === fetch.
const DEFAULT_URL_CACHE = new Map();

export function createOfficialSourceCache() {
  return new Map();
}

export function clearOfficialSourceCache() {
  DEFAULT_URL_CACHE.clear();
  NORM_TEXT_CACHE.clear();
}

const cacheGet = (c, k) => (c instanceof Map ? c.get(k) : (typeof c?.get === 'function' ? c.get(k) : c?.[k]));
const cacheSet = (c, k, v) => (c instanceof Map ? c.set(k, v) : (typeof c?.set === 'function' ? c.set(k, v) : (c[k] = v)));
const cacheHas = (c, k) => (c instanceof Map ? c.has(k) : (typeof c?.has === 'function' ? c.has(k) : Object.prototype.hasOwnProperty.call(c ?? {}, k)));
const cacheDel = (c, k) => (c instanceof Map ? c.delete(k) : (typeof c?.delete === 'function' ? c.delete(k) : delete c?.[k]));

async function readCapped(response, maxBytes) {
  const cap = Number(maxBytes) > 0 ? Number(maxBytes) : DEFAULT_MAX_SOURCE_BYTES;
  const declaredHeader = response.headers?.get?.('content-length');
  const declared = declaredHeader != null && declaredHeader !== '' ? Number(declaredHeader) : NaN;
  if (!Number.isNaN(declared) && declared > cap) {
    throw new Error(`Official source exceeds size cap of ${cap} bytes.`);
  }
  const chunks = [];
  let total = 0;
  if (response.body && typeof response.body[Symbol.asyncIterator] === 'function') {
    for await (const chunk of response.body) {
      total += chunk.length;
      if (total > cap) throw new Error(`Official source exceeds size cap of ${cap} bytes.`);
      chunks.push(chunk);
    }
  } else if (typeof response.arrayBuffer === 'function') {
    const buf = Buffer.from(await response.arrayBuffer());
    if (buf.length > cap) throw new Error(`Official source exceeds size cap of ${cap} bytes.`);
    return buf;
  }
  return Buffer.concat(chunks);
}

async function fetchAndCap(source, fetchImpl, options) {
  const allowed = new Set([source.url, ...(source.allowedRedirects ?? [])]);
  let url = source.url;
  const timeoutMs = options.timeoutMs ?? FETCH_TIMEOUT_MS;
  const maxBytes = source.maxBytes ?? options.maxBytes ?? DEFAULT_MAX_SOURCE_BYTES;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = options.signal
      ? (typeof AbortSignal.any === 'function' ? AbortSignal.any([options.signal, timeoutSignal]) : options.signal)
      : timeoutSignal;

    const response = await fetchImpl(url, {
      redirect: 'manual',
      signal,
      headers: { accept: source.kind === 'pdf' ? 'application/pdf' : 'text/html' },
    });

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const next = new URL(response.headers?.get?.('location') ?? '', url);
      if (next.protocol !== 'https:' || !allowed.has(next.href)) {
        throw new Error(`Official source redirect to a non-allowlisted URL (${next.origin}).`);
      }
      url = next.href;
      continue;
    }

    if (response.status !== 200) {
      throw new Error(`Official source returned HTTP ${response.status}.`);
    }

    const bytes = await readCapped(response, maxBytes);
    return { url, bytes, sourceSha256: sha256(bytes) };
  }
  throw new Error('Official source redirected too many times.');
}

export async function retrieve(source, fetchImpl = fetch, options = {}) {
  const activeCache = options.cache ?? (fetchImpl === fetch ? DEFAULT_URL_CACHE : null);

  if (activeCache && cacheHas(activeCache, source.url)) {
    const cached = await cacheGet(activeCache, source.url);
    if (cached && typeof cached === 'object' && cached.bytes) return cached;
  }

  const fetchPromise = fetchAndCap(source, fetchImpl, options)
    .then((result) => {
      if (activeCache) {
        cacheSet(activeCache, source.url, result);
        if (result.url && result.url !== source.url) {
          cacheSet(activeCache, result.url, result);
        }
      }
      return result;
    })
    .catch((err) => {
      if (activeCache) {
        cacheDel(activeCache, source.url);
      }
      throw err;
    });

  if (activeCache) {
    cacheSet(activeCache, source.url, fetchPromise);
  }

  return await fetchPromise;
}

export async function retrieveSources(sources, fetchImpl = fetch, options = {}) {
  const list = Array.isArray(sources) ? sources : [];
  if (!list.length) return [];
  const concurrency = Math.max(1, Number(options.concurrency) || 6);
  const results = new Array(list.length);
  let index = 0;

  async function worker() {
    while (index < list.length) {
      const i = index++;
      try {
        const res = await retrieve(list[i], fetchImpl, options);
        results[i] = options.settled ? { status: 'fulfilled', value: res } : res;
      } catch (err) {
        if (options.settled) {
          results[i] = { status: 'rejected', reason: err };
        } else {
          throw err;
        }
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, list.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

const CLAIM_EXCERPT_CACHE = new WeakMap();
function getClaimExcerptData(claim) {
  let data = CLAIM_EXCERPT_CACHE.get(claim);
  if (!data) {
    const excerpt = excerptOf(claim);
    data = { excerpt, excerptSha256: sha256(excerpt) };
    CLAIM_EXCERPT_CACHE.set(claim, data);
  }
  return data;
}

// Same shape as groundedSearch: { facts: [{ id, text, verdict, sources }] }.
export async function officialSourceSearch({ claims }, entry, { manifest = OFFICIAL_MANIFEST, fetchImpl = fetch, now = () => new Date(), ...options } = {}) {
  const retrieved = await retrieve(entry.source, fetchImpl, options);
  const { url, bytes } = retrieved;
  const sourceSha256 = retrieved.sourceSha256 ?? sha256(bytes);
  retrieved.sourceSha256 = sourceSha256;

  if (entry.source.kind === 'pdf') {
    // ponytail: no runtime PDF parser; excerpts of a PDF are reviewed against the pinned binary offline.
    if (sourceSha256 !== entry.source.sha256) throw new Error('Official PDF binary SHA does not match the reviewed binary SHA.');
  } else {
    const text = retrieved.normalizedText ?? normalizeSourceText(bytes.toString('utf8'));
    retrieved.normalizedText = text;
    for (const claim of entry.claims) {
      for (const x of claim.excerpts) {
        if (!text.includes(normalizeSourceText(x))) throw new Error(`Reviewed excerpt not found in retrieved official text: "${x.slice(0, 60)}".`);
      }
    }
  }

  const retrievedAt = now().toISOString();
  const claimMap = new Map((entry.claims ?? []).map((m) => [m.text, m]));

  return { facts: (claims ?? []).flatMap((c) => {
    const claim = claimMap.get(c.text);
    if (!claim) return [];
    const { excerpt, excerptSha256 } = getClaimExcerptData(claim);
    const source = { url, title: entry.source.title, passage: c.text, excerpt, excerptSha256, sourceSha256, retrievedAt,
      manifestId: manifest.id, entryId: entry.id, authority: entry.source.authority, providerMode: OFFICIAL_MODE };
    return [{ id: c.id, text: c.text, verdict: 'supported', sources: [{ ...source, receipt: receiptOf(source) }] }];
  }) };
}

export async function batchOfficialSourceSearch(items, options = {}) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return [];
  const cache = options.cache ?? createOfficialSourceCache();
  const concurrency = Math.max(1, Number(options.concurrency) || 6);
  const results = new Array(list.length);
  let index = 0;

  async function worker() {
    while (index < list.length) {
      const i = index++;
      const item = list[i];
      results[i] = await officialSourceSearch(item.request ?? item, item.entry, { ...options, cache });
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, list.length) }, () => worker());
  await Promise.all(workers);
  return results;
}
