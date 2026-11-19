// codex · gpt-6.1-sol · 2026-11-19 20:02 +02:00
// Static author feedback, never executes the build or imports Blender. Counts source calls, not rendered objects.
import { spawnSync } from 'node:child_process';

const CHECK = String.raw`
import ast, json, re, sys
tree = ast.parse(sys.stdin.read())
helpers = set('wood brushed_metal painted_metal concrete rock water ice glass rubber fabric soil grass noise_mat earth_relief map_land map_sea'.split())
parents = {child: node for node in ast.walk(tree) for child in ast.iter_child_nodes(node)}
def api(n):
    f = n.func if isinstance(n, ast.Call) else None
    return (f.value.id, f.attr) if isinstance(f, ast.Attribute) and isinstance(f.value, ast.Name) else ('', '')
def words(n):
    return ' '.join(x.id if isinstance(x, ast.Name) else x.value for x in ast.walk(n) if isinstance(x, ast.Name) or isinstance(x, ast.Constant) and isinstance(x.value, str))
def role(text):
    text = text.lower()
    if re.search(r'eye|marker|glow', text): return None
    if re.search(r'ground|floor|terrain|sand|asph|soil|grass', text): return 'ground'
    if re.search(r'subject|hero|fence|road', text): return 'subject'
    return None
counts = dict(pbr=0, surface=0, noise=0, hdri=0)
roles = {k: dict(pbr=0, surface=0) for k in ('subject', 'ground')}
plain = []
for n in ast.walk(tree):
    mod, fn = api(n)
    if mod == 'library' and fn == 'hdri': counts['hdri'] += 1
    if mod != 'materials' or fn not in helpers | {'pbr'}: continue
    kind = 'pbr' if fn == 'pbr' else 'surface'
    counts['noise' if fn == 'noise_mat' else kind] += 1
    label = words(n.args[0]) if n.args else ''
    owner = parents.get(n)
    if isinstance(owner, (ast.Assign, ast.AnnAssign)):
        targets = owner.targets if isinstance(owner, ast.Assign) else [owner.target]
        label += ' ' + ' '.join(words(t) for t in targets)
    r = role(label)
    if r: roles[r][kind] += 1
    if kind == 'pbr': plain.append(dict(line=n.lineno, role=r or 'other', name=label[:100]))
print(json.dumps(dict(counts=counts, roles=roles, plain=sorted(plain, key=lambda x:x['line']))))
`;

export function checkSurfaces(code, { spawn = spawnSync } = {}) {
  for (const exe of process.platform === 'win32' ? ['python', 'py'] : ['python3', 'python']) {
    const r = spawn(exe, ['-I', '-c', CHECK], { input: code, encoding: 'utf8', timeout: 15000, windowsHide: true });
    if (r.error || r.status !== 0) continue;
    try {
      const report = JSON.parse(r.stdout);
      const findings = [];
      for (const role of ['subject', 'ground']) {
        const c = report.roles[role];
        if (c.pbr) findings.push(`${role}: ${c.pbr} plain materials.pbr calls; replace the main visible surfaces with surface helpers.`);
        if (!c.surface) findings.push(`${role}: no named surface helper found; bind and apply ${role}_material to the actual ${role}.`);
      }
      if (!report.counts.hdri) findings.push('No library.hdri call: light the scene with a listed library sky or room image.');
      return { ...report, findings };
    } catch { /* try the next host interpreter */ }
  }
  return { counts: null, roles: null, plain: [], findings: ['Surface check unavailable; verify subject_material, ground_material and library.hdri against the contract.'] };
}

export function surfaceAdvice(report) {
  return `\nSURFACE CHECK (one report round; static source counts, inspect the actual assignments):\n${JSON.stringify(report.counts)}\n${JSON.stringify(report.roles)}\nPlain call locations: ${JSON.stringify(report.plain)}\n${report.findings.join('\n')}\n${report.findings.length ? 'Return fix this round and repair the subject, ground and library lighting. Small eyes, markers and glows may stay plain. There is no additional surface-only loop.' : 'Named surfaces and library lighting found; check them in the pictures.'}`;
}
