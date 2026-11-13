"""Registry of the code-built sets. Pure Python: importable without Blender.

The theme picker reads `catalog()` / `picker_text()`: one name and one line per set.
Camera angles are given relative to the set origin; `preview_scene` adds the origin.
The vertical frame is 1080x1920, sensor fit AUTO: the 36 mm sensor maps to the longer
(vertical) side, so vertical field = 2*atan(18/lens), horizontal = same scaled by 9/16.
"""
import importlib
import math
from dataclasses import dataclass

import numpy as np

from .. import framing
from .common import offset

SENSOR = 36.0
ASPECT = 1080 / 1920


@dataclass(frozen=True)
class Angle:
    name: str
    pos: tuple      # camera position, relative to the set origin
    target: tuple   # look-at point, relative to the set origin
    lens: float


@dataclass(frozen=True)
class SceneParams:
    """Render settings the preview (and a build job) should apply for this set."""
    background: tuple = (0.05, 0.05, 0.06)  # world colour behind the backdrop cards
    bg_strength: float = 1.0
    exposure: float = 0.0                   # stops, scene.view_settings.exposure (Standard view transform)
    samples: int = 24
    note: str = ""


@dataclass(frozen=True)
class SetSpec:
    name: str
    description: str   # one line for the theme picker
    themes: tuple      # words the picker can match a topic against
    subject: tuple     # what the set is about, relative to the origin; must stay in frame at every angle
    angles: tuple      # exactly three Angle
    scene: SceneParams


_STANDARD = "Standard view transform, exposure 0 stops; light energies as tuned on real preview frames (KAN-911 fix 1)."

SPECS = (
    SetSpec(
        "city_street",
        "Toy city street: road, sidewalks, pastel shop buildings, palms, lamps, clouds and a sky dome.",
        ("city", "street", "town", "traffic", "people", "crowd", "speed", "wind", "shop"),
        (0.0, 0.0, 4.0),
        (Angle("wide", (-21.5, -31.6, 23.0), (0.0, 4.0, 5.0), 35),
         Angle("street", (-6.0, -15.0, 3.4), (4.0, 2.0, 4.2), 30),
         Angle("closeup", (3.2, -12.6, 1.9), (0.9, -4.0, 2.0), 35)),
        SceneParams(note=_STANDARD + " Sun 3.0 plus 14 kW fill; sky dome is emissive.")),
    SetSpec(
        "globe",
        "Spinning Earth globe in space with clouds, equator ring, thin atmosphere and a star field.",
        ("earth", "globe", "planet", "space", "rotation", "spin", "world", "orbit", "day", "night"),
        (0.0, -5.0, 0.0),
        (Angle("front", (0.0, -31.0, -1.0), (0.0, 0.0, -1.2), 50),
         Angle("close", (0.0, -22.0, 2.0), (0.0, 0.0, 0.5), 50),
         Angle("low", (-12.0, -26.0, -9.0), (0.0, 0.0, -1.0), 50)),
        SceneParams(background=(0.0, 0.0, 0.01), note=_STANDARD + " Sun 21 kW, rim 6.3 kW (0.7 of the chat values); dark world, space card behind.")),
    SetSpec(
        "polar_penguin",
        "Polar ice field at the pole with icebergs, a striped pole and ring, and a waddling penguin.",
        ("pole", "polar", "arctic", "antarctic", "ice", "snow", "penguin", "cold", "animal", "north", "south"),
        (1.6, -0.6, 0.9),
        (Angle("wide", (9.0, -15.0, 3.2), (0.6, 0.0, 1.5), 35),
         Angle("pole", (6.5, -11.5, 3.2), (0.6, 0.0, 1.5), 35),
         Angle("penguin", (2.6, -5.4, 1.25), (1.5, -0.6, 0.98), 40)),
        SceneParams(note=_STANDARD + " Sun 0.72 plus 1.8 kW fill (0.2 of the chat values); sky card dimmed to 0.85 so it does not clip.")),
    SetSpec(
        "tunnel",
        "Long rocky tunnel with a glowing far end, floating dust and a falling astronaut figure.",
        ("tunnel", "hole", "shaft", "fall", "falling", "gravity", "underground", "core", "mantle", "dig"),
        (0.0, 0.0, 0.0),
        (Angle("side", (1.0, -2.4, 2.3), (0.0, 0.0, -0.2), 24),
         Angle("front", (0.0, -2.25, 0.9), (0.0, 0.0, 0.0), 22),
         Angle("high", (-0.9, -2.0, 2.0), (0.0, 0.35, -0.3), 24)),
        SceneParams(background=(0.0, 0.0, 0.0), note=_STANDARD + " Lit by two point lights (400 W, 600 W) and emissive rock; lens 24 keeps the tube wall in frame.")),
    SetSpec(
        "cutaway_planet",
        "Earth cut open to show crust, mantle and glowing core, with a shaft line, a marker and stars.",
        ("earth", "planet", "cutaway", "core", "mantle", "crust", "inside", "layers", "geology", "hole"),
        (0.0, 0.0, 0.0),
        (Angle("front", (0.0, -27.0, -1.0), (0.0, 0.0, -1.0), 50),
         Angle("left", (-12.0, -24.0, -1.0), (0.0, 0.0, -1.0), 50),
         Angle("above", (8.0, -23.0, 10.0), (0.0, 0.0, -0.5), 50)),
        SceneParams(background=(0.0, 0.0, 0.01), note=_STANDARD + " Sun 26 kW, rim 9 kW, 120 W core point light.")),
    SetSpec(
        "xray_body",
        "Transparent x-ray torso with a lit esophagus, stomach with acid and bubbles, and intestines.",
        ("body", "xray", "organ", "organs", "stomach", "digestion", "acid", "swallow", "food", "health", "anatomy"),
        (0.7, 0.0, -4.1),
        (Angle("stomach", (0.9, -6.0, -3.6), (0.7, 0.0, -4.1), 60),
         Angle("torso", (0.0, -12.0, -3.5), (0.0, 0.0, -3.5), 50),
         Angle("close", (1.6, -3.5, -4.0), (0.6, 0.1, -4.1), 50)),
        SceneParams(background=(0.0, 0.0, 0.01), note=_STANDARD + " Key 750, top 450, fill 250, low 200, rim 80 W areas (0.5 of the chat values); green point light 0.75 W inside the stomach.")),
    SetSpec(
        "room",
        "Cosy teal room: wall with wainscot, window, shelf with books, gumball machine and a potted plant.",
        ("room", "home", "indoor", "interior", "window", "shelf", "books", "plant", "kid", "bedroom"),
        (0.5, 7.0, 0.5),
        (Angle("wide", (0.0, -6.5, 0.5), (0.0, 7.0, 0.5), 28),
         Angle("shelf", (1.4, -1.0, 0.9), (1.4, 6.6, 0.8), 35),
         Angle("window", (-2.4, -1.5, 1.0), (-0.8, 7.0, 0.8), 35)),
        SceneParams(note=_STANDARD + " Five area lights, 117 to 470 W (0.18 of the chat values); window pane emission 1.0.")),
    SetSpec(
        "bathroom",
        "Tiled bathroom with toilet and water, tank, paper roll, bin, bath mat and a potted plant.",
        ("bathroom", "toilet", "flush", "water", "sewer", "plumbing", "tiles", "home", "pipes"),
        (0.0, 0.0, 1.0),
        (Angle("front", (0.0, -6.5, 2.4), (0.0, 0.0, 1.0), 50),
         Angle("high", (3.5, -5.5, 5.0), (0.0, 0.5, 0.9), 50),
         Angle("low", (-2.5, -4.5, 0.9), (0.0, 0.5, 1.0), 45)),
        SceneParams(note=_STANDARD + " Key 300, fill 76, top 70 W areas (0.2 of the chat values).")),
)

_BY_NAME = {s.name: s for s in SPECS}
BUILD_MODULES = {s.name: "blender_worker.codebuilt.sets." + s.name for s in SPECS}


def names():
    return [s.name for s in SPECS]


def get(name):
    try:
        return _BY_NAME[name]
    except KeyError:
        raise KeyError(f"unknown set {name!r}; known: {', '.join(names())}") from None


def catalog():
    """[{name, description, themes}] for the theme picker."""
    return [dict(name=s.name, description=s.description, themes=list(s.themes)) for s in SPECS]


def picker_text():
    """One line per set: 'name: description'."""
    return "\n".join(f"{s.name}: {s.description}" for s in SPECS)


def match_themes(words):
    """Set names whose theme words overlap the given words, best match first."""
    ws = {w.lower() for w in words}
    scored = [(len(ws & set(s.themes)), s.name) for s in SPECS]
    return [n for k, n in sorted(scored, key=lambda x: (-x[0], x[1])) if k]


def load_builder(name):
    """The set module's build function (needs Blender, imports bpy)."""
    get(name)
    return importlib.import_module(BUILD_MODULES[name]).build


def angle_world(angle, origin):
    """(pos, target, lens) in world coordinates for a set built at origin."""
    return offset(origin, angle.pos), offset(origin, angle.target), angle.lens


def project(angle, point, origin=(0.0, 0.0, 0.0)):
    """Pinhole projection of a world point through an angle: (x, y, depth), x and y in 0..1
    like Blender's world_to_camera_view for a 1080x1920 frame. Used to check framing offline."""
    pos, tgt, lens = angle_world(angle, origin)
    pos, tgt, pt = np.array(pos, float), np.array(tgt, float), np.array(point, float)
    fwd = (tgt - pos) / np.linalg.norm(tgt - pos)
    right = np.cross(fwd, [0.0, 0.0, 1.0])
    right /= np.linalg.norm(right)
    up = np.cross(right, fwd)
    d = pt - pos
    depth = float(d @ fwd)
    if depth <= 1e-9:
        return 0.0, 0.0, depth
    half_v = SENSOR / 2 / lens
    x = 0.5 + 0.5 * float(d @ right) / depth / (half_v * ASPECT)
    y = 0.5 + 0.5 * float(d @ up) / depth / half_v
    return x, y, depth


def subject_in_frame(spec, angle, origin=(0.0, 0.0, 0.0)):
    x, y, z = project(angle, offset(origin, spec.subject), origin)
    return framing.in_zone(x, y, z)
