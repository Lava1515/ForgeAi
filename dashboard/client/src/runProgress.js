const ORDER = ['stage1_research', 'stage2_creative', 'stage3_comfyui', 'stage4_packager', 'completed'];

// Percent for the 4-stage pipeline; null (indeterminate bar) for run types with their own stage names.
export function stageProgress(stage) {
  const i = ORDER.indexOf(stage);
  return i < 0 ? null : Math.round(((i + 1) / ORDER.length) * 100);
}
