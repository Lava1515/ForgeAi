import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

/**
 * The guidance text for one pipeline step (script, direction, build, look): every project-authored SKILL.md the pack assigns to
 * that step, in order, each under its own heading. Only names the pack lists in `skills` as guidance_only are read, and only from
 * this repository's .claude/skills folder (same path checks as the build skill). A step with no assigned skill gives ''.
 * `topic` (the topic and script text, optional): topic skills of rules.topicSkills whose keywords appear in it are added after the step skills.
 * The text goes into a prompt as guidance; nothing here is mounted, executed or copied into generated code.
 */
export function loadCodebuiltGuides({ pack, step, root = REPO_ROOT, topic = '' } = {}) {
  const names = [...new Set([...guideNamesFor(pack, step), ...topicGuideNamesFor(pack, step, topic)])];
  const approved = new Set((Array.isArray(pack?.skills) ? pack.skills : []).filter((entry) => entry?.mode === 'guidance_only').map((entry) => entry.skill));
  const parts = [];
  for (const name of names) {
    if (!approved.has(name)) throw new Error(`skill ${name} is assigned to step ${step} but is not approved by the code-built path pack`);
    // The YAML frontmatter (name, description) is for skill listings, not for a prompt.
    parts.push(`### ${name}\n${safeSkillText(root, name).replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').trim()}`);
  }
  return parts.join('\n\n');
}
