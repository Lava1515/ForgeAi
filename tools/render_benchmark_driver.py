#!/usr/bin/env python3
"""Run the approved host-side EEVEE subset of the render benchmark.

This driver deliberately does not start containers or GPU work. It creates all
scripts, logs and PNGs under output/agent-jobs/<job-id>.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import statistics
import subprocess
import sys
import time
import struct
import urllib.request

ROOT = Path(__file__).resolve().parent.parent
JOBS = ROOT / "output" / "agent-jobs"
FRAMES = list(range(1, 13))
WIDTH, HEIGHT = 1080, 1920

SCENE_SCRIPT = r'''import bpy, sys, json, math
args=sys.argv[sys.argv.index('--')+1:] if '--' in sys.argv else []
def build(blend):
 bpy.ops.wm.read_factory_settings(use_empty=True)
 scene=bpy.context.scene
 scene.render.engine='BLENDER_EEVEE'
 scene.eevee.taa_render_samples=64
 scene.render.resolution_x=1080; scene.render.resolution_y=1920; scene.render.resolution_percentage=100
 scene.render.image_settings.file_format='PNG'; scene.render.image_settings.color_mode='RGB'; scene.render.image_settings.color_depth='8'
 scene.render.film_transparent=False
 scene.render.fps=30; scene.frame_start=1; scene.frame_end=12
 world=bpy.data.worlds.new('Benchmark world'); world.color=(0.025,0.035,0.08); scene.world=world
 mat=bpy.data.materials.new('Benchmark blue'); mat.use_nodes=True
 bsdf=mat.node_tree.nodes['Principled BSDF']; bsdf.inputs['Base Color'].default_value=(0.04,0.28,0.8,1); bsdf.inputs['Roughness'].default_value=0.35
 bpy.ops.mesh.primitive_uv_sphere_add(segments=48, ring_count=24, location=(0,0,0)); sphere=bpy.context.object; sphere.name='Benchmark sphere'; sphere.data.materials.append(mat)
 for p in sphere.data.polygons: p.use_smooth=True
 # asymmetric moving parts so every frame differs: orbiting cube + tilted rotating sphere
 mat2=bpy.data.materials.new('Benchmark orange'); mat2.use_nodes=True
 mat2.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value=(0.9,0.35,0.05,1)
 bpy.ops.mesh.primitive_cube_add(size=0.5, location=(1.0,0,0)); cube=bpy.context.object; cube.name='Benchmark cube'; cube.data.materials.append(mat2)
 for f in range(1,13):
  a=(f-1)/11*math.tau*0.5
  cube.location=(1.0*math.cos(a),0,0.7*math.sin(a)); cube.rotation_euler=(a,a*2,0); cube.keyframe_insert(data_path='location',frame=f); cube.keyframe_insert(data_path='rotation_euler',frame=f)
  sphere.rotation_euler=(0.4,0,a*2); sphere.keyframe_insert(data_path='rotation_euler',frame=f)
 bpy.ops.object.camera_add(location=(0,-5,0)); cam=bpy.context.object; cam.rotation_euler=(1.5708,0,0); scene.camera=cam; cam.data.type='ORTHO'; cam.data.ortho_scale=3.4
 bpy.ops.object.light_add(type='AREA', location=(-3,-3,4)); light=bpy.context.object; light.data.energy=900; light.data.shape='DISK'; light.data.size=5
 scene.view_settings.view_transform='Standard'; scene.view_settings.look='Medium High Contrast'; scene.view_settings.exposure=0; scene.view_settings.gamma=1
 bpy.ops.wm.save_as_mainfile(filepath=blend)
if args and args[0]=='build':
 build(args[1])
elif args and args[0]=='render':
 blend,out,frames=args[1],args[2],[int(x) for x in args[3].split(',')]
 bpy.ops.wm.open_mainfile(filepath=blend)
 for frame in frames:
  bpy.context.scene.frame_set(frame); bpy.context.scene.render.filepath=out+'/'+str(frame).zfill(4)+'.png'; bpy.ops.render.render(write_still=True)
  if frame == frames[0]:
   import gpu
   dev={'gpu_vendor':gpu.platform.vendor_get(),'gpu_renderer':gpu.platform.renderer_get(),'gpu_version':gpu.platform.version_get()}
   info={**dev,'eevee_samples':bpy.context.scene.eevee.taa_render_samples,'engine':bpy.context.scene.render.engine}
   open(out+'/device-'+str(frame)+'.json','w').write(json.dumps(info))
'''

DECODE_SCRIPT = r'''import bpy, sys
path=sys.argv[sys.argv.index('--')+1]
image=bpy.data.images.load(path, check_existing=False)
image.pixels[0]
if tuple(image.size) != (1080,1920): raise RuntimeError('wrong PNG dimensions: '+str(tuple(image.size)))
'''

def canonical_job(job_id):
    if not job_id or not job_id[0].isalnum() or any(c not in 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-' for c in job_id) or '..' in job_id:
        raise ValueError('invalid job id')
    JOBS.mkdir(parents=True, exist_ok=True)
    if JOBS.is_symlink() or JOBS.resolve() != JOBS.absolute(): raise ValueError('agent-jobs root is aliased')
    job=JOBS / job_id
    job.mkdir(exist_ok=False)
    if job.is_symlink() or job.resolve() != job.absolute(): raise ValueError('job folder is aliased')
    return job

LOCK = ROOT / '.superpowers' / 'supervisor' / 'gpu.lock'
DASHBOARD_JOBS = 'http://127.0.0.1:3000/api/codebuilt/jobs'
ACTIVE = {'queued','scripting','voicing','resume','planning','previewing','looking','building','rendering','assembling'}

def assert_gpu_free():
    try:
        with urllib.request.urlopen(DASHBOARD_JOBS, timeout=5) as r: jobs=json.load(r).get('jobs', [])
    except OSError as exc:
        raise ValueError(f'cannot confirm no video job is active (dashboard unreachable: {exc})')
    busy=[j['id'] for j in jobs if j.get('status') in ACTIVE or j.get('step') in ACTIVE]
    if busy: raise ValueError(f'video job active, refusing to use the GPU: {busy}')

def take_lease(job_id):
    # same lease directory the dashboard queue uses; atomic mkdir, refuse (never reclaim) when it exists
    LOCK.parent.mkdir(parents=True, exist_ok=True)
    try: os.mkdir(LOCK)
    except FileExistsError: raise ValueError(f'GPU lease is held: {LOCK}')
    (LOCK/'owner').write_text(f'benchmark {job_id} {datetime.now(timezone.utc).isoformat()} pid {os.getpid()}'+chr(10),encoding='utf-8')

def release_lease():
    try:
        (LOCK/'owner').unlink(missing_ok=True); LOCK.rmdir()
    except OSError: pass

def main():
    ap=argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--mode',choices=['eevee','cycles-gpu','cycles-gpu-split'],required=True)
    ap.add_argument('--blender',required=True,help='absolute path to installed Blender executable')
    ap.add_argument('--job-id',required=True)
    args=ap.parse_args()
    if args.mode != 'eevee': raise SystemExit('GPU modes are intentionally disabled: no benchmark-specific approved launch or security review exists.')
    blender=Path(args.blender).resolve(strict=True)
    assert_gpu_free()
    job=canonical_job(args.job_id)
    take_lease(args.job_id)
    try: run(args,blender,job)
    finally: release_lease()

def run(args,blender,job):
    script=job/'trusted_scene.py'; script.write_text(SCENE_SCRIPT,encoding='utf-8')
    decoder=job/'decode_png.py'; decoder.write_text(DECODE_SCRIPT,encoding='utf-8')
    blend=job/'frozen-scene.blend'
    subprocess.run([str(blender),'--background','--python',str(script),'--','build',str(blend)],check=True,cwd=ROOT)
    scene_hash=hashlib.sha256(blend.read_bytes()).hexdigest()
    manifest={'mode':args.mode,'blender':str(blender),'scene_sha256':scene_hash,'resolution':[WIDTH,HEIGHT], 'frames':FRAMES,'fps':30,'eevee_samples':64,'warmup':1,'repeats':3,'process_count':2,'hold':1}
    (job/'settings.json').write_text(json.dumps(manifest,indent=2)+'\n',encoding='utf-8')
    timings=[]
    partitions=[FRAMES[::2],FRAMES[1::2]]
    for name,frames in [('warmup',[1])]+[(f'repeat-{i}',FRAMES) for i in range(1,4)]:
        out=job/name; out.mkdir()
        parts=[[f for f in part if f in frames] for part in partitions]
        parts=[p for p in parts if p]
        start=time.perf_counter()
        procs=[subprocess.Popen([str(blender),'--background','--python',str(script),'--','render',str(blend),str(out),','.join(map(str,part))],cwd=ROOT,stdout=(out/f'process-{i}.log').open('wb'),stderr=subprocess.STDOUT) for i,part in enumerate(parts)]
        statuses=[p.wait() for p in procs]
        elapsed=time.perf_counter()-start
        if any(statuses): raise SystemExit(f'{name} Blender process failed: {statuses}')
        if name=='warmup': continue
        manifest[f'{name}_devices']=[json.loads(p.read_text()) for p in sorted(out.glob('device-*.json'))]
        expected=set(FRAMES); found={int(p.stem) for p in out.glob('*.png')}
        if expected != found: raise SystemExit(f'{name}: expected frames {sorted(expected)}, got {sorted(found)}')
        hashes=[]
        for frame in FRAMES:
            path=out/f'{frame:04d}.png'
            subprocess.run([str(blender),'--background','--python',str(decoder),'--',str(path)],check=True,cwd=ROOT,stdout=subprocess.DEVNULL)
            hashes.append(hashlib.sha256(path.read_bytes()).hexdigest())
        timings.append(elapsed)
        if len(set(hashes)) != len(hashes): raise SystemExit(f'{name}: identical frames found, scene does not vary')
        manifest[f'{name}_sha256']=hashes
        manifest[f'{name}_wall_seconds']=elapsed
        (job/'settings.json').write_text(json.dumps(manifest,indent=2)+'\n',encoding='utf-8')
    manifest['median_wall_seconds']=statistics.median(timings)
    (job/'settings.json').write_text(json.dumps(manifest,indent=2)+'\n',encoding='utf-8')
    print(job)

if __name__=='__main__':
    try: main()
    except (OSError,ValueError,subprocess.CalledProcessError) as exc: print(f'error: {exc}',file=sys.stderr); raise SystemExit(2)
