// C4: shared authored preview helpers; historical artifact names remain readable.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { LOOK_FIX_ROUNDS } from './visualLoopPrompts.js';
export const MAX_LOOKS = LOOK_FIX_ROUNDS + 1;
export const MAX_CRASH_FIXES = 4;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const newSheetCode = () => Array.from({ length: 5 }, () => CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]).join('');

export const KIT_REPORT_FILE = 'qa_report.json';
const KIT_REPORT_MAX_BYTES = 64 * 1024;
/**
 * The kit's check report of a finished preview: <preview job>/work/qa_report.json, beside the preview/ folder the frames are in.
 * A regular file of at most 64 KB, or null (an older kit, or a build that never reached run_qa, leaves none).
 */
export function readKitReport(previewDir) {
  try {
    const file = path.join(path.dirname(previewDir), 'work', KIT_REPORT_FILE);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size === 0 || stat.size > KIT_REPORT_MAX_BYTES) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { return null; }
}
