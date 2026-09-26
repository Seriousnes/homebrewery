import clsx from 'clsx';
import styles from './Button.module.css';
import { Button, type ButtonProps } from './Button';
import type { IconName } from './iconPaths';
import type { Placement } from './internal/position';
import { Tooltip } from './Tooltip';

export interface IconButtonProps extends Omit<ButtonProps, 'children' | 'icon' | 'iconEnd' | 'fullWidth' | 'aria-label'> {
  icon: IconName;
  /** Required accessible name (aria-label); also the tooltip text. */
  label: string;
  /** Shown in the tooltip, e.g. "Ctrl+B". Pair it with aria-keyshortcuts ("Control+B"). */
  shortcut?: string;
  /** Tooltip placement, or false for no tooltip (default 'top'). */
  tooltip?: Placement | false;
}

/** A square icon-only button. Default variant 'ghost'. */
export function IconButton({ icon, label, shortcut, tooltip = 'top', variant = 'ghost', className, ...rest }: IconButtonProps) {
  const button = <Button {...rest} variant={variant} icon={icon} aria-label={label} className={clsx(styles.iconOnly, className)} />;
  if (tooltip === false) return button;
  return (
    <Tooltip content={label} shortcut={shortcut} placement={tooltip} describe={false}>
      {button}
    </Tooltip>
  );
}
