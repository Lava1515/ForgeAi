"""codex · gpt-6.1-sol, 2026-11-16. Run ONLY through probe-x1-surface-render.mjs."""
import sys, json, hashlib, time
from pathlib import Path
sys.path.insert(0, '/kit')
import bpy
import numpy as np
from blender_worker.codebuilt import meshes, materials, stage, maps
from blender_worker.codebuilt.geometry import box_geometry

WORK = Path('/job/work')
manifest = json.loads((WORK/'kit-manifest.json').read_text())
for rel, sha in manifest['files'].items():
    assert hashlib.sha256((Path('/kit/blender_worker/codebuilt')/rel).read_bytes()).hexdigest() == sha, rel
report = dict(kit_head=manifest['head'], kit_files_verified=len(manifest['files']), renders={})
scene = stage.reset_scene()
report['blender'] = bpy.app.version_string
report['look_tests'] = {}
scene.view_settings.view_transform = 'AgX'
report['agx_enum'] = [e.identifier for e in scene.view_settings.bl_rna.properties['look'].enum_items]
for look in ('Punchy', 'AgX - Punchy'):
    try:
        scene.view_settings.look = look
        report['look_tests'][look] = 'accepted'
    except Exception as ex:
        report['look_tests'][look] = str(ex)
report['contact_shadow'] = hasattr(bpy.types.Light, 'use_contact_shadow')
report['gtao'] = hasattr(getattr(scene, 'eevee', None), 'use_gtao')

def setup():
    s = stage.reset_scene()
    s.render.engine = 'CYCLES'; s.cycles.device = 'CPU'; s.cycles.samples = 8
    s.cycles.use_denoising = True
    s.render.resolution_x = 540; s.render.resolution_y = 960; s.render.resolution_percentage = 100
    s.render.image_settings.file_format = 'PNG'
    s.view_settings.view_transform = 'Standard'; s.view_settings.look = 'None'
    s.view_settings.exposure = 0; s.view_settings.gamma = 1
    s.world = bpy.data.worlds.new('world'); s.world.use_nodes = True
    bg = s.world.node_tree.nodes.get('Background'); bg.inputs[0].default_value=(0.15,0.18,0.22,1); bg.inputs[1].default_value=0.5
    c = meshes.coll(s, 'proof')
    stage.area(c, 'key', (-5,-6,10), (0,0,0), 1200, 7)
    stage.area(c, 'fill', (5,3,8), (0,0,0), 700, 6)
    cam = stage.Camera(s)
    return s,c,cam

def render(name,s,sea=False):
    start=time.monotonic(); p=Path('/job/frames')/(name+'.png')
    s.render.filepath=str(p); bpy.ops.render.render(write_still=True)
    im=bpy.data.images.load(str(p),check_existing=False)
    arr=np.array(im.pixels[:]).reshape(960,540,4)[:,:,:3]
    item=dict(seconds=time.monotonic()-start,sha256=hashlib.sha256(p.read_bytes()).hexdigest(),mean_rgb=arr.mean(axis=(0,1)).tolist(),std_rgb=arr.std(axis=(0,1)).tolist())
    if sea:
        # With this top-down regional camera, lower-left patch is the Pacific.
        rgb=arr[220:320,40:100].mean(axis=(0,1)); item['sea_rgb']=rgb.tolist()
        assert rgb[2]>rgb[0] and rgb[2]>rgb[1], rgb
    report['renders'][name]=item
    (WORK/'x1_render.json').write_text(json.dumps(report,indent=2))
    return arr

s,c,cam=setup()
names=['wood','brushed_metal','painted_metal','concrete','rock','water','ice','glass','rubber','fabric','soil','grass','flat_control']
for i,name in enumerate(names):
    mat=materials.col((0.15,0.35,0.7)) if name=='flat_control' else getattr(materials,name)(name)
    v,f=box_geometry((0.55,0.55,0.42)); ob=meshes.mk(name,v,f,mat,c,smooth=False)
    ob.location=((i%3-1)*1.6, (i//3-2)*1.8,0.45)
    stage.round_edges(ob,width=0.08,segments=3)
    # Pointiness needs actual curved geometry rather than shader-only bevel.
    bpy.context.view_layer.objects.active=ob; ob.select_set(True)
    bpy.ops.object.modifier_apply(modifier='round_edges'); ob.select_set(False)
meshes.mk('floor',[(-5,-7,-0.1),(5,-7,-0.1),(5,7,-0.1),(-5,7,-0.1)],[(0,1,2,3)],materials.col((0.18,0.2,0.23)),c,False)
cam.set((0,-9,18),(0,0,0),45)
report['swatch_order']=names
render('swatches',s)

for relief in (True,False):
    s,c,cam=setup()
    wm=maps.WorldMap(c,detail='50m',origin=(1,2,0),projection='equirectangular',palette='relief',relief=relief,only=['BRA','ARG','CHL','PER','BOL','COL','VEN','ECU','URY','PRY','GUY','SUR'])
    wm.highlight('BRA',lift=0.05)
    if relief:
        errors=[]
        for ob in wm.objs.values():
            for loop in ob.data.loops:
                xyz=ob.data.vertices[loop.vertex_index].co+ob.location
                want=((xyz.x-1)/(2*np.pi*wm.scale)+0.5,(xyz.y-2)/(np.pi*wm.scale)+0.5)
                errors.append(max(abs(a-b) for a,b in zip(want,ob.data.uv_layers.active.data[loop.index].uv)))
        report['geographic_uv_max_error']=max(errors); assert max(errors)<1e-6
    cam.set((wm.xy(-62,-19)[0],wm.xy(-62,-19)[1],15),wm.point(-62,-19),50)
    arr=render('map_relief' if relief else 'map_flat',s,sea=True)
    if relief: before=arr
    else: report['map_difference_mean']=float(np.abs(before-arr).mean())
assert report['map_difference_mean']>0.005
s,c,cam=setup()
x0,y0=maps.project('equirectangular',-180,-90); x1,y1=maps.project('equirectangular',180,90)
ob=meshes.mk('real_raster',[(x0,y0,0),(x1,y0,0),(x1,y1,0),(x0,y1,0)],[(0,1,2,3)],materials.earth_relief(),c,False)
uv=ob.data.uv_layers.new(name='geographic')
for loop in ob.data.loops: uv.data[loop.index].uv=[(0,0),(1,0),(1,1),(0,1)][loop.vertex_index]
cam.set((0,0,15),(0,0,0),40)
render('real_raster',s)
report['raster_sha256']=hashlib.sha256(Path('/kit/blender_worker/codebuilt/mapdata/ne2_50m_sr_w_4096.jpg').read_bytes()).hexdigest()
report['engine']='CYCLES'; report['device']='CPU'; report['view_transform']=s.view_settings.view_transform
try:
    materials.earth_relief(image_path='/kit/missing-earth.jpg')
    raise AssertionError('missing raster did not raise')
except RuntimeError: report['missing_raster_raises']=True
(WORK/'x1_render.json').write_text(json.dumps(report,indent=2))
