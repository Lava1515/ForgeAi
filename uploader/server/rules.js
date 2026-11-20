// Uploader rules: what a package must look like, and which waiting video goes into which slot. Pure functions, no I/O.
// claude-pro · claude-fable-5-2 · 2026-11-20. Plan: docs/plans/2026-11-20-uploader-service-plan.md

export const MIN_GAP_MS = 4 * 60 * 60 * 1000; // two videos of one channel are never closer than this
export const MAX_DAILY_LIMIT = 4;
export const MAX_SLOTS = 6;
export const DEFAULT_SLOTS = Object.freeze(['15:00', '21:00']);
export const DEFAULT_DAILY_LIMIT = 2;
export const DAY_MS = 24 * 60 * 60 * 1000;

export const isSafeId = (id) => typeof id === 'string' && /^[A-Za-z0-9_-]{1,120}$/.test(id);
export const isChannelId = (id) => typeof id === 'string' && /^UC[A-Za-z0-9_-]{22}$/.test(id);

const CALENDAR = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december',
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  'ינואר', 'פברואר', 'מרץ', 'מרס', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];
const CLOCK = new Set(['am', 'pm', 'utc', 'gmt', 'st', 'nd', 'rd', 'th', 'יום']);

/** A title needs one real word: not digits, not a month or weekday name (English or Hebrew, Hebrew may carry the prefix ב). */
export function titleError(value) {
  if (typeof value !== 'string' || !value.trim()) return 'the title is empty';
  const title = value.trim();
  if (title.length > 100) return 'the title is longer than 100 characters';
  if (/[<>]/.test(title)) return 'the title contains < or >';
  const words = title.replace(/(\p{N})(?=\p{L})|(\p{L})(?=\p{N})/gu, '$1$2 ').split(/[^\p{L}\p{M}\p{N}]+/u).filter(Boolean);
  const real = words.some((word) => {
    const w = word.toLowerCase();
    if (/^\p{N}+$/u.test(w) || w.length < 2 || CLOCK.has(w)) return false;
    return ![w, w.replace(/^ב/u, '')].some((f) => CALENDAR.includes(f) || (f.length >= 3 && CALENDAR.some((c) => c.startsWith(f))));
  });
  return real ? null : 'the title is only a date, a time or digits';
}

/**
 * Why a manifest is refused, or null. `knownHashes` are the videos this uploader already holds or published.
 * A made-for-kids video is always refused: ForgeAi's channels are not for kids, so the flag would be a mistake.
 */
export function manifestError(manifest, { folderId, knownHashes = new Set() } = {}) {
  const m = manifest;
  if (!m || typeof m !== 'object' || Array.isArray(m)) return 'the manifest is not an object';
  if (!isSafeId(m.package_id)) return 'package_id is missing or not a plain name';
  if (folderId !== undefined && m.package_id !== folderId) return 'package_id does not match its folder name';
  if (typeof m.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(m.sha256)) return 'sha256 is missing';
  if (!isChannelId(m.youtube_channel_id)) return 'youtube_channel_id is missing or not a YouTube channel id';
  const title = titleError(m.title);
  if (title) return title;
  if (typeof m.description !== 'string' || m.description.length > 5000) return 'the description is missing or longer than 5000 characters';
  if (!Array.isArray(m.tags) || m.tags.length > 15 || m.tags.some((t) => typeof t !== 'string' || !t || t.length > 60 || /[<>#\s]/.test(t))) return 'tags must be up to 15 plain words';
  if (m.made_for_kids !== false) return 'made_for_kids must be false';
  if (typeof m.contains_synthetic_media !== 'boolean') return 'contains_synthetic_media must be true or false';
  if (typeof m.category_id !== 'string' || !/^\d{1,3}$/.test(m.category_id)) return 'category_id is missing';
  if (typeof m.language !== 'string' || !/^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*$/.test(m.language)) return 'language is missing';
  if (knownHashes.has(m.sha256)) return 'this exact video was already sent (same file)';
  return null;
}

/** ["15:00","21:00"] cleaned, sorted and unique; throws on a bad value. */
export function cleanSlots(slots) {
  if (!Array.isArray(slots) || !slots.length || slots.length > MAX_SLOTS) throw new TypeError(`Give 1 to ${MAX_SLOTS} slot times`);
  const out = new Set();
  for (const s of slots) {
    const hit = typeof s === 'string' && s.trim().match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
    if (!hit) throw new TypeError('A slot time looks like 15:00');
    out.add(`${hit[1].padStart(2, '0')}:${hit[2]}`);
  }
  const sorted = [...out].sort();
  for (let i = 1; i < sorted.length; i += 1) {
    if (minutesOf(sorted[i]) - minutesOf(sorted[i - 1]) < MIN_GAP_MS / 60000) throw new TypeError('Slots of one channel must be at least 4 hours apart');
  }
  // The last slot of a day and the first of the next day must keep the gap too.
  if (sorted.length > 1 && 1440 - minutesOf(sorted.at(-1)) + minutesOf(sorted[0]) < MIN_GAP_MS / 60000) throw new TypeError('Slots of one channel must be at least 4 hours apart');
  return sorted;
}
const minutesOf = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));

export function cleanDailyLimit(value) {
  if (!Number.isInteger(value) || value < 1 || value > MAX_DAILY_LIMIT) throw new TypeError(`The daily limit is a whole number from 1 to ${MAX_DAILY_LIMIT}`);
  return value;
}

/** The local calendar day of a time, as YYYY-MM-DD (the uploader machine's time zone: the owner's wall clock). */
export function localDay(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Slot times (ms) after `from` and up to `until`, in local time, oldest first. */
export function upcomingSlots(slots, from, until) {
  const out = [];
  const start = new Date(from);
  for (let day = 0; day <= Math.ceil((until - from) / DAY_MS) + 1; day += 1) {
    for (const slot of slots) {
      const at = new Date(start.getFullYear(), start.getMonth(), start.getDate() + day, Number(slot.slice(0, 2)), Number(slot.slice(3)), 0, 0).getTime();
      if (at > from && at <= until) out.push(at);
    }
  }
  return out.sort((a, b) => a - b);
}

// A package that holds a place on YouTube's calendar: handed over, being handed over, or already public.
const HOLDS_SLOT = new Set(['uploading', 'scheduled', 'public']);
export const holdsSlot = (pkg) => HOLDS_SLOT.has(pkg.state) && Number.isFinite(Date.parse(pkg.publish_at || ''));

/**
 * Which waiting package goes to YouTube now, and for which slot.
 * state: { paused, channels: {id: {slots, daily_limit, paused}}, packages: {id: {...}} }
 * connected: Set of channel ids with a sign-in. leadMs: earliest slot after now. aheadMs: how far ahead a video is handed to YouTube.
 * -> [{ id, channel, publishAt (ISO) }]   Never more than the daily limit, never two in one slot, never closer than MIN_GAP_MS.
 */
export function planUploads({ state, connected, now, leadMs = 20 * 60 * 1000, aheadMs = 6 * 60 * 60 * 1000 }) {
  if (state.paused === true) return [];
  const plan = [];
  const packages = Object.values(state.packages || {});
  for (const [channelId, cfg] of Object.entries(state.channels || {})) {
    if (!cfg || cfg.paused === true || !connected.has(channelId)) continue;
    let slots; let limit;
    try { slots = cleanSlots(cfg.slots); limit = cleanDailyLimit(cfg.daily_limit); } catch { continue; } // a broken setting releases nothing
    const mine = packages.filter((p) => p.youtube_channel_id === channelId);
    const taken = mine.filter(holdsSlot).map((p) => Date.parse(p.publish_at));
    const waiting = mine
      .filter((p) => p.state === 'queued' && !(p.next_try_at && Date.parse(p.next_try_at) > now))
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || String(a.received_at).localeCompare(String(b.received_at)));
    for (const slot of upcomingSlots(slots, now + leadMs, now + aheadMs)) {
      if (!waiting.length) break;
      if (taken.some((t) => Math.abs(t - slot) < MIN_GAP_MS)) continue;
      if (taken.filter((t) => localDay(t) === localDay(slot)).length >= limit) continue;
      const next = waiting.shift();
      taken.push(slot);
      plan.push({ id: next.id, channel: channelId, publishAt: new Date(slot).toISOString() });
    }
  }
  return plan;
}
