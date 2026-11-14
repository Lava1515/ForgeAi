---
name: codebuilt-teardown
description: How to use the teardown kit (stylized stealth jet how-it-works, procedural disassembly, illustrative part names, exploded views, X-ray cutaway, subsystem highlights, and camera framing) in a code-built explainer short. Loaded by topic at the direction and build steps.
---

# Code-built teardown: stylized stealth jet

Topic kit for "how it works" engineering explainer shorts. Features a stylized stealth jet built entirely from procedural shapes (no downloaded models or external assets). The parts are illustrative design choices, not verified F-117 specifications. Do not narrate their names or mechanisms as facts about a real aircraft without independent source verification.

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

`teardown.build` returns a `StealthJet` instance controlling 17+ distinct subsystems organized as child objects under a root empty. All parts are centered around the aircraft datum (length ~14 m, wingspan ~10 m, height ~3 m).

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
1. **Phase 1 (t = 0.0 to 0.45):** Outer airframe shell lifts up, lower hull drops down, canopy opens upward, and bay doors swing open 55 degrees.
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

Available subsystem categories for `highlight()`:
- `"airframe"` (faceted upper and lower hulls, landing gear)
- `"stealth"` (RAM coating layer)
- `"cockpit"` (canopy, ejection seat, tub)
- `"avionics"` (fly-by-wire computers, FLIR sensor)
- `"propulsion"` (turbofans, S-duct intakes, platypus nozzle)
- `"payload"` (weapons bay, serrated doors, trapezes, guided bombs)
- `"aerodynamics"` (swept wings, elevons, canted V-tails)

## Technical callouts & labels

Highlight a part with a floating 3D readout banner:

```python
jet.callout("platypus_exhaust", "PLATYPUS 2D NOZZLE: IR SUPPRESSION")
```

Place callouts only during the shot in which the narration names that part. Show at most one callout banner at a time; remove or hide it when transitioning to the next beat.

## Suggested camera poses for vertical 1080x1920

Vertical 1080x1920 frame requires steep perspective and generous vertical clearance so exploded pieces do not clip off-screen. Suggested poses; verify visibility and framing in preview:

```python
from blender_worker.codebuilt.teardown import CAMERA_POSES

# 1. High isometric 3/4 view framing the complete exploded aircraft:
cam.set(pos=(9.5, -16.0, 11.0), target=(0.0, 0.0, 0.5), lens=35)

# 2. Close-up on the cockpit canopy, ACES II seat, and fly-by-wire avionics:
cam.set(pos=(2.2, 5.5, 4.0), target=(0.0, 2.0, 1.5), lens=50)

# 3. Rear 3/4 look at twin turbofans and flat platypus heat-shield nozzle:
cam.set(pos=(-3.5, -10.0, 3.5), target=(0.0, -2.5, 0.5), lens=45)

# 4. Low dramatic angle looking up into the serrated weapons bay and lowered bombs:
cam.set(pos=(3.0, -4.5, 1.5), target=(0.0, -0.5, 0.5), lens=40)

# 5. Direct head-on view of the radar-deflecting faceted nose angles:
cam.set(pos=(0.0, 12.0, 2.5), target=(0.0, 2.0, 0.5), lens=45)
```

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
- **Render cost:** The complete model has 24 parts, 937 vertices, and 1,134 faces—extremely fast to render in Blender EEVEE and Cycles (render time depends on the scene and hardware).

Narration constraint: the example shot beats above illustrate generic mechanisms only. Never infer a real F-117 configuration from this geometry. Fact-check every specific assertion independently; omit unsupported details.
