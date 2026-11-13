import React from 'react';
import PageHeader from '../../ui/PageHeader.jsx';
import CodebuiltStart from './CodebuiltStart.jsx';

export default function NewVideo() {
  return (
    <div className="space-y-6 max-w-4xl mx-auto" data-new-video>
      <PageHeader
        eyebrow="Code-built"
        title="New Video"
        subtitle="Start a code-built short. It is saved as a draft; nothing is published."
      />
      <CodebuiltStart />
    </div>
  );
}
