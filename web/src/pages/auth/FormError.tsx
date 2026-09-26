import type { ReactNode } from 'react';
import { Icon } from '@/ui';
import styles from './AuthForms.module.css';

export interface FormErrorProps {
  children?: ReactNode;
  id?: string;
}

/**
 * A form-level error, announced when it appears (role="alert"). Give it a new `key` per attempt
 * so the same message is announced again.
 */
export function FormError({ children, id }: FormErrorProps) {
  if (children == null || children === '' || children === false) return null;
  return (
    <p role="alert" id={id} className={styles.formError}>
      <Icon name="error" />
      <span>{children}</span>
    </p>
  );
}
