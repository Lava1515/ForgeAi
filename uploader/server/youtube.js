// The uploader's YouTube calls: sign-in, upload with YouTube's own schedule, and reading a video's state.
import fs from 'node:fs';

export const FULL_SCOPE = 'https://www.googleapis.com/auth/youtube';

async function googleError(res) {
  const data = await res.json().catch(() => ({}));
  const reason = data.error?.errors?.[0]?.reason;
  return `YouTube HTTP ${res.status}${reason ? ` (${reason})` : ''}: ${data.error?.message || data.error_description || res.statusText}`;
}

export function createYouTube({ clientId, clientSecret, redirectUri, fetchFn = fetch }) {
  async function token(params) {
    const res = await fetchFn('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, ...params }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Google sign-in failed: ${data.error_description || data.error || res.status}`);
    return data;
  }
  const accessToken = async (refreshToken) => (await token({ refresh_token: refreshToken, grant_type: 'refresh_token' })).access_token;

  /** The channel a sign-in really belongs to: { id, title }. */
  async function whoAmI(access) {
    const res = await fetchFn('https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true', { headers: { Authorization: `Bearer ${access}` } });
    if (!res.ok) throw new Error(await googleError(res));
    const item = (await res.json()).items?.[0];
    if (!item?.id) throw new Error('This Google sign-in has no YouTube channel.');
    return { id: item.id, title: item.snippet?.title || item.id };
  }

  return {
    configured: Boolean(clientId && clientSecret),
    connectUrl(state) {
      const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      url.search = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope: FULL_SCOPE, access_type: 'offline', prompt: 'consent', state });
      return url.toString();
    },
    /** After Google's redirect: -> { refresh_token, scope, channel: { id, title } } */
    async finishConnect(code) {
      const t = await token({ code, grant_type: 'authorization_code', redirect_uri: redirectUri });
      if (!t.refresh_token) throw new Error('Google returned no refresh token. Remove the app at myaccount.google.com/permissions and connect again.');
      return { refresh_token: t.refresh_token, scope: t.scope, channel: await whoAmI(t.access_token) };
    },
    /**
     * Uploads private with status.publishAt: YouTube makes it public at that time by itself.
     * The sign-in must belong to the manifest's channel; that is checked against YouTube right before the upload.
     */
    async upload({ refreshToken, manifest, videoFile, publishAt, stillWanted = () => true }) {
      const access = await accessToken(refreshToken);
      const me = await whoAmI(access);
      if (me.id !== manifest.youtube_channel_id) throw Object.assign(new Error(`This sign-in belongs to "${me.title}", not to the video's channel. Nothing was uploaded.`), { fatal: true });
      const video = fs.readFileSync(videoFile);
      const body = {
        snippet: { title: manifest.title, description: manifest.description, tags: manifest.tags, categoryId: manifest.category_id, defaultLanguage: manifest.language, defaultAudioLanguage: manifest.language },
        status: { privacyStatus: 'private', publishAt, selfDeclaredMadeForKids: false, ...(manifest.contains_synthetic_media && { containsSyntheticMedia: true }) },
      };
      const init = await fetchFn('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', {
        method: 'POST',
        headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': 'video/mp4', 'X-Upload-Content-Length': String(video.length) },
        body: JSON.stringify(body),
      });
      if (!init.ok) throw new Error(await googleError(init));
      // The last look before the video leaves: a pause or a removal made while we signed in still stops it. The unused
      // upload session is simply dropped.
      if (!stillWanted()) throw Object.assign(new Error('Stopped before the video left.'), { stopped: true });
      // From here on video bytes leave this machine. Any failure is marked `sent`: YouTube may hold the video, so the
      // caller must not send it again by itself.
      try {
        const put = await fetchFn(init.headers.get('location'), { method: 'PUT', headers: { 'Content-Type': 'video/mp4' }, body: video });
        if (!put.ok) throw new Error(await googleError(put));
        const uploaded = await put.json();
        if (typeof uploaded?.id !== 'string' || !/^[A-Za-z0-9_-]{6,20}$/.test(uploaded.id)) throw new Error('YouTube answered without a video id.');
        return { video_id: uploaded.id };
      } catch (err) { throw Object.assign(err instanceof Error ? err : new Error(String(err)), { sent: true }); }
    },
    /** -> 'public' | 'private' | 'unlisted' | 'gone' */
    async privacyOf({ refreshToken, videoId }) {
      const access = await accessToken(refreshToken);
      const res = await fetchFn(`https://www.googleapis.com/youtube/v3/videos?part=status&id=${encodeURIComponent(videoId)}`, { headers: { Authorization: `Bearer ${access}` } });
      if (!res.ok) throw new Error(await googleError(res));
      const item = (await res.json()).items?.[0];
      return item ? item.status?.privacyStatus || 'private' : 'gone';
    },
    /** Takes a scheduled video off the calendar: it stays on YouTube as private. */
    async cancelSchedule({ refreshToken, videoId, containsSyntheticMedia }) {
      const access = await accessToken(refreshToken);
      const res = await fetchFn('https://www.googleapis.com/youtube/v3/videos?part=status', {
        method: 'PUT', headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: videoId, status: { privacyStatus: 'private', selfDeclaredMadeForKids: false, ...(containsSyntheticMedia && { containsSyntheticMedia: true }) } }),
      });
      if (!res.ok) throw new Error(await googleError(res));
    },
  };
}
