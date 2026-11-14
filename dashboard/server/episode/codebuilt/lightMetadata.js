import { askRole } from '../../routes/askRole.js';

const clean = (value, max) => typeof value === 'string'
  ? value.replace(/[\x00-\x1f\x7f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, max) : '';

export function validateTitle(value) { return !!value && typeof value.title === 'string' && !!clean(value.title, 90); }
export function validateTags(value) { return !!value && Array.isArray(value.tags) && value.tags.length <= 12 && value.tags.every((tag) => typeof tag === 'string' && clean(tag, 32)); }

export async function produceLightMetadata(topic, { askRoleFn = askRole, onCallRecord } = {}) {
  const output = {};
  const safeTopic = clean(topic, 200);
  for (const [step, key, schema, prompt] of [
    ['titles', 'title', validateTitle, `Return JSON {"title":"..."} with a plain, accurate, descriptive video title for this topic, about 6 to 10 words as guidance (not a limit): say what the video shows or asks, in plain words. Avoid date-only titles, hashtags and clickbait; a relevant date or number in a descriptive title is welcome. Topic: ${safeTopic}`],
    ['tags', 'tags', validateTags, `Return JSON {"tags":[...]} with up to 8 short searchable tags for this topic: ${safeTopic}`],
  ]) {
    try {
      const result = await askRoleFn('writer', prompt, { step, validate: schema, onCallRecord });
      // An injected askRole is not trusted to have applied the schema: check the answer again here.
      if (!schema(result)) continue;
      output[key] = key === 'title' ? clean(result.title, 90) : [...new Set(result.tags.map((tag) => clean(tag, 32)).filter(Boolean))].slice(0, 12);
    } catch { /* metadata enriches the deterministic topic fallback; draft creation continues */ }
  }
  return output;
}
