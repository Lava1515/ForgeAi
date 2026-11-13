import { spawn } from 'node:child_process';
import { extractJson } from '../routes/gemini.js';

export const CLAUDE_HAIKU_MODEL = 'claude-haiku-5-5';
export const CLAUDE_SONNET_MODEL = 'claude-sonnet-5-5';

export function resolveClaudeModel(subskill) {
  const norm = String(subskill || '').toLowerCase().trim();
  if (norm === 'tags' || norm === 'titles' || norm === 'metadata') {
    return CLAUDE_HAIKU_MODEL;
  }
  return CLAUDE_SONNET_MODEL;
}

export function runClaudeFallback(prompt, {
  subskill = 'default',
  model = null,
  spawnFn = spawn,
  timeoutMs = 60000,
} = {}) {
  const selectedModel = model || resolveClaudeModel(subskill);

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnFn('claude', ['-p', '--model', selectedModel], {
        env: process.env,
      });
    } catch (err) {
      return reject(Object.assign(
        new Error(`Claude fallback unavailable: ${err.message || 'CLI could not be launched'}`),
        { unavailable: true }
      ));
    }
    child.stdin?.end(prompt);

    let out = '';
    let err = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGTERM');
      } catch {}
    }, timeoutMs);

    child.stdout?.on('data', (d) => { out += d; });
    child.stderr?.on('data', (d) => { err += d; });

    child.on('error', (e) => {
      clearTimeout(timer);
      const isMissing = e.code === 'ENOENT' || /not found|ENOENT/i.test(e.message);
      const msg = isMissing
        ? 'Claude fallback unavailable: Claude CLI command not found on system'
        : `Claude fallback unavailable: ${e.message}`;
      reject(Object.assign(new Error(msg), { unavailable: true }));
    });

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (timedOut) {
        return reject(Object.assign(
          new Error('Claude fallback timed out'),
          { timedOut: true }
        ));
      }

      const combined = `${err}\n${out}`.trim();
      const notLoggedIn = /not logged in|login|unauthorized|authentication required|api key/i.test(combined);

      if (notLoggedIn || code === 127) {
        return reject(Object.assign(
          new Error(`Claude fallback unavailable: ${combined || 'not logged in or command not found'}`),
          { unavailable: true }
        ));
      }

      if (code !== 0) {
        const isUnavailable = /not found|unavailable|enoent/i.test(combined);
        const prefix = isUnavailable ? 'Claude fallback unavailable:' : 'Claude fallback failed:';
        return reject(Object.assign(
          new Error(`${prefix} exit code ${code} (${combined || signal || 'unknown error'})`),
          { unavailable: isUnavailable }
        ));
      }

      try {
        const parsed = extractJson(out);
        return resolve(parsed);
      } catch {
        return resolve(out.trim());
      }
    });
  });
}
