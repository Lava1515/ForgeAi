import { MATERIALS, SHAPES } from './model3d.js';

const DEFAULT_HEIGHT = 1.75;
const POSES = new Set(['stand', 'walk', 'point', 'sit', 'arms-up']);
export const CHARACTER_ACTIONS = ['idle', 'walk', 'run', 'ride', 'look']; // KAN-451: actions the rigged mannequin renders (clips in blender_worker/character_render.py)
export const normalizeCharacterAction = (action) => {
  const key = typeof action === 'string' ? action.trim().toLowerCase() : '';
  return CHARACTER_ACTIONS.includes(key) ? key : 'idle';
};
const clampHeight = (height) => typeof height === 'number' && Number.isFinite(height) && height > 0 ? height : DEFAULT_HEIGHT;

/** Return Blender XYZ Euler degrees that aim a cylinder's local z axis along direction. */
export function limbRot(direction) {
  const [x, y, z] = direction;
  const length = Math.hypot(x, y, z);
  if (!(length > 0) || !Number.isFinite(length)) throw new TypeError('Limb direction must be a finite, nonzero vector.');
  return [0, Math.acos(Math.max(-1, Math.min(1, z / length))) * 180 / Math.PI, Math.atan2(y, x) * 180 / Math.PI];
}

function segment(id, label, start, end, radius, material) {
  const direction = end.map((n, i) => n - start[i]);
  const length = Math.hypot(...direction);
  if (!(length >= 1e-6)) throw new Error(`Figure segment ${id} has zero length.`);
  return {
    id, label, shape: 'cylinder', r: radius, h: length,
    at: start.map((n, i) => (n + end[i]) / 2),
    rot: limbRot(direction),
    material,
  };
}

function joint(id, label, at, radius, material) {
  return { id, label, shape: 'sphere', r: radius, at, rot: [0, 0, 0], material };
}

const addVec = (a, b) => a.map((n, i) => n + b[i]);

function kneeBetween(hip, ankle, upperLength, lowerLength, bendSign) {
  const dy = ankle[1] - hip[1];
  const dz = ankle[2] - hip[2];
  const distance = Math.hypot(dy, dz);
  const along = (upperLength ** 2 - lowerLength ** 2 + distance ** 2) / (2 * distance);
  const across = Math.sqrt(Math.max(0, upperLength ** 2 - along ** 2));
  const midY = hip[1] + dy * along / distance;
  const midZ = hip[2] + dz * along / distance;
  return [hip[0], midY - bendSign * dz * across / distance, midZ + bendSign * dy * across / distance];
}

/** Build a deterministic, metre-scaled clay mannequin for use as a 3D prop. */
export function figureModel(options = {}) {
  const input = options && typeof options === 'object' ? options : {};
  const H = clampHeight(input.height_m ?? DEFAULT_HEIGHT);
  const selectedPose = POSES.has(input.pose) ? input.pose : 'stand';
  const v2 = input.figures_v2 === true || input.figuresV2 === true;
  const skin = v2
    ? (input.skin === 'deep' ? 'clay_skin_deep' : (input.skin || 'clay_skin_warm'))
    : (input.skin || (MATERIALS.includes('hull') ? 'hull' : MATERIALS[0]));
  const clothes = v2
    ? (input.clothes || ((input.role === 'worker' || input.apparel === 'highvis') ? 'clay_highvis' : 'clay_denim'))
    : (input.clothes || (MATERIALS.includes('accent') ? 'accent' : MATERIALS[1]));
  const parts = [];
  const addSegment = (id, label, a, b, r, material) => parts.push(segment(id, label, a, b, r, material));
  const addJoint = (id, label, at, r) => parts.push(joint(id, label, at, r, skin));

  const headRadius = H / 15;
  const footHeight = H * 0.055;
  const standingHipZ = H * 0.49;
  const hipZ = selectedPose === 'sit' ? H * 0.245 : selectedPose === 'walk' ? H * 0.47 : standingHipZ;
  const upperBodyDrop = standingHipZ - hipZ;
  const pelvisCenter = hipZ + H * 0.065;
  const torsoBottom = H * 0.53 - upperBodyDrop;
  const torsoTop = H * 0.83 - upperBodyDrop;
  const shoulderZ = H * 0.77 - upperBodyDrop;
  const headCenterZ = H - upperBodyDrop - headRadius;
  const neckBottom = torsoTop;
  const neckTop = headCenterZ - headRadius;

  parts.push({ id: 'pelvis', label: 'Pelvis', shape: 'box', size: [H * 0.22, H * 0.13, H * 0.13], at: [0, 0, pelvisCenter], rot: [0, 0, 0], material: clothes });
  const torsoHeight = torsoTop - torsoBottom;
  parts.push({ id: 'torso', label: 'Torso', shape: 'loft', axis: 'z', sections: [
    { at: -torsoHeight / 2, w: H * 0.19, h: H * 0.12, shape: 'rect' },
    { at: 0, w: H * 0.18, h: H * 0.12, shape: 'rect' },
    { at: torsoHeight / 2, w: H * 0.24, h: H * 0.13, shape: 'rect' },
  ], at: [0, 0, (torsoTop + torsoBottom) / 2], rot: [0, 0, 0], material: clothes });
  parts.push({ id: 'neck', label: 'Neck', shape: 'cylinder', r: H * 0.045, h: neckTop - neckBottom, at: [0, 0, (neckTop + neckBottom) / 2], rot: [0, 0, 0], material: skin });
  parts.push(joint('head', 'Head', [0, 0, headCenterZ], headRadius, skin));

  if (selectedPose === 'sit') {
    const seatHeight = hipZ - H * 0.055;
    parts.push({ id: 'seat', label: 'Low seat', shape: 'box', size: [H * 0.42, H * 0.25, H * 0.025], at: [0, 0, seatHeight - H * 0.0125], rot: [0, 0, 0], material: clothes });
    for (const x of [-1, 1]) for (const y of [-1, 1]) {
      parts.push({ id: `seat_leg_${x < 0 ? 'left' : 'right'}_${y < 0 ? 'back' : 'front'}`, label: 'Seat leg', shape: 'box', size: [H * 0.035, H * 0.035, seatHeight - H * 0.025], at: [x * H * 0.16, y * H * 0.085, (seatHeight - H * 0.025) / 2], rot: [0, 0, 0], material: clothes });
    }
  }

  for (const [index, side] of ['left', 'right'].entries()) {
    const sign = index === 0 ? -1 : 1;
    const hip = [sign * H * 0.085, 0, hipZ];
    let knee;
    let ankle;
    if (selectedPose === 'sit') {
      knee = [hip[0], H * 0.245, hipZ];
      ankle = [hip[0], H * 0.245, footHeight];
    } else if (selectedPose === 'walk') {
      const forward = index === 0 ? 1 : -1;
      ankle = [hip[0], forward * H * 0.08, footHeight];
      knee = kneeBetween(hip, ankle, H * 0.245, H * 0.19, forward);
    } else {
      knee = [hip[0], 0, hipZ - H * 0.245];
      ankle = [hip[0], 0, footHeight];
    }

    addJoint(`${side}_hip`, 'Hip', hip, H * 0.058);
    addSegment(`${side}_upper_leg`, 'Upper leg', hip, knee, H * 0.052, clothes);
    addJoint(`${side}_knee`, 'Knee', knee, H * 0.048);
    addSegment(`${side}_lower_leg`, 'Lower leg', knee, ankle, H * 0.04, clothes);
    addJoint(`${side}_ankle`, 'Ankle', ankle, H * 0.034);

    const footY = ankle[1] + H * 0.035;
    const footMaterial = v2 ? clothes : skin;
    parts.push({ id: `${side}_foot`, label: 'Foot', shape: 'box', size: [H * 0.11, H * 0.19, footHeight], at: [ankle[0], footY, footHeight / 2], rot: [0, 0, 0], material: footMaterial });
  }

  for (const [index, side] of ['left', 'right'].entries()) {
    const sign = index === 0 ? -1 : 1;
    const shoulder = [sign * H * 0.13, 0, shoulderZ];
    let elbow;
    let wrist;
    let handTip;
    if (selectedPose === 'point' && side === 'right') {
      elbow = addVec(shoulder, [sign * H * 0.012, H * 0.17, -H * 0.035]);
      wrist = addVec(elbow, [sign * H * 0.004, H * 0.16, H * 0.018]);
      handTip = addVec(wrist, [0, H * 0.05, H * 0.008]);
    } else if (selectedPose === 'arms-up') {
      const outward = sign * H * 0.13;
      elbow = addVec(shoulder, [outward, 0, H * 0.13]);
      wrist = addVec(elbow, [outward * 0.82, 0, H * 0.13]);
      handTip = addVec(wrist, [outward * 0.22, 0, H * 0.05]);
    } else if (selectedPose === 'stand') {
      const armAngle = 8 * Math.PI / 180;
      elbow = addVec(shoulder, [sign * H * 0.195 * Math.sin(armAngle), 0, -H * 0.195 * Math.cos(armAngle)]);
      wrist = addVec(elbow, [sign * H * 0.156 * Math.sin(armAngle), 0, -H * 0.156 * Math.cos(armAngle)]);
      handTip = addVec(wrist, [sign * H * 0.055 * Math.sin(armAngle), 0, -H * 0.055 * Math.cos(armAngle)]);
    } else if (selectedPose === 'walk') {
      const swing = index === 0 ? -1 : 1;
      elbow = addVec(shoulder, [sign * H * 0.025, swing * H * 0.075, -H * 0.18]);
      wrist = addVec(elbow, [sign * H * 0.018, swing * H * 0.045, -H * 0.14]);
      handTip = addVec(wrist, [0, swing * H * 0.02, -H * 0.045]);
    } else {
      elbow = addVec(shoulder, [sign * H * 0.035, 0, -H * 0.18]);
      wrist = addVec(elbow, [sign * H * 0.012, 0, -H * 0.14]);
      handTip = addVec(wrist, [sign * H * 0.005, 0, -H * 0.05]);
    }

    addJoint(`${side}_shoulder`, 'Shoulder', shoulder, H * 0.052);
    addSegment(`${side}_upper_arm`, 'Upper arm', shoulder, elbow, H * 0.038, skin);
    addJoint(`${side}_elbow`, 'Elbow', elbow, H * 0.038);
    addSegment(`${side}_lower_arm`, 'Lower arm', elbow, wrist, H * 0.03, skin);
    addJoint(`${side}_wrist`, 'Wrist', wrist, H * 0.026);
    addSegment(`${side}_hand`, 'Hand', wrist, handTip, H * 0.03, skin);
  }

  if (!parts.every((part) => SHAPES[part.shape])) throw new Error('Figure contains a shape unsupported by the model renderer.');

  const model = {
    name: 'Clay human figure',
    size_m: { length: H * 0.65, width: H * 0.3, height: H },
    up: 'z',
    parts: parts.map((part) => ({ parent: null, stage: 1, interior: false, ...part })),
  };
  if (v2) {
    model.is_figure = true;
    model.figures_v2 = true;
  }
  if (input.characters_v1 === true) {
    // Marker for the worker: render this figure as the rigged mannequin with the action's looping clip. Absent when the flag is off.
    const clay = (name, fallback) => (v2 && typeof name === 'string' && name.startsWith('clay_') ? name : fallback);
    model.character = { asset: 'quaternius_standard', action: normalizeCharacterAction(input.action), body: clay(clothes, 'clay_denim'), joints: clay(skin, 'clay_skin_warm') };
  }
  return model;
}
