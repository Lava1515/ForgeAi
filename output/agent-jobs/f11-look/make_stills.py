"""F11 proof; deliberately NOT run by the build worker.
Author: codex / gpt-6.1-sol, 2026-11-19 20:04 +02:00.
Uses composePreviewRunner -> CB6 -> approved CPU executor -> renderloop preview.
"""
import argparse
import base64
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import zlib

MODULES = ('materials', 'maps', 'sets.globe', 'sets.world_map')


def git(repo, *args):
    return subprocess.check_output(['git', '-C', str(repo), *args])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--zero-jobs-confirmed', action='store_true', required=True,
                        help='Supervisor confirms no live jobs before running this CPU proof')
    parser.add_argument('--before-ref', default='main')
    parser.add_argument('--after-ref', default='t3/f11-earth-map-look')
    parser.add_argument('--source-job', type=Path, default=Path('C:/code/ForgeAi/output/agent-jobs/mwns1inh-0cdbd0'))
    parser.add_argument('--reference', type=Path, default=Path('C:/code/ForgeAi/output/agent-jobs/tools-demo-1119/sonnet/final_sheet.jpg'))
    args = parser.parse_args()
    repo = Path(__file__).resolve().parents[3]
    jobroot = Path('C:/code/ForgeAi/output/agent-jobs')
    proof = jobroot / 'f11-look'
    proof.mkdir(exist_ok=True)
    source = (args.source_job / 'build/build.py').read_bytes()
    frozen = proof / 'saved-build.py'
    if frozen.exists() and frozen.read_bytes() != source:
        raise RuntimeError('Saved Dingo build differs from this proof; use a fresh proof folder')
    frozen.write_bytes(source)
    inputs_dir = proof / 'saved-inputs'
    inputs_dir.mkdir(exist_ok=True)
    for name in ('script.txt', 'vo.wav', 'words.json', 'pathpack.json', 'brief.md'):
        target = inputs_dir / name
        data = (args.source_job / 'inputs' / name).read_bytes()
        if target.exists() and target.read_bytes() != data:
            raise RuntimeError(f'Saved input changed: {name}')
        target.write_bytes(data)
    shutil.copyfile(args.reference, proof / 'sonnet-final_sheet.jpg')
    manifest = {'author': 'codex / gpt-6.1-sol', 'savedBuildSha256': hashlib.sha256(source).hexdigest(),
                'frames': [62, 192, 832, 966], 'size': [540, 960], 'versions': {}}
    for label, ref in (('before', args.before_ref), ('after', args.after_ref)):
        sha = git(repo, 'rev-parse', ref).decode().strip()
        # Execute only the four look modules from each pinned revision inside the
        # ordinary generated build, keeping the approved kit mount and fence intact.
        # __file__ stays the mounted kit path, so both read the same registered raster.
        prelude = 'import importlib, base64, zlib\n'
        for module in MODULES:
            file = 'blender_worker/codebuilt/' + module.replace('.', '/') + '.py'
            body = git(repo, 'show', f'{sha}:{file}')
            encoded = base64.b64encode(zlib.compress(body)).decode()
            prelude += (f'_m = importlib.import_module("blender_worker.codebuilt.{module}")\n'
                        f'exec(compile(zlib.decompress(base64.b64decode("{encoded}")), _m.__file__, "exec"), _m.__dict__)\n')
        build = (prelude + source.decode('utf-8')).encode()
        compile(build, f'{label}.py', 'exec')
        if len(build) > 512 * 1024:
            raise RuntimeError('Build exceeds the existing runner limit')
        (proof / f'{label}-build.py').write_bytes(build)
        manifest['versions'][label] = {'commit': sha, 'buildSha256': hashlib.sha256(build).hexdigest()}
    (proof / 'manifest.json').write_text(json.dumps(manifest, indent=2))
    # Import trusted host helpers by file URL. No server, shell command string,
    # alternate image, custom mount, injected effects or approval bypass.
    preview = (repo / 'dashboard/server/episode/engines/codebuilt/composePreview.js').as_uri()
    sheet = (repo / 'dashboard/server/episode/codebuilt/previewSheet.js').as_uri()
    driver = r'''
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { composePreviewRunner } from PREVIEW;
import { createPreviewSheetMaker } from SHEET;
const proof = PROOF;
const input = path.join(proof, 'saved-inputs');
const inputs = {script: fs.readFileSync(path.join(input,'script.txt'),'utf8'),
 voWav:path.join(input,'vo.wav'), words:path.join(input,'words.json'),
 pathPack:path.join(input,'pathpack.json'), brief:fs.readFileSync(path.join(input,'brief.md'),'utf8')};
const {runPreview} = composePreviewRunner({launchId:'cb6-generated-blender-v1', inputs,
 inputRoots:[input], timeoutMs:30*60*1000});
const maker = createPreviewSheetMaker({repoRoot:REPO, execFileFn:execFile});
for (const label of ['before','after']) {
 const result = await runPreview({jobId:`f11-look-${label}-pv1`,
  buildScript:fs.readFileSync(path.join(proof,`${label}-build.py`),'utf8'),
  spec:{frames:[62,192,832,966],scale:50}});
 const sheets = await maker.makeSheets({framesDir:result.dir, outDir:path.join(proof,`${label}-sheets`),
  code:label==='before'?'F11BE':'F11AF'});
 fs.writeFileSync(path.join(proof,`${label}-result.json`),JSON.stringify({result,sheets},null,2));
}
'''
    driver = driver.replace('PREVIEW', json.dumps(preview)).replace('SHEET', json.dumps(sheet))
    driver = driver.replace('PROOF', json.dumps(str(proof))).replace('REPO', json.dumps(str(repo)))
    driver_path = proof / 'run-preview.mjs'
    driver_path.write_text(driver, encoding='utf-8')
    subprocess.run(['node', str(driver_path)], cwd=repo, check=True)
    # A standalone contact sheet beside the supplied Sonnet reference. Original
    # full-size 540x960 PNGs remain in each fenced job's preview directory.
    from PIL import Image, ImageDraw
    canvas = Image.new('RGB', (2160, 2560), '#070c17')
    draw = ImageDraw.Draw(canvas)
    for row, label in enumerate(('before', 'after')):
        draw.text((12, row * 1000 + 8), label + ' | globe f62/f192 | flat map f832/f966', fill='white')
        for col, frame in enumerate(manifest['frames']):
            file = jobroot / f'f11-look-{label}-pv1' / 'preview' / f'{frame:04d}.png'
            with Image.open(file) as im:
                if im.size != (540, 960):
                    raise RuntimeError(f'Unexpected size {im.size}: {file}')
                canvas.paste(im.convert('RGB'), (col * 540, row * 1000 + 32))
    with Image.open(args.reference) as im:
        im.thumbnail((2160, 520))
        canvas.paste(im.convert('RGB'), (0, 2040))
    canvas.save(proof / 'comparison.jpg', quality=94)
    print(proof / 'comparison.jpg')


if __name__ == '__main__':
    main()
