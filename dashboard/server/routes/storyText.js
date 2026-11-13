// Small text rules shared by the fact check, the topic research and the no-repeat list.

export const VIDEO_KINDS = ['whatif', 'explain', 'built', 'story', 'other'];

// The default hero of the archived preschool path. The fact check strips this phrase from a plan before hashing it.
export const PRESCHOOL_HERO = 'a chubby cartoon toddler with short brown hair, white t-shirt, orange shorts';

/** Any premise text -> exactly one leading "What if ...?" question. */
export function enforceWhatIfPremise(text) {
  let s = String(text || '').trim();
  while (/^What if\??(?=\s|$)\s*/i.test(s)) s = s.replace(/^What if\??(?=\s|$)\s*/i, '').trim();
  const stripped = s.replace(/[.?]+$/, '').trim();
  if (!stripped) return 'What if the impossible happened?';
  const uncap = stripped.charAt(0).toLowerCase() + stripped.slice(1);
  return `What if ${uncap}?`;
}
