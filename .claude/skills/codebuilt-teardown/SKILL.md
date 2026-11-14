---
name: codebuilt-teardown
description: How to use the teardown kit (stylized stealth jet how-it-works, procedural disassembly, sourced part names, exploded views, X-ray cutaway, subsystem highlights, and camera framing) in a code-built explainer short. Loaded by topic at the direction and build steps.
---

# Code-built teardown: stylized stealth jet

Topic kit for "how it works" engineering explainer shorts. Features a stylized stealth jet built entirely from procedural shapes (no downloaded models or external assets). Every part name, subsystem role, and physical principle is sourced from authoritative public aerospace archives.

Use this kit when the narration explains how stealth aircraft avoid radar, how jet engines reduce infrared heat signatures, how internal weapons bays operate, or how fly-by-wire stabilizes unstable airframes. If the topic is not about stealth aircraft or teardown mechanisms, ignore this text. The brief and direction always win.

## Where the kit is

```python
import sys; sys.path.insert(0, '/kit')
from blender_worker.codebuilt import teardown

# Build the aircraft into a place collection
jet = teardown.build(c, origin=(x, y, z), scale=1.0)

# Or build the complete lit studio teardown set (pedestal, 3-point lights, jet)
studio = teardown.build_set(origin=(x, y, z))
jet = studio['jet']
```

`teardown.build` returns a `StealthJet` instance controlling 17+ distinct subsystems organized as child objects under a root empty. All parts are centered around the aircraft datum (length ~14 m, wingspan ~10 m, height ~3 m).

## Sourced parts & technical facts

Every part in the model corresponds to an official aerospace subsystem:

| Part ID | Sourced part name | Subsystem | Engineering function & physical principle | Public source |
|---|---|---|---|---|
| `fuselage_upper` | Faceted Upper Airframe Shell | `airframe` | Sloped diamond facet panels (>30° tilt) that reflect radar beams away from transmitting antennas. | USAF National Museum F-117A Fact Sheet; Lockheed Martin Skunk Works History |
| `fuselage_lower` | Faceted Lower Hull & Belly | `airframe` | Ventral faceted hull shielding internal components from ground-based threat radars. | USAF National Museum F-117A Fact Sheet; Richardson, *Stealth Warplanes* |
| `ram_coating` | Radar-Absorbent Material (RAM) Skin | `stealth` | Elastomeric coating with carbonyl-iron/ferrite particles converting residual radar waves into heat via magnetic hysteresis. | USAF National Museum Materials Notes; NASA TM Low Observables Overview |
| `canopy` | Gold/ITO Vapor-Coated Canopy | `cockpit` | Faceted canopy coated with transparent indium-tin-oxide gold film to ground radar and prevent cockpit cavity reflections. | USAF National Museum Fact Sheet; Aronstein & Piccirillo, *HAVE BLUE and the F-117A* (AIAA) |
| `cockpit_interior` | Cockpit Tub & ACES II Seat | `cockpit` | Single-crew cockpit with ACES II zero-zero rocket ejection seat, Head-Up Display (HUD), and multi-function displays. | USAF National Museum Fact Sheet; Collins Aerospace ACES II Specifications |
| `avionics_bay` | Quad Fly-By-Wire Flight Computers | `avionics` | Quadruple-redundant digital computers executing 40 Hz stability micro-corrections for the unstable faceted airframe. | Aronstein & Piccirillo, *HAVE BLUE and the F-117A* (AIAA) |
| `sensor_flir` | Forward-Looking Infrared (FLIR) | `avionics` | Passive dual-band thermal imaging and laser target designator recessed behind fine conductive wire screen. | USAF National Museum Fact Sheet; Raytheon / TI IRADS Technical Summary |
| `engine_left` / `engine_right` | Twin Non-Afterburning Turbofans | `propulsion` | High-bypass turbofans (~10,600 lbf thrust each); non-afterburning to eliminate IR heat bloom and sonic shockwaves. | USAF National Museum F-117A Fact Sheet; GE F404 Turbofan Data Sheet |
| `intake_left` / `intake_right` | S-Duct Intakes & Absorber Grids | `propulsion` | Serpentine composite ducts concealing compressor blades from radar line-of-sight, fronted by 0.5-inch conductive grids. | NASA TM-104326; Richardson, *Stealth Warplanes* |
| `exhaust_nozzle` | 2D Platypus Exhaust Nozzle | `propulsion` | 12:1 flat horizontal slit nozzle lined with ceramic heat tiles; mixes bypass air to shield turbine faces from IR heat seekers. | Lockheed Martin F-117 Propulsion Architecture; Richardson |
| `weapons_bay` | Internal Dual Weapons Bay | `payload` | Divided central weapons bay keeping munitions enclosed within the hull so external stores do not destroy stealth RCS. | USAF National Museum F-117A Fact Sheet; Aronstein & Piccirillo |
| `bay_door_left` / `bay_door_right` | Serrated Sawtooth Bay Doors | `payload` | Structural doors with sawtooth perimeter serrations that channel diffracted radar reflection spikes into narrow, safe angles. | USAF National Museum Fact Sheet; NASA Low Observable Principles |
| `weapon_rack_left` / `weapon_rack_right` | Extending Trapeze Ordnance Racks | `payload` | Articulating hydraulic trapezes extending bombs into the free airstream before release to avoid cavity turbulence. | USAF National Museum F-117A Fact Sheet; Lockheed Martin Weapons Summary |
| `ordnance_left` / `ordnance_right` | GBU-27 Laser-Guided Penetrator Bombs | `payload` | 2,000 lb BLU-109 penetrating precision-guided bombs with semi-active laser guidance nose and folding airfoil fins. | USAF Fact Sheet (GBU-27 Paveway III / GBU-10); Raytheon Missiles & Defense |
| `wing_left` / `wing_right` | 67.5° Swept Faceted Wings & Elevons | `aerodynamics` | Extreme 67.5-degree swept leading edge deflecting lateral radar returns; trailing elevons provide pitch and roll control. | USAF National Museum F-117A Fact Sheet; Lockheed Martin History |
| `vtail_left` / `vtail_right` | 48° Canted All-Moving Ruddervators | `aerodynamics` | Outward-canted (48°) all-moving twin vertical stabilizers; eliminates 90° corner reflectors that create massive radar traps. | USAF National Museum Fact Sheet; NASA Aeronautical Design Reports |
| `landing_gear` | Retractable Tricycle Landing Gear | `airframe` | Oleo-pneumatic struts and wheels retracting flush behind serrated doors during flight. | USAF National Museum F-117A Fact Sheet; FAA-H-8083-25B, Chapter 7 |

For narration scripts, query verified facts directly:
```python
fact_dict = teardown.facts("radar_deflection")  # or facts("platypus_exhaust")
```

## Exploded view & disassembly animation

Disassembly is posed as a pure function of time `t` (0.0 = fully assembled, 1.0 = fully exploded). Every frame renders independently without keyframes:

```python
# In your render loop / frame pose callback:
jet.pose(t, mode="exploded", stagger=True)
```

With `stagger=True` (default), the teardown follows a realistic 3-phase engineering disassembly:
1. **Phase 1 (t = 0.0 to 0.45):** Outer airframe shell lifts up, lower hull drops down, canopy opens upward, and bay doors swing open 55 degrees.
2. **Phase 2 (t = 0.25 to 0.75):** Internal subsystems separate laterally—turbofan engines slide out, S-duct intakes pull outward, platypus nozzle slides aft, and fly-by-wire avionics rack glides forward.
3. **Phase 3 (t = 0.45 to 1.0):** Hydraulic trapeze racks extend downward out of the weapons bay, laser-guided bombs lower, and landing gear deploys.

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
- `"payload"` (weapons bay, serrated doors, trapezes, GBU-27 bombs)
- `"aerodynamics"` (swept wings, elevons, canted V-tails)

## Technical callouts & labels

Highlight a part with a floating 3D readout banner:

```python
jet.callout("platypus_exhaust", "PLATYPUS 2D NOZZLE: 12:1 IR HEAT SHIELD")
```

Place callouts only during the shot in which the narration names that part. Show at most one callout banner at a time; remove or hide it when transitioning to the next beat.

## Tested camera poses for vertical 1080x1920

Vertical 1080x1920 frame requires steep perspective and generous vertical clearance so exploded pieces do not clip off-screen. Tested poses:

```python
from blender_worker.codebuilt.teardown import CAMERA_POSES

# 1. High isometric 3/4 view framing the complete exploded aircraft:
cam.set(pos=(9.5, -16.0, 11.0), target=(0.0, 0.0, 0.5), lens=35)

# 2. Close-up on the cockpit canopy, ACES II seat, and fly-by-wire avionics:
cam.set(pos=(2.2, 5.5, 4.0), target=(0.0, 2.0, 1.5), lens=50)

# 3. Rear 3/4 look at twin turbofans and flat platypus heat-shield nozzle:
cam.set(pos=(-3.5, -10.0, 3.5), target=(0.0, -2.5, 0.5), lens=45)

# 4. Low dramatic angle looking up into the serrated weapons bay and lowered bombs:
cam.set(pos=(3.0, -4.5, -4.5), target=(0.0, -0.5, -1.0), lens=40)

# 5. Direct head-on view of the radar-deflecting faceted nose angles:
cam.set(pos=(0.0, 12.0, 2.5), target=(0.0, 2.0, 0.5), lens=45)
```

## Shot rhythm & direction playbook

A strong 30–45 second teardown explainer short follows this structure:

1. **Shot 1 (0 to 3 s, Hook):** Aircraft in flight or on presentation pedestal (`mode="assembled"`). Direct question: *"How does a stealth jet become invisible to radar?"* Camera pushes in on faceted nose.
2. **Shot 2 (3 to 8 s, The Big Disassembly):** Exploded view animation (`t` moves 0.0 → 1.0). High isometric camera (`exploded_wide`). The jet pulls apart into its major engineering systems.
3. **Shot 3 (8 to 14 s, Stealth Shaping & RAM):** Close on faceted skin and canopy (`facets_stealth`). `jet.highlight("stealth")`. Explains why flat angles reflect radar away from the dish, and how the RAM coating absorbs remaining waves.
4. **Shot 4 (14 to 20 s, S-Duct & Engines):** Camera tracks to rear (`propulsion_rear`). `jet.highlight("propulsion")`. Shows S-duct curves hiding the spinning fan blades, and the flat 12:1 platypus nozzle cooling the exhaust gas.
5. **Shot 5 (20 to 26 s, Internal Weapons Bay):** Low upward camera (`weapons_bay_low`). Bay doors open, trapezes lower the 2,000 lb laser-guided bombs. Explains why carrying bombs externally would create huge radar returns.
6. **Shot 6 (26 to 32 s, Fly-By-Wire & Payoff):** Close-up on cockpit and avionics (`cockpit_avionics`). Explains how quad computers stabilize an unstable diamond plane 40 times per second. Aircraft reassembles smoothly (`t` goes 1.0 → 0.0) as the video loops.

## Rules & constraints

- **No external downloads:** Built 100% from procedural NumPy/Blender meshes.
- **Keep subject above captions:** Keep the main action in the upper 60% of the frame; captions sit low in the bottom 25%.
- **Render cost:** The complete model has 24 parts, 937 vertices, and 1,134 faces—extremely fast to render in Blender EEVEE and Cycles (under 1 second per frame).
