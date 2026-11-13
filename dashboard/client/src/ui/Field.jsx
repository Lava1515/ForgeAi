import React, { Children, cloneElement, isValidElement, useId } from 'react';

const BASE = { input: 'input', select: 'input pr-8', textarea: 'input !h-auto py-3 min-h-[96px] leading-relaxed' };

// Label + control + hint/error. Either `as` renders the control (rest props go to it), or a single child control
// is passed in; both get the shared `.input` styling, id and aria wiring, so a wrapped <input> can't render unstyled.
export default function Field({ label, hint, error, as: Tag = 'input', id, className = '', children, ...rest }) {
  const autoId = useId();
  const child = Children.count(children) === 1 && isValidElement(children) ? children : null;
  const fieldId = id || child?.props.id || autoId;
  const helpId = hint || error ? `${fieldId}-help` : undefined;
  const styled = (type, extra = '') => `${BASE[type] || BASE.input} w-full ${error ? '!border-rose-500/60' : ''} ${extra}`.trim();
  const aria = { id: fieldId, 'aria-invalid': error ? true : undefined, 'aria-describedby': helpId };

  let control;
  if (child && typeof child.type === 'string' && BASE[child.type]) {
    control = cloneElement(child, { ...aria, className: styled(child.type, child.props.className || '') });
  } else if (children) {
    control = children; // composite control (e.g. a component): it styles itself
  } else {
    control = <Tag {...aria} className={styled(Tag, className)} {...rest} />;
  }

  return (
    <div className="ui-field space-y-1.5">
      {label && <label htmlFor={fieldId} className="ui-field-label label !text-ink-300 block">{label}</label>}
      {control}
      {helpId && <p id={helpId} className={`ui-field-help text-xs ${error ? 'text-rose-300' : 'text-ink-500'}`}>{error || hint}</p>}
    </div>
  );
}
