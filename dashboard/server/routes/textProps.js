// KAN-661: captions use word onsets, never the earlier label cues.
export function cleanTextProps(props) {
  if (!Array.isArray(props) || props.length > 8) throw new Error('Invalid text_props');
  return props.map(p => {
    if (!p || typeof p.text !== 'string' || !p.text.trim() || p.text.length > 80 || typeof p.word !== 'string' || !p.word.trim() || !Array.isArray(p.colour) || p.colour.length !== 3 || p.colour.some(v => typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) || ('socket' in p && typeof p.socket !== 'string')) throw new Error('Invalid text prop');
    return {text:p.text, word:p.word, colour:[...p.colour], ...('socket' in p ? {socket:p.socket} : {})};
  });
}
export function resolveTextProps(table, props, words = []) {
  return cleanTextProps(props).map(({word, ...p}) => {
    const key = s => String(s).toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
    const i = words.findIndex(w => key(w.word ?? w.text) === key(word));
    const frame = table.captionStarts[i];
    if (i < 0 || !Number.isFinite(frame) || frame < 0) throw new Error(`Missing text prop onset: ${word}`);
    return {...p, frame};
  });
}
