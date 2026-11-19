// codex · gpt-6.1-sol · 2026-11-19 14:31 +02:00 — advisory only, after the final sheet exists.
import path from 'node:path';
import { REPO_ROOT } from '../engines/codebuilt/launch.js';

export function checkFinalExposure({ jobDir, execFileFn, repoRoot = REPO_ROOT, signal }) {
  const script = path.join(repoRoot, 'narrative_factory/codebuilt/post/exposure.py');
  const env = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'TEMP', 'TMP', 'LANG']) {
    if (typeof process.env[key] === 'string') env[key] = process.env[key];
  }
  return new Promise(resolve => {
    const unavailable = () => resolve({ findings: [], unavailable: true });
    try {
      const child = execFileFn('python', ['-I', script, path.join(jobDir, 'out/contact_sheet.png')],
        { timeout: 20000, windowsHide: true, shell: false, env, maxBuffer: 64 * 1024, signal }, (error, stdout) => {
          if (error) return unavailable();
          try {
            const result = JSON.parse(String(stdout));
            if (!Array.isArray(result.findings)) return unavailable();
            resolve(result);
          } catch { unavailable(); }
        });
      child?.on?.('error', unavailable);
    } catch { unavailable(); }
  });
}

export function exposureAdvice(sheets = [], previous = []) {
  const lines = [...previous];
  for (const sheet of sheets) for (const tile of sheet.tiles ?? []) {
    for (const issue of tile.exposure?.issues ?? []) {
      if (issue === 'pale') lines.push(`frame ${tile.frame} is washed out; lower exposure or use a darker sky`);
      if (issue === 'black_region') lines.push(`frame ${tile.frame} has a large black region; check the surface and add fill light`);
    }
  }
  return lines.length ? `\nEXPOSURE ADVICE (advisory only; inspect the pictures, this does not require a fix verdict):\n${lines.slice(0, 48).join('\n')}` : '';
}
