// Public numbers over time (backlog G3). Each channel scan adds one point per video: views, likes and comments at an age.
// From the points we derive analytics_history (views at 1, 2, 7 and 28 days, which growth/report.js already reads) and
// views_24h. Nothing here calls YouTube; channel.js passes in the scanned videos.
import fs from 'node:fs';
import path from 'node:path';

export const MIN_GAP_MS = 45 * 60 * 1000;     // a point closer than this to the previous one is not kept
export const MAX_POINTS = 200;                // per video
export const HISTORY_AGES_DAYS = [1, 2, 7, 28];
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

export function snapshotFile(trendsDir, channelId) {
  if (!channelId || channelId === 'default') return path.join(trendsDir, 'snapshots.json');
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(channelId)) throw new Error('Invalid channel id');
  return path.join(trendsDir, `snapshots_${channelId}.json`);
}

export function readSnapshots(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch { return {}; }
}

// Thin old points. Kept: every point of the first 48 h, every point of the last 36 h (views_24h needs them), the point
// nearest each history age (so trimming never deletes a day-1/2/7/28 measurement), and otherwise the latest point per day.
// Over MAX_POINTS, the oldest unprotected points go first.
function thin(points) {
  const latest = points.length ? Date.parse(points[points.length - 1].at) : 0;
  const milestones = new Set(historyFor(points).map((h) => h.at));
  const protectedAt = (p) => p.age_h <= 48 || latest - Date.parse(p.at) <= 36 * HOUR || milestones.has(p.at);
  const keep = new Map();
  const lastOfDay = new Map();
  for (const p of points) {
    if (protectedAt(p)) keep.set(p.at, p);
    else lastOfDay.set(Math.floor(p.age_h / 24), p);
  }
  for (const p of lastOfDay.values()) keep.set(p.at, p);
  let merged = [...keep.values()].sort((a, b) => a.at.localeCompare(b.at));
  while (merged.length > MAX_POINTS) {
    const i = merged.findIndex((p) => !milestones.has(p.at) && latest - Date.parse(p.at) > 36 * HOUR);
    merged.splice(i === -1 ? 0 : i, 1);
  }
  return merged;
}

/** Pure: add one point per scanned video to `store` ({ video_id: points[] }) and return the new store. */
export function addSnapshots(store, videos, now = Date.now()) {
  const next = { ...store };
  for (const v of Array.isArray(videos) ? videos : []) {
    const id = v?.video_id;
    const published = Date.parse(v?.published_at);
    if (!id || !Number.isFinite(published)) continue;
    const points = Array.isArray(next[id]) ? next[id].slice() : [];
    const last = points[points.length - 1];
    if (last && now - Date.parse(last.at) < MIN_GAP_MS) continue;
    points.push({
      at: new Date(now).toISOString(),
      age_h: Math.max(0, Math.round(((now - published) / HOUR) * 10) / 10),
      views: Number(v.views) || 0,
      likes: Number(v.likes) || 0,
      comments: Number(v.comments) || 0,
    });
    next[id] = thin(points);
  }
  return next;
}

/** The point nearest each age (1, 2, 7, 28 days) inside a window of a quarter of that age, at most 36 h. No point, no entry. */
export function historyFor(points) {
  const list = Array.isArray(points) ? points : [];
  const out = [];
  for (const days of HISTORY_AGES_DAYS) {
    const target = days * 24;
    const window = Math.min(36, target / 4);
    let best = null;
    for (const p of list) {
      const off = Math.abs(p.age_h - target);
      if (off <= window && (!best || off < Math.abs(best.age_h - target))) best = p;
    }
    if (best) out.push({ age_days: days, age_h: best.age_h, views: best.views, likes: best.likes, comments: best.comments, at: best.at });
  }
  return out;
}

/** Views gained over about the last 24 h: latest point minus the point nearest to 24 h before it (18 to 30 h back). Null if none. */
export function views24h(points) {
  const list = Array.isArray(points) ? points : [];
  const latest = list[list.length - 1];
  if (!latest) return null;
  const t = Date.parse(latest.at);
  let best = null;
  for (const p of list) {
    const back = t - Date.parse(p.at);
    if (back >= 18 * HOUR && back <= 30 * HOUR && (!best || Math.abs(back - DAY) < Math.abs(t - Date.parse(best.at) - DAY))) best = p;
  }
  return best ? Math.max(0, latest.views - best.views) : null;
}

/** Record the scan's videos and return the videos with analytics_history and views_24h attached. Write failures are logged, not thrown. */
export function recordAndAttach(file, videos, now = Date.now(), log = console.warn) {
  const store = addSnapshots(readSnapshots(file), videos, now);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(store));
    fs.renameSync(tmp, file);
  } catch (err) { log(`snapshots not saved: ${err.message}`); }
  return (Array.isArray(videos) ? videos : []).map((v) => {
    const points = store[v?.video_id];
    return points ? { ...v, analytics_history: historyFor(points), views_24h: views24h(points) } : v;
  });
}
