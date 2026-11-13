import fs from 'node:fs';
import path from 'node:path';
import { readJson } from '../lib/objects.js';

// KAN-549: a topic that merely names a library object ("How a mechanical stopwatch works: ...") reuses that model
// instead of generating a new one. Returns the library entry to reuse, or null (exact slug already saved, or no
// eligible match) so the caller keeps today's path. Passing checkFailureReason and detailVersion in keeps this module
// free of a cycle with model3d.js, which owns the check rules.
// ponytail: whole-phrase match on model names and folder words, plurals folded, no synonyms; add a synonym table if misses matter.

const singular = (w) => {
  if (w.length <= 3) return w;
  if (/(ch|sh|ss|x|z)es$/.test(w)) return w.slice(0, -2);
  if (/[^s]s$/.test(w)) return w.slice(0, -1);
  return w;
};

export const normaliseName = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean).map(singular).join(' ');

const hasPhrase = (text, phrase) => Boolean(phrase) && ` ${text} `.includes(` ${phrase} `);

export function matchLibraryModel(story, topic, { root, slug, emit = () => {}, checkFailureReason, detailVersion }) {
  if (!root || !slug) return null;
  if (readJson(path.join(root, slug, 'model.json'))) return null; // exact slug: today's path, failed or not
  const texts = [topic, story?.name, story?.wiki_title, story?.object?.name].map(normaliseName).filter(Boolean);
  if (!texts.length) return null;
  let folders = [];
  try {
    folders = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return null;
  }
  const hits = [];
  for (const folder of folders) {
    const dir = path.join(root, folder.name);
    const model = readJson(path.join(dir, 'model.json'));
    const check = readJson(path.join(dir, 'check.json'));
    // A failed or missing check is never matched; requirements-keyed versions stay on their own path (KAN-301).
    if (!model || !check || model.requirements_hash || (Number(model.detail) || 1) < detailVersion || checkFailureReason(check)) continue;
    const phrase = [model.name, folder.name.replace(/-/g, ' ')].map(normaliseName)
      .filter((p) => texts.some((t) => hasPhrase(t, p)))
      .sort((a, b) => b.length - a.length)[0];
    if (phrase) hits.push({ slug: folder.name, name: model.name || folder.name, dir, length: phrase.length });
  }
  if (!hits.length) return null;
  hits.sort((a, b) => b.length - a.length || a.slug.localeCompare(b.slug));
  const best = hits[0];
  emit('PLANNER', `Reusing the library model "${best.name}" for topic "${String(topic || story?.name || '').slice(0, 120)}".`);
  return best;
}
