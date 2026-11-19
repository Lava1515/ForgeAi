// The local CC0 asset library (blender_worker/codebuilt/assets), as the build and direction models are told about it.
// codex · gpt-6.1-sol · 2026-11-19 20:02 +02:00: authored lighting requires the local library. It is git-ignored: tools/asset_library.py fetches it on the host. When no catalog is present,
// or CODEBUILT_ASSET_LIBRARY=0, this catalog text is empty; the authored contract reports the missing prerequisite.
// Read once at server start; restart the dashboard after the library changes.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
export const ASSET_ROOT = path.join(REPO_ROOT, 'blender_worker', 'codebuilt', 'assets');
const SAFE_ID = /^[A-Za-z0-9_.-]{1,80}$/;

/** Catalog entries whose file is really on disk, inside the library folder. A broken or missing catalog gives []. */
export function readAssetCatalog(root = ASSET_ROOT, env = process.env) {
  if (env.CODEBUILT_ASSET_LIBRARY === '0') return [];
  let assets;
  try { assets = JSON.parse(fs.readFileSync(path.join(root, 'catalog.json'), 'utf8')).assets; } catch { return []; }
  if (!Array.isArray(assets)) return [];
  const base = path.resolve(root) + path.sep;
  return assets.filter((a) => {
    if (!a || !SAFE_ID.test(String(a.id)) || !['hdri', 'model', 'person'].includes(a.kind) || typeof a.file !== 'string') return false;
    if (/^weapons(?:\/|$)/i.test(String(a.category ?? '')) || /rifle|sword|katana|cannon/i.test(a.id)) return false;
    const file = path.resolve(root, a.file);
    return file.startsWith(base) && fs.statSync(file, { throwIfNoEntry: false })?.isFile() === true;
  });
}

const leaf = (category) => String(category ?? '').split('/').filter(Boolean).pop() ?? '';
const height = (a) => (Array.isArray(a.dimensions_m) && a.dimensions_m.length === 3 ? `${Number(a.dimensions_m[2]).toFixed(2)} m tall` : 'size unknown');
const clean = (s) => String(s ?? '').replace(/[^A-Za-z0-9 ,.&'()/-]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);

/** The paragraph added to the kit contract. '' when the library is empty. */
export function assetContractText(assets) {
  if (!assets.length) return '';
  const of = (kind) => assets.filter((a) => a.kind === kind);
  const hdris = of('hdri').map((a) => {
    const t = a.attributes ?? {};
    return `${a.id} (${clean([t.environment, t.time_of_day, t.weather, t.light_type].filter(Boolean).join(' '))})`;
  });
  const models = of('model').map((a) => `${a.id} (${clean(leaf(a.category))}, ${height(a)})`);
  const people = of('person').map((a) => `${a.id} (${clean(String(a.description ?? '').split(';')[0])})`);
  return `ASSET LIBRARY (required for authored scene lighting; real photographed light and real scanned or modelled objects, already on disk, CC0). Add library to the kit import: from blender_worker.codebuilt import ..., library. On the authored route use library.hdri for sky or room lighting. The subject and ground must use surface helpers or an available library texture; small eyes, markers and glows may stay plain. Models and people can be chosen where they improve the picture; the story's special subject is still built from code so its parts can move. Only the ids listed here exist; any other id raises an error.
- library.hdri(scene, id, strength=1.0, rotation_deg=0.0, visible=False, background=(r,g,b)) lights the whole scene from a real sky or room and replaces the world. visible=False keeps a plain background colour behind the scene (studio look); visible=True shows the photograph (an outdoor place without a sky dome: then do not also add props.sky). One world per video: call it once after the render settings, or call it at the top of each shot function when places need different light. With an hdri, lower or drop stage.sun and area fills (start at a third of their usual energy) and check exposure in the preview. Turn rotation_deg until the sun comes from the side of the camera.
- library.model(c, id, loc=(x,y,z), height=None, scale=1.0, yaw_deg=0.0) appends a model into collection c and returns its root object; the model stands on loc. Models are real size in metres; height=h rescales to h scene units tall. Move, turn, scale or hide (scale 0) the root per frame. library.parts(root) -> {name: mesh object}.
- People: the same library.model call with a person id; a person faces -Y and is about 1.6 to 1.8 m tall. Pose every frame with library.pose_person(root, arms_down=1.0, arms=(left, right), legs=(left, right), head_yaw=0.0), swings in radians, forward positive; a walk is legs=(0.5*sin(t*8), -0.5*sin(t*8)) with arms=(-0.4*sin(t*8), 0.4*sin(t*8)) while the root moves at about 1.4 m/s. Use them for crowds, workers and bystanders at real scale; figures.make_person stays for toy looks.
Skies and rooms: ${hdris.join('; ')}.
Models: ${models.join('; ')}.
People: ${people.join('; ')}.`;
}

/** One line for the director, who only needs to know what exists. '' when the library is empty. */
export function assetPickerText(assets) {
  if (!assets.length) return '';
  const count = (kind) => assets.filter((a) => a.kind === kind).length;
  const kinds = [...new Set(assets.filter((a) => a.kind === 'model').map((a) => clean(String(a.category ?? '').split('/')[0])).filter(Boolean))];
  return `real asset library: ${count('hdri')} photographed skies and rooms for lighting (day, sunset, night, overcast, studio, interiors), ${count('person')} realistic clothed people who can walk and gesture, ${count('model')} real-size models (${kinds.join(', ').toLowerCase()})`;
}

const ASSETS = readAssetCatalog();
export const ASSET_CONTRACT_TEXT = assetContractText(ASSETS);
export const ASSET_PICKER_TEXT = assetPickerText(ASSETS);
export const ASSET_IDS = Object.freeze(ASSETS.map((a) => a.id));
