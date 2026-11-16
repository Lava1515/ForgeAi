---
name: codebuilt-look-review
description: How to review the preview frames of a code-built 3D explainer short and fix the build script (what to look for, how to diagnose from the script's numbers). Loaded by the pipeline at the visual check step.
---

# Code-built look review

Project-authored guidance for the visual check. It restates, for this pipeline, what the installed skills `video-release-qa`, `lookdev`, `cinematic-camera` and `shorts-video-director` teach about reviewing, and the faults that the drafts of 2026-11-13 shipped with. The reply format and the limits in the prompt always win over this text.

## How to look

1. Go through the tiles shot by shot and write what is actually visible, not what the script intends. If you cannot tell what a tile shows, that is the finding.
2. For each shot answer five questions: Is the subject immediately visible on the very first frame (tile 0 / frame 1 of shot 0)? Is it the place and subject the direction asked for? Is the subject large and in the upper middle of the frame? Is it lit so it can be read? Did something change between this shot's tiles?
3. Check surface finish: Does the main subject have rich surface texture (wood grain, brushed or painted metal with worn edges, concrete pores, rock strata, fabric sheen, bump, rounded edges), or is it a flat untextured solid colour? Flag flat-colour main subjects.
4. Judge as a viewer on a phone who sees each shot for a few seconds. Small, dark or confusing is a fault even if it is technically correct.
5. Then judge the whole: one palette, a recurring character that stays the same, alternating framings, an ending that is a finished picture.

## Severity

- P0: the shot cannot ship. A flat single-colour frame, a black frame, a white blob instead of the subject, a subject that is a dot or absent, a first frame that does not show the subject (opening on empty scenery, ground, or sky before the subject arrives, losing the viewer in the first second), a place unrelated to the words, a plate or wall covering the view, a missing planned shot.
- P1: the shot should be fixed. Flat-colour main subject (the hero subject uses plain untextured solid colour without bump, grain, worn edges, or procedural surface definition instead of the surface kit: `materials.wood`, `materials.painted_metal`, `materials.brushed_metal`, `materials.concrete`, `materials.rock`, `materials.fabric`, `materials.earth_relief`, etc.), subject cut by the frame edge, too small, low in the caption band, leftover objects from another shot, identical tiles within a shot, two neighbouring shots that look the same, text unreadable, a floating or intersecting object, an empty ending.
- P2: a note. Do not spend edits on P2 while a P0 or P1 remains.

## Diagnose from the numbers in the script

Always find the cause in the script before writing an edit. Read the place's origin, the subject's position and size, and the `cam.set` pose of the shot.

- First frame missing subject: shot 0 opens with the camera pointed at empty space, or the subject is scaled `(0, 0, 0)` or positioned off-camera waiting for a cue time. Fix: pose the main subject in frame on frame 0 (t = 0) so the video immediately hooks the viewer.
- Flat-colour main subject: the script assigned `materials.col(...)` to the hero subject or primary props. Fix: replace with the appropriate procedural surface from `materials` (`materials.painted_metal`, `materials.wood`, `materials.brushed_metal`, `materials.concrete`, `materials.rock`, `materials.fabric`, `materials.soil`, `materials.grass`, `materials.rubber`, `materials.water`, `materials.ice`, `materials.glass`, `materials.earth_relief`) with `bump` and `bevel` (rounded edges) or `wear` (worn edges).
- One flat colour: the camera is inside or facing a large surface. Compare the camera position with the ground height, the sky dome radius and centre, the walls, and any backdrop card of a ready set (the space sets have one about 45 m behind the subject; cameras must stay on the -Y side). A camera beyond the radius of a sky dome sees the dome's outside, also one flat colour. Move the camera to a tested pose of the set or recompute it from the subject.
- Black or very dark: the place has no light of its own, the light is in another place's collection, the light is hundreds of metres away, or the camera looks away from everything. Add or move lights into this place's collection; for an area light, quadruple the watts for double the distance.
- White blob: an emissive surface over strength 3 near the camera, or an area light of tens of kilowatts a few metres from the subject. Lower the strength or move the light back.
- Subject tiny: recompute the distance from `d = h * L / (36 * k)` with k = 0.5, or raise the lens. Check that the target is the subject and not the place origin.
- Subject cut or off to one side: the target is wrong, or the subject moved during the shot and the camera did not. Aim at the subject's position at that time.
- Wrong thing visible: the shot uses the wrong place name in the shots list, or the place's reset does not hide other shots' objects.
- Nothing moves: the shot uses `t` as if it started at 0. Use `local = t - SHOT_STARTS[i]`.
- A readout cropped or huge: fit it with `stage.hud(cam, obj, x, y, dist, scale)` after `cam.set`, with a plate at most 70 percent of the frame width.

## Diagrams and text: measure, do not guess

"Small", "thin", "unreadable" on a diagram can mean two opposite faults. In the Everest draft (job mwhu3xfu-a118b6) the triangle was called small and thin for three rounds, "move closer" was asked each time, and the cause was that its corners were already off the frame (x = -0.02 and 1.08): closer made it worse. So for a diagram, a chart, an arrow or a number card:

1. List its corner and end points from the script and project them. Frame height at distance d with lens L is `d * 36 / L`, width 9/16 of that. A point is off screen when its offset from the aim point is more than half of that. If any corner is outside, or the whole diagram is under 45 percent of the frame width, say which; the fix is to pull back (corners) or enlarge it (size).
2. Work out each stroke and capital in pixels: stroke / frame width * 1080 (need 15 or more), capital height / frame height * 1920 (need 50 or more). Layer lines of 0.22 m seen from 85 m are 5 px; that is the finding, not "thin".
3. Fix by rebuilding the diagram on a `diagram.Board` (the kit's `diagram` module, described in the scene-generation guidance) with `b.camera(cam, ...)`, instead of repeating a number change. If the same diagram or label finding appears in two rounds, the diagnosis was wrong: do not change the same numbers again, rebuild it on a board.
4. A diagram board may be up to 84 percent of the frame wide; labels on it stay few and short (6 at most). The 70 percent width limit is for readout plates and labels.

## Writing the fix

- Fix every P0 and P1 you found in the same reply. Looks are limited; a fault left for "next round" may ship.
- Prefer changing numbers and poses to rewriting geometry. When a place is beyond repair, rebuild that one place simply and solidly (ground, sky, horizon, five props, lights) rather than patching it again.
- When an earlier fix did not work, do not repeat it with different numbers: the diagnosis was wrong. Re-derive the camera and subject positions.
- Do not introduce new risk in shots that are fine.
- A pass means you would be content to publish every tile.
