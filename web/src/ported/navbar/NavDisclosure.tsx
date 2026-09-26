// Nav.dropdown from legacy client/homebrew/navbar/nav.jsx, rebuilt as a disclosure (WAI-ARIA APG
// "disclosure navigation menu"): a button with aria-expanded that shows a panel of links and
// buttons. Upstream opened on hover and click; this opens on click, Enter, Space or ArrowDown.
// In the panel ArrowUp/Down, Home and End move between entries, Escape closes it and returns to
// the button, and following a link closes it. The panel is a UI kit Popover, so Tab flows on to
// the next nav item and a press outside closes it.
import clsx from 'clsx';
import { type KeyboardEvent, type MouseEvent, type ReactNode, useId, useRef, useState } from 'react';
import { useLocation } from 'react-router';
import { focusElement, getTabbables, Icon, type Placement, Popover } from '@/ui';
import styles from './Navbar.module.css';
import { type NavTone, toneClass } from './navTone';

export interface NavDisclosureProps {
  /** The trigger's visible text. */
  label: ReactNode;
  /** The trigger's accessible name when the visible text is not enough. */
  'aria-label'?: string;
  icon?: ReactNode;
  tone?: NavTone;
  /** Hide the trigger text on narrow screens. */
  collapsible?: boolean;
  /** Names the panel. */
  panelLabel: string;
  /** Default 'bottom-end'. */
  placement?: Placement;
  /**
   * The panel content; a function gets `close`, for buttons that act and then close the panel
   * (focus returns to the trigger).
   */
  children: ReactNode | ((close: () => void) => ReactNode);
  className?: string;
  triggerClassName?: string;
  panelClassName?: string;
  /** On the trigger; the panel gets `<id>-panel`. */
  'data-testid'?: string;
}

const MOVE_KEYS = new Set(['ArrowDown', 'ArrowUp', 'Home', 'End']);

export function NavDisclosure({
  label,
  'aria-label': ariaLabel,
  icon,
  tone,
  collapsible,
  panelLabel,
  placement = 'bottom-end',
  children,
  className,
  triggerClassName,
  panelClassName,
  'data-testid': testId,
}: NavDisclosureProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const triggerId = useId();

  // Close when the route changes (back/forward while open, or a link inside was followed).
  const location = useLocation();
  const [locationKey, setLocationKey] = useState(location.key);
  if (locationKey !== location.key) {
    setLocationKey(location.key);
    setOpen(false);
  }

  // For panel buttons that act: close and put focus back on the trigger (the pressed button is
  // about to disappear with the panel).
  // (The trigger is found by id: `close` is handed to render code, which must not touch refs.)
  const close = () => {
    setOpen(false);
    focusElement(document.getElementById(triggerId));
  };

  const onTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowDown' && !open) {
      event.preventDefault();
      setOpen(true);
    }
  };

  const onPanelKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!MOVE_KEYS.has(event.key) || event.altKey || event.ctrlKey || event.metaKey) return;
    const entries = getTabbables(event.currentTarget);
    if (entries.length === 0) return;
    event.preventDefault();
    const current = entries.indexOf(event.target as HTMLElement);
    let next: number;
    if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = entries.length - 1;
    else if (event.key === 'ArrowDown') next = current < 0 ? 0 : (current + 1) % entries.length;
    else next = current < 0 ? entries.length - 1 : (current - 1 + entries.length) % entries.length;
    focusElement(entries[next]);
  };

  // Following a link closes the panel (the route change would too, but not for a link to the
  // current page, or one that opens a new tab).
  const onPanelClick = (event: MouseEvent<HTMLDivElement>) => {
    if ((event.target as Element).closest('a[href]')) setOpen(false);
  };

  return (
    <div className={clsx(styles.disclosure, className)}>
      <button
        ref={triggerRef}
        id={triggerId}
        type="button"
        className={clsx(styles.item, toneClass(tone), triggerClassName)}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={ariaLabel}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={onTriggerKeyDown}
        data-testid={testId}
      >
        {icon}
        <span className={clsx(styles.itemLabel, collapsible && styles.collapsible)}>{label}</span>
        <Icon name="chevronDown" size={12} className={styles.chevron} />
      </button>
      <Popover
        open={open}
        onOpenChange={setOpen}
        anchorRef={triggerRef}
        placement={placement}
        offset={2}
        role="group"
        aria-label={panelLabel}
        id={panelId}
        className={clsx(styles.panel, panelClassName)}
        data-testid={testId ? `${testId}-panel` : undefined}
      >
        {/* Key and click handling for the whole panel; the entries themselves are the controls. */}
        <div onKeyDown={onPanelKeyDown} onClick={onPanelClick}>
          {typeof children === 'function' ? children(close) : children}
        </div>
      </Popover>
    </div>
  );
}
