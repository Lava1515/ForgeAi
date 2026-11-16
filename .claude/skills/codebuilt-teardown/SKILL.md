---
name: codebuilt-teardown
description: How to use the teardown kit (stylized stealth jet how-it-works, procedural disassembly, illustrative part names, exploded views, X-ray cutaway, subsystem highlights, and camera framing) in a code-built explainer short. Loaded for an explicitly selected teardown type at script, direction, and build steps, as well as by topic.
---

# Code-built teardown: stylized stealth jet

Topic kit for "how it works" engineering explainer shorts. Features a stylized stealth jet built entirely from procedural shapes (no downloaded models or external assets). The parts are illustrative design choices, not verified F-117 specifications. Do not narrate their names or mechanisms as facts about a real aircraft without independent source verification.

When the owner explicitly selects video type `teardown`, this skill is loaded by type at the script, direction, and build steps even if the topic does not contain a stealth keyword. The registered `stealth_jet_teardown` set is mandatory as the main scene: build it with `stealth_jet_teardown.build(origin)` and use its returned `jet` handle for the assembled and exploded views. Do not replace it with another set or a generic jet. Auto and every other video type keep their existing selection behavior.

> **Illustrative reconstruction disclaimer:**
> Illustrative schematic reconstruction for educational and how-it-works explanation; not dimensionally exact, operational, or maintenance CAD geometry. Do not copy protected diagrams, marks, or proprietary geometry.

Research leads only. The USAF page was inaccessible during review; the Lockheed page supports faceted panels and radar-absorbent coating only. The FAA handbook describes generic aircraft systems. These links do not verify this model’s detailed mechanisms:
- USAF National Museum, *Lockheed F-117A Nighthawk Fact Sheet*:
  <https://www.nationalmuseum.af.mil/Visit/Museum-Exhibits/Fact-Sheets/Display/Article/198056/lockheed-f-117a-nighthawk/>
- Lockheed Martin, *F-117 Nighthawk History & Skunk Works*:
  <https://www.lockheedmartin.com/en-us/news/features/history/f-117.html>
- FAA, *Pilot's Handbook of Aeronautical Knowledge (FAA-H-8083-25B), Chapter 7: Aircraft Systems*:
  <https://www.faa.gov/sites/faa.gov/files/09_phak_ch7.pdf>

Use this kit when the narration explains how stealth aircraft avoid radar, how jet engines reduce infrared heat signatures, how internal weapons bays operate, or how fly-by-wire stabilizes unstable airframes. If the topic is not about stealth aircraft or teardown mechanisms, ignore this text. The brief and direction always win.

## Where the kit is

```python
import sys; sys.path.insert(0, '/kit')
from blender_worker.codebuilt import teardown
from blender_worker.codebuilt.sets import stealth_jet_teardown

# Build the complete lit studio teardown set (pedestal, 3-point lights, jet)
h = stealth_jet_teardown.build(origin=(x, y, z))
jet = h['jet']        # StealthJet instance; h['pedestal'], h['collection'], h['lights']

# Or build the aircraft alone into an existing place collection
jet = teardown.build(c, origin=(x, y, z), scale=1.0)
```

`teardown.build` returns a `StealthJet` instance controlling 24 parts in 7 subsystems, all children of one root empty placed at `origin` (the origin moves the whole set once; part locations are relative to that root). The assembled aircraft sits on its authored coordinates around the datum: about 10 m long, 11.6 m wingspan, about 4 m tall with the gear down. Exploded it reaches about 20 m across (wing tip to wing tip) and the gear and bombs drop about 5 m, so the set's pedestal top sits below that (`stealth_jet_teardown.pedestal_top_z()`); when assembled the jet floats above the disc.

## Illustrative parts and mechanism notes

Every row below describes this illustrative model, not a verified real aircraft. Specific engine, seat, weapon, duct, tail, canopy, nozzle and control-system details remain unverified. Source links are research leads only and must not be presented as supporting those details:

| Part ID | Illustrative part name | Subsystem | Engineering function & physical principle | Unverified research lead |
|---|---|---|---|---|
| `fuselage_upper` | Faceted Upper Airframe Shell | `airframe` | Sloped planar composite facets reflecting radar beams away from transmitting radars. | [USAF Museum Fact Sheet](https://www.nationalmuseum.af.mil/Visit/Museum-Exhibits/Fact-Sheets/Display/Article/198056/lockheed-f-117a-nighthawk/) |
| `fuselage_lower` | Faceted Lower Hull & Belly | `airframe` | Ventral faceted hull enclosing the payload bay and maintaining low observable lines against ground radar. | [USAF Museum Fact Sheet](https://www.nationalmuseum.af.mil/Visit/Museum-Exhibits/Fact-Sheets/Display/Article/198056/lockheed-f-117a-nighthawk/) |
| `ram_coating` | Radar-Absorbent Material (RAM) Coating | `stealth` | Exterior surface coating attenuating residual electromagnetic radar wave reflections. | [USAF Museum Fact Sheet](https://www.nationalmuseum.af.mil/Visit/Museum-Exhibits/Fact-Sheets/Display/Article/198056/lockheed-f-117a-nighthawk/) |
| `canopy` | Conductive-Coated Faceted Canopy | `cockpit` | Faceted canopy with conductive film preventing radar energy from entering the cockpit cavity. | [USAF Museum Fact Sheet](https://www.nationalmuseum.af.mil/Visit/Museum-Exhibits/Fact-Sheets/Display/Article/198056/lockheed-f-117a-nighthawk/) |
| `cockpit_interior` | Cockpit Station & ACES II Seat | `cockpit` | Single-crew cockpit station with ACES II zero-zero rocket ejection seat and flight controls. | [USAF Museum Fact Sheet](https://www.nationalmuseum.af.mil/Visit/Museum-Exhibits/Fact-Sheets/Display/Article/198056/lockheed-f-117a-nighthawk/) |
| `avionics_bay` | Fly-By-Wire Flight Computers | `avionics` | Redundant digital flight control computers providing artificial stabilization corrections. | [Lockheed Martin History](https://www.lockheedmartin.com/en-us/news/features/history/f-117.html) |
| `sensor_flir` | Optical Target Sensor (FLIR Turret) | `avionics` | Passive infrared thermal imaging and laser target designation sensor recessed behind a fine screen. | [USAF Museum Fact Sheet](https://www.nationalmuseum.af.mil/Visit/Museum-Exhibits/Fact-Sheets/Display/Article/198056/lockheed-f-117a-nighthawk/) |
| `engine_left` / `engine_right` | Twin Non-Afterburning Turbofans | `propulsion` | Low-bypass turbofans (F404-GE-F1D2 derivative) delivering subsonic thrust without afterburner heat bloom. | [USAF Museum Fact Sheet](https://www.nationalmuseum.af.mil/Visit/Museum-Exhibits/Fact-Sheets/Display/Article/198056/lockheed-f-117a-nighthawk/) |
| `intake_left` / `intake_right` | S-Duct Intakes & Radar Grid Screens | `propulsion` | Curved serpentine air ducts concealing compressor blades, fronted by conductive radar grid screens. | [USAF Museum Fact Sheet](https://www.nationalmuseum.af.mil/Visit/Museum-Exhibits/Fact-Sheets/Display/Article/198056/lockheed-f-117a-nighthawk/) |
| `exhaust_nozzle` | 2D Platypus Exhaust Nozzle & Shield | `propulsion` | Flat horizontal slit exhaust nozzle lined with heat-shield tiles; mixes bypass air to suppress infrared signature. | [Lockheed Martin History](https://www.lockheedmartin.com/en-us/news/features/history/f-117.html) |
| `weapons_bay` | Internal Dual Weapons Bay | `payload` | Divided central internal weapons cavity keeping munitions enclosed within the airframe. | [USAF Museum Fact Sheet](https://www.nationalmuseum.af.mil/Visit/Museum-Exhibits/Fact-Sheets/Display/Article/198056/lockheed-f-117a-nighthawk/) |
| `bay_door_left` / `bay_door_right` | Serrated Weapons Bay Doors | `payload` | Structural doors with sawtooth edge serrations channeling diffracted radar reflections away from threat sectors. | [USAF Museum Fact Sheet](https://www.nationalmuseum.af.mil/Visit/Museum-Exhibits/Fact-Sheets/Display/Article/198056/lockheed-f-117a-nighthawk/) |
| `weapon_rack_left` / `weapon_rack_right` | Trapeze Weapon Extension Racks | `payload` | Articulating hydraulic trapezes extending bombs into the free airstream before release. | [USAF Museum Fact Sheet](https://www.nationalmuseum.af.mil/Visit/Museum-Exhibits/Fact-Sheets/Display/Article/198056/lockheed-f-117a-nighthawk/) |
| `ordnance_left` / `ordnance_right` | Guided Bombs (GBU-27 Derivative) | `payload` | Precision-guided penetrator bombs with laser seeker nose and airfoil guidance fins. | [USAF Museum Fact Sheet](https://www.nationalmuseum.af.mil/Visit/Museum-Exhibits/Fact-Sheets/Display/Article/198056/lockheed-f-117a-nighthawk/) |
| `wing_left` / `wing_right` | Swept Faceted Wings & Elevons | `aerodynamics` | Highly swept leading edge deflecting lateral radar returns; trailing elevons provide pitch and roll control. | [FAA PHAK Ch. 7](https://www.faa.gov/sites/faa.gov/files/09_phak_ch7.pdf) |
| `vtail_left` / `vtail_right` | Canted All-Moving V-Tail Ruddervators | `aerodynamics` | All-moving vertical stabilizers canted outward; prevents 90-degree corner radar reflection traps. | [FAA PHAK Ch. 7](https://www.faa.gov/sites/faa.gov/files/09_phak_ch7.pdf) |
| `landing_gear` | Retractable Tricycle Landing Gear | `airframe` | Oleo-pneumatic shock struts and wheels retracting flush into fuselage wells behind doors during flight. | [FAA PHAK Ch. 7](https://www.faa.gov/sites/faa.gov/files/09_phak_ch7.pdf) |

For model design, query illustrative notes. Never treat this return value as verified narration evidence:
```python
fact_dict = teardown.facts("radar_deflection")  # or facts("turbofan_engines")
```

## Exploded view & disassembly animation

Disassembly is posed as a pure function of time `t` (0.0 = fully assembled, 1.0 = fully exploded). Every frame renders independently without keyframes:

```python
# In your render loop / frame pose callback:
jet.pose(t, mode="exploded", stagger=True)
```

With `stagger=True` (default), the teardown follows a illustrative 3-phase separation:
1. **Phase 1 (t = 0.0 to 0.5):** Outer airframe shell lifts up, lower hull drops down, the canopy lifts its front 22 degrees (done by t = 0.4), and the bay doors swing down and out 55 degrees about their outer hinge edge (done by t = 0.5). Hinged parts follow their own stagger window.
2. **Phase 2 (t = 0.25 to 0.75):** Internal subsystems separate laterally—turbofan engines slide out, S-duct intakes pull outward, platypus nozzle slides aft, and fly-by-wire avionics rack glides forward.
3. **Phase 3 (t = 0.45 to 1.0):** Hydraulic trapeze racks extend downward out of the weapons bay, guided bombs lower, and landing gear deploys.

To assemble or hold in rest configuration, pass `mode="assembled"` or `t = 0.0`.

## X-Ray cutaway & subsystem isolation

When the script discusses internal mechanisms while wanting to keep the aircraft silhouette visible:

```python
# Turn exterior skin semi-transparent with glowing Fresnel rim:
jet.set_xray(True)

# Highlight a specific subsystem (illuminates target, dims the rest):
jet.highlight("propulsion", color=(0.2, 0.9, 1.0), strength=3.5)
# Or a specific part:
jet.highlight("avionics_bay", color=(1.0, 0.75, 0.1))

# Restore normal materials:
jet.reset_highlight()
jet.set_xray(False)
```

With X-ray on, `highlight()` keeps the shell transparent (only non-shell parts are dimmed), and `reset_highlight()` leaves X-ray on. A target that is not a part id or subsystem raises `KeyError`.

Available subsystem categories for `highlight()`:
- `"airframe"` (faceted upper and lower hulls, landing gear)
- `"stealth"` (RAM coating layer)
- `"cockpit"` (canopy, ejection seat, tub)
- `"avionics"` (fly-by-wire computers, FLIR sensor)
- `"propulsion"` (turbofans, S-duct intakes, platypus nozzle)
- `"payload"` (weapons bay, serrated doors, trapezes, guided bombs)
- `"aerodynamics"` (swept wings, elevons, canted V-tails)

## Technical callouts & labels

Highlight a part with a floating readout. Give it the camera pose of the shot that shows it:

```python
jet.callout("exhaust_nozzle", "PLATYPUS 2D NOZZLE: IR SUPPRESSION", pose="propulsion_rear")  # t defaults to that pose's beat
jet.set_callout_visible("exhaust_nozzle", False)   # hide it outside its own shot
```

The first argument must be a **part id** from the table above (not a `teardown.facts()` key such as `platypus_exhaust`; an unknown id raises `KeyError`). The text is broken into short lines (18 letters), sized to about 55 percent of the frame width at that camera, turned to the camera and placed just above the part on screen, inside the text safe area. It is static: right for that pose and that `t` only (pass `t=` for a different beat, or a `{pos, target, lens}` dict for a custom camera). Create one per shot and switch it on only during the shot in which the narration names that part; show at most one callout banner at a time. The text QA checks every visible text object at every frame, so hidden labels must be hidden with `set_callout_visible`, not left in view.

## Suggested camera poses for vertical 1080x1920

The vertical frame is narrow and the exploded jet is wide, so these poses look down from above or from a low side angle. Each was measured with every vertex of the parts in its beat inside the frame (safe margin 4 percent), the camera outside every part and above the pedestal (fenced CPU probe `tools/codebuilt/probe-stealth-jet-teardown.py`). Use them with the beat time `t` listed in `teardown.CAMERA_BEATS`; change a pose and the parts will leave the frame.

```python
from blender_worker.codebuilt.teardown import CAMERA_POSES, CAMERA_BEATS

# 1. `exploded_wide` (t = 1.0): high 3/4 view, 55 degrees up, whole exploded aircraft wing tip to wing tip:
cam.set(pos=(9.9, -20.1, 30.1), target=(-1.0, -1.8, -0.4), lens=35)

# 2. `cockpit_avionics` (t = 1.0): front 3/4 close-up on the lifted canopy, cockpit station and flight-control computers:
cam.set(pos=(3.4, 10.3, 8.5), target=(0.0, 4.8, 2.0), lens=50)

# 3. `propulsion_rear` (t = 0.75): rear 3/4 from above on the turbofans, intakes and flat nozzle:
cam.set(pos=(-8.8, -20.4, 16.6), target=(-0.6, -2.7, 0.2), lens=45)

# 4. `weapons_bay_low` (t = 0.95): low angle just above the pedestal looking up at the open bay doors, racks and lowered bombs:
cam.set(pos=(8.0, -12.5, -5.1), target=(0.0, -0.5, -2.6), lens=40)

# 5. `facets_stealth` (t = 0.0): head-on view of the faceted nose and canopy:
cam.set(pos=(0.0, 12.0, 2.5), target=(0.0, 2.0, 0.5), lens=45)
```

Never put the camera below the pedestal top (about -5.6 m): the disc is opaque.

## Shot rhythm & direction playbook

A strong 30–45 second teardown explainer short follows this structure:

1. **Shot 1 (0 to 3 s, Hook):** Aircraft in flight or on presentation pedestal (`mode="assembled"`). Direct question: *"How does a stealth jet avoid radar?"* Camera pushes in on faceted nose.
2. **Shot 2 (3 to 8 s, The Big Disassembly):** Exploded view animation (`t` moves 0.0 → 1.0). High isometric camera (`exploded_wide`). The jet pulls apart into its major engineering systems.
3. **Shot 3 (8 to 14 s, Stealth Shaping & RAM):** Close on faceted skin and canopy (`facets_stealth`). `jet.highlight("stealth")`. Explains why flat angles reflect radar away from the emitter, and how the RAM coating absorbs remaining waves.
4. **Shot 4 (14 to 20 s, S-Duct & Engines):** Camera tracks to rear (`propulsion_rear`). `jet.highlight("propulsion")`. Shows S-duct curves hiding the spinning fan blades, and the flat platypus nozzle cooling the exhaust gas.
5. **Shot 5 (20 to 26 s, Internal Weapons Bay):** Low upward camera (`weapons_bay_low`). Bay doors open, trapezes lower the laser-guided bombs. Explains why carrying bombs externally would create huge radar returns.
6. **Shot 6 (26 to 32 s, Fly-By-Wire & Payoff):** Close-up on cockpit and avionics (`cockpit_avionics`). Explains how digital computers stabilize the faceted plane continuously. Aircraft reassembles smoothly (`t` goes 1.0 → 0.0) for the closing payoff.

## Rules & constraints

- **No external downloads:** Built 100% from procedural NumPy/Blender meshes.
- **Keep subject above captions:** Keep the main action in the upper 60% of the frame; captions sit low in the bottom 25%.
- **Render cost:** The complete model has 24 parts, 937 vertices, and 1134 faces, extremely fast to render in Blender EEVEE and Cycles (render time depends on the scene and hardware).
- **Framing:** Exploded, the jet is about 20 m wide, so in a 9:16 frame it fills the width and about 40 percent of the height at `exploded_wide`. Do not zoom in on the whole exploded jet; cut to a close pose instead.

Narration constraint: the example shot beats above illustrate generic mechanisms only. Never infer a real F-117 configuration from this geometry. Fact-check every specific assertion independently; omit unsupported details.
