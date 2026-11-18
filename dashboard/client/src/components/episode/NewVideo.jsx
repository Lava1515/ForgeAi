import React, { useEffect, useState } from 'react';
import PageHeader from '../../ui/PageHeader.jsx';
import CodebuiltStart from './CodebuiltStart.jsx';
import * as api from '../../services/api.js';

export default function NewVideo() {
  const [authorModeAvailable, setAuthorModeAvailable] = useState(false);

  useEffect(() => {
    let current = true;
    api.listCodebuiltJobs()
      .then((result) => {
        if (current) setAuthorModeAvailable(result?.authorModeAvailable === true);
      })
      .catch(() => {});
    return () => { current = false; };
  }, []);

  return (
    <div className="space-y-6 max-w-4xl mx-auto" data-new-video>
      <PageHeader
        eyebrow="Code-built"
        title="New Video"
        subtitle="Start a code-built short. It is saved as a draft; nothing is published."
      />
      <CodebuiltStart authorModeAvailable={authorModeAvailable} />
    </div>
  );
}
