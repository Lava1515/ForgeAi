#!/usr/bin/env python3
"""Run the approved host-side EEVEE subset of the render benchmark.

This driver deliberately does not start containers or GPU work. It creates all
scripts, logs and PNGs under output/agent-jobs/<job-id>.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import statistics
import subprocess
import sys
import time
import struct

ROOT = Path(__file__).resolve().parent.parent
JOBS = ROOT / "output" / "agent-jobs"
FRAMES = list(range(1, 13))
WIDTH, HEIGHT = 1080, 1920

SCENE_SCRIPT = r'''import bpy, sys
from mathutils import Vector
scene=bpy.context.scene
scene.render.engine='BLENDER_EEVEE_NEXT'
scene.render.resolution_x=1080; scene.render.resolution_y=1920; scene.render.resolution_percentage=100
scene.render.image_settings.file_format='PNG'; scene.render.image_settings.color_mode='RGBA'; scene.render.image_settings.color_depth='8'
scene.render.film_transparent=False
scene.render.fps=30; scene.frame_start=1; scene.frame_end=12
scene.world.color=(0.025,0.035,0.08)
mat=bpy.data.materials.new('Benchmark blue'); mat.diffuse_color=(0.04,0.28,0.8,1)
bpy.ops.mesh.primitive_uv_sphere_add(segments=48, ring_count=24, location=(0,0,0)); sphere=bpy.context.object; sphere.name='Benchmark sphere'; sphere.data.materials.append(mat)
for p in sphere.data.polygons: p.use_smooth=True
sphere.rotation_euler[2]=0
sphere.keyframe_insert(data_path='rotation_euler', index=2, frame=1)
sphere.rotation_euler[2]=1.2
sphere.keyframe_insert(data_path='rotation_euler', index=2, frame=12)
scene.render.image_settings.color_mode='RGB'
bpy.ops.object.camera_add(location=(0,-5,0)); cam=bpy.context.object; cam.rotation_euler=(1.5708,0,0); scene.camera=cam; cam.data.type='ORTHO'; cam.data.ortho_scale=3.4
bpy.ops.object.light_add(type='AREA', location=(-3,-3,4)); light=bpy.context.object; light.data.energy=900; light.data.shape='DISK'; light.data.size=5
scene.view_settings.view_transform='Standard'; scene.view_settings.look='Medium High Contrast'; scene.view_settings.exposure=0; scene.view_settings.gamma=1
args=sys.argv[sys.argv.index('--')+1:] if '--' in sys.argv else []
if args and args[0]=='build':
 bpy.ops.wm.save_as_mainfile(filepath=args[1])
elif args and args[0]=='render':
 blend,out,frames=args[1],args[2],[int(x) for x in args[3].split(',')]
 bpy.ops.wm.open_mainfile(filepath=blend)
 for frame in frames:
  bpy.context.scene.frame_set(frame); bpy.context.scene.render.filepath=out+'/'+str(frame).zfill(4)+'.png'; bpy.ops.render.render(write_still=True)
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

def main():
    ap=argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--mode',choices=['eevee','cycles-gpu','cycles-gpu-split'],required=True)
    ap.add_argument('--blender',required=True,help='absolute path to installed Blender executable')
    ap.add_argument('--job-id',required=True)
    args=ap.parse_args()
    if args.mode != 'eevee': raise SystemExit('GPU modes are intentionally disabled: no benchmark-specific approved launch or security review exists.')
    blender=Path(args.blender).resolve(strict=True)
    job=canonical_job(args.job_id)
    script=job/'trusted_scene.py'; script.write_text(SCENE_SCRIPT,encoding='utf-8')
    decoder=job/'decode_png.py'; decoder.write_text(DECODE_SCRIPT,encoding='utf-8')
    blend=job/'frozen-scene.blend'
    subprocess.run([str(blender),'--background','--python',str(script),'--','build',str(blend)],check=True,cwd=ROOT)
    scene_hash=hashlib.sha256(blend.read_bytes()).hexdigest()
    manifest={'mode':args.mode,'blender':str(blender),'scene_sha256':scene_hash,'resolution':[WIDTH,HEIGHT], 'frames':FRAMES,'fps':30,'samples':'EEVEE (not applicable)','warmup':1,'repeats':3,'process_count':2,'hold':1}
    (job/'settings.json').write_text(json.dumps(manifest,indent=2)+'\n',encoding='utf-8')
    timings=[]
    partitions=[FRAMES[::2],FRAMES[1::2]]
    for name,frames in [('warmup',[1])]+[(f'repeat-{i}',FRAMES) for i in range(1,4)]:
        out=job/name; out.mkdir()
        start=time.perf_counter()
        procs=[subprocess.Popen([str(blender),'--background','--python',str(script),'--','render',str(blend),str(out),','.join(map(str,part))],cwd=ROOT,stdout=(out/f'process-{i}.log').open('wb'),stderr=subprocess.STDOUT) for i,part in enumerate(partitions)]
        statuses=[p.wait() for p in procs]
        elapsed=time.perf_counter()-start
        if any(statuses): raise SystemExit(f'{name} Blender process failed: {statuses}')
        if name=='warmup': continue
        expected=set(FRAMES); found={int(p.stem) for p in out.glob('*.png')}
        if expected != found: raise SystemExit(f'{name}: expected frames {sorted(expected)}, got {sorted(found)}')
        hashes=[]
        for frame in FRAMES:
            path=out/f'{frame:04d}.png'
            subprocess.run([str(blender),'--background','--python',str(decoder),'--',str(path)],check=True,cwd=ROOT,stdout=subprocess.DEVNULL)
            hashes.append(hashlib.sha256(path.read_bytes()).hexdigest())
        timings.append(elapsed)
        manifest[f'{name}_sha256']=hashes
        manifest[f'{name}_wall_seconds']=elapsed
        (job/'settings.json').write_text(json.dumps(manifest,indent=2)+'\n',encoding='utf-8')
    manifest['median_wall_seconds']=statistics.median(timings)
    (job/'settings.json').write_text(json.dumps(manifest,indent=2)+'\n',encoding='utf-8')
    print(job)

if __name__=='__main__':
    try: main()
    except (OSError,ValueError,subprocess.CalledProcessError) as exc: print(f'error: {exc}',file=sys.stderr); raise SystemExit(2)
