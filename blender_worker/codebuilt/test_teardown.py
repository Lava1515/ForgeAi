"""Regressions for the stealth_jet_teardown set and the codebuilt-teardown skill (lane M5p, 2026-11-15); no Blender required.

Each test is a real defect found by the fenced CPU probe tools/codebuilt/probe-stealth-jet-teardown.py (Blender 5.2.2) before
the fix: parts offset twice (wings 2.2 m off the hull, avionics ahead of the nose), the set origin applied twice, a pedestal
that hid the belly, the landing gear and the lowered bombs, camera poses that did not frame their subject, a callout
wider than the frame, and a skill example that named a fact key as a part id.
"""
import math
import re
from pathlib import Path

import numpy as np
import pytest

from blender_worker.codebuilt import shotcheck, teardown
from blender_worker.codebuilt.sets import registry, stealth_jet_teardown

ASPECT = 1080 / 1920
SAFE = (0.04, 0.96, 0.04, 0.96)
SKILL = Path(__file__).resolve().parents[2] / ".claude" / "skills" / "codebuilt-teardown" / "SKILL.md"
CALLOUT = "PLATYPUS 2D NOZZLE: IR SUPPRESSION"
TIMES = (0.0, 0.1, 0.25, 0.4, 0.5, 0.6, 0.75, 0.9, 0.95, 1.0)


def world_vertices(pid, t=0.0, stagger=True):
    """Where Blender puts a part: pivot-local mesh, hinge rotation, then the location relative to the jet root at the origin."""
    v, _ = teardown.local_geometry(pid)
    rot = teardown.part_rotation(pid, t, stagger)
    for axis, angle in enumerate(rot):
        if not angle:
            continue
        c, s = math.cos(angle), math.sin(angle)
        i, j = [(1, 2), (2, 0), (0, 1)][axis]
        a, b = v[:, i].copy(), v[:, j].copy()
        v[:, i], v[:, j] = a * c - b * s, a * s + b * c
    return v + np.array(teardown.part_location(pid, t, stagger))


def test_assembled_parts_land_on_their_authored_coordinates():
    # build() used to add base_loc to meshes that were already authored in aircraft coordinates.
    for pid in teardown.PARTS:
        authored, _ = teardown.build_part_geometry(pid)
        assert np.allclose(world_vertices(pid, 0.0), authored, atol=1e-9), pid


def test_wings_meet_the_fuselage_and_nothing_stands_ahead_of_the_nose():
    chine = {1.0: (1.65, 0.4, 0.15), -1.0: (-1.65, 0.4, 0.15)}
    for side, sign in (("right", 1.0), ("left", -1.0)):
        wing = world_vertices(f"wing_{side}")
        assert min(np.linalg.norm(wing - np.array(chine[sign]), axis=1)) < 0.1, side
    nose = max(world_vertices(pid)[:, 1].max() for pid in teardown.PARTS)
    assert nose <= 5.2 * 1.025 + 1e-9  # the RAM skin is the upper shell scaled 1.025
    for pid in ("avionics_bay", "sensor_flir", "canopy", "cockpit_interior"):
        assert world_vertices(pid)[:, 1].max() <= 5.2, pid


def test_part_locations_are_relative_to_the_jet_root_only():
    # Parts are children of the root empty at the set origin; adding the origin to them as well moved the jet by twice the origin.
    for pid, spec in teardown.PARTS.items():
        assert teardown.part_location(pid, 0.0) == spec.base_loc
        end = teardown.part_location(pid, 1.0)
        assert end == pytest.approx(tuple(b + e for b, e in zip(spec.base_loc, spec.explode_vec)))
        assert teardown.part_location(pid, 1.0, scale=2.0) == pytest.approx(tuple(2 * c for c in end))
    assert "origin" not in teardown.part_location.__code__.co_varnames


def test_hinged_parts_open_inside_their_own_stagger_window():
    for pid, (axis, degrees) in teardown.HINGES.items():
        p0, p1 = teardown.PARTS[pid].stage_phase
        assert teardown.part_rotation(pid, p0) == (0.0, 0.0, 0.0)
        assert math.degrees(teardown.part_rotation(pid, p1)[axis]) == pytest.approx(degrees)
        assert math.degrees(teardown.part_rotation(pid, 1.0)[axis]) == pytest.approx(degrees)
    # the skill promises doors open by the end of phase 1 and the canopy early; without stagger the whole timeline is used
    assert math.degrees(teardown.part_rotation("canopy", 0.4)[0]) == pytest.approx(22.0)
    assert abs(math.degrees(teardown.part_rotation("bay_door_left", 0.5)[1])) == pytest.approx(55.0)
    assert 0 < math.degrees(teardown.part_rotation("canopy", 0.5, stagger=False)[0]) < 22.0


def test_bay_doors_hinge_on_the_outer_edge_and_swing_down_and_out():
    for side in ("left", "right"):
        rest, opened = world_vertices(f"bay_door_{side}", 0.0), world_vertices(f"bay_door_{side}", 0.5)
        hinge_x = teardown.PARTS[f"bay_door_{side}"].base_loc[0]
        assert abs(hinge_x) == pytest.approx(0.9)  # outer edge of the 0.08 .. 0.90 plate
        free = np.argsort(np.abs(rest[:, 0]))[:6]       # edge nearest the centre line
        hinge = np.argsort(-np.abs(rest[:, 0]))[:6]     # outer edge
        lift = opened[hinge, 2].mean() - opened[free, 2].mean()
        assert lift > 0.4, (side, lift)  # the free edge hangs lower than the hinge


def test_pedestal_never_hides_a_part():
    top = stealth_jet_teardown.pedestal_top_z()
    radius = stealth_jet_teardown.PEDESTAL_RADIUS
    for pid in teardown.PARTS:
        for t in TIMES:
            v = world_vertices(pid, t)
            hidden = (v[:, 2] < top) & (np.hypot(v[:, 0], v[:, 1]) <= radius)
            assert not hidden.any(), (pid, t, v[:, 2].min(), top)
    assert teardown.lowest_point_z() - stealth_jet_teardown.PEDESTAL_CLEARANCE == pytest.approx(top)


def beat_vertices(name):
    t, focus = teardown.CAMERA_BEATS[name]
    ids = list(teardown.PARTS) if focus is None else list(focus)
    return t, {pid: world_vertices(pid, t) for pid in ids}


@pytest.mark.parametrize("name", sorted(teardown.CAMERA_POSES))
def test_every_camera_pose_frames_its_beat_inside_the_vertical_frame(name):
    pose = teardown.CAMERA_POSES[name]
    _, parts = beat_vertices(name)
    for pid, v in parts.items():
        for p in v:
            x, y, depth = shotcheck.project_point(tuple(p), pose["pos"], pose["target"], pose["lens"], ASPECT)
            assert depth > 0.5, (name, pid)
            assert SAFE[0] <= x <= SAFE[1] and SAFE[2] <= y <= SAFE[3], (name, pid, round(x, 3), round(y, 3))
    # the camera is not inside any part and stays above the pedestal disc
    everything = {pid: world_vertices(pid, teardown.CAMERA_BEATS[name][0]) for pid in teardown.PARTS}
    for pid, v in everything.items():
        assert not all(lo <= c <= hi for c, lo, hi in zip(pose["pos"], v.min(axis=0), v.max(axis=0))), (name, pid)
    assert pose["pos"][2] > stealth_jet_teardown.pedestal_top_z() + 0.2


def test_registry_angles_are_the_teardown_poses_and_keep_the_subject_in_frame():
    spec = registry.get("stealth_jet_teardown")
    assert spec.subject == stealth_jet_teardown.SUBJECT_POINT
    poses = [(tuple(p["pos"]), tuple(p["target"]), p["lens"]) for p in teardown.CAMERA_POSES.values()]
    assert len(spec.angles) == 3
    for angle in spec.angles:
        assert (angle.pos, angle.target, angle.lens) in poses, angle.name
        x, y, depth = shotcheck.project_point(spec.subject, angle.pos, angle.target, angle.lens, ASPECT)
        assert depth > 0 and 0.06 <= x <= 0.94 and 0.08 <= y <= 0.92, (angle.name, x, y)


def callout_box(name, pid):
    pose = teardown.CAMERA_POSES[name]
    t, _ = teardown.CAMERA_BEATS[name]
    part_world = tuple(teardown.part_location(pid, t))
    layout = teardown.callout_layout(CALLOUT, part_world, pose["pos"], pose["target"], pose["lens"], ASPECT)
    right, up, _ = shotcheck.camera_basis(pose["pos"], pose["target"])
    corners = shotcheck.text_corners(layout["center"], layout["body"], layout["size"], right=right, up=up)
    return layout, shotcheck.project_box(corners, pose["pos"], pose["target"], pose["lens"], ASPECT)


@pytest.mark.parametrize("name", sorted(teardown.CAMERA_POSES))
def test_callout_fits_the_text_safe_area_and_the_readout_width_limit_in_every_shot(name):
    # The skill's own example callout was 137 percent of the frame wide at its camera.
    focus = teardown.CAMERA_BEATS[name][1] or ("exhaust_nozzle", "canopy", "wing_left", "wing_right", "landing_gear")
    for pid in focus:
        layout, box = callout_box(name, pid)
        assert shotcheck.box_in_safe(box), (name, pid, box)
        assert not shotcheck.readout_too_wide(box), (name, pid, box)
        assert max(len(line) for line in layout["body"].split("\n")) <= teardown.CALLOUT_LINE_CHARS


def test_callout_text_is_wrapped_and_sized_from_the_frame():
    assert teardown.callout_lines(CALLOUT) == ["PLATYPUS 2D", "NOZZLE: IR", "SUPPRESSION"]
    near, far = teardown.callout_size(CALLOUT, 10, 45), teardown.callout_size(CALLOUT, 20, 45)
    assert far == pytest.approx(2 * near)  # same share of the frame at twice the distance


def test_unknown_ids_raise_instead_of_doing_nothing():
    jet = teardown.StealthJet(None)
    with pytest.raises(KeyError):
        jet.callout("platypus_exhaust", "x")        # a facts() key, the exact mistake the skill example made
    with pytest.raises(KeyError):
        jet.highlight("platypus_exhaust")
    jet.highlight("propulsion")                      # a subsystem and a part id are fine
    jet.highlight("exhaust_nozzle")


def test_anchor_point_is_the_parts_world_centre_and_follows_the_explode():
    jet = teardown.StealthJet(None, origin=(1.0, 2.0, 3.0))
    pid = "exhaust_nozzle"
    p = jet.anchor_point(pid)
    assert len(p) == 3 and all(isinstance(c, float) for c in p)
    # assembled: the centre of the part's authored box, moved by the set origin
    authored, _ = teardown.build_part_geometry(pid)
    expected = (authored.min(axis=0) + authored.max(axis=0)) / 2 + np.array([1.0, 2.0, 3.0])
    assert p == pytest.approx(tuple(expected))
    # exploded: it moved by the part's explode vector
    jet.pose(1.0, "exploded")
    moved = jet.anchor_point(pid)
    assert moved == pytest.approx(tuple(np.array(p) + np.array(teardown.PARTS[pid].explode_vec)))
    assert moved != pytest.approx(p)
    jet.pose(1.0, "assembled")
    assert jet.anchor_point(pid) == pytest.approx(p)
    # a hinged part still gives three finite floats
    jet.pose(1.0)
    assert all(math.isfinite(c) for c in jet.anchor_point("canopy"))
    for pid in teardown.PARTS:
        assert len(jet.anchor_point(pid)) == 3


def test_anchor_point_unknown_id_raises_key_error_like_its_neighbours():
    jet = teardown.StealthJet(None)
    with pytest.raises(KeyError):
        jet.anchor_point("platypus_exhaust")        # a facts() key, not a part id
    with pytest.raises(KeyError):
        jet.anchor_point("propulsion")              # a subsystem is not a part


def skill_text():
    return SKILL.read_text(encoding="utf-8")


def test_skill_examples_use_real_part_ids_subsystems_and_fact_keys():
    text = skill_text()
    subsystems = set(teardown.subsystems())
    for pid in re.findall(r'\.callout\(\s*"([^"]+)"', text):
        assert pid in teardown.PARTS, pid
    for target in re.findall(r'\.highlight\(\s*"([^"]+)"', text):
        assert target in teardown.PARTS or target in subsystems, target
    for key in re.findall(r'facts\(\s*"([^"]+)"', text):
        assert key in teardown.FACTS, key
    for name in re.findall(r'CAMERA_POSES\[\s*"([^"]+)"', text) + re.findall(r'pose="([^"]+)"', text):
        assert name in teardown.CAMERA_POSES, name


def test_skill_lists_every_part_once_and_its_numbers_match_the_kit():
    text = skill_text()
    rows = {m.group(1) for m in re.finditer(r"^\| `([a-z_]+)`(?: / `([a-z_]+)`)? \|", text, re.M)}
    rows |= {m.group(2) for m in re.finditer(r"^\| `([a-z_]+)` / `([a-z_]+)` \|", text, re.M)}
    assert rows == set(teardown.PARTS), sorted(set(teardown.PARTS) ^ rows)
    geo = teardown.geometry_summary()
    assert f"{len(teardown.PARTS)} parts" in text and f"{len(teardown.subsystems())} subsystems" in text
    assert f"{sum(g['vertex_count'] for g in geo.values())} vertices" in text
    assert f"{sum(g['face_count'] for g in geo.values())} faces" in text
    assert "17+" not in text  # the kit has 24 parts in 7 subsystems; "17+ subsystems" was wrong
    allv = np.vstack([world_vertices(pid) for pid in teardown.PARTS])
    span = allv.max(axis=0) - allv.min(axis=0)
    assert f"{span[0]:.1f} m wingspan" in text
    assert f"about {round(span[1])} m long" in text and f"about {round(span[2])} m tall" in text
    for name in teardown.CAMERA_POSES:
        assert f"`{name}`" in text, name
    for name, pose in teardown.CAMERA_POSES.items():
        assert "cam.set(pos=(%.1f, %.1f, %.1f)" % pose["pos"] in text, name


def test_run_self_checks_still_pass():
    assert teardown.run_self_checks() is True
    assert len(teardown.PARTS) == 24 and len(teardown.subsystems()) == 7


def test_planner_set_manual_snapshot_carries_the_current_teardown_entry():
    # setCatalog.js is a snapshot of registry.manual_text(); it still told the build model the old poses and "17+ subsystems".
    import json
    src = (Path(__file__).resolve().parents[2] / "dashboard" / "server" / "episode" / "codebuilt" / "setCatalog.js").read_text(encoding="utf-8")
    key = "export const SET_MANUAL_TEXT = "
    manual, _ = json.JSONDecoder().raw_decode(src[src.index(key) + len(key):])
    line = next(l for l in manual.split("\n") if l.startswith("stealth_jet_teardown.build"))
    expected = next(l for l in registry.manual_text().split("\n") if l.startswith("stealth_jet_teardown.build"))
    assert line == expected
    assert "17+" not in line and "9.5, -16.0, 11.0" not in line
