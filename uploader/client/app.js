// The uploader's one page. Every text from a package is written with textContent, never as HTML.
const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...kids) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v; else if (k === 'on') for (const [ev, fn] of Object.entries(v)) node.addEventListener(ev, fn);
    else if (v !== false && v != null) node.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) node.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return node;
};
let zone; // the uploader machine's time zone: slot times are shown in it, wherever the page is opened
const when = (iso) => (iso ? new Date(iso).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: zone }) : '');
let editing = false; // true while a settings field has the cursor: the page does not redraw under the owner's hands

function toast(text) { const t = $('toast'); t.textContent = text; t.style.display = 'block'; clearTimeout(toast.timer); toast.timer = setTimeout(() => { t.style.display = 'none'; }, 6000); }

async function post(path, body = {}) {
  const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { toast(data.error || `Failed (${res.status})`); return; }
  draw(data);
}
async function load() {
  if (editing) return;
  try { const res = await fetch('/api/state'); if (res.ok) draw(await res.json()); } catch { toast('The uploader does not answer.'); }
}

const STATE_TEXT = { queued: 'waiting', uploading: 'uploading', scheduled: 'on YouTube, scheduled', public: 'public', refused: 'refused', failed: 'failed', unclear: 'cut off: check Studio', kept: 'on YouTube (found by you)', removed: 'removed', cancelled: 'cancelled', gone: 'gone from YouTube' };
const STATE_CLASS = { public: 'ok', scheduled: 'ok', refused: 'bad', failed: 'bad', gone: 'bad', uploading: 'warn', unclear: 'bad' };

function item(pkg, actions = []) {
  const sub = [pkg.state === 'kept' ? `reserved slot ${when(pkg.publish_at)}; the real time is in YouTube Studio` : pkg.publish_at ? `goes public ${when(pkg.publish_at)}` : pkg.public_at ? `public since ${when(pkg.public_at)}` : `received ${when(pkg.received_at)}`, pkg.video_type, pkg.error].filter(Boolean).join(' · ');
  return el('li', { class: 'item' },
    el('div', { class: 't' }, el('b', { title: pkg.title || pkg.id }, pkg.title || pkg.id), el('span', { class: 'dim small' }, sub)),
    el('span', { class: `pill ${STATE_CLASS[pkg.state] || ''}` }, STATE_TEXT[pkg.state] || pkg.state),
    pkg.url ? el('a', { class: 'btn', href: pkg.url, target: '_blank', rel: 'noreferrer' }, 'Open') : null,
    actions);
}
const act = (pkg, name, label, cls = '') => el('button', { class: cls, on: { click: () => {
  if (name === 'remove' && !confirm(`Remove "${pkg.title}"? It will not be uploaded.`)) return;
  if (name === 'found' && !confirm(`You saw "${pkg.title}" in YouTube Studio? Its slot stays taken and it will not be sent again.`)) return;
  if (name === 'retry' && pkg.state === 'unclear' && !confirm(`Send "${pkg.title}" again? Do this only after you looked in YouTube Studio and the video is NOT there.`)) return;
  if (name === 'cancel' && !confirm(`Cancel the schedule of "${pkg.title}"? It stays private on YouTube.`)) return;
  post(`/api/packages/${pkg.id}/${name}`);
} } }, label);
const list = (items, empty) => (items.length ? el('ul', {}, items) : el('div', { class: 'empty' }, empty));

function channelCard(ch) {
  const slotsInput = el('input', { type: 'text', value: ch.slots.join(', '), size: 16, 'aria-label': 'Slot times', on: { focus: () => { editing = true; }, blur: () => { editing = false; } } });
  const limitInput = el('input', { type: 'number', min: 1, max: 4, value: ch.daily_limit, style: 'width:64px', 'aria-label': 'Videos a day', on: { focus: () => { editing = true; }, blur: () => { editing = false; } } });
  return el('section', { class: 'card' },
    el('div', { class: 'row' },
      el('h2', {}, ch.name),
      el('span', { class: `pill ${ch.connected ? 'ok' : 'bad'}` }, ch.connected ? 'connected' : 'not connected'),
      ch.paused ? el('span', { class: 'pill warn' }, 'paused') : null,
      el('span', { class: 'dim small' }, ch.id),
      el('span', { style: 'flex:1' }),
      el('button', { on: { click: () => post('/api/pause', { paused: !ch.paused, channel: ch.id }) } }, ch.paused ? 'Resume channel' : 'Pause channel'),
      ch.connected ? el('button', { class: 'danger', on: { click: () => { if (confirm(`Disconnect ${ch.name}? Its waiting videos stay in the queue and nothing is uploaded until you connect it again.`)) post('/api/youtube/disconnect', { channel: ch.id }); } } }, 'Disconnect') : null),
    !ch.connected ? el('p', { class: 'small', style: 'color:var(--warn)' }, 'Videos for this channel wait here until you press "Connect a channel" and pick this channel in Google\'s window.') : null,
    el('div', { class: 'cols' },
      el('div', {}, el('h3', {}, `Waiting (${ch.queue.length})`),
        list(ch.queue.map((p, i) => item(p, [i > 0 ? act(p, 'up', 'Up') : null, i < ch.queue.length - 1 ? act(p, 'down', 'Down') : null, act(p, 'remove', 'Remove', 'danger')])), 'Nothing is waiting. An empty slot is skipped.'),
        el('h3', { style: 'margin-top:14px' }, 'Handed to YouTube'),
        list(ch.scheduled.map((p) => item(p, p.state === 'scheduled' ? [act(p, 'cancel', 'Cancel', 'danger')] : p.state === 'unclear' ? [act(p, 'found', 'It is on YouTube'), act(p, 'retry', 'Retry')] : [])), 'Nothing is scheduled.')),
      el('div', {}, el('h3', {}, 'Next slots'),
        list(ch.next_slots.map((s) => el('li', { class: 'item' }, el('div', { class: 't' }, el('b', {}, when(s.at)), el('span', { class: 'dim small' }, s.package || 'free')))), 'No slot times set.'),
        el('h3', { style: 'margin-top:14px' }, 'History'),
        list(ch.history.map((p) => item(p, p.state === 'failed' ? [act(p, 'retry', 'Retry'), act(p, 'remove', 'Remove', 'danger')] : [])), 'Nothing yet.'))),
    el('div', { class: 'settings row' },
      el('span', { class: 'dim small' }, 'Slot times'), slotsInput,
      el('span', { class: 'dim small' }, 'Videos a day'), limitInput,
      el('button', { on: { click: () => { editing = false; post(`/api/channels/${ch.id}`, { slots: slotsInput.value.split(/[,\s]+/).filter(Boolean), daily_limit: Number(limitInput.value) }); } } }, 'Save'),
      el('span', { class: 'dim small' }, 'Time of the uploader machine. Slots are at least 4 hours apart.')));
}

function draw(s) {
  if (editing) return;
  zone = s.time_zone || undefined;
  $('clock').textContent = `${when(s.now)} (${s.time_zone || 'local time'})`;
  $('allState').textContent = s.paused ? 'everything paused' : 'running';
  $('allState').className = `pill ${s.paused ? 'warn' : 'ok'}`;
  $('pauseAll').textContent = s.paused ? 'Resume everything' : 'Pause everything';
  $('pauseAll').onclick = () => post('/api/pause', { paused: !s.paused });
  const main = $('main');
  main.replaceChildren(...[
    ...s.problems.map((p) => el('div', { class: 'card problem' }, p)),
    s.paused ? el('div', { class: 'card small dim' }, 'Paused: no new video is handed to YouTube. Videos already handed over still go public at their time; use Cancel on them to stop that.') : null,
    ...(s.channels.length ? s.channels.map(channelCard) : [el('div', { class: 'card dim' }, 'No channel yet. Press "Connect a channel" and pick the YouTube channel in Google\'s window.')]),
    el('div', { class: 'small dim' }, `Hand-over folder: ${s.share}`, ' · ', el('a', { href: '#', on: { click: (e) => { e.preventDefault(); post('/api/check'); } } }, 'Check the folder now')),
  ].filter(Boolean));
}

const q = new URLSearchParams(location.search).get('youtube');
if (q === 'refused') toast('Google sign-in was cancelled.');
if (q) history.replaceState(null, '', '/');
load();
setInterval(load, 15000);
