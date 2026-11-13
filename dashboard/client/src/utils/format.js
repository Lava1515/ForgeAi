// Shared display formatters. Each keeps the output the call sites already show.

export function timeAgo(ts) {
  if (!ts) return 'never';
  const mins = Math.round((Date.now() - new Date(ts).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

// ["a", "#b"] -> "#a #b"
export const formatTags = (tags = []) => tags.map((t) => `#${String(t).replace(/^#+/, '')}`).join(' ');
