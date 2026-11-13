/**
 * Any-Story Plan schema validator, hand-off repair, capability registry,
 * and story normalisation for multi-location video generation (KAN-461 / A12-3).
 *
 * Spec reference: docs/superpowers/specs/2026-10-31-any-story-planner.md
 * (Sections 1-8, 11, 12 row A12-3).
 */

import { listKits, loadCatalog } from './storyKits.js';

// ---- Constants & Registry Definitions (Spec Section 3.1 - 3.4) ----

export const DESIGNED_CAST_ACTIONS = Object.freeze([
  'idle',
  'walk',
  'run',
  'climb',
  'press',
  'ride',
  'look_at',
  'react',
]);

export const ACCEPTED_CAST_ACTIONS = Object.freeze([
  'idle',
  'walk',
]);

export const DESIGNED_EVENTS = Object.freeze([
  'launch',
  'liftoff',
  'ignite',
]);

export const ACCEPTED_EVENTS = Object.freeze([]);

export const STORY_BEATS = Object.freeze([
  'hook',
  'context',
  'build',
  'peak',
  'hold',
  'payoff',
  'cta',
]);

export const TRANSITION_KINDS = Object.freeze([
  'whip',
  'zoom_through',
  'push_through',
  'cut',
]);

export const TRANSITION_CAUSES = Object.freeze([
  'action_end',
  'part_reveal',
  'impact',
]);

export const VALID_TIMES = Object.freeze([
  'dawn',
  'noon',
  'sunset',
  'night',
]);

const TIME_ORDER = Object.freeze({
  dawn: 1,
  noon: 2,
  sunset: 3,
  night: 4,
});

/**
 * Builtin worked kits catalog slices assumed by the worked plans (Spec Section 4).
 * Used as standard definitions and overlay for kits whose base geometry files
 * do not yet embed full story planning blocks.
 */
export const WORKED_KITS_CATALOG = Object.freeze({
  underground_platform: {
    kit: 'underground_platform',
    label: 'underground subway platform with train and stairs',
    tags: ['subway', 'transit', 'indoor', 'underground'],
    keywords: ['subway', 'train', 'platform', 'underground', 'metro'],
    placement: 'ground',
    default_socket: 'platform_mid',
    sockets: ['train_door', 'platform_mid', 'stair_foot', 'stair_top'],
    props: [
      { id: 'train_car', states: ['doors_closed', 'doors_open', 'departing'] },
      { id: 'stairs' },
    ],
    portals: [
      {
        socket: 'stair_top',
        leads_to: { kit: 'street', socket: 'stair_exit' },
        exit_dir: 'up',
      },
    ],
    walk_paths: [
      {
        id: 'stairs_climb',
        points: [
          [3.0, 5.0, -6.0],
          [3.0, 7.5, -3.0],
          [3.0, 10.0, 0.0],
        ],
      },
    ],
    camera_zones: ['platform_wide', 'stairs_close'],
  },
  street: {
    kit: 'street',
    label: 'city street with sidewalk, kiosk, fence gate',
    tags: ['city', 'road', 'outdoor'],
    keywords: ['street', 'road', 'city', 'sidewalk', 'traffic'],
    placement: 'ground',
    default_socket: 'sidewalk_mid',
    sockets: ['stair_exit', 'sidewalk_mid', 'gate', 'kerb_spot', 'street_far'],
    props: [
      { id: 'fence_gate', states: ['closed', 'open'] },
      { id: 'kiosk' },
    ],
    portals: [
      {
        socket: 'gate',
        leads_to: { kit: 'launch_pad', socket: 'gate_in', kit_tags: ['industrial', 'launch'] },
        exit_dir: 'right',
      },
    ],
    camera_zones: ['street_low', 'street_high'],
  },
  launch_pad: {
    kit: 'launch_pad',
    label: 'Rocket and missile launch site with console and gantry',
    tags: ['launch', 'industrial', 'outdoor', 'rocket', 'military'],
    keywords: ['launch', 'missile', 'rocket', 'pad', 'console', 'tower'],
    placement: 'ground',
    default_socket: 'pad_center',
    sockets: ['gate_in', 'console', 'pad_center', 'tower_base'],
    props: [
      { id: 'launch_console', states: ['key_idle', 'key_turned'] },
      { id: 'missile_mount', states: ['empty', 'on_pad'] },
      { id: 'umbilical_tower' },
    ],
    portals: [],
    camera_zones: ['pad_wide', 'console_close'],
  },
  desert: {
    kit: 'desert',
    label: 'desert salt flats with launch ramp',
    tags: ['desert', 'sand', 'salt_flats', 'outdoor', 'arid'],
    keywords: ['desert', 'sand', 'salt flats', 'dunes', 'flat', 'flats', 'road', 'wasteland'],
    placement: 'ground',
    default_socket: 'road_start',
    sockets: ['road_start', 'ramp_base', 'ramp_top'],
    props: [{ id: 'ramp' }],
    portals: [
      {
        socket: 'ramp_top',
        leads_to: { kit: 'space', socket: 'planet_view' },
        exit_dir: 'up',
      },
    ],
    camera_zones: ['desert_low', 'ramp_approach'],
    world_ref: 'desert',
  },
  space: {
    kit: 'space',
    label: 'outer space orbit with planet view',
    tags: ['space', 'orbit', 'stars', 'celestial', 'sci-fi'],
    keywords: ['space', 'orbit', 'planet', 'stars', 'cosmos', 'zero-g', 'vacuum'],
    placement: 'float',
    default_socket: 'orbit_center',
    sockets: ['planet_view', 'orbit_center'],
    props: [],
    portals: [],
    camera_zones: ['orbit_wide', 'planet_close'],
    world_ref: 'space',
  },
  ocean: {
    kit: 'ocean',
    label: 'open ocean and coastal pier',
    tags: ['ocean', 'sea', 'water', 'coastal', 'outdoor'],
    keywords: ['ocean', 'sea', 'water', 'waves', 'beach', 'coast', 'pier', 'dock', 'boat', 'ship'],
    placement: 'water',
    default_socket: 'water_surface',
    sockets: ['water_surface', 'pier_deck', 'deep_water'],
    props: [{ id: 'pier' }, { id: 'buoy' }],
    portals: [],
    camera_zones: ['ocean_wide', 'waterline_low'],
    world_ref: 'ocean',
  },
});

/**
 * Returns capability registry defining what worker can render now (Spec Section 3.4).
 */
export function getCapabilityRegistry(options = {}) {
  const isDesigned = options.tier === 'designed' || Boolean(options.all);
  let availableKits = [];

  if (Array.isArray(options.kits)) {
    availableKits = [...options.kits];
  } else {
    try {
      availableKits = listKits(options.kitsDir, options);
    } catch {
      availableKits = Object.keys(WORKED_KITS_CATALOG);
    }
  }

  // Ensure catalog keys are represented if list was empty
  if (availableKits.length === 0) {
    availableKits = Object.keys(WORKED_KITS_CATALOG);
  }
  availableKits.sort();

  if (isDesigned) {
    return {
      cast_actions: [...DESIGNED_CAST_ACTIONS],
      events: [...DESIGNED_EVENTS],
      vehicles: true,
      kits: availableKits,
    };
  }

  return {
    cast_actions: [...ACCEPTED_CAST_ACTIONS],
    events: [...ACCEPTED_EVENTS],
    vehicles: false,
    kits: availableKits,
  };
}

/**
 * Format capability registry for LLM planner prompt injection (Spec Section 8).
 */
export function formatCapabilityRegistryForPrompt(registry = null) {
  const reg = registry || getCapabilityRegistry();
  const acts = Array.isArray(reg.cast_actions) ? reg.cast_actions.join(', ') : 'none';
  const evts = Array.isArray(reg.events) && reg.events.length > 0 ? reg.events.join(', ') : 'none';
  return `allowed actions right now: ${acts}; allowed events right now: ${evts}`;
}

/**
 * Helper to resolve the catalog dictionary against disk and worked defaults.
 */
export function resolveStoryCatalog(options = {}) {
  if (options.catalog && typeof options.catalog === 'object') {
    if (Array.isArray(options.catalog)) {
      return Object.fromEntries(options.catalog.map((k) => [k.kit || k.id, k]));
    }
    return { ...options.catalog };
  }

  let diskCatalog = {};
  try {
    diskCatalog = loadCatalog({ kitsDir: options.kitsDir, asDict: true });
  } catch {
    diskCatalog = {};
  }

  // Merge worked kits overlay with loaded disk catalog
  const merged = { ...WORKED_KITS_CATALOG };
  for (const [kid, entry] of Object.entries(diskCatalog)) {
    if (!merged[kid]) {
      merged[kid] = entry;
    } else {
      const existing = merged[kid];
      const combinedSockets = Array.from(new Set([...(existing.sockets || []), ...(entry.sockets || [])]));

      const combinedPropsMap = new Map();
      for (const p of existing.props || []) combinedPropsMap.set(p.id, p);
      for (const p of entry.props || []) {
        if (combinedPropsMap.has(p.id)) {
          combinedPropsMap.set(p.id, { ...combinedPropsMap.get(p.id), ...p });
        } else {
          combinedPropsMap.set(p.id, p);
        }
      }

      const combinedPortalsMap = new Map();
      for (const p of existing.portals || []) combinedPortalsMap.set(p.socket, p);
      for (const p of entry.portals || []) combinedPortalsMap.set(p.socket, p);

      merged[kid] = {
        ...existing,
        ...entry,
        sockets: combinedSockets,
        props: Array.from(combinedPropsMap.values()),
        portals: Array.from(combinedPortalsMap.values()),
        default_socket: existing.default_socket || entry.default_socket,
      };
    }
  }

  return merged;
}

/**
 * Deep clones an object safely.
 */
function deepClone(obj) {
  if (obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(deepClone);
  const copy = {};
  for (const [k, v] of Object.entries(obj)) {
    copy[k] = deepClone(v);
  }
  return copy;
}

/**
 * Performs hand-off continuity checks and repairs between adjacent location blocks (Spec Section 3.3 Rule 5).
 * - Checks leaving portal leads_to and landing socket
 * - Repairs next scene's from_socket if mismatched
 * - Validates screen direction continuity
 * - Propagates cast from_socket defaults within same location
 */
export function repairStoryHandoffs(planInput, options = {}) {
  const plan = options.inPlace ? planInput : deepClone(planInput);
  const repairs = [];
  const warnings = [];

  if (!plan || typeof plan !== 'object' || !plan.story || !Array.isArray(plan.story.locations)) {
    return { plan, repairs, warnings };
  }

  const catalog = resolveStoryCatalog(options);
  const locations = plan.story.locations;
  const scenes = Array.isArray(plan.scenes) ? plan.scenes : [];

  // Track actor positions per kit across scenes
  const lastActorSocket = new Map();

  for (let lIdx = 0; lIdx < locations.length; lIdx++) {
    const loc = locations[lIdx];
    const kitEntry = catalog[loc.kit];
    const fromScene = loc.from_scene;
    const toScene = loc.to_scene;

    // Within-location actor socket continuity
    for (let sIdx = fromScene; sIdx <= toScene; sIdx++) {
      const scene = scenes[sIdx];
      if (!scene || !Array.isArray(scene.cast)) continue;

      for (const actor of scene.cast) {
        if (!actor || !actor.character) continue;
        const charId = actor.character;

        if (!actor.from_socket) {
          const prevSocket = lastActorSocket.get(`${loc.kit}:${charId}`);
          if (prevSocket) {
            actor.from_socket = prevSocket;
            repairs.push(
              `Defaulted scene ${sIdx} cast "${charId}" from_socket to previous socket "${prevSocket}" in kit "${loc.kit}"`
            );
          } else if (kitEntry && kitEntry.default_socket) {
            actor.from_socket = kitEntry.default_socket;
          }
        }

        if (actor.to_socket) {
          lastActorSocket.set(`${loc.kit}:${charId}`, actor.to_socket);
        } else if (actor.from_socket) {
          lastActorSocket.set(`${loc.kit}:${charId}`, actor.from_socket);
        }
      }
    }

    // Check transition to next location
    if (lIdx < locations.length - 1) {
      const nextLoc = locations[lIdx + 1];
      const leavingScene = scenes[toScene];
      const enteringScene = scenes[nextLoc.from_scene];

      if (!leavingScene || !enteringScene) continue;

      // Find leaving socket (from cast to_socket or scene socket)
      let leavingSocket = null;
      if (Array.isArray(leavingScene.cast) && leavingScene.cast.length > 0) {
        const lastCast = leavingScene.cast[leavingScene.cast.length - 1];
        leavingSocket = lastCast.to_socket || lastCast.from_socket;
      }
      if (!leavingSocket && leavingScene.location) {
        leavingSocket = leavingScene.location.socket;
      }

      // Check portals of leaving kit
      const leavingPortals = (kitEntry && Array.isArray(kitEntry.portals)) ? kitEntry.portals : [];
      let matchingPortal = null;

      for (const p of leavingPortals) {
        if (!p || p.socket !== leavingSocket) continue;
        const lt = p.leads_to;
        if (!lt) continue;

        if (lt.kit === nextLoc.kit) {
          matchingPortal = p;
          break;
        }
        if (Array.isArray(lt.kit_tags)) {
          const nextEntry = catalog[nextLoc.kit];
          const nextTags = (nextEntry && Array.isArray(nextEntry.tags)) ? nextEntry.tags : [];
          if (lt.kit_tags.some((t) => nextTags.includes(t))) {
            matchingPortal = p;
            break;
          }
        }
      }

      if (matchingPortal) {
        const targetSocket = matchingPortal.leads_to?.socket;
        if (targetSocket) {
          // Verify or repair entering scene's first cast from_socket
          if (Array.isArray(enteringScene.cast) && enteringScene.cast.length > 0) {
            const firstCast = enteringScene.cast[0];
            if (firstCast.from_socket !== targetSocket) {
              const oldSocket = firstCast.from_socket;
              firstCast.from_socket = targetSocket;
              repairs.push(
                `Repaired hand-off: set scene ${nextLoc.from_scene} cast "${firstCast.character}" from_socket from "${oldSocket || 'unset'}" to portal landing socket "${targetSocket}"`
              );
              warnings.push(
                `Hand-off repair: scene ${nextLoc.from_scene} cast from_socket repaired to "${targetSocket}"`
              );
            }
          }
        }

        // Screen direction check (exit_dir vs enter_dir)
        const exitDir = matchingPortal.exit_dir;
        const enterDir = matchingPortal.enter_dir || matchingPortal.leads_to?.enter_dir;
        if (exitDir && enterDir && exitDir !== enterDir) {
          warnings.push(
            `Direction mismatch across transition from scene ${toScene} (${loc.kit}, exit: ${exitDir}) to scene ${nextLoc.from_scene} (${nextLoc.kit}, enter: ${enterDir})`
          );
        }
      }
    }
  }

  return { plan, repairs, warnings };
}

/**
 * Validate a complete Director Any-Story Plan against the specification.
 *
 * Rules verified (Spec Sections 3.1 - 3.3, 5.1 - 5.3):
 * 1. Structure: story object with version 1, 1 to 4 locations, at most 8 props.
 * 2. Contiguity: locations cover all 3D scenes 0..N-1 contiguous without overlap or gap.
 * 3. Narration integrity: concatenation of scene text matches plan.script.
 * 4. Pacing cap: max 4.0 seconds of narration per scene (<= 8 words).
 * 5. Registry validation: kit IDs, socket IDs, cast actions, event kinds, prop IDs.
 * 6. Hand-off repair & transition semantics on location boundary scenes.
 */
export function validateAnyStoryPlan(planInput, options = {}) {
  const errors = [];
  const warnings = [];
  const repairs = [];

  if (!planInput || typeof planInput !== 'object') {
    return {
      valid: false,
      errors: ['Plan must be a non-null object'],
      warnings,
      repairs,
    };
  }

  const plan = options.inPlace ? planInput : deepClone(planInput);
  const catalog = resolveStoryCatalog(options);
  const shouldRepair = options.repair !== false;

  // 1. Top-level sanity
  if (!plan.title || typeof plan.title !== 'string') {
    warnings.push('Plan is missing a valid title string');
  }

  if (typeof plan.script !== 'string') {
    errors.push('Plan must have a script string');
  }

  const scenes = Array.isArray(plan.scenes) ? plan.scenes : null;
  if (!scenes || scenes.length === 0) {
    errors.push('Plan must contain a non-empty scenes array');
    return { valid: false, errors, warnings, repairs, plan };
  }

  // Fallback single-location handling
  if (!plan.story) {
    errors.push('Missing top-level story block in any-story plan');
    return { valid: false, errors, warnings, repairs, plan };
  }

  if (plan.story.fallback === 'single_location') {
    warnings.push('Story fallback active: single_location mode');
    return { valid: true, errors: [], warnings, repairs, plan };
  }

  if (plan.story.version !== 1) {
    errors.push(`Unsupported story version: expected 1, got ${plan.story.version}`);
  }

  // 2. Locations array validation (Spec Section 3.1, Rule D7)
  const locations = Array.isArray(plan.story.locations) ? plan.story.locations : [];
  if (locations.length === 0) {
    errors.push('story.locations must contain at least 1 location');
  } else if (locations.length > 4) {
    errors.push(`story.locations exceeds 4-location limit (got ${locations.length})`);
  }

  // Check contiguous scene coverage
  let expectedNextScene = 0;
  let prevTimeVal = 0;

  for (let i = 0; i < locations.length; i++) {
    const loc = locations[i];
    if (!loc || typeof loc !== 'object') {
      errors.push(`Invalid location entry at index ${i}`);
      continue;
    }

    if (!loc.id || !loc.id.startsWith('L')) {
      warnings.push(`Location at index ${i} should have id like L${i + 1}, got "${loc.id}"`);
    }

    if (!catalog[loc.kit]) {
      errors.push(`Unknown kit "${loc.kit}" in story.locations with no fallback`);
    }

    if (loc.from_scene !== expectedNextScene) {
      errors.push(
        `Location ${loc.id || i} from_scene mismatch: expected ${expectedNextScene}, got ${loc.from_scene}`
      );
    }

    if (typeof loc.to_scene !== 'number' || loc.to_scene < loc.from_scene) {
      errors.push(`Location ${loc.id || i} has invalid to_scene: ${loc.to_scene}`);
    } else {
      expectedNextScene = loc.to_scene + 1;
    }

    if (loc.time) {
      if (!VALID_TIMES.includes(loc.time)) {
        warnings.push(`Unknown location time "${loc.time}" at ${loc.id}; expected one of ${VALID_TIMES.join(', ')}`);
      } else {
        const curTimeVal = TIME_ORDER[loc.time];
        if (prevTimeVal > 0 && curTimeVal < prevTimeVal) {
          warnings.push(
            `Time moved backwards from step ${i - 1} to ${i} (${loc.time}); expected dawn < noon < sunset < night`
          );
        }
        prevTimeVal = curTimeVal;
      }
    }
  }

  if (expectedNextScene !== scenes.length) {
    errors.push(
      `Locations do not cover all scenes: locations cover up to scene ${expectedNextScene - 1}, but total scenes is ${scenes.length}`
    );
  }

  // 3. Script narration equality check (Spec Section 3.3 Rule 6)
  const normText = (str) => String(str || '').replace(/\s+/g, ' ').trim();
  const joinedNarration = normText(scenes.map((s) => s.text || '').join(' '));
  const planScript = normText(plan.script);

  if (joinedNarration !== planScript) {
    errors.push(
      `Narration does not match script.\nScript: "${planScript}"\nScenes joined: "${joinedNarration}"`
    );
  }

  // 4. Props roster validation (Spec Section 3.1)
  const storyProps = Array.isArray(plan.story.props) ? plan.story.props : [];
  if (storyProps.length > 8) {
    errors.push(`story.props exceeds 8-prop limit (got ${storyProps.length})`);
  }

  const knownPropIds = new Set();
  const chosenKits = new Set(locations.map((l) => l.kit));

  for (const p of storyProps) {
    if (!p || !p.id) {
      errors.push('Prop in story.props missing required id');
      continue;
    }
    knownPropIds.add(p.id);

    if (p.source === 'kit') {
      if (!p.kit_prop) {
        errors.push(`Kit prop "${p.id}" missing required kit_prop identifier`);
      } else {
        // Verify kit_prop exists in at least one chosen kit
        let propFoundInChosenKits = false;
        for (const kid of chosenKits) {
          const kEntry = catalog[kid];
          if (kEntry && Array.isArray(kEntry.props)) {
            if (kEntry.props.some((kp) => (kp.id || kp) === p.kit_prop)) {
              propFoundInChosenKits = true;
              break;
            }
          }
        }
        if (!propFoundInChosenKits) {
          errors.push(
            `Prop "${p.id}" specifies kit_prop "${p.kit_prop}" which is not found in chosen kits [${Array.from(chosenKits).join(', ')}]`
          );
        }
      }
    } else if (p.source === 'generated') {
      const allowedObjects = [plan.object, ...(Array.isArray(plan.objects) ? plan.objects : [])].filter(Boolean);
      const matchesObject = allowedObjects.some(
        (objName) => p.name?.toLowerCase().includes(objName.toLowerCase()) || p.id?.toLowerCase().includes(objName.toLowerCase())
      );
      if (!matchesObject && allowedObjects.length > 0) {
        warnings.push(`Generated prop "${p.id}" does not map to plan object/objects: [${allowedObjects.join(', ')}]`);
      }
    } else {
      errors.push(`Prop "${p.id}" has invalid source: "${p.source}"; must be "kit" or "generated"`);
    }
  }

  // 5. Cast roster validation
  const characters = Array.isArray(plan.characters) ? plan.characters : [];
  if (characters.length > 3) {
    errors.push(`Cast roster exceeds 3 characters limit (got ${characters.length})`);
  }
  const knownCharacterIds = new Set(characters.map((c) => c.id));

  // Determine valid action & event sets
  const allowedCastActions = options.strictWorkerAccepted ? ACCEPTED_CAST_ACTIONS : DESIGNED_CAST_ACTIONS;
  const allowedEvents = options.strictWorkerAccepted ? ACCEPTED_EVENTS : DESIGNED_EVENTS;

  // 6. Scene-by-scene validation
  for (let sIdx = 0; sIdx < scenes.length; sIdx++) {
    const scene = scenes[sIdx];
    if (!scene || typeof scene !== 'object') {
      errors.push(`Scene ${sIdx} is not a valid object`);
      continue;
    }

    // Narration pacing cap (Spec Section 8, Rule D9: max 4 s = 8 words)
    const words = String(scene.text || '').trim().split(/\s+/).filter(Boolean);
    if (words.length > 8) {
      warnings.push(`Scene ${sIdx} exceeds 4 s narration cap (${words.length} words > 8 words cap)`);
    }

    // Story beat
    if (scene.story_beat && !STORY_BEATS.includes(scene.story_beat)) {
      warnings.push(
        `Scene ${sIdx} has unknown story_beat "${scene.story_beat}"; expected one of ${STORY_BEATS.join(', ')}`
      );
    }

    // Find covering location
    const coveringLoc = locations.find((l) => sIdx >= l.from_scene && sIdx <= l.to_scene);
    if (!coveringLoc) {
      errors.push(`Scene ${sIdx} is not covered by any location in story.locations`);
      continue;
    }

    const kitEntry = catalog[coveringLoc.kit];
    const kitSockets = new Set(kitEntry?.sockets || []);
    const defaultSocket = kitEntry?.default_socket || kitEntry?.sockets?.[0];

    // Location key
    if (!scene.location || typeof scene.location !== 'object') {
      errors.push(`Scene ${sIdx} missing required location object`);
    } else {
      if (scene.location.kit !== coveringLoc.kit) {
        errors.push(
          `Scene ${sIdx} location.kit "${scene.location.kit}" does not match covering location kit "${coveringLoc.kit}"`
        );
      }
      if (scene.location.socket && !kitSockets.has(scene.location.socket)) {
        const badSock = scene.location.socket;
        if (shouldRepair && defaultSocket) {
          scene.location.socket = defaultSocket;
          repairs.push(
            `Repaired unknown socket "${badSock}" in scene ${sIdx} location to kit default socket "${defaultSocket}"`
          );
          warnings.push(
            `Unknown socket "${badSock}" in scene ${sIdx} location replaced by kit default "${defaultSocket}"`
          );
        } else {
          warnings.push(`Unknown socket "${badSock}" in scene ${sIdx} location`);
        }
      }
    }

    // Cast validation
    if (Array.isArray(scene.cast)) {
      if (scene.cast.length > 2) {
        warnings.push(`Scene ${sIdx} has ${scene.cast.length} cast members (cap is 2 per scene)`);
      }

      for (let cIdx = 0; cIdx < scene.cast.length; cIdx++) {
        const actor = scene.cast[cIdx];
        if (!actor || !actor.character) {
          errors.push(`Scene ${sIdx} cast member at index ${cIdx} missing character id`);
          continue;
        }

        if (!knownCharacterIds.has(actor.character)) {
          errors.push(`Scene ${sIdx} cast member "${actor.character}" not declared in plan.characters`);
        }

        if (actor.action && !allowedCastActions.includes(actor.action)) {
          const badAction = actor.action;
          if (shouldRepair) {
            actor.action = 'idle';
            repairs.push(`Repaired unknown cast action "${badAction}" in scene ${sIdx} to "idle"`);
            warnings.push(`Unknown cast action "${badAction}" in scene ${sIdx} replaced by "idle"`);
          } else {
            warnings.push(`Unknown cast action "${badAction}" in scene ${sIdx}`);
          }
        }

        // Sockets
        if (actor.from_socket && !kitSockets.has(actor.from_socket)) {
          const badSock = actor.from_socket;
          if (shouldRepair && defaultSocket) {
            actor.from_socket = defaultSocket;
            repairs.push(`Repaired unknown from_socket "${badSock}" for cast in scene ${sIdx} to "${defaultSocket}"`);
            warnings.push(`Unknown from_socket "${badSock}" for cast in scene ${sIdx} replaced by "${defaultSocket}"`);
          } else {
            warnings.push(`Unknown from_socket "${badSock}" for cast in scene ${sIdx}`);
          }
        }

        if (actor.to_socket && !kitSockets.has(actor.to_socket)) {
          const badSock = actor.to_socket;
          if (shouldRepair && defaultSocket) {
            actor.to_socket = defaultSocket;
            repairs.push(`Repaired unknown to_socket "${badSock}" for cast in scene ${sIdx} to "${defaultSocket}"`);
            warnings.push(`Unknown to_socket "${badSock}" for cast in scene ${sIdx} replaced by "${defaultSocket}"`);
          } else {
            warnings.push(`Unknown to_socket "${badSock}" for cast in scene ${sIdx}`);
          }
        }

        // Word index
        if (typeof actor.word_index === 'number') {
          if (actor.word_index < 0 || (words.length > 0 && actor.word_index >= words.length)) {
            warnings.push(
              `Scene ${sIdx} cast word_index ${actor.word_index} out of word range [0..${words.length - 1}]`
            );
          }
        }

        // Prop reference
        if (actor.prop && !knownPropIds.has(actor.prop)) {
          warnings.push(`Scene ${sIdx} cast refers to unknown prop id "${actor.prop}"`);
        }
      }
    }

    // Props validation
    if (Array.isArray(scene.props)) {
      for (const p of scene.props) {
        if (!p || !p.id) continue;
        if (!knownPropIds.has(p.id)) {
          warnings.push(`Scene ${sIdx} references undeclared prop "${p.id}"`);
        }
        if (p.move) {
          if (p.move.from_socket && !kitSockets.has(p.move.from_socket)) {
            warnings.push(`Scene ${sIdx} prop move has unknown from_socket "${p.move.from_socket}"`);
          }
          if (p.move.to_socket && !kitSockets.has(p.move.to_socket)) {
            warnings.push(`Scene ${sIdx} prop move has unknown to_socket "${p.move.to_socket}"`);
          }
        }
      }
    }

    // Events validation
    if (Array.isArray(scene.events)) {
      const validEvents = [];
      for (const ev of scene.events) {
        if (!ev || !ev.kind) continue;
        if (!allowedEvents.includes(ev.kind)) {
          if (shouldRepair) {
            repairs.push(`Dropped unknown or unsupported event "${ev.kind}" in scene ${sIdx}`);
            warnings.push(`Unknown event kind "${ev.kind}" in scene ${sIdx} dropped`);
          } else {
            warnings.push(`Unknown event kind "${ev.kind}" in scene ${sIdx}`);
            validEvents.push(ev);
          }
        } else {
          validEvents.push(ev);
        }

        if (ev.target && !knownPropIds.has(ev.target)) {
          const allowedObjects = [plan.object, ...(Array.isArray(plan.objects) ? plan.objects : [])].filter(Boolean);
          if (!allowedObjects.includes(ev.target)) {
            warnings.push(`Scene ${sIdx} event target "${ev.target}" does not match any prop or object`);
          }
        }

        if (typeof ev.word_index === 'number') {
          if (ev.word_index < 0 || (words.length > 0 && ev.word_index >= words.length)) {
            warnings.push(
              `Scene ${sIdx} event word_index ${ev.word_index} out of word range [0..${words.length - 1}]`
            );
          }
        }
      }
      if (shouldRepair) {
        scene.events = validEvents;
      }
    }

    // Transition validation (Spec Section 3.2: only on last scene of location block)
    const isLastSceneOfLocation = coveringLoc.to_scene === sIdx;
    if (scene.transition) {
      if (!isLastSceneOfLocation) {
        warnings.push(`Scene ${sIdx} has transition but is not the last scene of location ${coveringLoc.id}`);
      }
      if (!TRANSITION_KINDS.includes(scene.transition.kind)) {
        warnings.push(
          `Scene ${sIdx} transition has unknown kind "${scene.transition.kind}"; expected one of ${TRANSITION_KINDS.join(', ')}`
        );
      }
      if (!TRANSITION_CAUSES.includes(scene.transition.cause)) {
        warnings.push(
          `Scene ${sIdx} transition has unknown cause "${scene.transition.cause}"; expected one of ${TRANSITION_CAUSES.join(', ')}`
        );
      }
    }
  }

  // 7. Hand-off repair pass
  if (shouldRepair) {
    const handoffResult = repairStoryHandoffs(plan, { inPlace: true, catalog });
    repairs.push(...handoffResult.repairs);
    warnings.push(...handoffResult.warnings);
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    repairs,
    plan,
  };
}

/**
 * Normalises a story plan for execution, setting settings and preserving scene structures.
 * (Spec Section 3.3).
 */
export function normaliseStoryPlan(planInput, options = {}) {
  const validation = validateAnyStoryPlan(planInput, { ...options, repair: true });
  if (!validation.valid) {
    return validation;
  }

  const plan = validation.plan;
  const catalog = resolveStoryCatalog(options);
  const locations = plan.story?.locations || [];

  for (let sIdx = 0; sIdx < plan.scenes.length; sIdx++) {
    const scene = plan.scenes[sIdx];
    const loc = locations.find((l) => sIdx >= l.from_scene && sIdx <= l.to_scene);
    const kitEntry = loc ? catalog[loc.kit] : null;

    // Preserve scene keys as written (Spec Section 3.3 Rule 1)
    scene.preserveScenes = true;

    // Derive scene.setting (Spec Section 3.3 Rule 2)
    if (scene.location) {
      scene.setting = {
        world: 'kit',
        kit: scene.location.kit,
        placement: kitEntry?.placement || 'ground',
        ...(loc?.time ? { time: loc.time } : {}),
      };
    }

    // Copy transition into shot.transition for worker motion-law integration
    if (scene.transition && scene.shot) {
      scene.shot.transition = { ...scene.transition };
    }
  }

  return {
    valid: true,
    errors: [],
    warnings: validation.warnings,
    repairs: validation.repairs,
    plan,
  };
}
