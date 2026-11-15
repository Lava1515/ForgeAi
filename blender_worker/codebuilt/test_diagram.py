"""V1 (2026-11-15): diagram legibility arithmetic and Board checks; no Blender required.

Run from the repo root:  python -m pytest blender_worker/codebuilt/test_diagram.py
"""
import itertools
import math

import pytest

from blender_worker.codebuilt import diagram as dg


def test_frame_arithmetic_matches_the_scene_skill():
    # the skill: a 1.8 m person at half the frame height with a 35 mm lens stands 3.5 m away
    assert dg.distance_for_share(1.8, 0.5, 35, 'h') == pytest.approx(3.5, abs=0.1)
    assert dg.share(1.8, 3.5, 35, 'h') == pytest.approx(0.5, abs=0.02)
    # the frame is 9/16 as wide as it is tall
    assert dg.visible_width(10, 35) == pytest.approx(dg.visible_height(10, 35) * 9 / 16)


def test_the_everest_diagram_of_job_mwhu3xfu_was_below_the_legible_minimum():
    # shot 4: layer lines 0.22 m, ray bars 0.5 m, camera 85 m away at 35 mm, frame 87 m tall and 49 m wide
    layer = dg.share(0.22, 85, 35, 'w')
    ray = dg.share(0.5, 85, 35, 'w')
    assert layer < dg.MIN_STROKE / 3 and dg.px(layer, 'w') < 5
    assert ray < dg.MIN_STROKE
    # the Eratosthenes cards: 0.5 m font (about 0.35 m capitals) at 18 m, 24 mm
    cap = dg.share(0.5 * dg.CAP_RATIO, 18, 24, 'h')
    assert cap < dg.MIN_CAP / 1.5


def test_diagnose_names_the_cropped_everest_triangle():
    # job mwhu3xfu-a118b6 shot 3: camera 50 m from the middle of a 48 m baseline at 22 mm; two of the three corners are off screen
    def cam(aim, az, d, el):
        a, e = math.radians(az), math.radians(el)
        return (aim[0] + d * math.sin(a) * math.cos(e), aim[1] - d * math.cos(a) * math.cos(e), aim[2] + d * math.sin(e))
    aim = (-3, 17, 14)
    pos = cam(aim, 45, 50, 4)
    corners = [(-20, 0, 7.5), (14, 34, 0.5), (14, 34, 36), (-20, 0, 0.5)]
    why = dg.diagnose(corners, pos, aim, 22, stroke=1.4)
    assert why and 'outside the text safe area' in why[0]
    ext = dg.frame_extent(corners, pos, aim, 22)
    assert ext['box'][0] < 0.06 and ext['box'][1] > 0.94
    # a Board-planned view of the same facts has every corner inside
    p = dg.plan(34, 30, 22, 0.7)
    ok = dg.frame_extent([(-17, 0, 15), (17, 0, 15), (-17, 0, -15), (17, 0, -15)],
                         (0, -p['distance'], 0), (0, 0, 0), 22)
    assert not ok['outside']
    assert dg.diagnose([(0, 0, 0), (1, 0, 0)], (0, -80, 0), (0, 0, 0), 35, stroke=0.22)   # thin and small both reported


@pytest.mark.parametrize('w,h,lens,az,el', list(itertools.product((6, 10, 24), (4, 8, 14), (24, 35, 50), (0, 25), (0, 15))))
def test_a_planned_board_is_legible_and_clear_of_the_caption_band(w, h, lens, az, el):
    p = dg.plan(w, h, lens, 0.7, az, el)
    leg = dg.legibility(p['stroke'], p['cap'], p['distance'], lens, az, el)
    assert leg['stroke_ok'] and leg['cap_ok'], leg
    assert leg['stroke_px'] >= 15 * 0.98 and leg['cap_px'] >= 50 * 0.98
    assert p['fill'] <= dg.MAX_FILL + 1e-9
    assert p['height_share'] <= dg.BOARD_BOTTOM - dg.BOARD_TOP + 1e-9
    assert p['head'] >= 3 * p['stroke']
    # straight-on the same camera distance must not push the board past the widest allowed share
    if az:
        assert w / dg.visible_width(p['distance'], lens) <= dg.MAX_FILL + 1e-9


def test_the_lens_does_not_change_what_the_frame_shows():
    a, b = dg.plan(10, 8, 24), dg.plan(10, 8, 70)
    assert a['fill'] == pytest.approx(b['fill'])
    assert a['stroke'] / a['visible_w'] == pytest.approx(b['stroke'] / b['visible_w'])
    assert a['distance'] < b['distance']


def test_a_tall_board_loses_width_share_before_it_runs_into_the_captions():
    p = dg.plan(6, 12, 35, 0.7)
    assert p['height_share'] <= dg.BOARD_BOTTOM - dg.BOARD_TOP + 1e-9
    assert p['fill'] < 0.7


def test_a_view_far_off_the_normal_is_refused():
    with pytest.raises(dg.DiagramError):
        dg.plan(10, 8, 35, 0.7, 65, 0)
    with pytest.raises(dg.DiagramError):
        dg.plan(10, 8, 35, 0.7, 0, 61)


def test_text_capacity_is_a_few_words_not_a_paragraph():
    p = dg.plan(10, 8, 35)
    n = dg.max_chars(p['font'], 10 * dg.INNER)
    assert 10 <= n <= 24


def test_palette_contrast():
    pal = dg.PALETTE
    assert dg.contrast(pal['ink'], pal['panel']) >= dg.MIN_CONTRAST
    for name in ('blue', 'orange', 'red', 'green'):
        assert dg.contrast(pal[name], pal['panel']) >= dg.MIN_ACCENT, name
    assert dg.contrast((0.9, 0.9, 0.9), pal['panel']) < dg.MIN_ACCENT   # pale ink on a pale panel is refused


def test_pose_segment():
    assert dg.pose_segment((0, 0, 0), (4, 0, 0), 0.0) is None
    assert dg.pose_segment((0, 0, 0), (0, 0, 0), 1.0) is None
    half = dg.pose_segment((0, 0, 0), (4, 0, 0), 0.5)
    assert half['len'] == pytest.approx(2) and half['loc'][0] == pytest.approx(1) and not half['head_shown']
    up = dg.pose_segment((0, 0, 0), (0, 0, 3), 1.0, head_len=1.0)
    assert up['ang'] == pytest.approx(math.pi / 2) and up['len'] == pytest.approx(2)
    assert up['loc'][2] == pytest.approx(1) and up['head'][2] == pytest.approx(2) and up['head_shown']
    short = dg.pose_segment((0, 0, 0), (0, 0, 3), 0.2, head_len=1.0)   # shorter than the head: no head, no shaft yet
    assert short['len'] == 0 and not short['head_shown']


class _Obj(dict):
    pass


def _board(labels, width=10.0, height=8.0, pal=None):
    b = dg.Board.__new__(dg.Board)
    b.name, b.width, b.height = 't', width, height
    b.pal = dict(dg.PALETTE, **(pal or {}))
    b.plan = dg.plan(width, height, 35, 0.7)
    b.hw, b.hh = width / 2 * dg.INNER, height / 2 * dg.INNER
    b.problems = []
    b.labels = []
    for body, u, v in labels:
        o = _Obj(dg=[u, v, u, v, 2.0], dg_body=body, dg_font=b.plan['cap'] / dg.CAP_RATIO)
        b.labels.append(o)
    return b


def test_board_accepts_short_labels_and_refuses_overlong_or_too_many():
    assert _board([('170 KM', 0, -0.8), ('29,002 FT', 0.2, 0.7)]).check() == []
    why = _board([('THE LIGHT BENDS AS IT PASSES THROUGH THICKER AIR', 0, 0)]).check()
    assert why and 'leaves the board' in why[0]
    with pytest.raises(dg.DiagramError):
        _board([('A very long label here', 0.9, 0.9)]).require()
    assert any('labels' in w for w in _board([('A', 0, i / 10) for i in range(dg.MAX_LABELS + 1)]).check())
    assert any('contrast' in w for w in _board([], pal={'ink': (0.85, 0.85, 0.8)}).check())


def test_report_numbers_for_a_probe():
    b = _board([('170 KM', 0, 0)])
    b.az_max = b.el_max = 0.0
    b.center = (0, 0, 6)
    r = dg.Board.report(b)
    assert r['legibility']['stroke_ok'] and r['legibility']['cap_ok']
    assert r['preview_px']['cap'] == pytest.approx(r['legibility']['cap_px'] / 2)
    assert r['problems'] == []


# ---- Board with stand-ins for the Blender modules: exercises the drawing, posing and camera code on any CPU ---------------------------

import sys
import types


class FakeObj(dict):
    def __init__(self, kind, name):
        super().__init__()
        self.kind, self.name = kind, name
        self.location, self.rotation_euler, self.scale = (0, 0, 0), (0, 0, 0), (1, 1, 1)
        self.rotation_mode = 'XYZ'


class FakeCam:
    def __init__(self):
        self.calls = []

    def set(self, pos, target, lens=50, **kw):
        self.calls.append((pos, target, lens))


@pytest.fixture
def board_env(monkeypatch):
    mk = lambda kind: (lambda name, *a, **k: FakeObj(kind, name))
    meshes = types.SimpleNamespace(box=lambda name, c, mat, loc, size, bevel=0.06: _placed(FakeObj('box', name), loc), lathe=mk('lathe'),
                                   ball=lambda name, r, mat, c, **k: FakeObj('ball', name), empty=mk('empty'))
    stage = types.SimpleNamespace(text=lambda c, name, body, size, mat, loc, **k: _placed(FakeObj('text', name), loc), load_font=lambda: None)
    materials = types.SimpleNamespace(emit=lambda name, rgb, strength=1.0: ('mat', name, rgb))
    for name, mod in (('meshes', meshes), ('stage', stage), ('materials', materials)):
        monkeypatch.setitem(sys.modules, 'blender_worker.codebuilt.' + name, mod)
        monkeypatch.setattr(dg.__package__ and sys.modules['blender_worker.codebuilt'], name, mod, raising=False)
    monkeypatch.setattr(dg, '_cap_ratio', lambda: dg.CAP_RATIO)
    dg.reset_cache()
    return None


def _placed(o, loc):
    o.location = loc
    return o


def test_board_draws_poses_and_aims_the_camera_inside_the_safe_area(board_env):
    from blender_worker.codebuilt import shotcheck
    b = dg.Board('coll', 'tri', (0, 0, 14), 34, 28, lens=35, az_max=18, el_max=14)
    ln = b.line((-0.85, -0.55), (0.85, -0.55), 'blue')
    ar = b.arrow((-0.85, -0.2), (0.85, 0.7), 'orange')
    dot = b.dot((0.85, 0.7), 'red')
    lab = b.label('170 KM', (0, -0.78))
    assert b.require() is b
    assert all(o.scale == (0, 0, 0) for o in (ln, dot, lab, ar['shaft'], ar['head']))      # created hidden
    # a stroke: full length at k = 1, half at k = 0.5, hidden at 0
    b.draw(ln, 1.0)
    assert ln.scale[0] == pytest.approx(0.85 * 2 * b.hw) and ln.location[0] == pytest.approx(0.0, abs=1e-9)
    assert ln.location[1] < b.center[1] and ln.location[2] == pytest.approx(b.at((0, -0.55))[2])
    b.draw(ln, 0.5)
    assert ln.scale[0] == pytest.approx(0.85 * b.hw)
    b.draw(ln, 0)
    assert ln.scale == (0, 0, 0)
    # an arrow: shaft stops where the head starts; head sits at the tip
    b.draw(ar, 1.0)
    p = b.plan
    assert ar['head'].scale == (1, 1, 1) and ar['shaft'].scale[0] > 0
    full = math.hypot(1.7 * b.hw, 0.9 * b.hh)
    assert ar['shaft'].scale[0] == pytest.approx(full - ar['head_len'])
    b.draw(lab, 1)
    assert lab.scale == (1, 1, 1) and lab.location[1] < b.center[1]
    # the camera: board centre sits at 36 percent from the top, all four corners inside the text safe area, planned fill reached
    for az, el, u in ((0, 0, 0), (0, 0, 1), (-18, 0, 0.5), (18, 14, 1), (30, 30, 0)):
        cam = FakeCam()
        pos, target, lens = b.camera(cam, u, push=0.06, az=az, el=el)
        assert cam.calls == [(pos, target, lens)]
        corners = [(b.center[0] + sx * 17, b.center[1], b.center[2] + sz * 14) for sx in (-1, 1) for sz in (-1, 1)]
        pts = [shotcheck.project_point(c, pos, target, lens) for c in corners]
        for x, y, depth in pts:
            assert 0.06 <= x <= 0.94 and 0.08 <= y <= 0.92 and depth > 1
        top, bottom = 1 - max(q[1] for q in pts), 1 - min(q[1] for q in pts)
        assert top >= 0.07 and bottom <= 0.70                 # clear of the caption band (66 to 80 percent from the top) after the push
        width = max(q[0] for q in pts) - min(q[0] for q in pts)
        assert 0.55 <= width <= dg.MAX_FILL + 0.005
        assert pos[1] < b.center[1]                            # camera on the -Y side, as the kit's sets require


def test_board_refuses_a_label_that_cannot_fit(board_env):
    b = dg.Board('coll', 'x', (0, 0, 5), 10, 8)
    b.label('A SENTENCE THAT IS FAR TOO LONG FOR A PHONE', (0, 0))
    with pytest.raises(dg.DiagramError, match='leaves the board'):
        b.require()
    c = dg.Board('coll', 'y', (0, 0, 5), 10, 8)
    c.line((0, 0), (1, 1), (0.95, 0.93, 0.85))     # a line the colour of the panel
    with pytest.raises(dg.DiagramError, match='contrast'):
        c.require()


@pytest.mark.parametrize('w,h,az', [(34, 28, 18), (24, 20, 18), (12, 9, 18), (12, 9, 25), (10, 8, 0)])
def test_a_stroke_on_the_far_edge_of_a_slanted_board_still_reaches_the_floor(w, h, az):
    """The pinhole projection itself (not the plan's own formula): a stroke across the width of the drawing area, at its far edge, with the
    camera aimed at the board centre from az degrees off the normal, is MIN_STROKE of the frame width (floor 0.97 as the probe uses) even
    with no push-in."""
    p = dg.plan(w, h, 35, 0.7, az, 0)
    a, d, f = math.radians(az), p['distance'], 35.0
    x = -(w / 2 * dg.INNER)                       # the far side of the board for a camera at +az

    def u(xx):                                    # image x in sensor millimetres, camera aimed at the centre
        return f * (xx * math.cos(a)) / (d - xx * math.sin(a))

    sensor_w = dg.SENSOR_MM * dg.ASPECT
    px_wide = (u(x + p['stroke'] / 2) - u(x - p['stroke'] / 2)) / sensor_w * dg.FRAME_PX[0]
    assert abs(px_wide) >= dg.px(dg.MIN_STROKE, 'w') * 0.97, px_wide
