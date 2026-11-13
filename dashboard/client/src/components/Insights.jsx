import React from 'react';
import { navSectionsOf } from '../nav.js';
import { SectionHost } from './Library.jsx';
import ChannelStats from './ChannelStats.jsx';
import Growth from './Growth.jsx';

export default function Insights({ section, onSection, channelSwitchCount, activeChannel }) {
  return (
    <SectionHost
      label="Insights section"
      sections={navSectionsOf('channel')}
      active={section}
      onSelect={onSection}
      panels={{
        channel: <ChannelStats key={channelSwitchCount} />,
        growth: <Growth key={channelSwitchCount} activeChannel={activeChannel} />,
      }}
    />
  );
}
