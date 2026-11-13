import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { askRole } from '../routes/askRole.js';

export const BRIEF_TEMPLATE_VERSION = 'episode-brief-v1';
const TEMPLATE = [
  'Return one JSON object with exactly three keys: plan, brief, sources.',
  'plan and brief must be objects. plan requires goal and steps; brief requires summary, audience, and claims. Include concise useful fields as needed.',
  'sources must be an array of at most 50 objects. Each has title, kind, and exactly one of url or note. URLs must use http(s). Do not include paths or file locations.',
  'Keep each artifact under 256 KB and every string under 12000 characters.',
].join('\n');
const activeRuns = new Map();
const MAX_FILE_BYTES = 256 * 1024;
const MAX_STRING = 12000;
const REQUIRED = {
  plan: ['goal', 'steps'],
  brief: ['summary', 'audience', 'claims'],
  sources: null,
};

function fail(message) { throw new Error(`brief: ${message}`); }
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function normalise(value) { return String(value).normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US'); }
function episodeRoot() { return path.resolve(process.env.EPISODE_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../output/episodes')); }
function isWithin(root, target) { const rel = path.relative(root, target); return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel); }

function ipv4IsPrivate(host) {
  const parts = host.split('.').map(Number);
  const address = parts.reduce((value, part) => (value << 8n) | BigInt(part), 0n);
  const inRange = (prefix, bits) => (address >> BigInt(32 - bits)) === (prefix >> BigInt(32 - bits));
  return [[0, 8], [0x0a000000, 8], [0x64400000, 10], [0x7f000000, 8], [0xa9fe0000, 16], [0xac100000, 12], [0xc0a80000, 16], [0xe0000000, 4], [0xf0000000, 4]].some(([prefix, bits]) => inRange(BigInt(prefix), bits));
}

function ipv6Value(host) {
  let address = host.toLowerCase();
  const embedded = address.match(/(?:^|:)(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (embedded) {
    const octets = embedded[1].split('.').map(Number);
    address = address.slice(0, -embedded[1].length) + ((octets[0] << 8) | octets[1]).toString(16) + ':' + ((octets[2] << 8) | octets[3]).toString(16);
  }
  const halves = address.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const groups = halves.length === 2 ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left;
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null;
  return groups.reduce((value, group) => (value << 16n) | BigInt(`0x${group}`), 0n);
}

function isNonPublicHost(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (host === 'localhost' || ['.localhost', '.local', '.internal', '.lan', '.home.arpa'].some((suffix) => host.endsWith(suffix))) return true;
  const version = net.isIP(host);
  if (version === 4) return ipv4IsPrivate(host);
  if (version !== 6) return false;
  const address = ipv6Value(host);
  if (address === null) return true;
  const prefix = (bits) => address >> BigInt(128 - bits);
  if (address === 0n || address === 1n || prefix(7) === 0x7en || prefix(10) === 0x3fan || prefix(8) === 0xffn) return true;
  if (prefix(96) === 0xffffn) return ipv4IsPrivate([24, 16, 8, 0].map((shift) => Number((address >> BigInt(shift)) & 0xffn).toString()).join('.'));
  return false;
}

function confinedEpisode(episodeDir, root) {
  if (typeof episodeDir !== 'string' || !episodeDir || episodeDir.split(/[\\/]/).includes('..')) fail('invalid Episode folder path');
  let rootResolved; let resolved;
  try {
    rootResolved = fs.realpathSync(root);
    const candidate = path.isAbsolute(episodeDir) ? path.resolve(episodeDir) : path.resolve(rootResolved, episodeDir);
    resolved = fs.realpathSync(candidate);
  } catch { fail('Episode folder does not exist or cannot be resolved'); }
  if (!isWithin(rootResolved, resolved)) fail('Episode folder escapes episodes root');
  return resolved;
}

function validateResult(result) {
  if (!object(result) || Object.keys(result).sort().join(',') !== 'brief,plan,sources') fail('planner answer must contain only plan, brief, and sources objects');
  const output = {};
  for (const name of ['plan', 'brief']) {
    const value = result[name];
    if (!object(value)) fail(`${name} must be an object`);
    const required = REQUIRED[name];
    if (required.some((key) => !Object.hasOwn(value, key))) fail(`${name} is missing required keys: ${required.join(', ')}`);
    for (const key of Object.keys(value)) if (!/^[a-z][a-z0-9_]{0,63}$/.test(key)) fail(`${name} has an invalid key`);
    const json = JSON.stringify(value);
    if (Buffer.byteLength(json) > MAX_FILE_BYTES) fail(`${name} exceeds 256 KB`);
    const inspect = (item) => {
      if (typeof item === 'string') {
        if (item.length > MAX_STRING) fail(`${name} string exceeds ${MAX_STRING} characters`);
      } else if (Array.isArray(item)) item.forEach(inspect);
      else if (object(item)) for (const [key, child] of Object.entries(item)) {
        if (/(^|_)(path|file|dir|folder|filename)(_|$)/i.test(key)) {
          if (typeof child === 'string' && /^(?:[A-Za-z]:[\\/]|\/|\\\\)|(?:^|[\\/])\.\.(?:[\\/]|$)/.test(child)) fail(`${name} contains a path-like field`);
          fail(`${name} contains a path-like field`);
        }
        inspect(child);
      }
    };
    inspect(value);
    output[name] = value;
  }
  if (!Array.isArray(result.sources) || result.sources.length > 50) fail('sources must be an array of at most 50 entries');
  output.sources = result.sources.map((source, index) => {
    if (!object(source) || Object.keys(source).some((key) => !['title', 'url', 'note', 'kind'].includes(key)) || !['title', 'kind'].every((key) => typeof source[key] === 'string' && source[key].trim())) fail(`sources[${index}] must have title and kind strings`);
    if (Object.hasOwn(source, 'url') === Object.hasOwn(source, 'note')) fail(`sources[${index}] must have exactly one of url or note`);
    if (source.url !== undefined) {
      if (typeof source.url !== 'string' || source.url.length > 2048) fail(`sources[${index}] URL is invalid or too long`);
      let parsed;
      try { parsed = new URL(source.url); } catch { fail(`sources[${index}] URL must use http(s)`); }
      if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password || isNonPublicHost(parsed.hostname)) fail(`sources[${index}] URL must use a public http(s) host without credentials`);
    }
    for (const value of Object.values(source)) if (typeof value === 'string' && value.length > MAX_STRING) fail(`sources[${index}] string is too long`);
    return source;
  });
  for (const name of ['plan', 'brief', 'sources']) if (Buffer.byteLength(JSON.stringify(output[name])) > MAX_FILE_BYTES) fail(`${name} exceeds 256 KB`);
  return output;
}

function atomicWrite(folder, filename, content) {
  const target = path.join(folder, filename);
  const temp = path.join(folder, `.${filename}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  try { fs.writeFileSync(temp, content, { flag: 'wx' }); fs.renameSync(temp, target); }
  catch (error) { try { fs.unlinkSync(temp); } catch {} throw error; }
}

function readCache(file, key) {
  try {
    const cached = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (cached.key !== key) return null;
    return validateResult(cached.result);
  } catch { return null; }
}

export async function runBriefStage({ episodeDir, episodesRoot = episodeRoot(), topic, path: episodePath, askRoleFn = askRole, onCallRecord, promptText = '', templateText = TEMPLATE } = {}) {
    if (typeof topic !== 'string' || !topic.trim() || topic.length > MAX_STRING) fail('topic must be a non-empty bounded string');
    if (typeof episodePath !== 'string' || !episodePath.trim() || episodePath.length > 128) fail('path must be a non-empty bounded string');
    if (typeof promptText !== 'string' || promptText.length > MAX_STRING) fail('promptText is too long');
    const folder = confinedEpisode(episodeDir, episodesRoot);
    const prior = activeRuns.get(folder) || Promise.resolve();
    const run = prior.catch(() => {}).then(() => executeBrief({ folder, topic, episodePath, askRoleFn, onCallRecord, promptText, templateText }));
    activeRuns.set(folder, run);
    try { return await run; } finally { if (activeRuns.get(folder) === run) activeRuns.delete(folder); }
}

async function executeBrief({ folder, topic, episodePath, askRoleFn, onCallRecord, promptText, templateText }) {
    if (typeof templateText !== 'string' || templateText.length > MAX_STRING) fail('templateText is invalid');
    const key = crypto.createHash('sha256').update(JSON.stringify([normalise(topic), normalise(episodePath), BRIEF_TEMPLATE_VERSION, templateText, promptText])).digest('hex');
    const cacheFile = path.join(folder, '.brief-cache.json');
    const cached = readCache(cacheFile, key);
    if (cached) {
      let filesValid = true;
      try {
        const artifacts = Object.fromEntries(['plan', 'brief', 'sources'].map((name) => [name, JSON.parse(fs.readFileSync(path.join(folder, `${name}.json`), 'utf8'))]));
        validateResult(artifacts);
        if (JSON.stringify(artifacts) !== JSON.stringify(cached)) filesValid = false;
      }
      catch { filesValid = false; }
      if (!filesValid) writeArtifacts(folder, cached);
      return { ...cached, cached: true };
    }
    const instruction = `${templateText}\nTopic: ${topic}\nPath: ${episodePath}\n${promptText}`;
    const result = validateResult(await askRoleFn('planner', instruction, { id: 'episode-brief', onCallRecord }));
    writeArtifacts(folder, result);
    atomicWrite(folder, '.brief-cache.json', `${JSON.stringify({ key, result })}\n`);
    return { ...result, cached: false };
}

function writeArtifacts(folder, result) {
  const serialized = Object.fromEntries(['plan', 'brief', 'sources'].map((name) => [name, `${JSON.stringify(result[name], null, 2)}\n`]));
  for (const [name, content] of Object.entries(serialized)) if (Buffer.byteLength(content) > MAX_FILE_BYTES) fail(`${name} exceeds 256 KB`);
  const staged = Object.entries(serialized).map(([name, content]) => {
    const target = path.join(folder, `${name}.json`);
    const temp = path.join(folder, `.${name}.json.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
    return { target, temp, content, previous: fs.existsSync(target) ? fs.readFileSync(target) : null };
  });
  try {
    for (const file of staged) fs.writeFileSync(file.temp, file.content, { flag: 'wx' });
    let renamed = 0;
    try {
      for (const file of staged) { fs.renameSync(file.temp, file.target); renamed++; }
    } catch (error) {
      for (const file of staged.slice(0, renamed).reverse()) {
        try { if (file.previous === null) fs.unlinkSync(file.target); else fs.writeFileSync(file.target, file.previous); } catch {}
      }
      throw error;
    }
  } finally {
    for (const file of staged) { try { fs.unlinkSync(file.temp); } catch {} }
  }
}
