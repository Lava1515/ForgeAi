"""F5 map look: pure-Python parts (colours, reveal easing, label placement geometry). Appearance is checked by renders.
Author: claude-pro · claude-opus-5-5, 2026-11-16.
"""
import itertools
import sys
import importlib.util

import numpy as np
import pytest
from types import SimpleNamespace as NS

from blender_worker.codebuilt import maps


def test_highlight_colours_stay_apart_and_off_the_land():
    land = [(0.30, 0.42, 0.22), (0.55, 0.50, 0.35), (0.62, 0.62, 0.60)]   # graded greens, tans, rock
    sea = (0.010, 0.032, 0.070)
    for a, b in itertools.combinations(maps.HIGHLIGHTS, 2):
        assert np.linalg.norm(np.subtract(a, b)) > 0.35, (a, b)
    for c in maps.HIGHLIGHTS:
        assert max(c) - min(c) > 0.7, c                    # saturated
        for g in land + [sea]:
            assert np.linalg.norm(np.subtract(c, g)) > 0.5, (c, g)


def test_outline_is_lighter_than_its_fill():
    for c in maps.HIGHLIGHTS:
        o = maps._lighter(c)
        assert all(ov >= cv for ov, cv in zip(o, c)) and sum(o) > sum(c)


def test_reveal_easing_ends_exactly():
    assert maps._smooth(-1) == 0.0 and maps._smooth(0) == 0.0 and maps._smooth(1) == 1.0 and maps._smooth(2) == 1.0
    assert maps._pop(0) == 0.0 and maps._pop(1) == 1.0
    assert max(maps._pop(t / 100) for t in range(101)) > 1.0       # small overshoot while popping in


def test_point_in_ring_with_concave_ring():
    ring = np.array([(0, 0), (4, 0), (4, 4), (2, 1), (0, 4)], float)   # a "V" notch from the top
    px = np.array([1.0, 2.0, 2.0, 5.0, 3.9])
    py = np.array([1.0, 0.5, 3.0, 1.0, 3.5])   # last: right arm of the V (edge at x 3.67 there)
    assert maps._in_ring(px, py, ring).tolist() == [True, True, False, False, True]


def test_rect_overlap():
    assert maps._rect_overlap((0, 0, 2, 2), (1, 1, 3, 3)) == 1.0
    assert maps._rect_overlap((0, 0, 1, 1), (2, 2, 3, 3)) == 0.0


# State regressions reported in F5 round 1. codex · gpt-6-astra, 2026-11-16.
# Only Blender storage/constructors are stand-ins; styling and geometry updates are real.
class _Nodes(dict):
    def __iter__(self):
        return iter(self.values())


class _Vertices:
    def __init__(self, co):
        self.co = np.array(co, dtype=float)

    def __len__(self):
        return len(self.co)

    def foreach_get(self, name, out):
        out[:] = self.co.ravel()

    def foreach_set(self, name, values):
        self.co[:] = np.array(values).reshape(-1, 3)


class _Object(dict):
    def __init__(self, co, mats=()):
        super().__init__(origin=(0, 0, 0), glow_n=len(co))
        self.data = NS(vertices=_Vertices(co), materials=list(mats), update=lambda: None)
        self.material_slots = [NS(material=m) for m in mats]
        self.location = NS(z=0)
        self.children = []
        self.children_recursive = []
        self.hide_render = self.hide_viewport = False
        self.scale = (1, 1, 1)


def _material(color, mix=None):
    inputs = {k: NS(default_value=v) for k, v in {
        'Base Color': (*color, 1), 'Emission Color': (*color, 1), 'Emission Strength': .2}.items()}
    nodes = _Nodes(bsdf=NS(type='BSDF_PRINCIPLED', inputs=inputs))
    if mix is not None:
        nodes['hl_mix'] = NS(type='VALUE', outputs=[NS(default_value=mix)])
        nodes['country_tint'] = NS(type='RGB', outputs=[NS(default_value=(*color, 1))])
    return NS(node_tree=NS(nodes=nodes))


def _map_state(monkeypatch, mix=1.0, palette='muted'):
    from blender_worker import codebuilt
    from pathlib import Path
    monkeypatch.setitem(sys.modules, 'bpy', NS())
    monkeypatch.setitem(sys.modules, 'bmesh', NS())
    # Load isolated real helpers; restore package/module state after each test.
    for name in ('materials', 'meshes'):
        full_name = 'blender_worker.codebuilt.' + name
        spec = importlib.util.spec_from_file_location(full_name, Path(maps.__file__).with_name(name + '.py'))
        module = importlib.util.module_from_spec(spec)
        monkeypatch.setitem(sys.modules, full_name, module)
        monkeypatch.setattr(codebuilt, name, module, raising=False)
        spec.loader.exec_module(module)
    from blender_worker.codebuilt import materials
    wm = maps.WorldMap.__new__(maps.WorldMap)
    cty = NS(iso='BRA', name='Brazil', continent='South America')
    wm.data = NS(find=lambda key: cty)
    wm.border, wm.eps, wm.origin, wm.land_glow = .02, .005, (0, 0, 0), .2
    wm.scale = 4.0
    wm.border_color, wm._border_set = (.1, .1, .1), False
    wm._hl, wm._labels = {}, []
    ring = np.array([(0, 0), (4, 0), (4, 4), (0, 4)], float)
    col = maps.country_color(cty, palette)
    top, side = _material(col, mix), _material(tuple(v * .45 for v in col))
    wm._border_mat = object()
    co = np.vstack([np.column_stack([ring, np.full(4, z)]) for z in (.1, 0, .105, .105)])
    wm.objs = {'BRA': _Object(co, [top, side, wm._border_mat])}
    wm._info = {'BRA': dict(n=4, top_z=.1, rings=[ring], col=col, lift=0)}
    wm.project_size_km = lambda *args: (20000, 20000)
    def outline(*args):
        return NS(node_tree=NS(nodes=_Nodes(em=NS(type='EMISSION', inputs=[NS(default_value=None), NS(default_value=None)]))))
    monkeypatch.setattr(materials, 'map_outline', outline)
    def halo(iso, color):
        v, _, _ = wm._halo_verts(iso, 7 * wm.border)
        mat = NS(node_tree=NS(nodes={'glow_strength': NS(inputs=[None, NS(default_value=0)])}))
        return _Object(v, [mat])
    wm._halo = halo
    def label(*args, **kwargs):
        ob, plate = _Object([]), _Object([])
        ob.children = ob.children_recursive = [plate]
        return ob
    wm.label = label
    return wm


def _appearance(wm):
    top, side = wm.objs['BRA'].data.materials[:2]
    nodes = top.node_tree.nodes
    return (tuple(nodes['bsdf'].inputs['Base Color'].default_value),
            tuple(nodes['bsdf'].inputs['Emission Color'].default_value),
            nodes['bsdf'].inputs['Emission Strength'].default_value,
            tuple(side.node_tree.nodes['bsdf'].inputs['Base Color'].default_value),
            nodes['hl_mix'].outputs[0].default_value if 'hl_mix' in nodes else None,
            tuple(nodes['country_tint'].outputs[0].default_value) if 'country_tint' in nodes else None)


@pytest.mark.parametrize('palette', ['muted', 'flat', 'continents', 'relief'])
def test_reveal_preserves_palette_at_zero(monkeypatch, palette):
    wm = _map_state(monkeypatch, mix=0 if palette == 'relief' else 1, palette=palette)
    before = _appearance(wm)
    fill = wm.highlight('BRA', glow=False, show=0)['fill']
    assert _appearance(wm) == before
    fill.pose(1)
    fill.pose(0)
    assert _appearance(wm) == before


@pytest.mark.parametrize('mix', [None, 0.0, .35, 1.0])
def test_reveal_blends_actual_base_and_repeats(monkeypatch, mix):
    wm = _map_state(monkeypatch, mix)
    wm.set_color('BRA', (.2, .3, .7), emission=.17)
    if mix is not None:
        wm.objs['BRA'].data.materials[0].node_tree.nodes['hl_mix'].outputs[0].default_value = mix
    before = _appearance(wm)
    fill = wm.highlight('BRA', glow=False, show=0)['fill']
    assert _appearance(wm) == before
    fill.pose(.5)
    state = _appearance(wm)
    if mix is not None:
        # Shader colour is (1-mix)*natural + mix*tint*relief-light.
        assert state[4] == pytest.approx((1 + mix) / 2)
        assert np.array(state[5][:3]) * state[4] == pytest.approx((np.array(before[5][:3]) * mix + fill.color) / 2)
    else:
        assert state[0][:3] == pytest.approx((np.array(before[0][:3]) + fill.color) / 2)
    fill.pose(1)
    fill.pose(.5)
    assert _appearance(wm) == state
    fill.pose(0)
    assert _appearance(wm) == before


@pytest.mark.parametrize('outline', [False, True])
def test_border_resize_preserves_overrides_and_updates_geometry(monkeypatch, outline):
    wm = _map_state(monkeypatch)
    hit = wm.highlight('BRA', outline=outline, label=True, show=.5)
    wm.set_color('BRA', (.1, .8, .2), emission=.7)
    wm.set_lift('BRA', .9)
    before = _appearance(wm)
    co = wm.objs['BRA'].data.vertices.co.copy()
    halo = hit['halo']
    halo_co = halo.data.vertices.co.copy()
    label_scale = hit['label'].scale
    wm.set_border(.007)
    assert _appearance(wm) == before
    assert wm._info['BRA']['lift'] == .9 and halo.location.z == .9 and hit['fill'].lift == .9
    assert hit['label'].scale == label_scale and hit['fill'].t == .5
    assert wm.objs['BRA'].data.vertices.co[:, 2] == pytest.approx(co[:, 2])
    factor = 1.75 if outline else 1
    expected = maps._inner_ring(wm._info['BRA']['rings'][0], maps.Shape._bw(wm._info['BRA']['rings'][0], .007 * factor))
    assert wm.objs['BRA'].data.vertices.co[12:16, :2] == pytest.approx(expected)
    assert not np.allclose(halo.data.vertices.co, halo_co)


def test_border_without_highlight_outline_resizes(monkeypatch):
    wm = _map_state(monkeypatch)
    wm.highlight('BRA', outline=False, glow=False)
    before = wm.objs['BRA'].data.vertices.co.copy()
    wm.set_border(.007)
    assert not np.allclose(wm.objs['BRA'].data.vertices.co[12:16, :2], before[12:16, :2])


def test_automatic_highlight_lift_tracks_closeup_border(monkeypatch):
    wm = _map_state(monkeypatch)
    hit = wm.highlight('BRA', outline=False, glow=False)
    assert hit['fill'].lift == pytest.approx(0.02 * 20000 * 4 / maps.R_KM)
    wm.set_border(.0005)
    assert hit['fill'].lift == pytest.approx(.0075)  # close-up width now limits the lift
    assert wm._info['BRA']['lift'] == pytest.approx(.0075)
    wm.set_border(.00025)
    assert hit['fill'].lift == pytest.approx(.00375)


def test_zero_lift_preserves_highlight_animation_target(monkeypatch):
    wm = _map_state(monkeypatch)
    fill = wm.highlight('BRA', outline=False, glow=False)['fill']
    target = fill.lift
    wm.set_lift('BRA', 0)
    assert fill.lift == target and fill.auto_lift
    fill.pose(1)
    assert wm._info['BRA']['lift'] == pytest.approx(target)


def test_regional_bbox_adds_context_and_reduces_relief():
    padded = maps._padded_bbox((19, 34, 28, 41))
    assert padded == pytest.approx((10, 27, 37, 48))
    assert maps._zoom_relief_strength(6.0, padded) == pytest.approx(1.5)
    assert maps._zoom_relief_strength(6.0, None) == pytest.approx(6.0)


def test_replacement_retires_old_label_plate_and_halo(monkeypatch):
    wm = _map_state(monkeypatch)
    old = wm.highlight('BRA', label=True)
    new = wm.highlight('BRA', label=True, outline=False, show=0)
    for ob in [old['label'], *old['label'].children, old['halo']]:
        assert ob.hide_render and ob.hide_viewport
    assert wm.objs['BRA'].data.materials[2] is wm._border_mat
    assert new['label'].hide_render and new['halo'].hide_render
    new['fill'].pose(1)
    assert not new['label'].hide_render and not new['halo'].hide_render
    assert old['label'].hide_render and old['halo'].hide_render


# G7 anchor_point: a world point above a country's centre for overlay labels. claude-pro · claude-sonnet-5-5, 2026-11-17.
def _anchor_map(border_set=False):
    wm = maps.WorldMap.__new__(maps.WorldMap)
    wm.data = maps.load("110m")
    wm.projection, wm.scale, wm.origin, wm.thickness = "equirectangular", 4.0, (1.0, 2.0, 0.5), 0.04
    wm.border, wm._border_set = 0.01, border_set
    wm.objs, wm._info = {}, {}
    wm.extent = lambda: (-12.0, -6.0, 12.0, 6.0)
    return wm


def test_anchor_point_follows_center_and_sits_above_surface():
    wm = _anchor_map()
    p = wm.anchor_point("BRA")
    lon, lat = wm.data.find("BRA").center("auto")
    x, y = wm.xy(lon, lat)
    assert p[0] == pytest.approx(float(x)) and p[1] == pytest.approx(float(y))
    assert p[2] > wm.origin[2] + wm.thickness
    assert len(p) == 3 and all(type(v) is float for v in p)
    assert wm.anchor_point("Brazil") == p and wm.anchor_point("br") == p     # any key find() accepts


def test_anchor_point_unknown_key_raises_like_find():
    with pytest.raises(KeyError):
        _anchor_map().anchor_point("Atlantis")


def test_anchor_point_rises_with_lift():
    wm = _anchor_map()
    flat = wm.anchor_point("BRA")
    wm._info["BRA"] = dict(lift=0.3)
    lifted = wm.anchor_point("BRA")
    assert lifted[2] == pytest.approx(flat[2] + 0.3) and lifted[:2] == flat[:2]
    assert wm.anchor_point("FRA")[2] == pytest.approx(flat[2])               # an unlifted country is unaffected


def test_anchor_point_rise_follows_shot_width_when_border_set():
    wm = _anchor_map(border_set=True)
    base = wm.origin[2] + wm.thickness
    assert wm.anchor_point("BRA")[2] == pytest.approx(base + 0.02 * wm.border / 0.002)
    wm._border_set = False
    assert wm.anchor_point("BRA")[2] == pytest.approx(base + 0.02 * 24.0)


def test_anchor_point_leaves_point_unchanged():
    wm = _anchor_map()
    assert wm.point(10.0, 20.0, 0.5) == (*[float(v) for v in wm.xy(10.0, 20.0)], 0.5 + wm.origin[2] + wm.thickness)


def test_anchor_point_parts_reach_center():
    wm = _anchor_map()
    assert wm.anchor_point("FRA", parts="all")[:2] != pytest.approx(wm.anchor_point("FRA", parts="main")[:2])
