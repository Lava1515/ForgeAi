const sharedStyle = 'vibrant 3D animation style, adorable chubby cartoon toddler, sunny daylight';
const sharedFinish = 'saturated candy colours, soft glossy textures, cheerful and friendly, 4k 3d render';

export const PRESCHOOL_ENVIRONMENTS = Object.freeze([
  { id: 'playroom', label: 'Playroom', style: `${sharedStyle} playroom, ${sharedFinish}` },
  { id: 'garden', label: 'Garden', style: `${sharedStyle} garden, ${sharedFinish}` },
  { id: 'kitchen', label: 'Kitchen', style: `${sharedStyle} kitchen, ${sharedFinish}` },
  { id: 'beach', label: 'Beach', style: `${sharedStyle} beach, ${sharedFinish}` },
  { id: 'park', label: 'Park', style: `${sharedStyle} park, ${sharedFinish}` },
  { id: 'art_room', label: 'Art room', style: `${sharedStyle} art room, ${sharedFinish}` },
]);

const environmentIds = new Set(PRESCHOOL_ENVIRONMENTS.map(({ id }) => id));

export function resolvePreschoolEnvironment(id) {
  return environmentIds.has(id) ? id : 'playroom';
}

export function environmentStyle(id) {
  const resolvedId = resolvePreschoolEnvironment(id);
  return PRESCHOOL_ENVIRONMENTS.find(({ id: candidate }) => candidate === resolvedId).style;
}

// Hero identity never depends on the setting: one neutral studio look, so a saved hero fits every environment.
export const NEUTRAL_HERO_STYLE = `${sharedStyle} plain neutral studio background, ${sharedFinish}`;

// Removes the six exact known style strings (never arbitrary text) from authored prompts.
export const stripEnvironmentStyles = (text) => PRESCHOOL_ENVIRONMENTS.reduce((value, { style }) => value.replaceAll(style, ''), text);
