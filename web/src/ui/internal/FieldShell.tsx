import clsx from 'clsx';
import type { ReactNode } from 'react';
import styles from '../Field.module.css';
import { Icon } from '../Icon';
import { VisuallyHidden } from '../VisuallyHidden';
import type { FieldIds } from './useField';

export interface FieldProps {
  /** Visible label (or visually hidden with hideLabel). */
  label: ReactNode;
  /** Help text under the control (aria-describedby). */
  hint?: ReactNode;
  /** Error text; sets aria-invalid and is announced with the control. */
  error?: ReactNode;
  hideLabel?: boolean;
  /** Class of the wrapper. */
  className?: string;
}

export interface FieldShellProps extends FieldProps {
  ids: FieldIds;
  required?: boolean;
  children: ReactNode;
}

export function FieldShell({ label, hint, error, hideLabel, className, ids, required, children }: FieldShellProps) {
  const labelContent = (
    <>
      {label}
      {required ? (
        <span className={styles.required} aria-hidden="true">
          *
        </span>
      ) : null}
    </>
  );
  return (
    <div className={clsx(styles.field, className)}>
      <label id={ids.labelId} htmlFor={ids.controlId} className={styles.label}>
        {hideLabel ? <VisuallyHidden>{labelContent}</VisuallyHidden> : labelContent}
      </label>
      {children}
      {hint ? (
        <p id={ids.hintId} className={styles.hint}>
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={ids.errorId} className={styles.error}>
          <Icon name="error" size={14} />
          {error}
        </p>
      ) : null}
    </div>
  );
}
