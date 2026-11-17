import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AsyncLocalStorage } from 'node:async_hooks';
import { SET_PICKER_TEXT } from './setCatalog.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_SKILL_BYTES = 24 * 1024;

function safeSkillText(root, name) {
  if (!NAME_RE.test(name)) throw new Error(`invalid code-built skill name: ${name}`);
  const skillRoot = path.resolve(root, '.claude', 'skills');
  const dir = path.join(skillRoot, name);
  const file = path.join(dir, 'SKILL.md');
  for (const [target, label] of [[skillRoot, 'skill root'], [dir, 'skill directory'], [file, 'skill file']]) {
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink()) throw new Error(`${label} is a link or reparse point: ${target}`);
  }
  const realRoot = fs.realpathSync.native(skillRoot);
  const realDir = fs.realpathSync.native(dir);
  const realFile = fs.realpathSync.native(file);
  const samePath = (left, right) => process.platform === 'win32'
    ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
    : path.resolve(left) === path.resolve(right);
  const inside = (parent, child) => {
    const rel = path.relative(parent, child);
    const normalized = process.platform === 'win32' ? rel.toLowerCase() : rel;
    return rel === '' || (!normalized.startsWith(`..${path.sep}`) && normalized !== '..' && !path.isAbsolute(normalized));
  };
  if (!samePath(realRoot, skillRoot) || !samePath(realDir, dir) || !samePath(realFile, file)
    || !inside(realRoot, realDir) || !inside(realDir, realFile) || !fs.statSync(realFile).isFile()) {
    throw new Error(`skill path escapes the approved root: ${name}`);
  }
  const { size } = fs.statSync(realFile);
  if (size > MAX_SKILL_BYTES) throw new Error(`skill file exceeds ${MAX_SKILL_BYTES} bytes: ${name}`);
  return fs.readFileSync(realFile, 'utf8').trim();
}

/** Reads only the named, project-authored SKILL.md assigned to the build step. */
export function loadCodebuiltBuildSkill({ pack, root = REPO_ROOT } = {}) {
  const name = pack?.rules?.skillsByStep?.build;
  if (typeof name !== 'string' || !Array.isArray(pack?.skills) || !pack.skills.some((entry) => entry?.skill === name && entry?.mode === 'guidance_only')) {
    throw new Error('build skill is not approved by the code-built path pack');
  }
  return { skill: name, text: safeSkillText(root, name) };
}


/** Skill names the pack assigns to a step: rules.skillsByStep[step] is one name or a list of names. */
export function guideNamesFor(pack, step) {
  const value = pack?.rules?.skillsByStep?.[step];
  const names = typeof value === 'string' ? [value] : Array.isArray(value) ? value : [];
  return names.filter((name) => typeof name === 'string');
}

/**
 * Skill names the pack's rules.topicSkills assign to a step for this topic text: an entry applies when the step is in its `steps` and one of
 * its `keywords` appears in the text as a whole word or phrase (case-insensitive). Empty text matches nothing.
 */
export function topicGuideNamesFor(pack, step, text) {
  const haystack = String(text ?? '').toLowerCase();
  if (!haystack.trim() || !Array.isArray(pack?.rules?.topicSkills)) return [];
  const escape = (word) => word.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return pack.rules.topicSkills
    .filter((entry) => typeof entry?.skill === 'string' && Array.isArray(entry.steps) && entry.steps.includes(step) && Array.isArray(entry.keywords)
      && entry.keywords.some((word) => typeof word === 'string' && word.trim() && new RegExp(`(?<![a-z0-9])${escape(word.trim())}(?![a-z0-9])`).test(haystack)))
    .map((entry) => entry.skill);
}

// ---- Job formats (fix lane F1, 2026-11-16) ----
// A format is a flag a job carries from its topic pick or its channel profile (autoTopic.js jobFormatsFor), for example "map".
// What a format loads is configuration: paths/codebuilt.json rules.formats[<format>] = { skills, steps, sets, setSteps, note }.
// Nothing here knows a niche. The keyword route (rules.topicSkills) is unchanged and still serves every other channel.
const FORMAT_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const formatScope = new AsyncLocalStorage();

/** Format names that are safe to use as keys: lowercase words, at most 4, no repeats. Anything else is dropped. */
export function cleanJobFormats(value) {
  return [...new Set((Array.isArray(value) ? value : []).filter((name) => typeof name === 'string' && FORMAT_RE.test(name)))].slice(0, 4);
}

/** Whether any of the job's configured formats opts into the host-drawn overlay path. */
export function jobUsesOverlay(pack, formats) {
  return cleanJobFormats(formats).some((name) => pack?.rules?.formats?.[name]?.overlay === true);
}

/** Route defaults first, then each format override in job order. root remains the second argument for existing callers. */
export function formatDirectionLimits(formats, root = REPO_ROOT, route = 'classic', pathPack = null) {
  let configured = {};
  try {
    const pack = pathPack ?? JSON.parse(fs.readFileSync(path.join(root, 'paths', 'codebuilt.json'), 'utf8'));
    if (route === 'overlay' || route === 'authored') configured = { ...pack?.rules?.routes?.overlay?.direction };
    for (const name of cleanJobFormats(formats)) {
      const limits = pack?.rules?.formats?.[name]?.direction;
      if (limits && typeof limits === 'object' && !Array.isArray(limits)) configured = { ...configured, ...limits };
    }
  } catch {}
  return configured;
}

/** Runs fn with the job's formats in scope, so every guide loaded while the job's steps run sees them without each caller passing them on. */
export function runWithJobFormats(formats, fn) {
  return formatScope.run(cleanJobFormats(formats), fn);
}

/** The formats of the job whose step is running now; [] outside a job. */
export function currentJobFormats() {
  return formatScope.getStore() ?? [];
}

const formatEntries = (pack, formats) => cleanJobFormats(formats)
  .map((name) => pack?.rules?.formats && Object.hasOwn(pack.rules.formats, name) ? pack.rules.formats[name] : null)
  .filter((entry) => entry && typeof entry === 'object');

/** Skill names the pack's rules.formats assign to a step for these job formats. No keyword is needed. */
export function formatGuideNamesFor(pack, step, formats) {
  return formatEntries(pack, formats)
    .filter((entry) => Array.isArray(entry.steps) && entry.steps.includes(step) && Array.isArray(entry.skills))
    .flatMap((entry) => entry.skills.filter((name) => typeof name === 'string'));
}

/**
 * The ready sets a format offers at a step, as a guidance block: the format's note and the catalogue line of each set it names
 * (setCatalog.js, so a set that does not exist is never offered). '' when no format offers sets at this step.
 */
export function formatSetsText(pack, step, formats) {
  const lines = new Map(SET_PICKER_TEXT.split('\n').map((line) => [line.slice(0, line.indexOf(':')), line]));
  const parts = [];
  for (const entry of formatEntries(pack, formats)) {
    if (!Array.isArray(entry.setSteps) || !entry.setSteps.includes(step) || !Array.isArray(entry.sets)) continue;
    const offered = entry.sets.filter((name) => typeof name === 'string' && lines.has(name)).map((name) => `- ${lines.get(name)}`);
    if (!offered.length) continue;
    parts.push(`### Ready sets for this video\n${typeof entry.note === 'string' ? `${entry.note.trim()}\n` : ''}${offered.join('\n')}`);
  }
  return parts.join('\n\n');
}

/**
 * The guidance text for one pipeline step (script, direction, build, look): every project-authored SKILL.md the pack assigns to
 * that step, in order, each under its own heading. Only names the pack lists in `skills` as guidance_only are read, and only from
 * this repository's .claude/skills folder (same path checks as the build skill). A step with no assigned skill gives ''.
 * `topic` (the topic and script text, optional): topic skills of rules.topicSkills whose keywords appear in it are added after the step skills.
 * `formats` (default: the formats of the running job): skills and ready sets of rules.formats are added for them, whatever the text says.
 * The text goes into a prompt as guidance; nothing here is mounted, executed or copied into generated code.
 */
export function loadCodebuiltGuides({ pack, step, root = REPO_ROOT, topic = '', formats = currentJobFormats(), route = 'classic' } = {}) {
  const names = [...new Set([...guideNamesFor(pack, step), ...formatGuideNamesFor(pack, step, formats), ...topicGuideNamesFor(pack, step, topic)])];
  const approved = new Set((Array.isArray(pack?.skills) ? pack.skills : []).filter((entry) => entry?.mode === 'guidance_only').map((entry) => entry.skill));
  const parts = [];
  for (const name of names) {
    if (!approved.has(name)) throw new Error(`skill ${name} is assigned to step ${step} but is not approved by the code-built path pack`);
    // The YAML frontmatter (name, description) is for skill listings, not for a prompt.
    let content = safeSkillText(root, name).replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').trim();
    if (!(route === 'overlay' || route === 'authored' || jobUsesOverlay(pack, formats))) {
      content = content.split('\n## When text is drawn after the render')[0].trimEnd();
    }
    parts.push(`### ${name}\n${content}`);
  }
  const sets = formatSetsText(pack, step, formats);
  if (sets) parts.push(sets);
  return parts.join('\n\n');
}
