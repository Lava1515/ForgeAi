const EXACT_FORMS = new WeakMap();
// Bound descriptive modifiers so an action cannot consume an unrelated sentence.
const NOUN_MODIFIERS = '(?:(?:a|an|the|some)\\s+)?(?:[a-z]+\\s+){0,2}';

const action = (id, still, motion, audio, needsProp, pattern, exactForms) => {
  const entry = {
    id,
    still,
    motion,
    audio,
    needsProp,
    match: new RegExp(`\\b(?:${pattern})\\b`, 'i'),
    verified: false,
    status: 'unverified',
  };
  EXACT_FORMS.set(entry, new Set([id, ...exactForms]));
  return entry;
};

// Candidate descriptions only. The GPU probe must establish which actions are reliable.
export const PRESCHOOL_ACTIONS = [
  action('wave', 'Toddler stands upright and waves one hand in a friendly hello.', 'Toddler raises one hand and waves it gently side to side.', 'touch', false, 'wav(?:e|es|ed|ing)', ['wave', 'waves', 'waved', 'waving']),
  action('point', 'Toddler stands upright and points outward with one arm.', 'Toddler extends one arm and points clearly toward something nearby.', 'touch', false, 'point(?:s|ed|ing)?', ['point', 'points', 'pointed', 'pointing']),
  action('look', 'Toddler stands upright with head turned to look around.', 'Toddler turns their head and looks around the setting.', 'pop', false, 'look(?:s|ed|ing)?', ['look', 'looks', 'looked', 'looking']),
  action('walk', 'Full-body wide view of toddler mid-stride, walking across the setting.', 'Toddler walks forward with several small, clear steps.', 'steps', false, 'walk(?:s|ed|ing)?', ['walk', 'walks', 'walked', 'walking']),
  action('run', 'Full-body wide view of toddler in a playful running stride.', 'Toddler runs forward with several quick, playful steps.', 'steps', false, 'run(?:s|ning)?|ran', ['run', 'runs', 'running', 'ran']),
  action('jump', 'Full-body view of toddler bending knees before a small jump.', 'Toddler bends their knees, makes one small jump, and lands safely.', 'touch', false, 'jump(?:s|ed|ing)?', ['jump', 'jumps', 'jumped', 'jumping']),
  action('dance', 'Full-body view of toddler standing with room to move and dance.', 'Toddler dances with a few simple sways and gentle steps.', 'touch', false, 'danc(?:e|es|ed|ing)', ['dance', 'dances', 'danced', 'dancing']),
  action('paint', 'Toddler faces an easel with paper and holds a child-safe paintbrush in one hand, touching the brush to the paper.', 'Toddler faces an easel and holds a brush in one hand, making a few strokes on paper.', 'touch', true, 'paint(?:s|ed|ing)?', ['paint', 'paints', 'painted', 'painting']),
  action('clap', 'Toddler stands upright with both hands visible in front of the body.', 'Toddler brings both hands together for a few gentle claps.', 'touch', false, 'clap(?:s|ped|ping)?', ['clap', 'claps', 'clapped', 'clapping']),
  action('kick_ball', 'Toddler stands near a soft ball with both feet visible.', 'Toddler gently kicks a soft ball forward once.', 'touch', true, `kick(?:s|ed|ing)?[\\s-]+${NOUN_MODIFIERS}ball`, ['kick ball', 'kicks ball', 'kicking ball', 'kicked ball']),
  action('stack_blocks', 'Toddler sits or kneels beside a few large soft blocks.', 'Toddler carefully places one block on top of another.', 'touch', true, `stack(?:s|ed|ing)?[\\s-]+${NOUN_MODIFIERS}blocks?`, ['stack blocks', 'stacks blocks', 'stacking blocks', 'stacked blocks']),
  action('pick_up', 'Toddler bends toward a toy on the floor while keeping the face and hair clear.', 'Toddler bends down, picks up a toy, and holds it at chest height.', 'touch', true, 'pick(?:s|ed|ing)?[\\s-]+(?:up|(?:(?:a|an|the|some)\\s+)?(?:[a-z]+\\s+){0,2}(?:toy|ball|blocks?)\\s+up)', ['pick up', 'picks up', 'picked up', 'picking up']),
];

export function resolveAction(text) {
  if (typeof text !== 'string') return { entry: null, exact: false };
  const normalized = text.trim().toLocaleLowerCase();
  if (!normalized) return { entry: null, exact: false };

  for (const entry of PRESCHOOL_ACTIONS) {
    if (EXACT_FORMS.get(entry).has(normalized)) return { entry, exact: true };
  }

  for (const entry of PRESCHOOL_ACTIONS) {
    if (!entry.match.test(normalized)) continue;
    return { entry, exact: false };
  }
  return { entry: null, exact: false };
}
