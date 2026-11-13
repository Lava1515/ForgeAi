// /api/channels replies with { channels: [...] }. Anything else must never reach state: App.jsx calls .find on the list.
export function channelListFrom(data) {
  return Array.isArray(data?.channels) ? data.channels : null;
}
