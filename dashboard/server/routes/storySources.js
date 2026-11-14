import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';

// Reviewed official-source verification for a finite set of exact scripts (KAN-265).
// Trust lives ONLY in the server-side manifest below: never in a request, a plan
// flag, request research or model-authored citations. Anything unexpected throws,
// and verifyStoryPlan turns a throw into needs_review.
export const OFFICIAL_MANIFEST = JSON.parse(fs.readFileSync(new URL('./officialStorySources.manifest.json', import.meta.url), 'utf8'));
export const OFFICIAL_MODE = 'official_manifest';
const EXCERPT_JOIN = ' [...] ';
const FETCH_TIMEOUT_MS = 15000;
const MAX_REDIRECTS = 3;

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

// Canonical text for comparing an excerpt with retrieved text: tags, entities,
// curly quotes and whitespace removed. Pure, so tests and runtime agree.
export function normalizeSourceText(raw) {
  return String(raw)
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ').trim();
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

async function readCapped(response, maxBytes) {
  maxBytes = Number.isSafeInteger(maxBytes) && maxBytes > 0 ? maxBytes : 2 * 1024 * 1024;
  const declared = Number(response.headers.get('content-length'));
  if (declared > maxBytes) {
    await response.body?.cancel?.().catch(() => {});
    throw new Error(`Official source exceeds size cap of ${maxBytes} bytes.`);
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of response.body ?? []) {
    total += chunk.length;
    if (total > maxBytes) throw new Error(`Official source exceeds size cap of ${maxBytes} bytes.`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function retrieve(source, fetchImpl) {
  const allowed = new Set([source.url, ...source.allowedRedirects]);
  let url = source.url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const response = await fetchImpl(url, { redirect: 'manual', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { accept: source.kind === 'pdf' ? 'application/pdf' : 'text/html' } });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const next = new URL(response.headers.get('location') ?? '', url);
      if (next.protocol !== 'https:' || !allowed.has(next.href)) throw new Error(`Official source redirect to a non-allowlisted URL (${next.origin}).`);
      url = next.href;
      continue;
    }
    if (response.status !== 200) throw new Error(`Official source returned HTTP ${response.status}.`);
    return { url, bytes: await readCapped(response, source.maxBytes) };
  }
  throw new Error('Official source redirected too many times.');
}

// Same shape as groundedSearch: { facts: [{ id, text, verdict, sources }] }.
export async function officialSourceSearch({ claims }, entry, { manifest = OFFICIAL_MANIFEST, fetchImpl = fetch, now = () => new Date() } = {}) {
  const { url, bytes } = await retrieve(entry.source, fetchImpl);
  const sourceSha256 = sha256(bytes);
  if (entry.source.kind === 'pdf') {
    // ponytail: no runtime PDF parser; excerpts of a PDF are reviewed against the pinned binary offline.
    if (sourceSha256 !== entry.source.sha256) throw new Error('Official PDF binary SHA does not match the reviewed binary SHA.');
  } else {
    const text = normalizeSourceText(bytes.toString('utf8'));
    for (const claim of entry.claims) for (const x of claim.excerpts) {
      if (!text.includes(normalizeSourceText(x))) throw new Error(`Reviewed excerpt not found in retrieved official text: "${x.slice(0, 60)}".`);
    }
  }
  const retrievedAt = now().toISOString();
  return { facts: claims.flatMap((c) => {
    const claim = entry.claims.find((m) => m.text === c.text);
    if (!claim) return [];
    const excerpt = excerptOf(claim);
    const source = { url, title: entry.source.title, passage: c.text, excerpt, excerptSha256: sha256(excerpt), sourceSha256, retrievedAt,
      manifestId: manifest.id, entryId: entry.id, authority: entry.source.authority, providerMode: OFFICIAL_MODE };
    return [{ id: c.id, text: c.text, verdict: 'supported', sources: [{ ...source, receipt: receiptOf(source) }] }];
  }) };
}
