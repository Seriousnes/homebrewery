import clsx from 'clsx';
import type { ComponentPropsWithRef } from 'react';
import styles from './Field.module.css';
import { FieldShell, type FieldProps } from './internal/FieldShell';
import { useField } from './internal/useField';

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectProps extends FieldProps, Omit<ComponentPropsWithRef<'select'>, 'className' | 'children'> {
  options: readonly SelectOption[];
  /** Adds a first, empty option with this text (e.g. "Choose…"). */
  placeholder?: string;
  inputClassName?: string;
}

/** Labelled native select (keyboard and screen reader behaviour come from the platform). */
export function Select({ label, hint, error, hideLabel, className, inputClassName, id, options, placeholder, ...rest }: SelectProps) {
  const ids = useField(id, hint, error, rest['aria-describedby']);
  return (
    <FieldShell label={label} hint={hint} error={error} hideLabel={hideLabel} className={className} ids={ids} required={rest.required}>
      <select
        {...rest}
        id={ids.controlId}
        aria-describedby={ids.describedBy}
        aria-invalid={error ? true : rest['aria-invalid']}
        className={clsx(styles.control, styles.select, inputClassName)}
      >
        {placeholder != null ? <option value="">{placeholder}</option> : null}
        {options.map((option) => (
          <option key={option.value} value={option.value} disabled={option.disabled}>
            {option.label}
          </option>
        ))}
      </select>
    </FieldShell>
  );
}
