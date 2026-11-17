// codex · gpt-6.1-sol · 2026-11-17 13:53 +02:00
import crypto from 'node:crypto';
import { cleanJobFormats } from './skills.js';
export function jobUsesOverlay(pack, formats, route) {
 return route === 'overlay' || route === 'authored' || cleanJobFormats(formats).some(name => pack?.rules?.formats?.[name]?.overlay === true);
}
// codex · gpt-6.1-sol · 2026-11-17 17:25 +02:00: builds and overlays are resumed only as a validated pair.
export function overlayPair(build, spec, options) {
 return {version:1, build_sha256:crypto.createHash('sha256').update(build).digest('hex'), spec:validateOverlaySpec(spec,options)};
}
export function validateOverlayPair(pair, build, options) {
 if (!pair || pair.version !== 1 || pair.build_sha256 !== crypto.createHash('sha256').update(build).digest('hex')) fail('bad_pair','');
 return validateOverlaySpec(pair.spec,options);
}
// Contract 2.3. Keep error order and paths in parity with post/overlay.py.
export class OverlaySpecError extends Error {
  constructor(code, where = '') { super(`overlay.json: ${code} at ${where || 'top level'}`); this.code = code; this.where = where; }
}
const fail = (code, where) => { throw new OverlaySpecError(code, where); };
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const schema = {
 counter: [{value:'name',format:'format',from:'num',to:'num'},{unit:'text',label:'text'}],
 labels: [{anchor:'name',title:'text',from:'num',to:'num'},{value:'text',side:'side'}],
 measures: [{a:'name',b:'name',text:'text',from:'num',to:'num'},{}],
 bars: [{value:'name',min:'num',max:'num',from:'num',to:'num'},{label:'text'}],
 big: [{text:'text',from:'num',to:'num'},{sub:'sub'}], tag: [{text:'text',from:'num',to:'num'},{}],
};
function field(kind, v, where) {
 if (kind === 'name') {
  if (typeof v !== 'string') fail('bad_type',where);
  if (!/^[a-z][a-z0-9_]{0,23}$/.test(v)) fail('bad_name',where);
 } else if (kind === 'text' || kind === 'sub') {
  if (typeof v !== 'string') fail('bad_type',where);
  if (!/^[A-Za-z0-9 .,%\u00b0\u00d7\-+/:'()]+$/.test(v) || !v.trim()) fail('bad_text',where);
  if (v.length > (kind === 'sub' ? 40 : 28)) fail('text_length',where);
 } else if (kind === 'num') {
  if (typeof v !== 'number' || !Number.isFinite(v)) fail('bad_number',where);
 } else if (kind === 'format' && !['int','int_commas','one_decimal','two_decimals','year','times'].includes(v)) fail('bad_format',where);
 else if (kind === 'side' && !['left','right','auto'].includes(v)) fail('bad_side',where);
 return v;
}
export function validateOverlaySpec(spec, {videoSeconds = null} = {}) {
 if (!object(spec)) fail('not_object','');
 for (const key of Object.keys(spec)) if (key !== 'version' && !Object.hasOwn(schema,key)) fail('unknown_key',key);
 if (!Object.hasOwn(spec,'version')) fail('missing_key','version');
 if (spec.version !== 1) fail('bad_version','version');
 const out = {version:1};
 const element = (key, obj, where) => {
  if (!object(obj)) fail('bad_type',where);
  const [required,optional] = schema[key];
  for (const k of Object.keys(obj)) if (!Object.hasOwn(required,k) && !Object.hasOwn(optional,k)) fail('unknown_key',`${where}.${k}`);
  for (const k of Object.keys(required)) if (!Object.hasOwn(obj,k)) fail('missing_key',`${where}.${k}`);
  const result = {};
  for (const [k,kind] of Object.entries({...required,...optional})) if (Object.hasOwn(obj,k)) result[k] = field(kind,obj[k],`${where}.${k}`);
  if (result.from < 0 || result.from >= result.to || (videoSeconds !== null && result.to > videoSeconds)) fail('bad_time',where);
  if (key === 'bars' && result.min >= result.max) fail('bad_range',where);
  if (key === 'measures' && result.a === result.b) fail('same_anchor',where);
  if (key === 'labels') result.side ??= 'auto';
  return result;
 };
 for (const key of Object.keys(schema)) {
  if (key === 'counter' || key === 'tag') { if (Object.hasOwn(spec,key)) out[key] = element(key,spec[key],key); continue; }
  const list = Object.hasOwn(spec,key) ? spec[key] : [];
  if (!Array.isArray(list)) fail('bad_type',key);
  if (list.length > ({labels:12,measures:4,bars:2,big:3})[key]) fail('too_many',key);
  out[key] = list.map((v,i) => element(key,v,`${key}[${i}]`));
 }
 return out;
}
export function parseOverlaySpec(raw, options) {
 if (Buffer.byteLength(raw,'utf8') > 65536) fail('too_large','');
 let spec; try { spec = JSON.parse(raw); } catch { fail('not_json',''); }
 return validateOverlaySpec(spec,options);
}
export function extractOverlay(reply, options) {
 const blocks = [...String(reply).matchAll(/```json[ \t]*\r?\n([\s\S]*?)```/gi)];
 if (blocks.length !== 1) fail('json_block_required','');
 return parseOverlaySpec(blocks[0][1],options);
}
export function overlayNames(spec) {
 return {points:[...(spec.labels ?? []).map(x=>x.anchor),...(spec.measures ?? []).flatMap(x=>[x.a,x.b])], values:[...(spec.counter ? [spec.counter.value] : []),...(spec.bars ?? []).map(x=>x.value)]};
}
