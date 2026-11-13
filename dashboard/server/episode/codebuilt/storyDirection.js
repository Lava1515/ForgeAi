// KAN-940: steer topic and narration prompts toward a story carried by real places and visible actions.
export function storyDirection(type = 'factual') {
  const core = 'Prefer a story that moves through real places the viewer can recognize, with concrete actions, stakes and clear progression. Use a person or character viewpoint when it fits, but do not force a human into a process that has no natural human role. For science and engineering, follow the process through places it naturally occupies (for example, an engine from hangar to runway to sky) instead of defaulting to an isolated boxed lab. Keep explanations accurate.';
  const guard = type === 'whatif'
    ? 'Make the setup explicitly imaginary and label it as hypothetical. The events may be invented, but every real-world number and physical fact must be checked and accurate; do not present the hypothetical as real history.'
    : type === 'history'
      ? 'Use real, documented people and places. Check dates and other physical facts against sources. Do not invent dialogue, events or private thoughts; use documented actions or neutral explanatory narration.'
      : 'Do not present invented scenes, dialogue or events as fact. Keep every real-world claim checkable.';
  return `Story direction: ${core}\n${guard}`;
}
