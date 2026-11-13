// KAN-928 (CB16): retrieval and independent citation validation for the batch fact check.
//
// The first fact check ran the checker through askRole, which calls the CLI with search disabled, so a "supported" verdict was the model's own attestation.
// This adapter is the search backend the batch hands to the real Episode fact check (runFactsStage searchFn):
//   1. RETRIEVAL   the existing CLI retrieval, routes/storyVerification.js groundedSearch over askGemini with search on (agy search_web). CLI only: no API key
//                  is read and no API call is made (cliOnly, apiFallback off). It can only answer when the agy CLI is ready.
//   2. VALIDATION  nothing the CLI reports is trusted by itself. Every source behind a "supported" verdict is fetched by this server (https only, public
//                  hosts only, guarded DNS, size and time caps, redirects re-checked) and the page text must contain the figures and key words of the claim.
//                  A source that cannot be fetched or does not contain them is dropped; a claim left with no validated source becomes "uncertain" and blocks.
//   3. FAIL CLOSED when nothing can be retrieved (agy not ready, the call fails, no facts come back, under the test runner without injected backends) the
//                  adapter throws retrieval_unavailable. The batch stops that video before voice and build; it is never filed as verified and never invents a URL.
// The page check is a conservative presence test, not a truth oracle: it proves the cited page exists and mentions what the claim states.
import dns from 'node:dns';
import https from 'node:https';
import net from 'node:net';
import { groundedSearch } from '../../routes/storyVerification.js';
import { askGemini } from '../../routes/gemini.js';
import { getAgyStatus } from '../../routes/antigravityCli.js';

export const RETRIEVAL_VERSION = 'codebuilt-retrieval-v1';
export const MAX_PAGE_BYTES = 400 * 1024;
export const FETCH_TIMEOUT_MS = 8000;
export const MAX_REDIRECTS = 3;
export const SOURCES_PER_CLAIM = 2;
export const MAX_FETCHES = 80;

export class RetrievalUnavailable extends Error {
  constructor(detail = 'retrieval is not available') { super(detail); this.name = 'RetrievalUnavailable'; this.code = 'retrieval_unavailable'; }
}

// ---- address guard --------------------------------------------------------------------------------------------------------------------------------------

/** Conservative public transport allowlist; unsupported IPv6 ranges fail closed. */
export function isPublicAddress(address) {
  const kind = net.isIP(address);
  if (kind === 4) {
    const [a, b, c] = address.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 192 && b === 0 && (c === 0 || c === 2)) return false;
    if (a === 198 && (b === 18 || b === 19)) return false;
    if (a === 198 && b === 51 && c === 100) return false;
    if (a === 203 && b === 0 && c === 113) return false;
    return true;
  }
  if (kind === 6) {
    // Only native global unicast prefixes 2003:: through 3ffe:: are supported.
    // This deliberately excludes all mapped/compatible IPv4 forms, translation,
    // 2001 special-use allocations, 2002 6to4 and 3fff documentation space.
    // Rejecting the complete special prefixes avoids textual/canonical-form gaps.
    const first = Number.parseInt(address.split(':')[0], 16);
    return first >= 0x2003 && first < 0x3fff;
  }
  return false;
}

/** https only, no credentials, default port, a host that is a name or a public address. Returns the URL or null. */
export function checkedUrl(value) {
  let url;
  try { url = new URL(String(value)); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return null;
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || !host.includes('.') && net.isIP(host) === 0) return null;
  if (net.isIP(host) && !isPublicAddress(host)) return null;
  return url;
}

// The connection itself resolves through this lookup, so the address that is checked is the address that is used (no check-then-connect gap).
function guardedLookup(hostname, options, callback) {
  dns.lookup(hostname, { all: true }, (error, addresses) => {
    if (error) return callback(error);
    if (!addresses.length || addresses.some((a) => !isPublicAddress(a.address))) return callback(Object.assign(new Error('address not allowed'), { code: 'EBLOCKED' }));
    if (options?.all) return callback(null, addresses);
    return callback(null, addresses[0].address, addresses[0].family);
  });
}

const TEXT_TYPES = /^(?:text\/(?:html|plain)|application\/xhtml\+xml)\b/i;

function getOnce(url, { lookup = guardedLookup, request = https.request } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => { if (!settled) { settled = true; resolve(value); } };
    const req = request(url, { method: 'GET', lookup, timeout: FETCH_TIMEOUT_MS, headers: { 'user-agent': 'ForgeAI-factcheck/1', accept: 'text/html,text/plain;q=0.9' } }, (res) => {
      const status = res.statusCode ?? 0;
      if ([301, 302, 303, 307, 308].includes(status)) { res.resume(); return done({ redirect: res.headers.location ?? null }); }
      if (status !== 200 || !TEXT_TYPES.test(String(res.headers['content-type'] ?? ''))) { res.resume(); return done(null); }
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_PAGE_BYTES) { req.destroy(); return done(null); }
        chunks.push(chunk);
      });
      res.on('end', () => done({ body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', () => done(null));
    });
    req.on('timeout', () => { req.destroy(); done(null); });
    req.on('error', () => done(null));
    req.end();
  });
}

export function pageText(html) {
  return String(html)
    .replace(/<(script|style|noscript|template)\b[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&quot;|&#34;/gi, '"').replace(/&#39;|&apos;/gi, "'").replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ').trim();
}

/** Production page fetch: text of the page at a checked URL (redirects re-checked), or null. */
export async function fetchPageText(value, deps = {}) {
  let url = checkedUrl(value);
  for (let hop = 0; url && hop <= MAX_REDIRECTS; hop += 1) {
    const result = await getOnce(url, deps);
    if (!result) return null;
    if (result.body !== undefined) return pageText(result.body);
    url = result.redirect ? checkedUrl(new URL(result.redirect, url).href) : null;
  }
  return null;
}

// ---- the page must say what the claim says ----------------------------------------------------------------------------------------------------------------

const STOP = new Set('about above after again also been before being between both cannot could does doing down during each from have having here into just made make many more most much only other over same shall should some such than that their them then there these they this those through under until upon very were what when where which while will with would your'.split(' '));
const norm = (text) => String(text).toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/(\d),(?=\d{3}\b)/g, '$1').replace(/[^a-z0-9.% ]+/g, ' ').replace(/\s+/g, ' ');
const numbersOf = (text) => [...new Set((norm(text).match(/\d+(?:\.\d+)?/g) ?? []))];
const wordsOf = (text) => [...new Set(norm(text).split(' ').map((w) => w.replace(/^\.+|\.+$/g, '')).filter((w) => w.length >= 4 && !STOP.has(w) && !/\d/.test(w)))];

/** Conservative presence test: every figure of the claim is on the page and most of its key words are. A claim with nothing to match is never supported. */
export function pageSupportsClaim(page, claim) {
  const haystack = norm(page);
  const numbers = numbersOf(claim);
  const words = wordsOf(claim);
  if (!numbers.length && words.length < 3) return false;
  if (!numbers.every((n) => new RegExp(`(?:^|[^0-9.])${n.replace('.', '\\.')}(?![0-9])`).test(haystack))) return false;
  if (!words.length) return true;
  return words.filter((w) => haystack.includes(w)).length / words.length >= 0.7;
}

// ---- the search backend ----------------------------------------------------------------------------------------------------------------------------------------

const cliRetrieve = (request) => groundedSearch(request, (prompt, options) => askGemini(prompt, { ...options, cliOnly: true, apiFallback: false }));

/**
 * -> async searchFn({ claims, topic, contentMode, premise }) for runFactsStage. Injectable: ready(), retrieve(request), fetchPage(url).
 * Without injected backends under `node --test` (NODE_TEST_CONTEXT) it refuses before any CLI or network use.
 */
export function createBatchRetrieval({ ready: readyFn, retrieve: retrieveFn, fetchPage: fetchPageFn, maxFetches = MAX_FETCHES, perClaim = SOURCES_PER_CLAIM } = {}) {
  // Only a rig that injects all three backends can run under the test runner; any production default refuses there before a CLI or the network is touched.
  const injected = typeof readyFn === 'function' && typeof retrieveFn === 'function' && typeof fetchPageFn === 'function';
  const ready = readyFn ?? (() => getAgyStatus().ready === true);
  const retrieve = retrieveFn ?? cliRetrieve;
  const fetchPage = fetchPageFn ?? fetchPageText;
  return async function retrievalSearch(request) {
    if (process.env.NODE_TEST_CONTEXT && !injected) throw new RetrievalUnavailable('retrieval is disabled under the test runner');
    let isReady = false;
    try { isReady = ready() === true; } catch { isReady = false; }
    if (!isReady) throw new RetrievalUnavailable('the retrieval CLI is not ready');
    let response;
    try { response = await retrieve(request); } catch { throw new RetrievalUnavailable('the retrieval call failed'); }
    if (!response || response.error || response.status >= 400 || !Array.isArray(response.facts) || !response.facts.length) throw new RetrievalUnavailable('retrieval returned no facts');

    const claimText = new Map((request.claims ?? []).map((c) => [c.id, c.text]));
    const cache = new Map();
    let fetches = 0;
    let validatedSources = 0;
    let droppedSources = 0;
    const pageFor = async (url) => {
      if (cache.has(url)) return cache.get(url);
      if (fetches >= maxFetches) return null;
      fetches += 1;
      let text = null;
      try { text = await fetchPage(url); } catch { text = null; }
      cache.set(url, typeof text === 'string' ? text : null);
      return cache.get(url);
    };
    // A statement keeps only the sources whose page really contains it; the passage recorded is then the checked statement, never model-authored text.
    const validate = async (item, text) => {
      if (item?.verdict === 'contradicted' || (Array.isArray(item?.sources) && item.sources.some((s) => s?.verdict === 'contradicted'))) return { ...item, verdict: 'contradicted' };
      if (item?.verdict !== 'supported') return { ...item, verdict: 'uncertain', sources: [] };
      const kept = [];
      for (const source of (Array.isArray(item.sources) ? item.sources : []).slice(0, perClaim)) {
        const page = checkedUrl(source?.url) ? await pageFor(String(source.url)) : null;
        if (page && pageSupportsClaim(page, text)) { kept.push({ url: String(source.url), title: String(source.title ?? '').slice(0, 300), passage: text, verdict: 'supported', validated: 'page_fetch' }); validatedSources += 1; } else droppedSources += 1;
      }
      return kept.length ? { ...item, text, sources: kept } : { ...item, verdict: 'uncertain', sources: [] };
    };
    const facts = [];
    for (const fact of response.facts.slice(0, 500)) facts.push(await validate(fact, claimText.get(fact?.id) ?? fact?.text ?? ''));
    const background = [];
    for (const fact of (Array.isArray(response.background) ? response.background : []).slice(0, 30)) background.push(await validate(fact, fact?.text ?? ''));
    return { facts, background, evidence_source: 'antigravity_cli', independent_validation: { version: RETRIEVAL_VERSION, fetched_pages: fetches, validated_sources: validatedSources, dropped_sources: droppedSources } };
  };
}
