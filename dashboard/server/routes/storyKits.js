/**
 * Scene kit catalog reader, validator, and slice builder for ForgeAI Any-Story Planner (KAN-459 / A12-2).
 *
 * Implements JS mirror of blender_worker/scene_kit.py catalog building:
 * - Reads and validates kit.json files
 * - Enforces licensing, path security, bounds, and schema constraints
 * - Builds catalog slices per Section 4 of docs/superpowers/specs/2026-10-31-any-story-planner.md
 * - Applies allowlists and filters for location and scene passes
 */
import fs from 'node:fs';
import path from 'node:path';
import { resolveWorldsDir } from './worldsDir.js';

// ---- Hard caps and constants matching scene_kit.py and Survey Spec 4.2 ----
export const MAX_TRIANGLES_PER_PIECE = 2500;
export const MAX_TOTAL_TRIANGLES = 45000;
// KAN-757: a hero prop (a generated kit's prop that carries its own model `parts`) has its own cap, not the per-piece one, and counts in the kit total.
export const HERO_MAX_TRIANGLES = 15000;
export const HERO_MAX_INSTANCES = 120; // part instances after repeat and mirror
export const HERO_MAX_SIDE_M = 50;
const HERO_SHAPES = { // the shape kinds a part may have; scene_kit.py HERO_SHAPES is the mirror
  lathe: 1, extrude: 1, loft: 1, box: 1, cylinder: 1, cone: 1, sphere: 1, torus: 1, tube: 1, panel: 1, truss: 1, gear: 1,
};
export const HERO_MAX_COORD = 1000; // metres: every position, length and radius of a part is finite and within +-1000
const HERO_MAX_ROT_DEG = 3600;
const HERO_MAX_SEGMENTS = 256;
const HERO_MAX_POINTS = 64; // profile / outline / path points
const HERO_MAX_SECTIONS = 32;
const HERO_MAX_BAYS = 32;
const HERO_MAX_TEETH = 128;
const HERO_FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype']); // never a key or an id
const HERO_ID = /^[A-Za-z0-9_-]{1,60}$/;
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isWhole = (v) => isNum(v) && Number.isInteger(v) && v >= 1;
const inRange = (v, lo, hi) => isNum(v) && v >= lo && v <= hi;
const coord = (v) => inRange(v, -HERO_MAX_COORD, HERO_MAX_COORD);
const pos = (v) => isNum(v) && v > 0 && v <= HERO_MAX_COORD;
const isTriple = (v, ok = coord) => Array.isArray(v) && v.length === 3 && v.every(ok);
const isPair = (v) => Array.isArray(v) && v.length === 2 && v.every(coord);
const points = (v, lo, check) => Array.isArray(v) && v.length >= lo && v.length <= HERO_MAX_POINTS && v.every(check);
const isRecord = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const has = (o, k) => Object.hasOwn(o, k);
const forbiddenKey = (o) => Object.keys(o).some((k) => HERO_FORBIDDEN.has(k));
const latheTris = (radii, segments, closed = false) => {
  const poles = radii.map((r) => r <= 1e-9);
  const pairs = poles.slice(1).map((_, i) => [poles[i], poles[i + 1]]);
  if (closed) pairs.push([poles[poles.length - 1], poles[0]]);
  return pairs.reduce((n, [x, y]) => n + (x && y ? 0 : x || y ? segments : 2 * segments), 0);
};

/** The problems with one part's shape parameters and, when there are none, the triangles shapes.geometry builds for ONE instance.
 *  scene_kit.py _part_param_errors is the mirror; kitCompiler.js modelTriangles agrees on every valid part. */
export function heroPartIssues(part) {
  const shape = part.shape, bad = [];
  const need = (key, ok, what) => { if (!ok) bad.push(`'${key}' ${what}`); };
  const opt = (key, ok, what) => { if (has(part, key) && !ok) bad.push(`'${key}' ${what}`); };
  const whole = (v, lo, hi) => isNum(v) && Number.isInteger(v) && v >= lo && v <= hi;
  let tris = 0;
  switch (shape) {
    case 'lathe': {
      const prof = part.profile;
      need('profile', points(prof, 2, (q) => isPair(q) && q[0] >= 0), 'must be 2 to 64 [r, z] points with r >= 0');
      opt('segments', whole(part.segments, 3, HERO_MAX_SEGMENTS), 'must be a whole number from 3 to 256');
      if (!bad.length && !prof.some((q) => q[0] > 0)) bad.push("'profile' needs at least one point with r > 0");
      if (!bad.length) tris = latheTris(prof.map((q) => q[0]), has(part, 'segments') ? part.segments : 48);
      break;
    }
    case 'extrude':
      need('outline', points(part.outline, 3, isPair), 'must be 3 to 64 [u, v] points');
      need('depth', pos(part.depth), 'must be a positive length');
      opt('plane', ['xy', 'xz', 'yz'].includes(part.plane), "must be 'xy', 'xz' or 'yz'");
      if (!bad.length) tris = 4 * part.outline.length - 4;
      break;
    case 'loft': {
      const secs = part.sections;
      need('sections', Array.isArray(secs) && secs.length >= 2 && secs.length <= HERO_MAX_SECTIONS && secs.every((x) => isRecord(x) && coord(x.at) && pos(x.w) && pos(x.h)
        && ['ellipse', 'rect'].includes(has(x, 'shape') ? x.shape : 'ellipse') && !forbiddenKey(x)), 'must be 2 to 32 {at, w, h, shape} sections');
      opt('axis', ['x', 'y', 'z'].includes(part.axis), "must be 'x', 'y' or 'z'");
      if (!bad.length) tris = 60 + 64 * (secs.length - 1);
      break;
    }
    case 'box': need('size', isTriple(part.size, pos), 'must be three positive lengths'); tris = 12; break;
    case 'cylinder':
      need('r', pos(part.r), 'must be a positive length'); need('h', pos(part.h), 'must be a positive length');
      tris = latheTris([0, 1, 1, 0], 32);
      break;
    case 'cone':
      need('r1', inRange(part.r1, 0, HERO_MAX_COORD), 'must be a length >= 0'); need('r2', inRange(part.r2, 0, HERO_MAX_COORD), 'must be a length >= 0');
      need('h', pos(part.h), 'must be a positive length');
      if (!bad.length && !(part.r1 > 0 || part.r2 > 0)) bad.push("'r1' and 'r2' cannot both be 0");
      if (!bad.length) tris = latheTris([0, part.r1, part.r2, 0], 32);
      break;
    case 'sphere': need('r', pos(part.r), 'must be a positive length'); tris = 960; break;
    case 'torus':
      need('r', pos(part.r), 'must be a positive length'); need('thickness', pos(part.thickness), 'must be a positive length');
      if (!bad.length) tris = latheTris(Array.from({ length: 12 }, (_, i) => part.r + part.thickness * Math.cos(2 * Math.PI * i / 12)), 32, true);
      break;
    case 'tube': {
      const path = part.path;
      need('path', points(path, 2, (q) => isTriple(q)), 'must be 2 to 64 [x, y, z] points');
      need('r', pos(part.r), 'must be a positive length');
      if (!bad.length && path.slice(1).some((b, i) => [0, 1, 2].reduce((n, k) => n + (b[k] - path[i][k]) ** 2, 0) <= 1e-18)) bad.push("'path' has a zero-length segment");
      if (!bad.length) tris = 28 + 32 * (path.length - 1);
      break;
    }
    case 'panel':
      need('size', isTriple(part.size, pos), 'must be three positive lengths'); need('bevel', inRange(part.bevel, 0, HERO_MAX_COORD), 'must be a length >= 0');
      tris = 28;
      break;
    case 'truss':
      for (const key of ['length', 'width', 'height', 'member']) need(key, pos(part[key]), 'must be a positive length');
      need('bays', whole(part.bays, 1, HERO_MAX_BAYS), 'must be a whole number from 1 to 32');
      if (!bad.length) tris = 12 * (4 + 2 * (part.bays + 1) + 2 * part.bays);
      break;
    case 'gear':
      need('r', pos(part.r), 'must be a positive length'); need('thickness', pos(part.thickness), 'must be a positive length');
      need('teeth', whole(part.teeth, 3, HERO_MAX_TEETH), 'must be a whole number from 3 to 128');
      need('tooth_depth', inRange(part.tooth_depth, 0, HERO_MAX_COORD), 'must be a length >= 0');
      if (!bad.length) tris = 20 * part.teeth - 4;
      break;
    default: break;
  }
  return { bad, tris: bad.length ? 0 : tris };
}

/** KAN-757: the rules of a prop that carries `parts`. Only a generated kit may; scene_kit.py hero_prop_errors is the mirror (they accept and refuse the same kits).
 *  The triangle count is DERIVED from the parts (repeat and mirror included): a declared tri_count below it, or a derived total over the hero cap, is refused. */
export function heroPropErrors(prop, kitId) {
  const where = `prop '${prop.id ?? 'unnamed_prop'}'`;
  if (!(typeof kitId === 'string' && /^gen_[A-Za-z0-9_-]+$/.test(kitId))) return [`${where}: parts are only allowed in generated kits (gen_ ids)`];
  const errors = [];
  if (!(typeof prop.id === 'string' && HERO_ID.test(prop.id) && !HERO_FORBIDDEN.has(prop.id))) errors.push(`${where}: invalid id`);
  const size = prop.size_m;
  if (!(Array.isArray(size) && size.length === 3 && size.every((v) => isNum(v) && v > 0 && v <= HERO_MAX_SIDE_M))) errors.push(`${where}: size_m must be three positive metres, at most ${HERO_MAX_SIDE_M} each`);
  const tc = prop.tri_count;
  if (!isWhole(tc)) errors.push(`${where}: tri_count must be a whole number of at least 1`);
  else if (tc > HERO_MAX_TRIANGLES) errors.push(`${where}: tri_count ${tc} exceeds the hero cap of ${HERO_MAX_TRIANGLES}`);
  const parts = prop.parts;
  if (!Array.isArray(parts) || !parts.length) return [...errors, `${where}: parts must be a non-empty list`];
  const seen = new Set();
  let instances = 0, derived = 0, countable = true;
  for (const part of parts) {
    const isObj = isRecord(part);
    const pw = `${where} part ${isObj ? part.id : JSON.stringify(part)}`;
    if (!isObj) { errors.push(`${pw}: must be an object`); countable = false; continue; }
    if (forbiddenKey(part)) { errors.push(`${pw}: forbidden key`); countable = false; continue; }
    if (!(typeof part.id === 'string' && HERO_ID.test(part.id) && !HERO_FORBIDDEN.has(part.id))) errors.push(`${pw}: invalid id`);
    else if (seen.has(part.id)) errors.push(`${pw}: duplicate id`);
    else seen.add(part.id);
    if (!(typeof part.shape === 'string' && Object.hasOwn(HERO_SHAPES, part.shape))) { errors.push(`${pw}: unknown shape ${JSON.stringify(part.shape)}`); countable = false; continue; }
    const { bad, tris } = heroPartIssues(part);
    for (const m of bad) errors.push(`${pw}: ${m}`);
    if (has(part, 'at') && !isTriple(part.at)) errors.push(`${pw}: 'at' must be [x, y, z] within +-${HERO_MAX_COORD} m`);
    if (has(part, 'rot') && !isTriple(part.rot, (c) => inRange(c, -HERO_MAX_ROT_DEG, HERO_MAX_ROT_DEG))) errors.push(`${pw}: 'rot' must be [x, y, z] degrees within +-${HERO_MAX_ROT_DEG}`);
    if (part.mirror != null && !['x', 'y'].includes(part.mirror)) errors.push(`${pw}: mirror must be 'x', 'y' or absent`);
    const rep = part.repeat;
    let count = 1;
    if (rep != null) {
      if (!(isRecord(rep) && isWhole(rep.count) && rep.count <= HERO_MAX_INSTANCES && !forbiddenKey(rep))) errors.push(`${pw}: repeat needs a whole count of 1 to ${HERO_MAX_INSTANCES}`);
      else {
        count = rep.count;
        const stepOk = has(rep, 'step') ? isTriple(rep.step) : inRange(rep.radius, 0, HERO_MAX_COORD) && ['x', 'y', 'z'].includes(has(rep, 'axis') ? rep.axis : 'z');
        if (!stepOk) errors.push(`${pw}: repeat needs a step [dx, dy, dz] or a radius with an x, y or z axis`);
      }
    }
    const per = count * (part.mirror === 'x' || part.mirror === 'y' ? 2 : 1);
    instances += per;
    derived += tris * per;
    if (instances > HERO_MAX_INSTANCES) { errors.push(`${where}: more than ${HERO_MAX_INSTANCES} part instances after repeat and mirror`); countable = false; break; }
    if (tris === 0) countable = false;
  }
  if (countable && !errors.length) {
    if (derived > HERO_MAX_TRIANGLES) errors.push(`${where}: the parts build ${derived} triangles, over the hero cap of ${HERO_MAX_TRIANGLES}`);
    else if (isWhole(tc) && tc < derived) errors.push(`${where}: tri_count ${tc} is below the ${derived} triangles the parts build`);
  }
  return errors;
}

export const MAX_HDRI_BYTES = 7.5 * 1024 * 1024;
export const MAX_TEXTURE_BYTES = 4.5 * 1024 * 1024;
export const MAX_MESH_BYTES = 4.5 * 1024 * 1024;

export const KNOWN_PRIMITIVE_KINDS = new Set([
  'box',
  'cube',
  'cylinder',
  'sphere',
  'uv_sphere',
  'ico_sphere',
  'plane',
  'cone',
  'torus',
  'wedge',
  'circle',
  'capsule',
  'disk',
  'disc',
  'ring',
]);

export const REQUIRED_TOP_LEVEL_KEYS = ['kit_id', 'name', 'license'];

export const ALLOWED_PORTAL_DIRECTIONS = new Set(['left', 'right', 'toward', 'away', 'up', 'down']);

// Licences: CC0-1.0, MIT, or Apache-2.0 only
export const ALLOWED_KIT_LICENSES = new Set([
  'cc0',
  'cc0-1.0',
  'cc0 1.0',
  'cc0 1.0 universal',
  'public domain',
  'mit',
  'apache-2.0',
  'apache 2.0',
  'apache-2',
]);

/**
 * Determine if a license string is on the approved open-source list.
 */
export function isAllowedLicense(license) {
  if (typeof license !== 'string') return false;
  const clean = license.toLowerCase().trim();
  if (ALLOWED_KIT_LICENSES.has(clean)) return true;
  for (const allowed of ALLOWED_KIT_LICENSES) {
    if (clean.includes(allowed)) return true;
  }
  return false;
}

/**
 * Extract bounding dimensions and coordinates from a kit object.
 */
export function extractBounds(obj) {
  const errors = [];
  const rawBounds = obj?.bounds;
  const shellDims = obj?.shell?.dimensions_m;

  let width = null;
  let depth = null;
  let height = null;
  let xMin = null;
  let xMax = null;
  let yMin = null;
  let yMax = null;
  let zMin = null;
  let zMax = null;

  if (rawBounds && typeof rawBounds === 'object') {
    if (Array.isArray(rawBounds) && rawBounds.length === 3) {
      [width, depth, height] = rawBounds;
    } else if ('width' in rawBounds && 'depth' in rawBounds && 'height' in rawBounds) {
      width = rawBounds.width;
      depth = rawBounds.depth;
      height = rawBounds.height;
    } else if ('x' in rawBounds && 'y' in rawBounds && 'z' in rawBounds) {
      if (Array.isArray(rawBounds.x) && rawBounds.x.length === 2) {
        [xMin, xMax] = rawBounds.x;
        [yMin, yMax] = rawBounds.y;
        [zMin, zMax] = rawBounds.z;
        width = xMax - xMin;
        depth = yMax - yMin;
        height = zMax - zMin;
      } else {
        width = rawBounds.x;
        depth = rawBounds.y;
        height = rawBounds.z;
      }
    } else if (Array.isArray(rawBounds.min) && Array.isArray(rawBounds.max) && rawBounds.min.length >= 3 && rawBounds.max.length >= 3) {
      [xMin, yMin, zMin] = rawBounds.min;
      [xMax, yMax, zMax] = rawBounds.max;
      width = xMax - xMin;
      depth = yMax - yMin;
      height = zMax - zMin;
    }
  }

  // Fallback to shell.dimensions_m
  if ((width === null || depth === null || height === null) && shellDims && typeof shellDims === 'object') {
    width = shellDims.width;
    depth = shellDims.depth;
    height = shellDims.height;
  }

  if (width === null || depth === null || height === null) {
    errors.push('bounds must be specified with width, depth, height (or shell.dimensions_m)');
    return { bounds: null, errors };
  }

  width = Number(width);
  depth = Number(depth);
  height = Number(height);

  if (Number.isNaN(width) || Number.isNaN(depth) || Number.isNaN(height)) {
    errors.push('bounds dimensions must be numeric');
    return { bounds: null, errors };
  }

  if (width <= 0 || depth <= 0 || height <= 0) {
    errors.push(`bounds in metres must be positive (got width=${width}, depth=${depth}, height=${height})`);
    return { bounds: null, errors };
  }

  const floorZ = typeof obj?.shell?.floor_elevation_z === 'number' ? obj.shell.floor_elevation_z : 0.0;

  if (xMin === null || xMax === null) {
    xMin = -width / 2.0;
    xMax = width / 2.0;
  }
  if (yMin === null || yMax === null) {
    yMin = -depth / 2.0;
    yMax = depth / 2.0;
  }
  if (zMin === null || zMax === null) {
    zMin = floorZ;
    zMax = floorZ + height;
  }

  const bounds = {
    width,
    depth,
    height,
    x_min: Number(xMin),
    x_max: Number(xMax),
    y_min: Number(yMin),
    y_max: Number(yMax),
    z_min: Number(zMin),
    z_max: Number(zMax),
  };

  return { bounds, errors };
}

/**
 * Check if a 3D coordinate [x, y, z] is inside bounding box.
 */
export function isInsideBounds(pos, bounds, eps = 1e-3) {
  if (!Array.isArray(pos) || pos.length < 3 || !bounds) return false;
  const [x, y, z] = pos;
  return (
    x >= bounds.x_min - eps &&
    x <= bounds.x_max + eps &&
    y >= bounds.y_min - eps &&
    y <= bounds.y_max + eps &&
    z >= bounds.z_min - eps &&
    z <= bounds.z_max + eps
  );
}

/**
 * Collect all path-like string values recursively from an object.
 */
function findAllPaths(obj, prefix = '') {
  const paths = [];
  if (obj && typeof obj === 'object') {
    if (Array.isArray(obj)) {
      obj.forEach((item, idx) => {
        const curKey = `${prefix}[${idx}]`;
        if (typeof item === 'string') {
          if (item.includes('/') || item.includes('\\')) paths.push([curKey, item]);
        } else if (item && typeof item === 'object') {
          paths.push(...findAllPaths(item, curKey));
        }
      });
    } else {
      for (const [k, v] of Object.entries(obj)) {
        const curKey = prefix ? `${prefix}.${k}` : k;
        if (typeof v === 'string') {
          const lk = k.toLowerCase();
          if (['path', 'file', 'mesh', 'diffuse', 'normal', 'roughness', 'relative_mesh'].some((w) => lk.includes(w))) {
            paths.push([curKey, v]);
          } else if (v.includes('/') || v.includes('\\')) {
            paths.push([curKey, v]);
          }
        } else if (v && typeof v === 'object') {
          paths.push(...findAllPaths(v, curKey));
        }
      }
    }
  }
  return paths;
}

/**
 * Security validation: check for path traversal (..) and absolute paths.
 */
export function checkPathSecurity(value, context, errors) {
  if (typeof value !== 'string') return;
  if (value.startsWith('http://') || value.startsWith('https://')) return;

  const normalized = value.replace(/\\/g, '/');
  const segments = normalized.split('/');
  if (segments.includes('..')) {
    errors.push(`path traversal rejected in '${context}': '${value}' contains '..'`);
  }

  if (path.isAbsolute(value) || /^[a-zA-Z]:/.test(value) || value.startsWith('/') || value.startsWith('\\')) {
    errors.push(`absolute path rejected in '${context}': '${value}' must be a relative path`);
  }
}

/**
 * Check if a prop is declared as procedural.
 */
export function isProceduralProp(prop) {
  if (!prop || typeof prop !== 'object') return false;
  if (prop.procedural === true) return true;
  if (String(prop.mesh_type || '').startsWith('procedural')) return true;
  if (String(prop.type || '').toLowerCase() === 'procedural') return true;
  if (String(prop.source_pack || '').toLowerCase() === 'procedural') return true;
  if (String(prop.source || '').toLowerCase() === 'procedural') return true;
  return false;
}

/**
 * Extract primitive kind if known.
 */
export function getPrimitiveKind(prop) {
  if (!prop || typeof prop !== 'object') return null;
  for (const field of ['primitive', 'primitive_kind', 'mesh_type', 'kind', 'type', 'shape']) {
    const val = prop[field];
    if (typeof val === 'string') {
      let clean = val.toLowerCase().trim();
      if (clean.startsWith('procedural_')) clean = clean.slice('procedural_'.length);
      if (KNOWN_PRIMITIVE_KINDS.has(clean)) return clean;
    }
  }
  return null;
}

/**
 * Parse approved asset IDs enclosed in backticks from LICENSES.md content.
 */
export function parseLicensedAssetIds(licensesText) {
  if (typeof licensesText !== 'string') return new Set();
  const matches = licensesText.match(/`([^`\r\n]+)`/g) || [];
  return new Set(matches.map((m) => m.slice(1, -1).trim()).filter(Boolean));
}

/**
 * Validate a scene kit definition dictionary matching Python validate_kit.
 * Returns an array of error messages. Empty array = valid.
 */
export function validateKit(obj, options = {}) {
  const errors = [];
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return ['kit definition must be a dictionary'];
  }

  // 1. Required Top-Level Keys
  for (const reqKey of REQUIRED_TOP_LEVEL_KEYS) {
    if (!(reqKey in obj)) {
      errors.push(`missing required key: '${reqKey}'`);
    }
  }

  // 1b. License Allowlist
  if (obj.license && !isAllowedLicense(obj.license)) {
    errors.push(`unapproved license '${obj.license}': must be CC0-1.0, MIT, or Apache-2.0`);
  }

  // 2. Bounds in Metres and Positive
  const { bounds, errors: boundsErrors } = extractBounds(obj);
  errors.push(...boundsErrors);

  // 3. Security: No Absolute Paths, No '..' Path Traversal
  for (const [context, pathStr] of findAllPaths(obj)) {
    checkPathSecurity(pathStr, context, errors);
  }

  // Optional: asset catalog from manifest / LICENSES.md if provided
  let licensedIds = options.licensedIds || null;
  let manifestAssetIds = options.manifestAssetIds || null;

  if (!licensedIds && options.worldsDir) {
    try {
      const licPath = path.join(options.worldsDir, 'LICENSES.md');
      if (fs.existsSync(licPath)) {
        licensedIds = parseLicensedAssetIds(fs.readFileSync(licPath, 'utf8'));
      }
    } catch {}
  }
  if (!manifestAssetIds && options.worldsDir) {
    try {
      const manPath = path.join(options.worldsDir, 'manifest.json');
      if (fs.existsSync(manPath)) {
        const man = JSON.parse(fs.readFileSync(manPath, 'utf8'));
        manifestAssetIds = new Set();
        for (const cat of ['hdris', 'textures']) {
          for (const [preset, spec] of Object.entries(man[cat] || {})) {
            manifestAssetIds.add(preset);
            if (spec && typeof spec === 'object' && spec.asset_id) {
              manifestAssetIds.add(spec.asset_id);
            }
          }
        }
      }
    } catch {}
  }

  // 4. Snap Sockets Inside Bounds
  let socketsList = [];
  if (Array.isArray(obj.sockets)) {
    socketsList = obj.sockets.filter((s) => s && typeof s === 'object');
  } else if (obj.sockets && typeof obj.sockets === 'object') {
    for (const [sId, sData] of Object.entries(obj.sockets)) {
      if (sData && typeof sData === 'object') {
        socketsList.push({ id: sId, ...sData });
      }
    }
  } else if ('sockets' in obj) {
    errors.push("'sockets' must be a list or a dictionary");
  }

  for (const s of socketsList) {
    const sId = s.id || 'unnamed_socket';
    const pos = s.pos || s.position || s.location || s.rel_pos;
    if (!Array.isArray(pos) || pos.length < 3) {
      errors.push(`socket '${sId}' missing valid 3D coordinates in 'pos'`);
      continue;
    }
    const coords = pos.slice(0, 3).map(Number);
    if (coords.some(Number.isNaN)) {
      errors.push(`socket '${sId}' coordinates must be numeric (got ${JSON.stringify(pos)})`);
      continue;
    }
    if (bounds && !isInsideBounds(coords, bounds)) {
      errors.push(
        `socket '${sId}' position ${JSON.stringify(coords)} is outside bounds ` +
          `[X: ${bounds.x_min}..${bounds.x_max}, Y: ${bounds.y_min}..${bounds.y_max}, Z: ${bounds.z_min}..${bounds.z_max}]`,
      );
    }
  }

  // 5. Props: Known Primitive, Manifest Asset, or Procedural
  const rawProps = Array.isArray(obj.props) ? obj.props : [];
  if (!Array.isArray(obj.props) && 'props' in obj) {
    errors.push("'props' must be a list of prop definitions");
  }

  for (const prop of rawProps) {
    if (!prop || typeof prop !== 'object') {
      errors.push('prop entry must be a dictionary');
      continue;
    }
    const propId = prop.id || 'unnamed_prop';

    // Position containment
    const pPos = prop.rel_pos || prop.pos || prop.location;
    if (bounds && Array.isArray(pPos) && pPos.length >= 3) {
      const coords = pPos.slice(0, 3).map(Number);
      if (!coords.some(Number.isNaN) && !isInsideBounds(coords, bounds)) {
        errors.push(`prop '${propId}' position ${JSON.stringify(coords)} is outside bounds`);
      }
    }

    const isProc = isProceduralProp(prop);
    const primKind = getPrimitiveKind(prop);
    if (isProc || primKind) {
      continue;
    }

    if (licensedIds || manifestAssetIds) {
      const assetRef = prop.asset_id || prop.source_pack || prop.source || prop.mesh || prop.relative_mesh || prop.model || prop.id;
      const hasLic =
        (licensedIds && licensedIds.has(assetRef)) ||
        (manifestAssetIds && manifestAssetIds.has(assetRef)) ||
        (prop.license_id && licensedIds && licensedIds.has(prop.license_id)) ||
        (prop.licence_id && licensedIds && licensedIds.has(prop.licence_id));
      if (!hasLic) {
        errors.push(`unknown external asset without licence: '${assetRef}' in prop '${propId}'`);
      }
    }
  }

  // 7. Tri-count budgets
  const triBudget = obj.tri_count_budget || obj.tri_budget;
  if (triBudget && typeof triBudget === 'object') {
    const maxPiece = triBudget.max_triangles_per_piece;
    if (maxPiece !== undefined && Number(maxPiece) > MAX_TRIANGLES_PER_PIECE) {
      errors.push(`tri-count budget per piece ${maxPiece} exceeds cap of ${MAX_TRIANGLES_PER_PIECE}`);
    }
    const totalMax = triBudget.total_max_triangles || triBudget.max_triangles;
    if (totalMax !== undefined && Number(totalMax) > MAX_TOTAL_TRIANGLES) {
      errors.push(`total tri-count budget ${totalMax} exceeds cap of ${MAX_TOTAL_TRIANGLES}`);
    }
  }

  // Check individual modular piece / prop tri counts
  let totalPropTris = 0;
  for (const collName of ['modular_pieces', 'props']) {
    const items = Array.isArray(obj[collName]) ? obj[collName] : [];
    for (const item of items) {
      if (item && typeof item === 'object') {
        const tc = item.tri_count || item.triangle_count;
        if (tc !== undefined) {
          const numTc = Number(tc);
          if (numTc > MAX_TRIANGLES_PER_PIECE && !(collName === 'props' && 'parts' in item)) { // a hero prop has its own cap (heroPropErrors)
            errors.push(`tri_count for item '${item.id || 'unnamed'}' (${numTc}) exceeds cap of ${MAX_TRIANGLES_PER_PIECE}`);
          }
          totalPropTris += numTc;
        }
      }
    }
  }
  if (totalPropTris > MAX_TOTAL_TRIANGLES) {
    errors.push(`sum of item tri-counts (${totalPropTris}) exceeds total cap of ${MAX_TOTAL_TRIANGLES}`);
  }
  for (const prop of rawProps) { // KAN-757
    if (prop && typeof prop === 'object' && 'parts' in prop) errors.push(...heroPropErrors(prop, obj.kit_id));
  }

  // 8. Clay Look Rules
  const clayRules = obj.clay_look_rules;
  if (clayRules && typeof clayRules === 'object') {
    if (clayRules.bevel_radius_m !== undefined) {
      const br = Number(clayRules.bevel_radius_m);
      if (Number.isNaN(br) || br < 0.0 || br > 0.5) {
        errors.push(`clay_look_rules.bevel_radius_m (${clayRules.bevel_radius_m}) must be between 0.0 and 0.5`);
      }
    }
    if (clayRules.bevel_segments !== undefined) {
      const bs = Number(clayRules.bevel_segments);
      if (Number.isNaN(bs) || bs < 1 || bs > 16) {
        errors.push(`clay_look_rules.bevel_segments (${clayRules.bevel_segments}) must be between 1 and 16`);
      }
    }
    if (clayRules.default_roughness !== undefined) {
      const dr = Number(clayRules.default_roughness);
      if (Number.isNaN(dr) || dr < 0.0 || dr > 1.0) {
        errors.push(`clay_look_rules.default_roughness (${clayRules.default_roughness}) must be between 0.0 and 1.0`);
      }
    }
  }

  // 10. Story Block Validation (Optional block for story planning)
  const story = obj.story;
  const knownSocketIds = new Set(socketsList.map((s) => s.id).filter(Boolean));

  if (story !== undefined && story !== null) {
    if (typeof story !== 'object' || Array.isArray(story)) {
      errors.push("'story' must be a dictionary");
    } else {
      if (story.tags !== undefined && (!Array.isArray(story.tags) || !story.tags.every((t) => typeof t === 'string'))) {
        errors.push('story.tags must be a list of strings');
      }
      if (story.keywords !== undefined && (!Array.isArray(story.keywords) || !story.keywords.every((k) => typeof k === 'string'))) {
        errors.push('story.keywords must be a list of strings');
      }
      if (story.placement !== undefined && typeof story.placement !== 'string') {
        errors.push('story.placement must be a string');
      }
      if (story.world_ref !== undefined && typeof story.world_ref !== 'string') {
        errors.push('story.world_ref must be a string');
      }
      if (story.default_socket !== undefined) {
        if (typeof story.default_socket !== 'string') {
          errors.push('story.default_socket must be a string');
        } else if (knownSocketIds.size > 0 && !knownSocketIds.has(story.default_socket)) {
          errors.push(`story.default_socket '${story.default_socket}' not found in kit sockets: ${[...knownSocketIds].sort().join(', ')}`);
        }
      }

      if (story.portals !== undefined) {
        if (!Array.isArray(story.portals)) {
          errors.push('story.portals must be a list');
        } else {
          story.portals.forEach((portal, idx) => {
            if (!portal || typeof portal !== 'object') {
              errors.push(`story.portals[${idx}] must be a dictionary`);
              return;
            }
            if (!portal.socket || typeof portal.socket !== 'string') {
              errors.push(`story.portals[${idx}] missing valid 'socket' identifier`);
            } else if (knownSocketIds.size > 0 && !knownSocketIds.has(portal.socket)) {
              errors.push(`story.portals[${idx}] references unknown socket '${portal.socket}'`);
            }
            if (!portal.leads_to || typeof portal.leads_to !== 'object') {
              errors.push(`story.portals[${idx}] missing 'leads_to' specification`);
            }
            for (const dirField of ['exit_dir', 'enter_dir']) {
              if (portal[dirField] !== undefined) {
                const dVal = String(portal[dirField]).toLowerCase().trim();
                if (!ALLOWED_PORTAL_DIRECTIONS.has(dVal)) {
                  errors.push(
                    `story.portals[${idx}].${dirField} '${portal[dirField]}' invalid; must be one of ${[...ALLOWED_PORTAL_DIRECTIONS].sort().join(', ')}`,
                  );
                }
              }
            }
          });
        }
      }

      if (story.walk_paths !== undefined) {
        if (!Array.isArray(story.walk_paths)) {
          errors.push('story.walk_paths must be a list');
        } else {
          story.walk_paths.forEach((wp, idx) => {
            if (!wp || typeof wp !== 'object') {
              errors.push(`story.walk_paths[${idx}] must be a dictionary`);
              return;
            }
            const wpId = wp.id || wp.name;
            if (!wpId || typeof wpId !== 'string') {
              errors.push(`story.walk_paths[${idx}] missing 'id' or 'name'`);
            }
            const points = wp.points || wp.polyline || wp.path;
            if (!Array.isArray(points) || points.length < 2) {
              errors.push(`story.walk_paths[${idx}] '${wpId}' must have at least 2 points in polyline`);
            } else {
              points.forEach((pt, ptIdx) => {
                if (!Array.isArray(pt) || pt.length < 3) {
                  errors.push(`story.walk_paths[${idx}] '${wpId}' point ${ptIdx} must be a 3D coordinate [x, y, z]`);
                  return;
                }
                const ptCoords = pt.slice(0, 3).map(Number);
                if (ptCoords.some(Number.isNaN)) {
                  errors.push(`story.walk_paths[${idx}] '${wpId}' point ${ptIdx} coordinates must be numeric`);
                } else if (bounds && !isInsideBounds(ptCoords, bounds)) {
                  errors.push(`story.walk_paths[${idx}] '${wpId}' point ${ptIdx} ${JSON.stringify(ptCoords)} is outside bounds`);
                }
              });
            }
          });
        }
      }
    }
  }

  return errors;
}

/**
 * Build a catalog entry dictionary from a valid scene kit definition.
 * Exact mirror of blender_worker/scene_kit.py: build_catalog_entry(obj, kit_id).
 */
export function buildCatalogEntry(obj, kitId = null) {
  if (!obj || typeof obj !== 'object') return {};
  const kid = String(kitId || obj.kit_id || obj.id || '');
  const story = obj.story && typeof obj.story === 'object' && !Array.isArray(obj.story) ? obj.story : {};

  const label = story.label || obj.name || obj.label || obj.category || '';
  const tags = Array.isArray(story.tags) ? [...story.tags] : [];
  const keywords = Array.isArray(story.keywords) ? [...story.keywords] : [];
  const placement = story.placement || obj.placement || 'ground';

  // Sockets extraction
  let socketsList = [];
  if (Array.isArray(obj.sockets)) {
    socketsList = obj.sockets.filter((s) => s && typeof s === 'object');
  } else if (obj.sockets && typeof obj.sockets === 'object') {
    for (const [sId, sData] of Object.entries(obj.sockets)) {
      if (sData && typeof sData === 'object') {
        socketsList.push({ id: sId, ...sData });
      }
    }
  }
  const socketIds = socketsList.map((s) => String(s.id)).filter(Boolean);

  // Default socket: story.default_socket or first socket or ''
  const defaultSocket = story.default_socket || (socketIds[0] || '');

  // Props extraction with states
  const rawProps = Array.isArray(obj.props) ? obj.props : [];
  let storyStates = story.states || story.prop_states || {};
  if (Array.isArray(storyStates)) {
    const mapped = {};
    for (const item of storyStates) {
      if (item && typeof item === 'object' && item.id && item.states) {
        mapped[item.id] = item.states;
      }
    }
    storyStates = mapped;
  } else if (!storyStates || typeof storyStates !== 'object') {
    storyStates = {};
  }

  const catalogProps = [];
  for (const p of rawProps) {
    if (!p || typeof p !== 'object') continue;
    const pId = p.id;
    if (!pId) continue;
    const states = p.states || storyStates[pId];
    if (states && Array.isArray(states)) {
      catalogProps.push({ id: String(pId), states: [...states] });
    } else {
      catalogProps.push({ id: String(pId) });
    }
  }

  // Portals extraction
  const rawPortals = Array.isArray(story.portals) ? story.portals : [];
  const portals = [];
  for (const p of rawPortals) {
    if (!p || typeof p !== 'object') continue;
    const pDict = {};
    for (const k of ['socket', 'leads_to', 'exit_dir', 'enter_dir']) {
      if (k in p) pDict[k] = p[k];
    }
    portals.push(pDict);
  }

  // Camera zones extraction
  const rawCz = Array.isArray(story.camera_zones) ? story.camera_zones : [];
  const cameraZones = [];
  for (const cz of rawCz) {
    if (typeof cz === 'string') {
      cameraZones.push(cz);
    } else if (cz && typeof cz === 'object') {
      const czId = cz.id || cz.name;
      if (czId) cameraZones.push(String(czId));
    }
  }

  const entry = {
    kit: kid,
    label,
    tags,
    keywords,
    placement,
    default_socket: defaultSocket,
    sockets: socketIds,
    props: catalogProps,
    portals,
    camera_zones: cameraZones,
  };

  if (Array.isArray(story.walk_paths)) {
    entry.walk_paths = story.walk_paths;
  }
  if (typeof story.world_ref === 'string') {
    entry.world_ref = story.world_ref;
  }

  return entry;
}

/**
 * Resolve the default kits directory using resolveWorldsDir.
 */
export function getDefaultKitsDir(env = process.env) {
  return path.join(resolveWorldsDir(env), 'kits');
}

/**
 * Load and validate a single kit definition file from disk.
 */
export function loadKit(filePath, options = {}) {
  const content = fs.readFileSync(filePath, 'utf8');
  const data = JSON.parse(content);
  const kitId = options.kitId || data.kit_id || data.id || path.basename(filePath, '.json');
  const errors = validateKit(data, { ...options, kitPath: filePath });
  const entry = errors.length === 0 ? buildCatalogEntry(data, kitId) : null;
  return {
    kitId,
    data,
    errors,
    valid: errors.length === 0,
    entry,
  };
}

/**
 * Discover candidate kit files (.json and *\/kit.json) in a directory.
 */
function findKitCandidateFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const results = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const dirent of entries) {
    const fullPath = path.join(dir, dirent.name);
    if (dirent.isFile() && dirent.name.endsWith('.json')) {
      results.push(fullPath);
    } else if (dirent.isDirectory()) {
      const subKit = path.join(fullPath, 'kit.json');
      if (fs.existsSync(subKit)) {
        results.push(subKit);
      }
    }
  }
  return results;
}

/**
 * Return a sorted list of valid kit IDs from a kits directory.
 */
export function listKits(kitsDir = null, options = {}) {
  const dir = kitsDir || getDefaultKitsDir(options.env);
  const candidates = findKitCandidateFiles(dir);
  const validIds = [];

  for (const f of candidates) {
    try {
      const content = fs.readFileSync(f, 'utf8');
      const data = JSON.parse(content);
      if (data && typeof data === 'object') {
        const errors = validateKit(data, { ...options, kitPath: f });
        if (errors.length === 0) {
          const kitId = data.kit_id || data.id || path.basename(f, '.json');
          if (!validIds.includes(kitId)) {
            validIds.push(kitId);
          }
        }
      }
    } catch {}
  }

  return validIds.sort();
}

/**
 * Load full catalog of valid kits from disk, building catalog slices.
 * Matches python scene_kit.catalog(kits_dir, as_dict).
 */
export function loadCatalog(options = {}) {
  const dir = options.kitsDir || getDefaultKitsDir(options.env);
  const asDict = Boolean(options.asDict);
  const allowlist = options.allowlist ? new Set(Array.isArray(options.allowlist) ? options.allowlist : [options.allowlist]) : null;

  if (!fs.existsSync(dir)) {
    return asDict ? {} : [];
  }

  const candidates = findKitCandidateFiles(dir).sort();
  const entries = [];
  const seenIds = new Set();

  for (const f of candidates) {
    try {
      const content = fs.readFileSync(f, 'utf8');
      const data = JSON.parse(content);
      if (data && typeof data === 'object') {
        const errors = validateKit(data, { ...options, kitPath: f });
        if (errors.length === 0) {
          const kitId = data.kit_id || data.id || path.basename(f, '.json');
          if (allowlist && !allowlist.has(kitId)) {
            continue;
          }
          if (!seenIds.has(kitId)) {
            seenIds.add(kitId);
            entries.push(buildCatalogEntry(data, kitId));
          }
        }
      }
    } catch {}
  }

  entries.sort((a, b) => String(a.kit || '').localeCompare(String(b.kit || '')));

  if (options.minimal) {
    const minimalEntries = entries.map((e) => ({
      kit: e.kit,
      label: e.label,
      tags: e.tags,
      keywords: e.keywords,
      placement: e.placement,
    }));
    if (asDict) {
      return Object.fromEntries(minimalEntries.map((e) => [e.kit, e]));
    }
    return minimalEntries;
  }

  if (asDict) {
    return Object.fromEntries(entries.map((e) => [e.kit, e]));
  }
  return entries;
}

/**
 * Filter an existing catalog or catalog list to a specific slice.
 *
 * Options:
 * - allowlist: array/Set of kit IDs to keep
 * - tags: array of tag strings (entry must contain at least one)
 * - minimal: boolean (if true, return compact location-pass slice: kit, label, tags, keywords, placement)
 * - asDict: boolean
 */
export function getCatalogSlice(catalogInput, options = {}) {
  let list = [];
  if (Array.isArray(catalogInput)) {
    list = [...catalogInput];
  } else if (catalogInput && typeof catalogInput === 'object') {
    list = Object.values(catalogInput);
  }

  const allowlist = options.allowlist ? new Set(Array.isArray(options.allowlist) ? options.allowlist : [options.allowlist]) : null;
  const tagFilter = Array.isArray(options.tags) && options.tags.length > 0 ? options.tags : null;

  let filtered = list;

  if (allowlist) {
    filtered = filtered.filter((e) => e && allowlist.has(e.kit));
  }

  if (tagFilter) {
    filtered = filtered.filter((e) => e && Array.isArray(e.tags) && e.tags.some((t) => tagFilter.includes(t)));
  }

  filtered.sort((a, b) => String(a.kit || '').localeCompare(String(b.kit || '')));

  if (options.minimal) {
    filtered = filtered.map((e) => ({
      kit: e.kit,
      label: e.label,
      tags: e.tags,
      keywords: e.keywords,
      placement: e.placement,
    }));
  }

  if (options.asDict) {
    return Object.fromEntries(filtered.map((e) => [e.kit, e]));
  }

  return filtered;
}

/**
 * Format catalog entries for LLM prompts according to spec Section 8.
 *
 * Mode 'location':
 * "PLACES: <one line per kit: id - label - tags>"
 * Mode 'scene':
 * "<kit>: sockets [<socket_list>], props [<prop_list>]"
 */
export function formatCatalogForPrompt(entries, mode = 'location') {
  const list = Array.isArray(entries) ? entries : Object.values(entries || {});

  if (mode === 'location' || mode === 'minimal') {
    return list
      .map((e) => {
        const tags = Array.isArray(e.tags) ? e.tags.join(', ') : '';
        return `${e.kit} - ${e.label}${tags ? ` - ${tags}` : ''}`;
      })
      .join('\n');
  }

  if (mode === 'scene') {
    return list
      .map((e) => {
        const socks = Array.isArray(e.sockets) ? e.sockets.join(', ') : '';
        const props = Array.isArray(e.props)
          ? e.props
              .map((p) => {
                if (p.states && p.states.length) return `${p.id} (${p.states.join('/')})`;
                return p.id;
              })
              .join(', ')
          : '';
        return `${e.kit}: sockets [${socks}], props [${props}]`;
      })
      .join('\n');
  }

  return '';
}
