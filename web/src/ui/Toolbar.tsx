import clsx from 'clsx';
import { type ComponentPropsWithRef, type FocusEvent, type KeyboardEvent, useLayoutEffect, useRef } from 'react';
import { assignRef } from './internal/refs';
import { moveRovingFocus, ownsArrowKeys, type RovingOrientation, syncRovingTabIndex } from './internal/roving';
import styles from './Toolbar.module.css';

export interface ToolbarProps extends Omit<ComponentPropsWithRef<'div'>, 'role'> {
  /** The toolbar's accessible name. */
  label: string;
  orientation?: RovingOrientation;
}

/**
 * role="toolbar" with a roving tab stop: Tab enters on the last used item, Left/Right (Up/Down
 * when vertical) move between items, Home/End jump. Text inputs inside keep their arrow keys.
 * Items are any focusable descendants (buttons, IconButtons, MenuButtons, selects).
 */
export function Toolbar({ label, orientation = 'horizontal', className, children, onKeyDown, onFocus, ref, ...rest }: ToolbarProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    syncRovingTabIndex(root);
    // Items come and go (and get disabled): keep exactly one tab stop.
    const observer = new MutationObserver(() => syncRovingTabIndex(root, root.contains(document.activeElement) ? (document.activeElement as HTMLElement) : null));
    observer.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ['disabled', 'hidden', 'inert'] });
    return () => observer.disconnect();
  }, []);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    onKeyDown?.(event);
    const root = rootRef.current;
    const target = event.target as Element;
    if (event.defaultPrevented || !root || !root.contains(target) || ownsArrowKeys(target)) return;
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const rtl = getComputedStyle(root).direction === 'rtl';
    if (moveRovingFocus(root, event.key, target, orientation, rtl)) event.preventDefault();
  };

  const handleFocus = (event: FocusEvent<HTMLDivElement>) => {
    onFocus?.(event);
    const root = rootRef.current;
    if (root && root.contains(event.target)) syncRovingTabIndex(root, event.target);
  };

  return (
    <div
      {...rest}
      ref={(el) => {
        rootRef.current = el;
        assignRef(ref, el);
      }}
      role="toolbar"
      aria-label={label}
      aria-orientation={orientation}
      className={clsx(styles.toolbar, orientation === 'vertical' && styles.vertical, className)}
      onKeyDown={handleKeyDown}
      onFocus={handleFocus}
    >
      {children}
    </div>
  );
}

export interface ToolbarGroupProps extends Omit<ComponentPropsWithRef<'div'>, 'role'> {
  /** The group's accessible name. */
  label: string;
}

/** A labelled group of toolbar items. */
export function ToolbarGroup({ label, className, ...rest }: ToolbarGroupProps) {
  return <div {...rest} role="group" aria-label={label} className={clsx(styles.group, className)} />;
}

/** A divider between toolbar groups. */
export function ToolbarSeparator({ orientation = 'horizontal' }: { orientation?: RovingOrientation }) {
  return <div role="separator" aria-orientation={orientation === 'horizontal' ? 'vertical' : 'horizontal'} className={styles.separator} />;
}
