import React from 'react';
import { Loader2 } from 'lucide-react';

const VARIANTS = {
  primary: 'btn-ember border-transparent',
  secondary: 'btn-secondary',
  ghost: 'border-transparent bg-transparent text-ink-400 hover:text-ink-100 hover:bg-ink-850',
  danger: 'btn-danger',
};
const SIZES = { sm: '!h-8 !px-3', md: '', lg: '!h-11 !px-5 !text-sm !rounded-xl' };

export default function Button({ variant = 'secondary', size = 'md', loading = false, icon: Icon, type = 'button', disabled, className = '', children, ...rest }) {
  return (
    <button type={type} disabled={disabled || loading} className={`btn ${VARIANTS[variant]} ${SIZES[size]} ${className}`} {...rest}>
      {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" /> : Icon && (React.isValidElement(Icon) ? Icon : <Icon className="w-3.5 h-3.5" aria-hidden="true" />)}
      {children}
    </button>
  );
}
