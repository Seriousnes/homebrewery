import clsx from 'clsx';
import type { ComponentPropsWithRef } from 'react';
import styles from './Field.module.css';
import { FieldShell, type FieldProps } from './internal/FieldShell';
import { useField } from './internal/useField';

export type { FieldProps } from './internal/FieldShell';

export interface TextFieldProps extends FieldProps, Omit<ComponentPropsWithRef<'input'>, 'className' | 'size'> {
  inputClassName?: string;
}

/** Labelled text input with optional hint and error. */
export function TextField({ label, hint, error, hideLabel, className, inputClassName, id, type = 'text', ...rest }: TextFieldProps) {
  const ids = useField(id, hint, error, rest['aria-describedby']);
  return (
    <FieldShell label={label} hint={hint} error={error} hideLabel={hideLabel} className={className} ids={ids} required={rest.required}>
      <input
        {...rest}
        id={ids.controlId}
        type={type}
        aria-describedby={ids.describedBy}
        aria-invalid={error ? true : rest['aria-invalid']}
        className={clsx(styles.control, inputClassName)}
      />
    </FieldShell>
  );
}

export interface TextAreaProps extends FieldProps, Omit<ComponentPropsWithRef<'textarea'>, 'className'> {
  inputClassName?: string;
}

/** Labelled multi-line text input. */
export function TextArea({ label, hint, error, hideLabel, className, inputClassName, id, ...rest }: TextAreaProps) {
  const ids = useField(id, hint, error, rest['aria-describedby']);
  return (
    <FieldShell label={label} hint={hint} error={error} hideLabel={hideLabel} className={className} ids={ids} required={rest.required}>
      <textarea
        {...rest}
        id={ids.controlId}
        aria-describedby={ids.describedBy}
        aria-invalid={error ? true : rest['aria-invalid']}
        className={clsx(styles.control, styles.textarea, inputClassName)}
      />
    </FieldShell>
  );
}
