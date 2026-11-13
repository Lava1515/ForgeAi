export function formatRevision(revision) {
  if (!revision) return '';
  return String(revision).slice(0, 8);
}

export function formatStillMeta(scene = {}) {
  if (!scene || typeof scene !== 'object') return '';
  const parts = [];

  const action = scene.action || scene.action_id || '';
  if (action) {
    parts.push(`Action: ${action}`);
  }

  let cue = scene.cue || '';
  if (!cue) {
    const sfx = scene.sfx || '';
    const audioObj = scene.audio || null;
    const audioKind = typeof audioObj === 'string' ? audioObj : (audioObj?.kind || '');
    if (sfx && audioKind) {
      cue = sfx === audioKind ? sfx : `${sfx} + ${audioKind}`;
    } else if (sfx) {
      cue = sfx;
    } else if (audioKind) {
      cue = audioKind;
    }
  }
  if (cue) {
    parts.push(`Cue: ${cue}`);
  }

  const rev = formatRevision(scene.input_revision || scene.input_identity);
  if (rev) {
    parts.push(`Rev: ${rev}`);
  }

  const seed = Number.isInteger(scene.still_seed)
    ? scene.still_seed
    : (Number.isInteger(scene.seed) ? scene.seed : null);
  if (seed !== null && seed !== undefined) {
    parts.push(`Seed: ${seed}`);
  }

  return parts.join(' · ');
}

export function getStillImageUrl(stillUrl, revision) {
  if (!stillUrl) return null;
  const rev = formatRevision(revision);
  if (!rev) return stillUrl;
  const sep = stillUrl.includes('?') ? '&' : '?';
  return `${stillUrl}${sep}v=${encodeURIComponent(rev)}`;
}
