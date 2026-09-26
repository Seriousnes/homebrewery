import clsx from 'clsx';
import {
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useEffectEvent,
  useLayoutEffect,
  useRef,
} from 'react';
import { focusElement, focusFirst, getTabbables, tabbableAfter, trapTab } from './internal/focus';
import type { Placement } from './internal/position';
import { type DismissReason, useDismiss } from './internal/useDismiss';
import { useFloating } from './internal/useFloating';
import styles from './Popover.module.css';
import { Portal } from './Portal';

export interface PopoverProps {
  open: boolean;
  /** Called with false on Escape, a press outside, or focus leaving (with the reason). */
  onOpenChange: (open: boolean, reason?: DismissReason) => void;
  /** The element it is placed against, usually its trigger. */
  anchorRef: RefObject<HTMLElement | null>;
  children: ReactNode;
  /** Default 'bottom-start'; flips when there is no room. */
  placement?: Placement;
  offset?: number;
  matchAnchorWidth?: boolean;
  /** Default 'dialog' (a non-modal dialog). Give it a name with aria-label or aria-labelledby. */
  role?: 'dialog' | 'group' | 'region';
  'aria-label'?: string;
  'aria-labelledby'?: string;
  id?: string;
  /** Focus on open: the first tabbable element (default), the panel, a ref, or nothing. */
  initialFocus?: 'first' | 'panel' | 'none' | RefObject<HTMLElement | null>;
  /** Return focus to the anchor when closed by Escape (default true). */
  returnFocus?: boolean;
  /** Keep Tab cycling inside instead of closing when focus leaves (default false). */
  trapFocus?: boolean;
  className?: string;
  'data-testid'?: string;
}

/**
 * A non-modal floating panel next to an anchor. It closes on Escape (focus returns to the anchor),
 * a press outside, or focus leaving; Tab past its last element continues after the anchor and
 * Shift+Tab before its first returns to the anchor. The trigger should carry aria-expanded,
 * aria-controls={id} and (for a dialog) aria-haspopup="dialog". Unmounted while closed.
 */
export function Popover(props: PopoverProps) {
  return props.open ? <PopoverContent {...props} /> : null;
}

function PopoverContent({
  onOpenChange,
  anchorRef,
  children,
  placement = 'bottom-start',
  offset = 6,
  matchAnchorWidth = false,
  role = 'dialog',
  id,
  initialFocus = 'first',
  returnFocus = true,
  trapFocus = false,
  className,
  'aria-label': ariaLabel,
  'aria-labelledby': ariaLabelledBy,
  'data-testid': testId,
}: PopoverProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  useFloating(true, anchorRef, panelRef, { placement, offset, matchAnchorWidth });

  const dismiss = (reason: DismissReason) => {
    onOpenChange(false, reason);
    if (reason === 'escape' && returnFocus) focusElement(anchorRef.current);
  };
  useDismiss(true, { floatingRef: panelRef, anchorRef, onDismiss: dismiss, focusOut: !trapFocus });

  const focusOnOpen = useEffectEvent(() => {
    const panel = panelRef.current;
    if (!panel || initialFocus === 'none') return;
    if (initialFocus === 'panel') focusElement(panel);
    else if (initialFocus === 'first') focusFirst(panel);
    else if (!focusElement(initialFocus.current)) focusFirst(panel);
  });
  useLayoutEffect(() => {
    focusOnOpen();
  }, []);

  // The panel lives at the end of <body>, so the browser's own Tab order would leave it for the
  // end of the page. Instead Shift+Tab at the start returns to the anchor and Tab at the end
  // continues after the anchor, as if the panel sat next to it.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const panel = panelRef.current;
    if (!panel || event.key !== 'Tab' || !panel.contains(event.target as Node)) return;
    if (trapFocus) {
      trapTab(event, panel);
      return;
    }
    const tabbables = getTabbables(panel);
    const anchor = anchorRef.current;
    const atStart = event.target === panel || event.target === tabbables[0];
    const atEnd = event.target === tabbables.at(-1) || (tabbables.length === 0 && event.target === panel);
    if (event.shiftKey && atStart && anchor) {
      event.preventDefault();
      onOpenChange(false, 'focus-out');
      focusElement(anchor);
    } else if (!event.shiftKey && atEnd && anchor) {
      event.preventDefault();
      onOpenChange(false, 'focus-out');
      focusElement(tabbableAfter(anchor) ?? anchor);
    }
  };

  return (
    <Portal>
      <div
        ref={panelRef}
        id={id}
        role={role}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        tabIndex={-1}
        className={clsx(styles.popover, className)}
        data-testid={testId}
        onKeyDown={onKeyDown}
      >
        {children}
      </div>
    </Portal>
  );
}
