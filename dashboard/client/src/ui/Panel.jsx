import React from 'react';

export default function Panel({ title, actions, as: Tag = 'section', className = '', children, ...rest }) {
  return (
    <Tag className={`ui-panel panel p-6 ${className}`} {...rest}>
      {(title || actions) && (
        <div className="flex items-center justify-between gap-3 mb-4">
          {title && <h2 className="text-sm font-semibold text-ink-100">{title}</h2>}
          {actions}
        </div>
      )}
      {children}
    </Tag>
  );
}
