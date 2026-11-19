// Lane C2 security fixes: codex · gpt-6.1-sol · 2026-11-19 14:50 +02:00.
// Fail closed: only scoped Freesound and Commons licence statements are supported.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { assertJobDirSafe, assertRealDir, assertNoLinksInTree, isInside, resolveJobDir } from './jobPaths.js';
import { scanReparsePoints } from './reparse.js';

export const OPENVERSE_API_BASE = 'https://api.openverse.org/v1';
export const DEFAULT_USER_AGENT = 'ForgeAi-Openverse/1.0';
export const ALLOWED_API_LICENSES = new Set(['cc0', 'pdm']);
const PAGE_LIMIT = 2 * 1024 * 1024;
const ASSET_LIMIT = 25 * 1024 * 1024;
const LICENSE_URLS = {
  cc0: 'https://creativecommons.org/publicdomain/zero/1.0/',
  pdm: 'https://creativecommons.org/publicdomain/mark/1.0/',
};
const LICENSE_NAMES = { cc0: 'CC0 1.0', pdm: 'Public Domain Mark 1.0' };

// Deliberately conservative: IPv6 is limited to global unicast, excluding transition
// and special ranges; mapped IPv4 and non-global IPv4 ranges are refused.
function publicIP(address) {
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && [0, 2, 168].includes(b)) ||
      (a === 198 && [18, 19, 51].includes(b)) || (a === 203 && b === 0));
  }
  return isIP(address) === 6 && /^2[0-9a-f]{3}:/i.test(address) &&
    !/^200[12]:/i.test(address);
}

async function validateURL(raw, lookupFn) {
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      (url.port && !['80', '443'].includes(url.port))) throw new Error('Unsafe URL scheme, credentials or port');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) throw new Error('Non-public host');
  const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookupFn(host, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(a => !publicIP(a.address))) throw new Error('Host resolves to a non-public address');
  return { url, address: addresses[0] };
}

// The native transport pins the checked IP but keeps the original Host and TLS SNI.
function pinnedRequest(url, address, signal, headers) {
  return new Promise((resolve, reject) => {
    const req = (url.protocol === 'https:' ? https : http).get(url, {
      signal, headers, agent: false,
      lookup: (_host, opts, done) => opts.all
        ? done(null, [address]) : done(null, address.address, address.family),
    }, res => resolve({ status: res.statusCode, headers: { get: name => res.headers[name.toLowerCase()] }, body: res }));
    req.on('error', reject);
  });
}

// One deadline includes DNS, all redirect hops, headers AND streaming the body.
async function readURL(raw, { fetchFn, lookupFn = lookup, timeoutMs = 10000, limit = PAGE_LIMIT, providerHost, accept = '*/*' } = {}) {
  const controller = new AbortController();
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new Error('Network deadline exceeded')); }, timeoutMs);
  });
  const work = async () => {
    let next = raw;
    for (let hop = 0; hop <= 3; hop++) {
      const { url, address } = await validateURL(next, lookupFn);
      if (controller.signal.aborted) throw new Error('Network deadline exceeded');
      // Exact provider hosts are stricter than a registrable-domain check.
      if (providerHost && url.hostname !== providerHost) throw new Error('Landing page redirect leaves item provider');
      const headers = { 'User-Agent': DEFAULT_USER_AGENT, Accept: accept };
      const res = fetchFn && fetchFn !== globalThis.fetch
        ? await fetchFn(url.href, { headers, signal: controller.signal, redirect: 'manual' })
        : await pinnedRequest(url, address, controller.signal, headers);
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location');
        if (res.body?.destroy) res.body.destroy();
        else await res.body?.cancel();
        if (!location || hop === 3) throw new Error('Invalid redirect or redirect limit exceeded');
        next = new URL(location, url).href;
        continue;
      }
      if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status}`);
      if (Number(res.headers.get('content-length')) > limit) { controller.abort(); throw new Error('Body size limit exceeded'); }
      if (!res.body?.[Symbol.asyncIterator]) throw new Error('Streaming response body required');
      const chunks = [];
      let bytes = 0;
      for await (const chunk of res.body) {
        if (controller.signal.aborted) throw new Error('Network deadline exceeded');
        const buffer = Buffer.from(chunk);
        bytes += buffer.length;
        if (bytes > limit) { controller.abort(); throw new Error('Body size limit exceeded'); }
        chunks.push(buffer);
      }
      return Buffer.concat(chunks);
    }
  };
  try { return await Promise.race([work(), deadline]); }
  finally { clearTimeout(timer); controller.abort(); }
}

function provider(raw) {
  const u = new URL(raw);
  if (u.hostname === 'freesound.org' && /^\/people\/[^/]+\/sounds\/\d+\/?$/.test(u.pathname)) return 'freesound';
  if (u.hostname === 'commons.wikimedia.org' && /^\/wiki\/File:[^/]+/.test(u.pathname)) return 'commons';
  throw new Error('Unsupported item provider or own-page path');
}

// A deliberately narrow HTML subset: balanced tags, quoted attributes, no raw
// text containers or comments. Unknown/malformed markup fails closed. This avoids
// matching a licence string in a comment, script, sidebar, or another template.
function licenseAreas(content, kind) {
  const html = content.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style|textarea|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
  if (html.includes('<!--')) throw new Error('Unterminated HTML comment');
  const stack = [], areas = [];
  for (const token of html.match(/<[^>]*>|[^<]+/g) || []) {
    if (!token.startsWith('<')) { for (const n of stack) if (n.scope) n.text += token; continue; }
    if (/^<!/.test(token)) continue;
    const end = token.match(/^<\/([a-z0-9]+)\s*>$/i);
    if (end) {
      const i = stack.findLastIndex(n => n.tag === end[1].toLowerCase());
      if (i < 0) continue;
      // A licence block closed by an ancestor is not a valid scoped statement.
      const removed = stack.splice(i);
      if (removed.length === 1 && removed[0].scope) areas.push(removed[0]);
      continue;
    }
    const start = token.match(/^<([a-z0-9]+)\b/i);
    if (!start) continue;
    const tag = start[1].toLowerCase();
    const attrs = {};
    for (const a of token.matchAll(/\s([\w-]+)\s*=\s*(["'])(.*?)\2/gs)) {
      const key = a[1].toLowerCase();
      if (Object.hasOwn(attrs, key)) throw new Error('Ambiguous duplicate HTML attribute');
      attrs[key] = a[3];
    }
    const scope = kind === 'freesound' ? tag === 'div' && attrs.id === 'sound_license'
      : tag === 'table' && (attrs.class || '').split(/\s+/).includes('licensetpl');
    if (tag === 'a' && attrs.href) for (const n of stack) if (n.scope) n.links.push(attrs.href);
    if (!['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'].includes(tag)) {
      stack.push({ tag, scope, text: '', links: [] });
    }
  }
  return areas;
}

export function evaluatePageLicense(content, { url = '' } = {}) {
  try {
    const kind = provider(url);
    const areas = licenseAreas(String(content || ''), kind);
    if (!areas.length) throw new Error('Missing scoped item licence area');
    const confirmed = new Set();
    for (const area of areas) {
      // Encoded text must not hide a negation or a conflicting marker. Unknown
      // entities fail closed rather than being interpreted differently by HTML.
      const text = area.text.replace(/&#(x[0-9a-f]+|[0-9]+);?/gi, (_, n) => {
        const code = n[0].toLowerCase() === 'x' ? parseInt(n.slice(1), 16) : Number(n);
        return code <= 0x10ffff ? String.fromCodePoint(code) : '&unknown;';
      }).replace(/&(?:nbsp|amp|quot|apos|lt|gt);/gi, ' ');
      if (/&[a-z0-9#]/i.test(text) || /\b(?:not|no longer|never|CC[ -]?BY|attribution|all rights reserved)\b/i.test(text)) throw new Error('Conflicting or negated item licence statement');
      let count = 0;
      for (const link of area.links) {
        const u = new URL(link, url);
        if (u.hostname !== 'creativecommons.org') continue;
        const tag = Object.keys(LICENSE_URLS).find(k =>
          ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password && !u.port && !u.search && !u.hash &&
          u.pathname === new URL(LICENSE_URLS[k]).pathname);
        if (!tag) throw new Error('Conflicting or unsupported item licence URL');
        confirmed.add(tag); count++;
      }
      if (!count) throw new Error('Item licence area does not confirm CC0 or PDM');
    }
    if (confirmed.size !== 1) throw new Error('Conflicting item licence markers');
    const licenseTag = [...confirmed][0];
    return { confirmed: true, licenseTag, license: LICENSE_NAMES[licenseTag], licenseUrl: LICENSE_URLS[licenseTag] };
  } catch (e) { return { confirmed: false, reason: e.message }; }
}

export async function searchOpenverse({ query, mediaType = 'image', pageSize = 10, ...network } = {}) {
  if (typeof query !== 'string' || !query.trim()) throw new Error('Search requires a non-empty query');
  const endpoint = ['audio', 'sound'].includes(mediaType) ? 'audio' : 'images';
  const url = `${OPENVERSE_API_BASE}/${endpoint}/?q=${encodeURIComponent(query.trim())}&license=cc0,pdm&page_size=${Math.min(20, Math.max(1, Number(pageSize) || 10))}`;
  const data = JSON.parse((await readURL(url, { ...network, accept: 'application/json' })).toString('utf8'));
  return Array.isArray(data.results) ? data.results : [];
}

export async function confirmPageLicense(landingUrl, network = {}) {
  try {
    provider(landingUrl);
    const body = await readURL(landingUrl, { ...network, providerHost: new URL(landingUrl).hostname, accept: 'text/html' });
    return evaluatePageLicense(body.toString('utf8'), { url: landingUrl });
  } catch (e) { return { confirmed: false, reason: `Landing page: ${e.message}` }; }
}

export async function verifyOpenverseItem(item, network = {}) {
  if (!item || !ALLOWED_API_LICENSES.has(item.license)) return { ok: false, reason: 'API licence is not CC0 or PDM' };
  if (!item.foreign_landing_url) return { ok: false, reason: 'Missing foreign_landing_url (Openverse detail page is not an own page)' };
  const page = await confirmPageLicense(item.foreign_landing_url, network);
  if (!page.confirmed) return { ok: false, reason: page.reason };
  if (page.licenseTag !== item.license) return { ok: false, reason: 'API and own-page licence mismatch' };
  return { ok: true, ...page, landingUrl: item.foreign_landing_url };
}

function safeJob(jobDir) {
  const real = assertJobDirSafe(jobDir);
  assertNoLinksInTree(real, 'Openverse job', { reparseScan: scanReparsePoints });
  return real;
}

function assetFilename(item, filename) {
  const raw = filename ?? item.id;
  if (typeof raw !== 'string' || !raw || /[\\/:]/.test(raw) || /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(raw)) throw new Error('Unsafe or reserved asset filename');
  const ext = String(item.filetype || path.extname(new URL(item.url).pathname).slice(1)).replace(/^\./, '').toLowerCase();
  if (!['jpg', 'jpeg', 'png', 'webp', 'mp3', 'wav', 'ogg', 'flac'].includes(ext)) throw new Error('Unsupported asset extension');
  const base = raw.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 100);
  if (!base) throw new Error('Empty asset id');
  return `${base}.${ext}`;
}

export async function storeAcceptedAsset({ item, jobDir, destSubdir = 'assets', filename, confirmedLicense, ...network }) {
  const real = safeJob(jobDir);
  const name = assetFilename(item, filename);
  // Keep subdirectories simple; reject drive paths, traversal and NTFS streams.
  if (!/^[A-Za-z0-9_-]+$/.test(destSubdir)) throw new Error('Unsafe asset subdirectory');
  if (confirmedLicense !== LICENSE_NAMES[item.license]) throw new Error('Missing or mismatched confirmed licence');
  const bytes = await readURL(item.url, { ...network, limit: ASSET_LIMIT });
  safeJob(real); // Recheck after network waits, before any host write.
  const folder = path.join(real, destSubdir);
  if (!fs.existsSync(folder)) fs.mkdirSync(folder);
  assertRealDir(folder);
  const destPath = path.join(folder, name);
  const recordPath = `${destPath}.license.json`;
  if (!isInside(real, destPath)) throw new Error('Asset escapes job');
  const record = {
    id: `openverse-${item.id}`, title: item.title || '', creator: item.creator || 'Unknown',
    own_page_link: item.foreign_landing_url, source: item.foreign_landing_url,
    licence: confirmedLicense, licence_url: LICENSE_URLS[item.license],
    date: new Date().toISOString().slice(0, 10),
    file: path.relative(real, destPath).replace(/\\/g, '/'), file_bytes: bytes.length,
  };
  // Exclusive opens refuse pre-existing files, including links and hard links.
  fs.writeFileSync(destPath, bytes, { flag: 'wx' });
  fs.writeFileSync(recordPath, JSON.stringify(record, null, 2), { flag: 'wx' });
  return { destPath, recordPath, record };
}

export async function getOpenverseAsset({ query, mediaType = 'image', jobId, jobDir, destSubdir = 'assets', filename, destFilename, pageSize = 10, ...network } = {}) {
  const rejections = [];
  try {
    const real = safeJob(jobDir || resolveJobDir(jobId));
    const candidates = await searchOpenverse({ query, mediaType, pageSize, ...network });
    for (const item of candidates) {
      try {
        const check = await verifyOpenverseItem(item, network);
        if (!check.ok) throw new Error(check.reason);
        const stored = await storeAcceptedAsset({ item, jobDir: real, destSubdir, filename: filename ?? destFilename, confirmedLicense: check.license, ...network });
        return { ok: true, accepted: true, item, assetPath: stored.destPath, recordPath: stored.recordPath, record: stored.record, rejections };
      } catch (e) { rejections.push({ id: item?.id, reason: e.message }); }
    }
    return { ok: false, accepted: false, reason: 'No candidate met CC0/Public Domain verification requirements', checkedCount: candidates.length, rejections };
  } catch (e) { return { ok: false, accepted: false, reason: e.message, rejections }; }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  const arg = key => args.includes(key) ? args[args.indexOf(key) + 1] : undefined;
  const result = await getOpenverseAsset({ query: arg('--query'), mediaType: arg('--type'), jobDir: arg('--job-dir'), jobId: arg('--job-id'), destSubdir: arg('--dest'), filename: arg('--filename') });
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.accepted ? 0 : 2;
}
export default getOpenverseAsset;
