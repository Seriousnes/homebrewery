import clsx from 'clsx';
import type { ComponentPropsWithRef, MouseEvent } from 'react';
import styles from './Button.module.css';
import { Icon } from './Icon';
import type { IconName } from './iconPaths';
import { Spinner } from './Spinner';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md';

export interface ButtonProps extends ComponentPropsWithRef<'button'> {
  /** Default 'secondary'. */
  variant?: ButtonVariant;
  /** Default 'md'. */
  size?: ButtonSize;
  /** Icon before the label. */
  icon?: IconName;
  /** Icon after the label (e.g. chevronDown for menus). */
  iconEnd?: IconName;
  /**
   * Busy: shows a spinner, sets aria-busy and ignores clicks, but stays focusable (a disabled
   * button would drop focus).
   */
  loading?: boolean;
  /** Toggle button state (aria-pressed). */
  pressed?: boolean;
  fullWidth?: boolean;
}

export function Button({
  variant = 'secondary',
  size = 'md',
  icon,
  iconEnd,
  loading = false,
  pressed,
  fullWidth = false,
  type = 'button',
  className,
  children,
  onClick,
  ...rest
}: ButtonProps) {
  const iconSize = size === 'sm' ? 14 : 16;
  const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
    if (loading || rest['aria-disabled'] === true || rest['aria-disabled'] === 'true') {
      event.preventDefault();
      return;
    }
    onClick?.(event);
  };
  return (
    <button
      {...rest}
      type={type}
      aria-pressed={pressed}
      aria-busy={loading || undefined}
      onClick={handleClick}
      className={clsx(styles.button, styles[variant], size === 'sm' && styles.sm, fullWidth && styles.fullWidth, className)}
    >
      {loading ? <Spinner size={iconSize} decorative /> : icon ? <Icon name={icon} size={iconSize} /> : null}
      {children != null && children !== false ? <span className={styles.label}>{children}</span> : null}
      {iconEnd ? <Icon name={iconEnd} size={iconSize} /> : null}
    </button>
  );
}
