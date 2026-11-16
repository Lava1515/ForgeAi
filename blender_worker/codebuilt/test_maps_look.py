"""F5 map look: pure-Python parts (colours, reveal easing, label placement geometry). Appearance is checked by renders.
Author: claude-pro · claude-opus-5-5, 2026-11-16.
"""
import itertools

import numpy as np

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
