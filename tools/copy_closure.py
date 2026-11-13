"""Copy the import closure of entry files from the old ForgeAi tree into this project.
Usage: python tools/copy_closure.py <entry> [<entry> ...]   (paths relative to the repo root)
Files that already exist here are kept as they are (they may be slimmed rewrites) but are still scanned."""
import os, re, shutil, sys
OLD = 'C:/code/ForgeAi'
NEW = os.path.dirname(os.path.dirname(os.path.abspath(__file__))).replace(chr(92), '/')
EXTS = ('.js', '.mjs', '.jsx', '.ts', '.tsx', '.cjs', '.json', '.css')
IMP = re.compile(r'''(?:import\s+(?:[^'"()]*?\s+from\s+)?|export\s+[^'"]*?\s+from\s+|import\s*\(\s*|require\s*\(\s*)['"]([^'"]+)['"]''')

def resolve(src, spec):
    if not spec.startswith('.'):
        return None
    base = os.path.normpath(os.path.join(os.path.dirname(src), spec)).replace(chr(92), '/')
    for cand in [base] + [base + e for e in EXTS] + [base + '/index' + e for e in EXTS]:
        for root in (NEW, OLD):
            if os.path.isfile(f'{root}/{cand}'):
                return cand
    return 'MISSING:' + base

def main(entries):
    seen, stack, copied, missing = set(), list(entries), [], []
    while stack:
        rel = stack.pop()
        if rel in seen:
            continue
        seen.add(rel)
        new, old = f'{NEW}/{rel}', f'{OLD}/{rel}'
        if not os.path.isfile(new):
            if not os.path.isfile(old):
                missing.append(rel)
                continue
            os.makedirs(os.path.dirname(new), exist_ok=True)
            shutil.copy2(old, new)
            copied.append(rel)
        if not rel.endswith(('.js', '.mjs', '.jsx', '.ts', '.tsx', '.cjs')):
            continue
        text = open(new, encoding='utf-8', errors='ignore').read()
        for m in IMP.finditer(text):
            r = resolve(rel, m.group(1))
            if r is None:
                continue
            if r.startswith('MISSING:'):
                missing.append(f'{rel} -> {m.group(1)}')
            else:
                stack.append(r)
    lines = sum(open(f'{NEW}/{f}', encoding='utf-8', errors='ignore').read().count('\n') for f in seen if os.path.isfile(f'{NEW}/{f}') and not f.endswith('.json'))
    print(f'closure {len(seen)} files, {lines} lines; copied {len(copied)} new')
    for m in missing:
        print('MISSING', m)
    return seen

if __name__ == '__main__':
    main(sys.argv[1:])
