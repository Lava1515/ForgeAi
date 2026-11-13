// CB6: reparse-point scan for the job folder on Windows hosts.
// Why: a container on Docker Desktop (WSL2) can create a symlink inside the bind-mounted job folder. WSL writes it
// as an NTFS reparse point with its own tag (not the Windows symlink/junction tags). Node's lstat/Dirent report only
// Windows symlinks and junctions as links, so such an entry looks like a regular file to isSymbolicLink(), and a host
// consumer that opens it would follow it to a host file. This scan asks the file system for the reparse-point
// attribute itself, whatever the tag, and never descends into a reparse point (so a junction loop cannot trap it).
// Any failure is reported as an error, never as "no links": callers fail closed.
// Unproven against a link created by a real container until the supervised Docker proof (docs step 12b).
import { execFileSync } from 'node:child_process';

const PS_SCRIPT = [
  "$ErrorActionPreference='Stop'",
  '$root=$env:CB6_SCAN_ROOT; $max=[int]$env:CB6_SCAN_MAX; $n=0',
  '$stack=New-Object System.Collections.Generic.Stack[string]; $stack.Push($root)',
  'while($stack.Count -gt 0){ $d=$stack.Pop()',
  '  foreach($e in [System.IO.Directory]::EnumerateFileSystemEntries($d)){',
  '    $n++; if($n -gt $max){ [Console]::Out.WriteLine("#TRUNCATED"); exit 0 }',
  '    $a=[int][System.IO.File]::GetAttributes($e)',
  '    if(($a -band 0x400) -ne 0){ [Console]::Out.WriteLine("L " + $e) }',
  '    elseif(($a -band 0x10) -ne 0){ $stack.Push($e) } } }',
  '[Console]::Out.WriteLine("#DONE")',
].join('\n');

/**
 * Parses the scanner output. Only a final "#DONE" line means the walk finished; anything else is incomplete.
 * returns { points: string[], errors: string[], truncated: boolean, complete: boolean }
 */
export function parseReparseOutput(text) {
  const lines = String(text).split(/\r?\n/).map(l => l.trimEnd()).filter(Boolean);
  const points = lines.filter(l => l.startsWith('L ')).map(l => l.slice(2));
  const truncated = lines.includes('#TRUNCATED');
  const done = lines[lines.length - 1] === '#DONE';
  const errors = done || truncated ? [] : ['reparse scan did not finish'];
  return { points, errors, truncated, complete: done && !truncated };
}

/**
 * Lists every reparse point (any tag: Windows symlink, junction, WSL symlink, OneDrive placeholder, ...) below `dir`.
 * On a host that is not Windows the Node lstat check is sufficient and this returns an empty, complete result.
 * `run(script, env)` is injectable for tests; the default runs Windows PowerShell once, without a profile.
 */
export function scanReparsePoints(dir, { platform = process.platform, run, maxEntries = 200000, timeoutMs = 120000 } = {}) {
  if (platform !== 'win32') return { points: [], errors: [], truncated: false, complete: true };
  const env = { SystemRoot: process.env.SystemRoot, windir: process.env.windir, PATH: process.env.PATH, CB6_SCAN_ROOT: String(dir), CB6_SCAN_MAX: String(maxEntries) };
  try {
    const out = run
      ? run(PS_SCRIPT, env)
      : execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', PS_SCRIPT],
        { env, encoding: 'utf8', timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    return parseReparseOutput(out);
  } catch (e) {
    return { points: [], errors: [`reparse scan failed: ${String(e?.message ?? e).split('\n')[0].slice(0, 200)}`], truncated: false, complete: false };
  }
}
