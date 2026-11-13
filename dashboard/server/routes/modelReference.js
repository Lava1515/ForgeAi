import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// KAN-171: a real reference (Wikipedia summary, Wikidata dimensions, Commons image licences) for the model builder,
// so proportions come from the real object. Cached under data/model_refs/<slug>.json (git-ignored).
// Only the short description and numbers go into the prompt; article text is never stored or copied.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = process.env.FORGEAI_ROOT || path.resolve(__dirname, '../../../');
export const refsDir = () => process.env.FORGEAI_MODEL_REFS_DIR || path.join(REPO_ROOT, 'data/model_refs');

const slugOf = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const round2 = (n) => Math.round(n * 100) / 100;
const WIKI = 'https://en.wikipedia.org';
const UA = { headers: { 'User-Agent': 'ForgeAi/1.0 (model reference lookup)' } };

// Wikidata unit entity -> metres
const UNIT_M = { Q11573: 1, Q174728: 0.01, Q828224: 1000, Q174789: 0.001, Q3710: 0.3048, Q218593: 0.0254 };
const DIM_PROPS = { P2043: 'length', P2049: 'width', P2048: 'height' };
const TEXT_UNIT_M = { m: 1, metre: 1, metres: 1, meter: 1, meters: 1, ft: 0.3048, foot: 0.3048, feet: 0.3048 };
const TEXT_AXIS = { long: 'length', length: 'length', high: 'height', tall: 'height', height: 'height', wide: 'width', width: 'width', wingspan: 'width' };
const NUM = '(\\d+(?:\\.\\d+)?)\\s*(m|metres?|meters?|ft|feet|foot)\\b';
const AFTER = new RegExp(`${NUM}\\s+(long|high|tall|wide)\\b`, 'gi'); // "220 metres long"
const BEFORE = new RegExp(`\\b(length|height|width|wingspan)\\s+of\\s+${NUM}`, 'gi'); // "a length of 20 m"

export function dimensionsFromText(text = '') {
  const out = {};
  const put = (axis, n, unit) => { out[TEXT_AXIS[axis.toLowerCase()]] ??= round2(Number(n) * TEXT_UNIT_M[unit.toLowerCase()]); };
  for (const [, n, unit, axis] of String(text).matchAll(AFTER)) put(axis, n, unit);
  for (const [, axis, n, unit] of String(text).matchAll(BEFORE)) put(axis, n, unit);
  return out;
}

const getJson = async (fetchFn, url) => {
  try {
    const res = await fetchFn(url, { ...UA, signal: AbortSignal.timeout(10000) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
};

async function wikidataDimensions(fetchFn, qid) {
  const data = await getJson(fetchFn, `https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${qid}&props=claims&format=json&origin=*`);
  const claims = data?.entities?.[qid]?.claims || {};
  const out = {};
  for (const [prop, axis] of Object.entries(DIM_PROPS)) {
    const value = claims[prop]?.[0]?.mainsnak?.datavalue?.value;
    const factor = UNIT_M[String(value?.unit || '').split('/').pop()];
    const n = Number(value?.amount);
    if (factor && Number.isFinite(n) && n > 0) out[axis] = round2(n * factor);
  }
  return out;
}

const SKIP_FILE = /flag|icon|logo|symbol|commons-|wiki|\.svg$/i;
const IMAGE_FILE = /\.(jpe?g|png)$/i;
const stripHtml = (s) => String(s || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();

async function pageImages(fetchFn, title) {
  const data = await getJson(fetchFn, `${WIKI}/w/api.php?action=query&titles=${encodeURIComponent(title)}&prop=images&imlimit=12&format=json&origin=*`);
  const files = Object.values(data?.query?.pages || {}).flatMap((p) => (p.images || []).map((i) => i.title));
  const out = [];
  for (const file of files.filter((f) => IMAGE_FILE.test(f) && !SKIP_FILE.test(f)).slice(0, 3)) {
    const info = await getJson(fetchFn, `https://commons.wikimedia.org/w/api.php?action=query&titles=${encodeURIComponent(file)}&prop=imageinfo&iiprop=url%7Cextmetadata&format=json&origin=*`);
    const ii = Object.values(info?.query?.pages || {})[0]?.imageinfo?.[0];
    if (!ii?.url) continue;
    const meta = ii.extmetadata || {};
    out.push({ file, url: ii.url, license: stripHtml(meta.LicenseShortName?.value) || 'unknown', license_url: stripHtml(meta.LicenseUrl?.value), artist: stripHtml(meta.Artist?.value) });
  }
  return out;
}

// Returns the cached or freshly fetched reference, or null when nothing usable was found (nothing is cached then).
export async function getModelReference(name, { fetchFn = fetch, dir = refsDir() } = {}) {
  const slug = slugOf(name);
  if (!slug) return null;
  const file = path.join(dir, `${slug}.json`);
  try {
    const cached = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (cached?.slug === slug) return cached;
  } catch { /* miss */ }

  const summary = await getJson(fetchFn, `${WIKI}/api/rest_v1/page/summary/${encodeURIComponent(String(name).trim().replace(/ /g, '_'))}`);
  if (!summary || summary.type === 'disambiguation' || !summary.title) return null;

  const wikidata = summary.wikibase_item ? await wikidataDimensions(fetchFn, summary.wikibase_item) : {};
  const dimensions_m = { ...dimensionsFromText(summary.extract), ...wikidata }; // Wikidata numbers win over text guesses
  const description = stripHtml(summary.description).slice(0, 160);
  if (!description && !Object.keys(dimensions_m).length) return null;

  const ref = {
    slug,
    title: summary.title,
    fetched_at: new Date().toISOString(),
    source: { wikipedia_url: summary.content_urls?.desktop?.page || `${WIKI}/wiki/${encodeURIComponent(summary.title.replace(/ /g, '_'))}`, wikidata_id: summary.wikibase_item || null },
    description,
    dimensions_m,
    images: await pageImages(fetchFn, summary.title),
  };
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(ref, null, 2));
  } catch { /* cache write failure never blocks a build */ }
  return ref;
}

// Prompt block for the model builder; '' when there is no usable reference.
export function referencePromptBlock(ref) {
  const d = ref?.dimensions_m || {};
  const dims = ['length', 'width', 'height'].filter((k) => d[k]).map((k) => `${k} ${d[k]} m`);
  if (!ref || (!ref.description && !dims.length)) return '';
  const ratios = ['width', 'height'].filter((k) => d[k] && d.length).map((k) => `${k}/length ${(d[k] / d.length).toFixed(2)}`);
  return `\nReal reference (Wikipedia / Wikidata, use it for proportions; the facts above win if they disagree):\n${ref.description ? `- What it is: ${ref.description}\n` : ''}${dims.length ? `- Real dimensions: ${dims.join(', ')}. Set "size_m" to these and fill them.\n` : ''}${ratios.length ? `- Proportions: ${ratios.join(', ')}.\n` : ''}`;
}
