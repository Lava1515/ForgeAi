import { Clapperboard, Layers, BarChart3, Mic } from 'lucide-react';

// Sidebar entries (hosts). Each section id is a persisted tab id (sessionStorage app.activeTab, #/<id> hash):
// never rename an id, only labels.
export const NAV_ITEMS = [
  { id: 'newvideo', label: 'New Video', icon: Clapperboard, sections: [] },
  {
    id: 'products', label: 'Library', icon: Layers, sections: [
      { id: 'products', label: 'Videos' },
      { id: 'drafts', label: 'Drafts' },
    ],
  },
  {
    id: 'channel', label: 'Insights', icon: BarChart3, sections: [
      { id: 'channel', label: 'Channel' },
      { id: 'growth', label: 'Growth' },
    ],
  },
  { id: 'voices', label: 'Voices', icon: Mic, sections: [] },
];

export const DEFAULT_TAB = 'newvideo';

const HOST_OF = Object.fromEntries(
  NAV_ITEMS.flatMap((item) => (item.sections.length ? item.sections : [item]).map((s) => [s.id, item.id])),
);

export const NAV_LABELS = Object.fromEntries(NAV_ITEMS.map((item) => [item.id, item.label]));

export const navLabelOf = (id) => NAV_LABELS[id] || '';

export const isNavId = (id) => Object.hasOwn(HOST_OF, id);

export const navHostOf = (id) => HOST_OF[id];

export const navSectionsOf = (hostId) => NAV_ITEMS.find((item) => item.id === hostId)?.sections || [];

export const resolveNavHash = (hash) => {
  const route = String(hash || '').replace(/^#\/?/, '').replace(/\/$/, '').split(/[/?#]/, 1)[0].toLowerCase();
  const aliases = {
    'new-video': 'newvideo',
    new: 'newvideo',
    channels: 'channel',
    library: 'products',
    videos: 'products',
    voice: 'voices',
    qwen: 'voices',
  };
  const id = aliases[route] || route;
  return isNavId(id) ? id : DEFAULT_TAB;
};
