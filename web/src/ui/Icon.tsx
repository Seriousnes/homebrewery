import clsx from 'clsx';
import type { SVGProps } from 'react';
import styles from './Icon.module.css';
import { type IconDef, type IconName, ICONS } from './iconPaths';

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'name' | 'children'> {
  name: IconName;
  /** px (default 16) or any CSS length. */
  size?: number | string;
  /** Accessible name. Without it the icon is decorative (aria-hidden). */
  label?: string;
}

/** Inline SVG icon in currentColor. */
export function Icon({ name, size = 16, label, className, ...rest }: IconProps) {
  const def: IconDef = ICONS[name];
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={def.strokeWidth ?? 2}
      strokeLinecap="round"
      strokeLinejoin="round"
      focusable="false"
      data-icon={name}
      {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}
      {...rest}
      className={clsx(styles.icon, className)}
    >
      <path d={def.d} />
    </svg>
  );
}
