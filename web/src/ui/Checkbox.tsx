import clsx from 'clsx';
import type { ComponentPropsWithRef, ReactNode } from 'react';
import styles from './Field.module.css';
import { useField } from './internal/useField';

export interface CheckboxProps extends Omit<ComponentPropsWithRef<'input'>, 'type' | 'className' | 'role'> {
  label: ReactNode;
  hint?: ReactNode;
  className?: string;
}

/** Native checkbox with a label (and optional hint). */
export function Checkbox({ label, hint, className, id, ...rest }: CheckboxProps) {
  const ids = useField(id, hint, undefined, rest['aria-describedby']);
  return (
    <div className={clsx(styles.check, className)}>
      <label className={styles.checkRow}>
        <input {...rest} id={ids.controlId} type="checkbox" aria-describedby={ids.describedBy} className={styles.checkbox} />
        <span>{label}</span>
      </label>
      {hint ? (
        <p id={ids.hintId} className={styles.checkHint}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export type SwitchProps = CheckboxProps;

/** On/off switch: a checkbox with role="switch" (announced as on/off). */
export function Switch({ label, hint, className, id, ...rest }: SwitchProps) {
  const ids = useField(id, hint, undefined, rest['aria-describedby']);
  return (
    <div className={clsx(styles.check, className)}>
      <label className={styles.checkRow}>
        <input {...rest} id={ids.controlId} type="checkbox" role="switch" aria-describedby={ids.describedBy} className={styles.switch} />
        <span>{label}</span>
      </label>
      {hint ? (
        <p id={ids.hintId} className={clsx(styles.checkHint, styles.switchHint)}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}
