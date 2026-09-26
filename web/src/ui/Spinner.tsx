import clsx from 'clsx';
import styles from './Spinner.module.css';
import { VisuallyHidden } from './VisuallyHidden';

export interface SpinnerProps {
  /** px (default 16). */
  size?: number;
  /** Announced text (default "Loading"). */
  label?: string;
  /** No role or text (for use inside a control that already says it is busy). */
  decorative?: boolean;
  className?: string;
}

/** Indeterminate progress. Announces its label politely unless decorative. */
export function Spinner({ size = 16, label = 'Loading', decorative = false, className }: SpinnerProps) {
  const svg = (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      aria-hidden="true"
      focusable="false"
      className={clsx(styles.spinner, decorative && className)}
    >
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="3" opacity="0.25" />
      <path d="M21 12a9 9 0 0 0-9-9" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
  if (decorative) return svg;
  return (
    <span role="status" className={clsx(styles.wrapper, className)}>
      {svg}
      <VisuallyHidden>{label}</VisuallyHidden>
    </span>
  );
}
