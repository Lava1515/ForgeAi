import React from 'react';

export default function EmptyState({ icon: Icon, title, description, action, children }) {
  const body = children || description;
  return (
    <div className="ui-empty-state flex flex-col items-center justify-center text-center gap-2 py-12 px-6 rounded-xl border border-dashed border-ink-800">
      {Icon && <Icon className="w-5 h-5 text-ink-500" aria-hidden="true" />}
      {title && <p className="text-sm font-medium text-ink-200">{title}</p>}
      {body && <p className="text-sm text-ink-500 max-w-prose">{body}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
