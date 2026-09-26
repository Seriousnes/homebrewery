import clsx from 'clsx';
import type { ComponentPropsWithRef } from 'react';
import styles from './VisuallyHidden.module.css';

export interface VisuallyHiddenProps extends ComponentPropsWithRef<'span'> {
  /** Become visible while focused (skip links). */
  focusable?: boolean;
}

/** Content for assistive technology only. */
export function VisuallyHidden({ focusable = false, className, ...rest }: VisuallyHiddenProps) {
  return <span {...rest} className={clsx(focusable ? styles.focusable : styles.hidden, className)} />;
}
