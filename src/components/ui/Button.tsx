import type { ButtonHTMLAttributes } from 'react';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'danger';
}

const VARIANT_CLASSES: Record<NonNullable<ButtonProps['variant']>, string> = {
  primary: 'bg-accent-600 text-white shadow-[var(--elevation-1)] active:bg-accent-500 active:shadow-[var(--glow-accent)]',
  secondary: 'bg-(--surface-2) text-(--text-primary) border border-(--border-subtle) active:bg-(--surface-1)',
  danger: 'bg-danger-500 text-white active:opacity-90',
};

/**
 * Large, thumb-friendly touch target by default — DriverOS is a tablet-in-a-
 * vehicle app, not a desktop one. The 2026 refresh adds a soft press-scale and
 * (on primary) an accent glow on tap so actions feel responsive in the cab.
 */
export function Button({ variant = 'primary', className = '', ...props }: ButtonProps) {
  return (
    <button
      className={`min-h-14 w-full rounded-2xl px-6 text-lg font-semibold transition-all duration-200 [transition-timing-function:var(--ease-out-soft)] active:scale-[0.98] disabled:opacity-50 ${VARIANT_CLASSES[variant]} ${className}`}
      {...props}
    />
  );
}
