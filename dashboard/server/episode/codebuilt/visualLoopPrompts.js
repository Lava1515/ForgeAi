// Visual loop (KAN-934): what the look call is asked, how its reply is checked, and how a fix is applied to the build script.
// The checklist below is written for this loop and for the failures actually seen (a label plate across the whole frame, a
// bicycle ending against its own backdrop wall, a bare floor box and a wall box as "scenery"); it is not skill text. The
// reply parser is strict on purpose: a reply that does not echo the sheet codes, describe every shot, or follow the schema is
// never a pass. Scoped edits are structural (replace one definition, add one, replace one constant) and are applied by
// splicing lines, with a host `python -I` AST helper (stdin only, nothing is executed) that says where the definitions are.
import { spawnSync } from 'node:child_process';
import { parseModelJson } from './planner.js';
import { LoopError } from './loopErrors.js';

export const LOOK_CHECKLIST = Object.freeze([
  'Direction: each shot shows what the planned shot says: that subject, in that place, doing that action. A shot that shows something else, or a place that has nothing to do with the words spoken, is a P0.',
  'Subject size: the subject of each shot fills a third to two thirds of the frame height and sits in the middle 60 percent of the frame. A subject that is a dot, or smaller than a sixth of the frame height in a shot that is not an establishing wide, is a P0; a subject cut by a frame edge is a P1.',
  'Camera: the camera is never against or inside a wall, floor, sky dome, backdrop card or plate. A frame that is one flat colour, or mostly filled by one flat surface, is a P0 (the measured facts name such tiles).',
  'Scenery: every place reads as a real location with depth: ground, things behind the subject up to a horizon or far wall, things around it. A bare floor with one wall, or a subject floating in an empty colour, is a P0 (deep space with stars and a planet is a place).',
  'Light: no black frame, no blown-out white blob where the subject should be, nothing important lost in shadow (P0 when the subject cannot be read, else P1).',
  'Plates and labels: no label, HUD plate or readout wider than 70 percent of the frame or covering the subject (P0); text on a plate must be readable at the size it is drawn (P1); leftover text that belongs to another shot is a P1. A diagram board (a flat panel with a drawn diagram on it) is not a plate: it may be up to 84 percent of the frame wide.',
  'Diagrams (triangles, arrows, charts, number cards, labelled sketches): every corner and end of a diagram is inside the frame and the diagram is at least 45 percent of the frame width; lines are at least 15 px wide and capital letters at least 50 px tall at 1080 x 1920 (half of that in the preview tiles); at most 6 short labels. Judge each fault by what is on the tile: a diagram cut by the frame edge is a P1 whose fix is to pull back or shrink it, a diagram that is small or thin is a P1 whose fix is to enlarge or thicken it. Never ask for the opposite of what the numbers in the script show.',
  'Caption band: the burned-in captions will cover the band from 66 to 80 percent of the frame height (counted from the top), across the middle. The most important part of the subject (a face, the thing being pointed at) must not sit only in that band (P1).',
  'Change: two tiles of the same shot must differ (the action or the camera moved); neighbouring shots differ in composition (camera side, height or distance). A shot whose tiles are identical, or two neighbouring shots that look the same, is a P1.',
  'Continuity: a recurring character or object looks the same in every shot it appears in, and objects of one shot are not left standing in another shot of the same place (P1).',
  'Props: each place has 4 to 8 props that support the story; fewer than 3 is a P1, an empty place is a P0.',
  'Ending: the last tile shows a finished picture (the pay-off or the return to the opening), not an empty scene or a repeat of the tile before it (P1).',
  'Mistakes: objects passing through the floor or each other, floating pieces that should be attached, a person lying or tilted who should stand, stretched or flipped text (P1).',
  'Look: colours look chosen and consistent across places (one palette); everything default grey is a P1.',
  'Truth: anything on screen that contradicts the narration is a P1; a missing planned shot is a P0.',
]);

export const DEFAULT_LOCKED = Object.freeze(['FPS', 'NFRAMES', 'SHOT_STARTS', 'OUT']);
export const DEFAULT_EDIT_LIMITS = Object.freeze({ maxDefs: 10, maxFraction: 0.6, maxEdits: 12, maxSourceChars: 16000 });
// Fix rounds after the first look; visualLoop.js imports it so the prompt and the controller agree.
export const LOOK_FIX_ROUNDS = 3;
const MAX_FINDINGS = 40;
const MAX_TILE = 24;
const IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const SEVERITIES = ['P0', 'P1', 'P2'];

/** Which planned shot each tile (preview frame) falls in. shotStarts are seconds in video time. */
export function tileShotMap(tiles, shots, shotStarts, fps = 30) {
  const map = {};
  for (const tile of tiles) {
    let k = 0;
    shotStarts.forEach((start, i) => { if (tile.frame >= Math.round(start * fps)) k = i; });
    map[tile.n] = shots[Math.min(k, shots.length - 1)].id;
  }
  return map;
}

/** Host paths and long output out of QA/diagnostic text before it reaches a prompt. */
function cleanDiagnostic(text) {
  return String(text ?? '')
    .replace(/[A-Za-z]:[\\/][^\s'"]*/g, '<path>')
    .replace(/\/(?:Users|home|root|mnt|c)\/[^\s'"]*/g, '<path>')
    .slice(-3000);
}

// A diagram or label finding that comes back for the same shot after a fix is a wrong diagnosis (job mwhu3xfu-a118b6: the Everest triangle was
// called small and thin in rounds 2, 3 and 4 and every fix moved the camera, while its corners were off the frame). Say so, and say what to do.
const LEGIBILITY_SUBJECT = /\b(diagram|triangle|chart|graph|arrow|labels?|text|cards?|numbers?|readouts?|rays?|layers?|lines?|plates?)\b/i;
const LEGIBILITY_FAULT = /\b(small|thin|tiny|unread|illegib|not readable|cannot be read|too small|cropped|cut off|cut by)/i;

/** Shot ids whose diagram or text legibility finding (P0 or P1) appears in two or more earlier rounds. */
export function repeatedLegibilityShots(previous) {
  const seen = new Map();
  for (const round of Array.isArray(previous) ? previous : []) {
    const inRound = new Set();
    for (const f of round.findings ?? []) {
      if ((f.severity === 'P0' || f.severity === 'P1') && f.shot && LEGIBILITY_SUBJECT.test(f.issue ?? '') && LEGIBILITY_FAULT.test(f.issue ?? '')) inRound.add(f.shot);
    }
    for (const shot of inRound) seen.set(shot, (seen.get(shot) ?? 0) + 1);
  }
  return [...seen].filter(([, n]) => n >= 2).map(([shot]) => shot);
}

function repeatedLegibilityNote(previous) {
  const shots = repeatedLegibilityShots(previous);
  if (!shots.length) return '';
  return `\nREPEATED LEGIBILITY FINDING (${shots.join(', ')}): the same diagram or text fault came back after a fix, so the fix changed the wrong thing. Do not change the same numbers again. Project the diagram's corners and ends through the camera first (frame height at distance d is d * 36 / lens, width 9/16 of that): a corner outside the frame needs a camera further back or a smaller diagram, a thin line or small text needs bigger strokes and letters (15 px and 50 px at 1080 x 1920). Then rebuild that diagram on a diagram.Board (from blender_worker.codebuilt import diagram; the review guidance describes it) and aim the shot with board.camera(cam, ...).\n`;
}

// ---- kit checks and measured numbers (fix lane F2, 2026-11-16) ---------------------------------------------------------------------
// The kit's pre-render checks no longer stop a preview: shotcheck.run_qa writes what failed, each shot's camera numbers and the
// measured framing of each preview frame to <preview job>/work/qa_report.json, and the look gets them next to the pictures.
// The file is written inside the container by code that ran generated code, so every value is checked and bounded here.

export const KIT_CHECKS = Object.freeze(['text_clipped', 'readout_too_wide', 'readout_behind_subject', 'same_composition', 'missing_target', 'uncheckable_shot', 'text_in_3d']);
const EDGES = ['left', 'right', 'bottom', 'top', 'camera'];
const plain = (text, max) => cleanDiagnostic([...String(text ?? '')].filter((ch) => ch >= ' ' && ch <= '~').join('')).slice(0, max);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) && Math.abs(v) < 1e7 ? v : null);
const frameNo = (v) => (Number.isInteger(v) && v >= 0 && v < 1e6 ? v : null);

/** A parsed qa_report.json -> { findings, cameras, framing, seconds } with only checked values, or null when it is not one. */
export function sanitizeKitReport(raw, shotCount) {
  if (!isObj(raw) || raw.version !== 1) return null;
  const shotIndex = (v) => (Number.isInteger(v) && v >= 0 && v < shotCount ? v : null);
  const findings = (Array.isArray(raw.findings) ? raw.findings : []).slice(0, 40).flatMap((f) => {
    if (!isObj(f) || !KIT_CHECKS.includes(f.check)) return [];
    const text = plain(f.text, 600);
    if (text.length < 3) return [];
    const shot = shotIndex(f.shot);
    return [{ check: f.check, shot: shot === null ? null : `shot-${shot}`, frames: (Array.isArray(f.frames) ? f.frames : []).slice(0, 2).map(frameNo).filter((n) => n !== null), text }];
  });
  const cameras = (Array.isArray(raw.cameras) ? raw.cameras : []).slice(0, 40).flatMap((c) => {
    const shot = isObj(c) ? shotIndex(c.shot) : null;
    const values = isObj(c) ? [c.az, c.el, c.dist, c.lens].map(num) : [null];
    const target = isObj(c) && Array.isArray(c.target) && c.target.length === 3 ? c.target.map(num) : [null];
    if (shot === null || values.includes(null) || target.includes(null)) return [];
    return [{ shot: `shot-${shot}`, frame: frameNo(c.frame), az: values[0], el: values[1], dist: values[2], lens: values[3], target }];
  });
  const framing = (Array.isArray(raw.framing) ? raw.framing : []).slice(0, 60).flatMap((m) => {
    const frame = isObj(m) ? frameNo(m.frame) : null;
    if (frame === null) return [];
    const shot = shotIndex(m.shot);
    const base = { frame, shot: shot === null ? null : `shot-${shot}` };
    if (m.subject === null || m.subject === undefined) return [{ ...base, subject: null }];
    const subject = plain(m.subject, 60);
    if (!subject) return [];
    const parts = Number.isInteger(m.parts) && m.parts > 0 && m.parts < 1e5 ? m.parts : 1;
    if (m.out === true) return [{ ...base, subject, parts, out: true }];
    const [h, w, cx, cy] = [m.h, m.w, m.cx, m.cy].map((v) => (num(v) !== null && v >= 0 && v <= 1 ? v : null));
    if ([h, w, cx, cy].includes(null)) return [];
    return [{ ...base, subject, parts, h, w, cx, cy, cut: (Array.isArray(m.cut) ? m.cut : []).filter((e) => EDGES.includes(e)).slice(0, 4) }];
  });
  return { findings, cameras, framing, seconds: num(raw.seconds) };
}

const pct = (v) => `${Math.round(v * 100)}%`;
const short = (v) => String(Math.round(v * 100) / 100);

function framingLine(m) {
  if (m.subject === null) return 'nothing is at the camera target (no object within reach of the point the camera is aimed at)';
  const what = `"${m.subject}"${m.parts > 1 ? ` (${m.parts} parts)` : ''}`;
  if (m.out) return `${what} is at the camera target but NOT IN THE FRAME`;
  const cut = m.cut.length ? `, ${m.cut.includes('camera') ? 'partly BEHIND THE CAMERA' : `CUT by the ${m.cut.join(' and ')} frame edge${m.cut.length > 1 ? 's' : ''}`}` : '';
  const small = m.h < 1 / 6 && m.w < 0.5 ? ' (under a sixth of the frame height)' : '';
  return `${what} fills ${pct(m.h)} of the frame height${small} and ${pct(m.w)} of the width, centre ${pct(m.cx)} across and ${pct(m.cy)} up${cut}`;
}

/** The prompt sections for a kit report: failed checks, camera numbers per shot, measured framing per tile. [] when there is nothing. */
export function kitPromptSections(kit, sheets = []) {
  if (!kit) return [];
  const parts = [];
  if (kit.findings.length) {
    parts.push(`KIT CHECKS THAT FAILED ON THIS SCRIPT (measured in code on the posed scene; facts, not opinions). The pictures were rendered anyway, but the final render refuses a script with any of these, so "pass" is not accepted while one remains. Fix every one of them in this same reply, together with what you see in the pictures, and list each as a finding (P1, or P0 when the pictures show it spoils the shot):\n${kit.findings.map((f) => `- [${f.check}]${f.shot ? ` ${f.shot}` : ''}: ${f.text}`).join('\n').slice(0, 6000)}`);
  }
  if (kit.cameras.length) {
    parts.push(`CAMERA NUMBERS (measured at the middle frame of each shot, from the pos and target given to cam.set; azimuth 0 = the camera is on the -Y side of its target, positive towards +X; elevation = degrees above the target; shot numbers in kit messages are these shot ids). Edit these numbers, do not guess:\n${kit.cameras.map((c) => `${c.shot}${c.frame === null ? '' : ` (frame ${c.frame})`}: azimuth ${Math.round(c.az)}, elevation ${Math.round(c.el)}, distance ${short(c.dist)} m, lens ${Math.round(c.lens)} mm, target (${c.target.map(short).join(', ')})`).join('\n')}`);
  }
  const tileOf = new Map(sheets.flatMap((sheet) => sheet.tiles.map((t) => [t.frame, t.n])));
  const lines = kit.framing.filter((m) => tileOf.has(m.frame)).map((m) => `T${tileOf.get(m.frame)} (frame ${m.frame}${m.shot ? `, ${m.shot}` : ''}): ${framingLine(m)}`);
  if (lines.length) {
    parts.push(`MEASURED FRAMING PER TILE (what the camera is aimed at: the object or parent group found at the camera target; sizes are the visible share of the frame, measured from its vertices, y up). When the named object is the shot's subject these numbers are facts: a subject under a third of the frame height needs a shorter distance or a longer lens (size in frame scales with lens / distance), a CUT subject needs more distance or a moved target. When the named object is not the subject (the camera is aimed at something else, or past it), that is worth fixing too: aim cam.set at the subject.\n${lines.join('\n')}`);
  }
  return parts;
}

function previousSummary(previous) {
  if (!Array.isArray(previous) || !previous.length) return '';
  const lines = [];
  for (const round of previous) {
    for (const f of round.findings ?? []) lines.push(`round ${Number(round.round) + 1}: [${f.severity}] ${f.shot ?? 'all'}: ${f.issue} -> ${f.fix ?? ''}`.slice(0, 400));
  }
  return lines.length ? `\nWHAT WAS ALREADY FOUND AND TRIED (do not repeat a fix that did not work; check that these are really gone):\n${lines.join('\n').slice(0, 3000)}\n${repeatedLegibilityNote(previous)}` : '';
}

export function buildLookPrompt({
  brief, script, shots, buildScript, kitContract, sheets = [], shotStarts, fps = 30, round = 0, finalRound = false, qaText, previous, guides = '', fixRoundsLeft = null, kit = null, layoutFindings = [],
}) {
  const hasSheets = sheets.length > 0;
  const uniqueCodes = [...new Set(sheets.map((x) => x.code))];
  const tileLines = [];
  for (const [index, sheet] of sheets.entries()) {
    const map = tileShotMap(sheet.tiles, shots, shotStarts, fps);
    tileLines.push(`Sheet ${index + 1} (code in its header: ${sheet.code}): ${sheet.tiles.map((t) => `T${t.n} (frame ${t.frame}, ${map[t.n]})`).join(', ')}`);
  }
  const shotLines = shots.map((s, i) => `${s.id} (from ${Number(shotStarts[i] ?? 0).toFixed(1)} s): ${s.subject}. Narration: ${s.narration}`);
  const schema = `{"sheet_codes": [${uniqueCodes.map((c) => `"${c}"`).join(', ')}], "verdict": "pass" | "fix", "shots": [{"id": "${shots[0].id}", "sees": "one sentence: what is visible in this shot's frames", "ok": true | false}, ...one entry per shot...], "findings": [{"severity": "P0" | "P1" | "P2", "shot": "<shot id or null>", "frames": [<tile numbers>], "issue": "...", "fix": "..."}], "targets": ["<names of the definitions and constants you will change>"], "edits": [{"op": "replace_def", "name": "<existing def>", "source": "<the whole new def>"}, {"op": "add_def", "name": "<new def>", "before": "<existing top-level name>", "source": "<the whole def>"}, {"op": "replace_assign", "name": "<existing constant>", "source": "<NAME = value>"}]}`;
  const parts = [];
  parts.push(`You are the director checking a 9:16 short that is built in Blender by the Python script below. ${hasSheets ? `${sheets.length} contact sheet image${sheets.length > 1 ? 's are' : ' is'} attached, made from a low-resolution preview render of this exact script (look round ${round + 1}). Each sheet header shows a code; each tile is labelled T<number> and its frame.` : `There are no pictures this round: the preview of this script did not produce any, and the reason is given below. Fix the script from the reason alone.`}`);
  parts.push(`BRIEF:\n${brief}\n\nNARRATION:\n${script}\n\nPLANNED SHOTS:\n${shotLines.join('\n')}`);
  if (hasSheets) parts.push(`TILES:\n${tileLines.join('\n')}`);
  if (hasSheets) parts.push('These tiles carry the final text: captions are burned in, and any overlay labels are drawn in their final positions. Check whether each label is readable at phone size and whether any text covers the subject.');
  const flagged = sheets.flatMap((sheet) => sheet.tiles.filter((t) => t.flag).map((t) => `T${t.n} (frame ${t.frame}) is ${t.flag === 'flat' ? 'ONE FLAT COLOUR (the camera is inside or against a surface, or nothing is lit)' : t.flag === 'dark' ? 'almost black' : t.flag === 'plain' ? 'nearly one colour: look closely, and if the frame is mostly one flat surface (a wall, floor, dome or plate filling it) that is a P0' : 'blown out (a quarter or more of it is pure white)'}`));
  if (flagged.length) parts.push(`MEASURED FROM THE PIXELS (facts, not opinions; a flat tile can never pass):\n${flagged.join('\n')}`);
  if (hasSheets) parts.push(...kitPromptSections(kit, sheets));
  // codex | gpt-6.1-sol | 2026-11-19 19:33 +02:00: F9 uses the existing framing signal.
  if (hasSheets) parts.push('Opening check (frame 0 / first preview tile): the whole subject must be inside the frame and readable at phone size. Use its measured framing when available; report a cropped or unreadable opening as a P1 finding with the tile number and a concrete fix.');
  if (layoutFindings.length) {
    // preview_sheet.py writes frame -1 for findings that belong to no single frame (label_hidden): print no frame for them, never "frame -1".
    const clean = layoutFindings.slice(0, 120).map((f) => `${Number.isInteger(f.frame) && f.frame >= 0 ? `frame ${f.frame}` : 'no single frame'}: ${String(f.code ?? 'layout issue').slice(0, 50)}${Array.isArray(f.elements) && f.elements.length ? ` (${f.elements.slice(0, 8).join(', ')})` : ''}`);
    parts.push(`PREVIEW TEXT LAYOUT FINDINGS (measured on the previewed frames; consider these alongside the framing numbers):\n${clean.join('\n')}`);
  }
  if (qaText) parts.push(`WHY THERE ARE NO PICTURES (preview/QA output):\n${cleanDiagnostic(qaText)}`);
  parts.push(`LOOK CHECKLIST (P0 = must not ship as it is, P1 = should be fixed, P2 = a note):\n${LOOK_CHECKLIST.map((line) => `- ${line}`).join('\n')}`);
  const prior = previousSummary(previous);
  if (prior) parts.push(prior.trim());
  if (guides) parts.push(`REVIEW GUIDANCE (project skills):\n${guides}`);
  parts.push(`THE KIT YOU MAY USE (same contract as when the script was written):\n${kitContract}`);
  parts.push(`CURRENT BUILD SCRIPT:\n\`\`\`python\n${buildScript}\n\`\`\``);
  parts.push([
    'HOW TO ANSWER: reply with ONE JSON object and nothing else, in this shape:',
    schema,
    'Rules:',
    hasSheets ? '- sheet_codes must list each distinct code printed in the sheet headers, exactly as printed (once each). A reply without them is thrown away.' : '- sheet_codes must be an empty list this round. You cannot answer "pass" without pictures.',
    '- shots must have exactly one entry per planned shot, with one real sentence in "sees" about what is visible in that shot. A "pass" is only valid when every shot is ok and there is no P0.',
    `- Say "fix" only for a P0 or P1 problem. Name the definitions or constants you will change in "targets" and give the complete new source of each in "edits" (targeted edits, not a rewrite: at most ${DEFAULT_EDIT_LIMITS.maxDefs} definitions, under ${Math.round(DEFAULT_EDIT_LIMITS.maxFraction * 100)} percent of the script, each source at most ${DEFAULT_EDIT_LIMITS.maxSourceChars} characters). Fix the cause, not the symptom: when a tile is one flat colour, work out from the numbers in the script where the camera is and which surface it is inside or facing, and move the camera or the surface; when the subject is tiny, move the camera closer or lengthen the lens using the sizes in the script; when a fix of an earlier round did not work, do something different.`,
    '- Never change FPS, NFRAMES, SHOT_STARTS, OUT or the shotcheck.run_qa / renderloop.render_frames statements, and never call them in an edit.',
    finalRound
      ? '- This is the last look. Edits must be empty and targets must be empty: say "pass" if there is no P0, otherwise "fix" with the findings and the job will stop.'
      : `- After a fix the script is previewed and you look again. You have ${fixRoundsLeft ?? Math.max(0, LOOK_FIX_ROUNDS - round)} fix round${(fixRoundsLeft ?? Math.max(0, LOOK_FIX_ROUNDS - round)) === 1 ? '' : 's'} left including this one. Fix every P0 and P1 you found in this one reply; do not leave some for later.`,
  ].join('\n'));
  return parts.join('\n\n');
}

// ---- reply parser --------------------------------------------------------------------------------------------------------------

const bad = (message, detail = {}) => new LoopError('bad_reply', message, detail);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const onlyKeys = (obj, allowed, what) => { for (const k of Object.keys(obj)) if (!allowed.includes(k)) throw bad(`${what} has an unknown key`); };

export function parseLookReply(text, { shots, sheetCodes, finalRound = false, flatTiles = [], kitFailures = [] } = {}) {
  let body;
  try { body = parseModelJson(text); } catch { throw bad('the reply was not JSON'); }
  if (!isObj(body)) throw bad('the reply must be a JSON object');
  onlyKeys(body, ['sheet_codes', 'verdict', 'shots', 'findings', 'targets', 'edits'], 'the reply');
  const expected = [...sheetCodes];
  const codes = body.sheet_codes ?? (expected.length ? undefined : []);
  if (!Array.isArray(codes) || codes.some((c) => typeof c !== 'string')) throw bad('sheet_codes is missing or not a list of strings', { reason: 'sheet_codes' });
  if (new Set(codes).size !== codes.length || codes.length !== expected.length || !expected.every((c) => codes.includes(c))) throw bad('sheet_codes do not match the sheets that were sent', { reason: 'sheet_codes' });
  if (body.verdict !== 'pass' && body.verdict !== 'fix') throw bad('verdict must be pass or fix');

  const ids = shots.map((s) => s.id);
  if (!Array.isArray(body.shots)) throw bad('shots must be a list with one entry per planned shot');
  const seen = new Set();
  const entries = body.shots.map((entry) => {
    if (!isObj(entry)) throw bad('a shots entry must be an object');
    onlyKeys(entry, ['id', 'sees', 'ok'], 'a shots entry');
    if (!ids.includes(entry.id) || seen.has(entry.id)) throw bad('a shots entry names an unknown or repeated shot');
    seen.add(entry.id);
    if (typeof entry.ok !== 'boolean') throw bad('a shots entry needs ok true or false');
    const sees = typeof entry.sees === 'string' ? entry.sees.trim() : '';
    if (entry.sees !== undefined && (typeof entry.sees !== 'string' || sees.length > 300)) throw bad('sees must be a short sentence');
    return { id: entry.id, sees, ok: entry.ok };
  });
  const described = entries.every((e) => e.sees.length >= 12 && e.sees.split(/\s+/).length >= 3);
  if (body.verdict === 'pass' && (entries.length !== ids.length || !described)) throw bad('a pass needs one real "sees" sentence for every planned shot');
  if (body.verdict === 'pass' && expected.length === 0) throw bad('there is nothing to pass without pictures');
  if (body.verdict === 'pass' && entries.some((e) => !e.ok)) throw bad('a pass cannot contain a shot that is not ok');

  const findingsIn = body.findings ?? [];
  if (!Array.isArray(findingsIn) || findingsIn.length > MAX_FINDINGS) throw bad(`findings must be a list of at most ${MAX_FINDINGS}`);
  const findings = findingsIn.map((f) => {
    if (!isObj(f)) throw bad('a finding must be an object');
    onlyKeys(f, ['severity', 'shot', 'frames', 'issue', 'fix'], 'a finding');
    if (!SEVERITIES.includes(f.severity)) throw bad('severity must be P0, P1 or P2');
    if (f.shot !== null && f.shot !== undefined && !ids.includes(f.shot)) throw bad('a finding names an unknown shot');
    const frames = f.frames ?? [];
    if (!Array.isArray(frames) || frames.length > MAX_TILE || frames.some((n) => !Number.isInteger(n) || n < 1 || n > MAX_TILE)) throw bad('a finding lists tile numbers 1..24');
    if (typeof f.issue !== 'string' || f.issue.trim().length < 3 || f.issue.length > 400) throw bad('a finding needs an issue sentence');
    if (f.fix !== undefined && (typeof f.fix !== 'string' || f.fix.length > 400)) throw bad('a finding fix must be a short sentence');
    return { severity: f.severity, shot: f.shot ?? null, frames, issue: f.issue.trim(), fix: (f.fix ?? '').trim() };
  });
  const hasP0 = findings.some((f) => f.severity === 'P0');
  const hasP0P1 = findings.some((f) => f.severity === 'P0' || f.severity === 'P1');
  if (body.verdict === 'pass' && hasP0) throw bad('a pass cannot carry a P0 finding');
  if (body.verdict === 'pass' && flatTiles.length) throw bad(`tile${flatTiles.length > 1 ? 's' : ''} ${flatTiles.map((n) => `T${n}`).join(', ')} measured as one flat colour: that is a P0 (camera inside or against a surface, or nothing lit), so the verdict cannot be pass`);

  if (body.verdict === 'pass' && kitFailures.length) throw bad(`the kit checks failed on this script (${[...new Set(kitFailures)].join(', ')}) and the final render refuses it, so the verdict cannot be pass: list each failed check as a finding and fix it`);

  const targetsIn = body.targets ?? [];
  const editsIn = body.edits ?? [];
  if (!Array.isArray(targetsIn) || targetsIn.length > DEFAULT_EDIT_LIMITS.maxEdits || targetsIn.some((t) => typeof t !== 'string' || !IDENT.test(t))) throw bad('targets must be a short list of names');
  if (!Array.isArray(editsIn) || editsIn.length > DEFAULT_EDIT_LIMITS.maxEdits) throw bad(`edits must be a list of at most ${DEFAULT_EDIT_LIMITS.maxEdits}`);
  const edits = editsIn.map((e) => {
    if (!isObj(e)) throw bad('an edit must be an object');
    if (!['replace_def', 'add_def', 'replace_assign'].includes(e.op)) throw bad('unknown edit op');
    onlyKeys(e, e.op === 'add_def' ? ['op', 'name', 'before', 'source'] : ['op', 'name', 'source'], 'an edit');
    if (typeof e.name !== 'string' || !IDENT.test(e.name)) throw bad('an edit needs a name');
    if (typeof e.source !== 'string' || !e.source.trim() || e.source.length > DEFAULT_EDIT_LIMITS.maxSourceChars) throw bad('an edit needs a source of at most 12000 characters');
    if (e.op === 'add_def' && (typeof e.before !== 'string' || !IDENT.test(e.before))) throw bad('add_def needs "before": an existing top-level name');
    if (!targetsIn.includes(e.name)) throw bad('an edit changes something that is not listed in targets');
    return e.op === 'add_def' ? { op: e.op, name: e.name, before: e.before, source: e.source } : { op: e.op, name: e.name, source: e.source };
  });

  if (body.verdict === 'pass' && (edits.length || targetsIn.length)) throw bad('a pass carries no edits');
  if (body.verdict === 'fix') {
    if (!hasP0P1) throw bad('a fix needs at least one P0 or P1 finding');
    if (finalRound) {
      if (edits.length || targetsIn.length) throw bad('the last look cannot carry edits');
    } else if (!targetsIn.length || !edits.length) {
      throw bad('a fix needs targets and edits');
    }
  }
  return { sheet_codes: codes, verdict: body.verdict, shots: entries, findings, targets: targetsIn, edits };
}

// ---- scoped edits --------------------------------------------------------------------------------------------------------------

const AST_PY = `import ast, json, sys
LOCKED_CALLS = {"render_frames", "run_qa"}
def callee(c):
    f = c.func
    return f.attr if isinstance(f, ast.Attribute) else (f.id if isinstance(f, ast.Name) else None)
def info(src):
    try:
        tree = ast.parse(src)
    except SyntaxError as e:
        return {"ok": False, "error": "line %s: %s" % (e.lineno, e.msg)}
    nodes = []
    for n in tree.body:
        kind, name, names = "other", None, []
        if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)):
            kind, name = "def", n.name
        elif isinstance(n, ast.ClassDef):
            kind, name = "def", n.name
        elif isinstance(n, ast.Assign):
            kind = "assign"
            for t in n.targets:
                for x in ast.walk(t):
                    if isinstance(x, ast.Name):
                        names.append(x.id)
            if len(n.targets) == 1 and isinstance(n.targets[0], ast.Name):
                name = n.targets[0].id
        elif isinstance(n, (ast.AnnAssign, ast.AugAssign)):
            kind = "assign"
            if isinstance(n.target, ast.Name):
                names.append(n.target.id)
        elif isinstance(n, (ast.Import, ast.ImportFrom)):
            kind = "import"
        elif isinstance(n, ast.Expr):
            kind = "expr"
        start = min([n.lineno] + [d.lineno for d in getattr(n, "decorator_list", [])])
        locked = sorted({callee(x) for x in ast.walk(n) if isinstance(x, ast.Call) and callee(x) in LOCKED_CALLS})
        nodes.append({"kind": kind, "name": name, "names": names, "start": start, "end": n.end_lineno, "locked": locked})
    return {"ok": True, "nodes": nodes}
print(json.dumps([info(s) for s in json.load(sys.stdin)]))`;

/** Runs the AST helper on a list of sources with the host interpreter (python -I, stdin only, nothing executed). Null when none runs. */
export function astNodes(sources, { spawn = spawnSync } = {}) {
  for (const exe of process.platform === 'win32' ? ['python', 'py'] : ['python3', 'python']) {
    const r = spawn(exe, ['-I', '-c', AST_PY], { input: JSON.stringify(sources), encoding: 'utf8', timeout: 20000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
    if (r.error || r.status !== 0) continue;
    try { const out = JSON.parse(String(r.stdout).trim()); if (Array.isArray(out) && out.length === sources.length) return out; } catch { /* next interpreter */ }
  }
  return null;
}

/**
 * Applies a parsed fix reply to `source`. Returns { source, touched, replacedChars }. Throws LoopError('bad_edit', msg, { reasons }) and
 * changes nothing when any rule is broken. `validate(code) -> string[]` is the build validator (validateBuildScript + syntax + QA structure).
 */
export function applyScopedEdits(source, reply, {
  locked = DEFAULT_LOCKED, limits = DEFAULT_EDIT_LIMITS, validate, astFn = astNodes,
} = {}) {
  const reasons = [];
  const refuse = () => { throw new LoopError('bad_edit', `the edit was refused: ${reasons[0]}`, { reasons: [...reasons] }); };
  const edits = reply.edits ?? [];
  if (!edits.length) { reasons.push('there are no edits'); refuse(); }
  const names = edits.map((e) => e.name);
  if (new Set(names).size !== names.length) reasons.push('the same name is edited twice; each name may be edited once');
  if (edits.length > limits.maxDefs) reasons.push(`more than ${limits.maxDefs} definitions touched in one round`);
  for (const edit of edits) {
    if (!reply.targets.includes(edit.name)) reasons.push(`${edit.name} is outside the listed targets`);
    if (locked.includes(edit.name)) reasons.push(`${edit.name} is locked`);
  }
  const parsed = astFn([source, ...edits.map((e) => e.source)]);
  if (!parsed) { reasons.push('no Python interpreter is available to check the edit'); refuse(); }
  const [main, ...pieces] = parsed;
  if (!main.ok) { reasons.push(`the current script does not parse (${main.error})`); refuse(); }
  const crlf = source.includes('\r\n');
  const lines = source.split('\n');
  const regions = [];
  edits.forEach((edit, i) => {
    const piece = pieces[i];
    if (!piece.ok) { reasons.push(`the source of ${edit.name} does not parse (${piece.error})`); return; }
    if (piece.nodes.length !== 1) { reasons.push(`the source of ${edit.name} must be exactly one ${edit.op === 'replace_assign' ? 'assignment' : 'definition'}`); return; }
    const [node] = piece.nodes;
    if (node.locked.length) { reasons.push(`the source of ${edit.name} calls ${node.locked.join(' / ')}, which only the build script body may do`); return; }
    const wantKind = edit.op === 'replace_assign' ? 'assign' : 'def';
    if (node.kind !== wantKind || node.name !== edit.name) { reasons.push(`the source of ${edit.name} must be a single ${wantKind === 'def' ? 'def or class' : 'assignment'} named ${edit.name}`); return; }
    const existing = main.nodes.filter((n) => (edit.op === 'replace_assign' ? n.names.includes(edit.name) : n.kind === 'def' && n.name === edit.name));
    if (edit.op === 'add_def') {
      if (main.nodes.some((n) => n.name === edit.name || n.names.includes(edit.name))) { reasons.push(`${edit.name} already exists; use replace_def`); return; }
      const anchors = main.nodes.filter((n) => n.name === edit.before || n.names.includes(edit.before));
      if (anchors.length !== 1) { reasons.push(`add_def ${edit.name}: "${edit.before}" is not a unique top-level name`); return; }
      regions.push({ edit, at: anchors[0].start, from: anchors[0].start, to: anchors[0].start - 1, original: '', order: i });
      return;
    }
    if (existing.length !== 1) { reasons.push(`${edit.name} is not a unique top-level ${edit.op === 'replace_assign' ? 'constant' : 'definition'}`); return; }
    const target = existing[0];
    if (edit.op === 'replace_assign' && (target.kind !== 'assign' || target.name !== edit.name)) { reasons.push(`${edit.name} is not a plain single-name assignment`); return; }
    if (target.locked.length) { reasons.push(`${edit.name} contains ${target.locked.join(' / ')}, which is locked`); return; }
    regions.push({ edit, at: target.start, from: target.start, to: target.end, original: lines.slice(target.start - 1, target.end).join('\n'), order: i });
  });
  if (reasons.length) refuse();

  const replacedChars = regions.reduce((sum, r) => sum + r.original.length, 0);
  const newChars = regions.reduce((sum, r) => sum + r.edit.source.length, 0);
  if (Math.max(replacedChars, newChars) / Math.max(1, source.length) > limits.maxFraction) {
    reasons.push(`the edit replaces more than ${Math.round(limits.maxFraction * 100)} percent of the script`);
    refuse();
  }
  // Splice from the bottom up so earlier line numbers stay valid; a replaced region is exactly the lines of its statement.
  const out = [...lines];
  for (const r of [...regions].sort((a, b) =>
    b.at - a.at
    // At a shared anchor, replace first so a later insertion cannot be consumed by it.
    || Number(a.edit.op === 'add_def') - Number(b.edit.op === 'add_def')
    // Apply inserts in reverse reply order; splicing at one index then preserves reply order.
    || b.order - a.order
  )) {
    const body = r.edit.source.replace(/\r\n/g, '\n').replace(/\n+$/, '').split('\n').map((l) => (crlf ? `${l}\r` : l));
    const insert = r.edit.op === 'add_def' ? [...body, crlf ? '\r' : '', crlf ? '\r' : ''] : body;
    out.splice(r.from - 1, r.to - r.from + 1, ...insert);
  }
  const next = out.join('\n');
  const after = astFn([next]);
  if (!after || !after[0].ok) { reasons.push(`the result does not parse (${after?.[0]?.error ?? 'no interpreter'})`); refuse(); }
  if (typeof validate === 'function') reasons.push(...validate(next));
  if (reasons.length) refuse();
  return { source: next, touched: names, replacedChars };
}
