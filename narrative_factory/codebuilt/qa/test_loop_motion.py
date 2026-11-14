"""Motion and local seam regressions. codex · gpt-6.1-sol · 2026-11-14."""
import math
from pathlib import Path
import tempfile
import pytest
import numpy as np
from PIL import Image
from blender_worker.codebuilt.renderloop import check_loop_state
from narrative_factory.codebuilt.post.loop import check_motion
from narrative_factory.codebuilt.qa.loop_seam import check_seam


def test_preflight_rejects_static_and_nonperiodic_without_render():
    state = {}
    def pose(f):
        state['x'] = math.cos(f * math.tau / 180)
    assert check_loop_state(pose, 180, lambda: state.copy())['passed']
    with pytest.raises(ValueError, match='no motion'):
        check_loop_state(lambda f: state.update(x=1), 180, lambda: state.copy())
    with pytest.raises(ValueError, match='does not equal'):
        check_loop_state(lambda f: state.update(x=f), 180, lambda: state.copy())


def test_pixel_motion_rejects_static_tiny_motion_and_long_freeze():
    scratch = Path('output/temp/loop-d2').resolve(); scratch.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=scratch) as folder:
        files = []
        for i in range(60):
            file = Path(folder) / f'{i}.png'
            Image.fromarray(np.full((32, 32, 3), i % 30, dtype=np.uint8)).save(file)
            files.append(file)
        # Half must differ as well as adjacent frames.
        assert not check_motion(files)['passed']
        assert not check_motion([files[0]] * 60)['passed']
        assert not check_motion([files[0]] * 20 + files[1:41])['passed']
        assert check_motion(files[:30])['passed']


def test_small_subject_erasure_fails_tile_even_below_global_threshold():
    scratch = Path('output/temp/loop-d2').resolve(); scratch.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=scratch) as folder:
        a, b = Path(folder) / 'a.png', Path(folder) / 'b.png'
        pixels = np.zeros((1024, 1024, 3), dtype=np.uint8)
        Image.fromarray(pixels).save(a)
        pixels[100:140, 100:140] = 200
        Image.fromarray(pixels).save(b)
        result = check_seam(a, b)
        assert result['mae_rgb_255'] < 1
        assert result['p99_max_channel_255'] == 0
        assert result['tile_max_rgb_255'] > 2
        assert not result['passed']


def test_preflight_reads_blender_sequence_protocol_world_matrix(monkeypatch):
    # mathutils.Vector exposes the sequence protocol without __iter__.
    import sys
    from types import SimpleNamespace as NS
    class Row:
        def __init__(self, values): self.values = values
        def __getitem__(self, index): return self.values[index]
    obj = NS(name='subject', type='MESH', hide_render=False)
    obj.evaluated_get = lambda graph: obj
    scene = NS(objects=[obj], camera=None)
    bpy = NS(context=NS(scene=scene, view_layer=NS(update=lambda: None), evaluated_depsgraph_get=lambda: None),
             data=NS(materials=[], lights=[], worlds=[]))
    monkeypatch.setitem(sys.modules, 'bpy', bpy)
    def pose(f):
        obj.matrix_world = [Row([1, 0, 0, math.cos(f * math.tau / 180)]), Row([0, 1, 0, 0]), Row([0, 0, 1, 0]), Row([0, 0, 0, 1])]
    assert check_loop_state(pose, 180)['passed']
