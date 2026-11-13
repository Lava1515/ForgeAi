import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KNOWLEDGE_DIR = path.join(__dirname, 'knowledge');

// One parser for both rule files: "### XX-nn [TAG] title" plus its "- field:" lines; section headings and prose belong to no rule.
function readRules(file, prefix, knowledgeDir) {
  const text = fs.readFileSync(path.join(knowledgeDir, file), 'utf8');
  return text
    .split(new RegExp(`^(?=### ${prefix}-\\d+ )`, 'm'))
    .filter((b) => b.startsWith(`### ${prefix}-`))
    .map((b) => b.split('\n').filter((l) => l.startsWith('### ') || l.startsWith('- ')).join('\n'));
}
const ruleId = (block) => block.match(/^### ([A-Z]+-\d+)/)[1];
const pick = (blocks, ids) => {
  const byId = new Map(blocks.map((b) => [ruleId(b), b]));
  return ids.map((id) => byId.get(String(id).toUpperCase())).filter(Boolean);
};

/**
 * Returns the text blocks of motion-grammar.md, one string per rule
 * ("### MG-xx [TAG] title" plus its field lines).
 * No ids (or an empty list) = every MG rule in file order; otherwise the
 * named ids, in the order asked. MG-xx and SG-xx (shorts-shot-grammar.md,
 * KAN-435) ids are both accepted; unknown ids are skipped.
 */
export function loadMotionRules(ids, { knowledgeDir = KNOWLEDGE_DIR } = {}) {
  const mg = readRules('motion-grammar.md', 'MG', knowledgeDir);
  if (!Array.isArray(ids) || ids.length === 0) return mg;
  const wantsSg = ids.some((id) => /^SG-/i.test(String(id)));
  return pick(wantsSg ? [...mg, ...readRules('shorts-shot-grammar.md', 'SG', knowledgeDir)] : mg, ids);
}

/** Same as loadMotionRules but for shorts-shot-grammar.md (SG-xx): no ids = every rule in file order. */
export function loadShortsRules(ids, { knowledgeDir = KNOWLEDGE_DIR } = {}) {
  const sg = readRules('shorts-shot-grammar.md', 'SG', knowledgeDir);
  return Array.isArray(ids) && ids.length ? pick(sg, ids) : sg;
}

/** Same as loadShortsRules but for skills-3d-rules.md (SK-xx, KAN-559): no ids = every rule in file order. */
export function loadSkillRules(ids, { knowledgeDir = KNOWLEDGE_DIR } = {}) {
  const sk = readRules('skills-3d-rules.md', 'SK', knowledgeDir);
  return Array.isArray(ids) && ids.length ? pick(sk, ids) : sk;
}

const ruleLine = (b) => `   - ${ruleId(b)} ${b.match(/^### \S+ \[\w+\] (.*)$/m)[1]}: ${b.match(/^- rule: (.*)$/m)[1]}`;

/** Planner prompt lines for the named SK rules (id, title, rule text; the check and source stay in the file). Empty when none match. */
export function skillRulesPrompt(ids, { knowledgeDir } = {}) {
  const lines = loadSkillRules(ids, { knowledgeDir }).map(ruleLine);
  return lines.length ? `\n   3D rules (skills_rules_v1):\n${lines.join('\n')}` : '';
}

/**
 * KAN-712: the skill rules a pipeline stage gets, from skills-manifest.json. Empty unless policy.skills_in_prompt_v1 === true
 * (strict boolean). Entries go in ascending priority; whole rules are dropped from the end until the text fits maxChars.
 * Unknown stage, missing file or bad JSON gives '' (never throws). Only SK-xx rule files are read today.
 */
export function skillsPrompt(stage, { policy, maxChars = 2500, knowledgeDir = KNOWLEDGE_DIR } = {}) {
  if (policy?.skills_in_prompt_v1 !== true) return '';
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(knowledgeDir, 'skills-manifest.json'), 'utf8'));
    const entries = [...(manifest.stages?.[stage] ?? [])].sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
    const lines = entries.flatMap((e) => pick(readRules(e.file, 'SK', knowledgeDir), e.ids ?? []).map(ruleLine));
    const head = '\n   3D rules (skills_rules_v1):\n';
    while (lines.length && (head + lines.join('\n')).length > maxChars) lines.pop();
    return lines.length ? head + lines.join('\n') : '';
  } catch {
    return '';
  }
}
