"""Monetization licence gate (owner rule, 2026-11-13).

Finds every outside thing the project uses (AI models, Python and npm packages, container base images, asset folders)
and fails when one is missing from licenses/register.json or is marked "allowed": false there. It also fails when a
pattern of a not-allowed entry (for example Fish Speech) appears in the code.

Usage:  python tools/license_check.py          exit 0 = everything is registered and allowed
Runs before every commit (tools/hooks/pre-commit) and can be run by hand at any time.
"""
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CODE_DIRS = ('dashboard/server', 'dashboard/client/src', 'narrative_factory', 'blender_worker', 'tools', 'scripts', 'paths')
SKIP_DIRS = {'node_modules', '__pycache__', 'dist', '.git', 'hooks'}
CODE_EXT = ('.py', '.js', '.mjs', '.jsx', '.json', '.yml', '.yaml', '.ps1', '.sh')
SELF = {'tools/license_check.py'}
# Our own image names (built here from registered bases) and hashes are not outside things.
OWN_IMAGES = re.compile(r'^(forgeai-|cb6-|sha256:|scratch$)')
HF_ID = re.compile(r'''["']([A-Za-z0-9][\w.-]*/[A-Za-z0-9][\w.-]*)["']''')
HF_ORGS = ('Qwen', 'fishaudio', 'openai', 'ResembleAI', 'hexgrad', 'coqui', 'SWivid', 'microsoft', 'facebook', 'google',
           'stabilityai', 'black-forest-labs', 'Wan-AI', 'ACE-Step', 'tencent', 'bosonai', 'IndexTeam', 'myshell-ai',
           'suno', 'nari-labs', 'sesame', 'canopylabs', 'HiDream-ai', 'Lightricks', 'genmo', 'THUDM', 'ByteDance')


def code_files():
    for base in CODE_DIRS:
        for d, dirs, files in os.walk(os.path.join(ROOT, base)):
            dirs[:] = [x for x in dirs if x not in SKIP_DIRS]
            for f in files:
                if f.endswith(CODE_EXT) or f == 'Dockerfile' or f == 'requirements.txt':
                    full = os.path.join(d, f)
                    yield os.path.relpath(full, ROOT).replace(os.sep, '/'), full
    for f in ('docker-compose.yml',):
        full = os.path.join(ROOT, f)
        if os.path.isfile(full):
            yield f, full


def found_things():
    """Returns {register id: first place it was seen}."""
    seen = {}
    def add(key, where):
        seen.setdefault(key, where)
    for rel, full in code_files():
        if rel in SELF:
            continue
        try:
            text = open(full, encoding='utf-8', errors='ignore').read()
        except OSError:
            continue
        name = os.path.basename(rel)
        if name == 'requirements.txt':
            for line in text.splitlines():
                m = re.match(r'\s*([A-Za-z0-9][A-Za-z0-9._-]*)', line)
                if m and not line.lstrip().startswith('#'):
                    add('pip:' + m.group(1).lower(), rel)
        if name == 'Dockerfile':
            for m in re.finditer(r'^\s*FROM\s+(\S+)', text, re.M):
                image = m.group(1).split('@')[0].split(':')[0]
                if not OWN_IMAGES.match(m.group(1)) and image not in ('asm',):
                    add(image, rel)
            for m in re.finditer(r'COPY\s+--from=([^\s]+)', text):
                image = m.group(1).split(':')[0]
                if '/' in image:
                    add(image, rel)
            for m in re.finditer(r'pip install[^\n]*?\s((?:[a-z][a-z0-9_-]+\s*)+)(?:--|$|\n)', text):
                for pkg in m.group(1).split():
                    add('pip:' + pkg.lower(), rel)
            if re.search(r'blender-[\d.]+-linux', text):
                add('blender', rel)
            if re.search(r'\bffmpeg\b', text):
                add('ffmpeg', rel)
        if name == 'package.json' and 'node_modules' not in rel:
            try:
                for dep in (json.loads(text).get('dependencies') or {}):
                    add('npm:' + dep, rel)
            except ValueError:
                pass
        if rel.endswith('.py') or rel.endswith(('.js', '.mjs')):
            for m in HF_ID.finditer(text):
                if m.group(1).split('/')[0] in HF_ORGS:
                    add(m.group(1), rel)
    for base in ('data/music', 'data/sfx', 'data/voices'):
        folder = os.path.join(ROOT, base)
        if os.path.isdir(folder):
            for item in sorted(os.listdir(folder)):
                if os.path.isdir(os.path.join(folder, item)):
                    add(f'asset:{base}/{item}', f'{base}/{item}')
    return seen


def banned_hits(entries):
    hits = []
    banned = [(e['id'], p) for e in entries if not e.get('allowed') for p in e.get('patterns', [])]
    if not banned:
        return hits
    for rel, full in code_files():
        if rel in SELF or rel.startswith('licenses/'):
            continue
        try:
            text = open(full, encoding='utf-8', errors='ignore').read()
        except OSError:
            continue
        for entry_id, pattern in banned:
            if pattern in text:
                line = text[:text.index(pattern)].count('\n') + 1
                hits.append(f'{rel}:{line} uses "{pattern}" ({entry_id} is not allowed)')
    return hits


def main():
    register = json.load(open(os.path.join(ROOT, 'licenses', 'register.json'), encoding='utf-8'))
    entries = register['entries']
    by_id = {e['id'].lower(): e for e in entries}
    problems = []
    for key, where in sorted(found_things().items()):
        entry = by_id.get(key.lower())
        if entry is None:
            problems.append(f'NOT REGISTERED  {key}  (seen in {where}): check its licence, then add it to licenses/register.json')
        elif not entry.get('allowed'):
            problems.append(f'NOT ALLOWED     {key}  (seen in {where}): {entry.get("licence")}')
    problems += ['NOT ALLOWED     ' + h for h in banned_hits(entries)]
    for e in entries:
        for field in ('licence', 'source', 'checked'):
            if not e.get(field):
                problems.append(f'INCOMPLETE      {e["id"]}: the register entry has no "{field}"')
    if problems:
        print(f'Licence check FAILED: {len(problems)} problem(s)')
        for p in problems:
            print('  ' + p)
        return 1
    reverify = [e['id'] for e in entries if e.get('reverify')]
    print(f'Licence check passed: {len(entries)} entries, everything in use is registered and allowed.')
    if reverify:
        print(f'  Still to re-read at the source ({len(reverify)}): ' + ', '.join(reverify))
    return 0


if __name__ == '__main__':
    sys.exit(main())
