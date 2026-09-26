import clsx from 'clsx';
import {
  type ComponentPropsWithRef,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  type RefObject,
  useEffectEvent,
  useId,
  useLayoutEffect,
  useRef,
} from 'react';
import { IconButton } from './IconButton';
import { activeElement, focusElement } from './internal/focus';
import styles from './SplitPanel.module.css';

export type DrawerSide = 'left' | 'right' | 'bottom';

export interface SplitPanelProps extends ComponentPropsWithRef<'div'> {
  /** 'row' (default): side panels left and right of the main area; 'column': a bottom panel. */
  direction?: 'row' | 'column';
}

/**
 * Layout for side panels: children are laid out in a row (or column) that fills its parent. Put
 * <SplitMain> for the main area and <Drawer>s beside it, in visual order. Nest a column SplitPanel
 * inside SplitMain for a bottom drawer.
 */
export function SplitPanel({ direction = 'row', className, ...rest }: SplitPanelProps) {
  return <div {...rest} className={clsx(styles.split, direction === 'column' && styles.column, className)} />;
}

/** The flexible main area of a SplitPanel. */
export function SplitMain({ className, ...rest }: ComponentPropsWithRef<'div'>) {
  return <div {...rest} className={clsx(styles.main, className)} />;
}

export interface ResizeHandleProps {
  /** The side the resized panel is docked on (the handle sits on its inner edge). */
  side: DrawerSide;
  size: number;
  min: number;
  max: number;
  onSizeChange: (size: number) => void;
  /** Id of the resized panel. */
  controls: string;
  /** Accessible name, e.g. "Resize outline". */
  label: string;
  /** Keyboard step in px (default 16; Shift × 4). */
  step?: number;
  className?: string;
}

function clampSize(value: number, min: number, max: number): number {
  return Math.round(Math.min(max, Math.max(min, value)));
}

/**
 * A focusable separator (role="separator" with aria-valuenow) that resizes a panel by dragging or
 * with the arrow keys (Shift for bigger steps), Home (smallest) and End (largest).
 */
export function ResizeHandle({ side, size, min, max, onSizeChange, controls, label, step = 16, className }: ResizeHandleProps) {
  const drag = useRef<{ start: number; size: number; pointerId: number } | null>(null);
  const vertical = side === 'bottom';
  // +1 means moving the pointer right (or down) grows the panel.
  const grow = side === 'left' ? 1 : -1;

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const amount = event.shiftKey ? step * 4 : step;
    const keys: Record<string, number> = vertical
      ? { ArrowUp: amount, ArrowDown: -amount }
      : side === 'left'
        ? { ArrowRight: amount, ArrowLeft: -amount }
        : { ArrowLeft: amount, ArrowRight: -amount };
    const delta = keys[event.key];
    let next: number | null = null;
    if (delta !== undefined) next = size + delta;
    else if (event.key === 'Home') next = min;
    else if (event.key === 'End') next = max;
    if (next === null) return;
    event.preventDefault();
    const clamped = clampSize(next, min, max);
    if (clamped !== size) onSizeChange(clamped);
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { start: vertical ? event.clientY : event.clientX, size, pointerId: event.pointerId };
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    const delta = (vertical ? event.clientY : event.clientX) - current.start;
    const next = clampSize(current.size + (vertical ? -delta : grow * delta), min, max);
    if (next !== size) onSizeChange(next);
  };
  const endDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointerId !== event.pointerId) return;
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  return (
    <div
      role="separator"
      aria-orientation={vertical ? 'horizontal' : 'vertical'}
      aria-valuenow={Math.round(size)}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-controls={controls}
      aria-label={label}
      tabIndex={0}
      data-side={side}
      className={clsx(styles.handle, className)}
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    />
  );
}

export interface DrawerProps {
  side: DrawerSide;
  open: boolean;
  /** Called with false by the close button. */
  onOpenChange?: (open: boolean) => void;
  /** Heading (h2) and name of the panel landmark. */
  title: ReactNode;
  /** Width (left/right) or height (bottom) in px. */
  size: number;
  /** Makes the panel resizable. */
  onSizeChange?: (size: number) => void;
  minSize?: number;
  maxSize?: number;
  /** Accessible name of the resize handle (default "Resize panel"). */
  resizeLabel?: string;
  /** Accessible name of the close button (default "Close panel"). */
  closeLabel?: string;
  /** Extra controls in the header, before the close button. */
  actions?: ReactNode;
  children?: ReactNode;
  id?: string;
  /** Receives focus when the drawer closes while focus is inside it (e.g. its toggle button). */
  returnFocusRef?: RefObject<HTMLElement | null>;
  className?: string;
  'data-testid'?: string;
}

/**
 * A docked side (or bottom) panel: a complementary landmark named by its title, with a close
 * button and an optional resize handle. Unmounted while closed.
 */
export function Drawer(props: DrawerProps) {
  return props.open ? <DrawerContent {...props} /> : null;
}

function DrawerContent({
  side,
  onOpenChange,
  title,
  size,
  onSizeChange,
  minSize = 160,
  maxSize = 720,
  resizeLabel = 'Resize panel',
  closeLabel = 'Close panel',
  actions,
  children,
  id,
  returnFocusRef,
  className,
  'data-testid': testId,
}: DrawerProps) {
  const generated = useId();
  const panelId = id ?? `${generated}-panel`;
  const titleId = `${generated}-title`;
  const panelRef = useRef<HTMLElement>(null);

  const restoreFocus = useEffectEvent(() => {
    const panel = panelRef.current;
    if (panel && panel.contains(activeElement(panel.ownerDocument))) focusElement(returnFocusRef?.current);
  });
  // Runs before the panel leaves the DOM, while focus can still be inside it.
  useLayoutEffect(() => () => restoreFocus(), []);

  const dimension = side === 'bottom' ? { height: size } : { width: size };
  return (
    <aside
      ref={panelRef}
      id={panelId}
      aria-labelledby={titleId}
      className={clsx(styles.drawer, styles[side], className)}
      style={dimension}
      data-testid={testId}
    >
      {onSizeChange ? (
        <ResizeHandle side={side} size={size} min={minSize} max={maxSize} onSizeChange={onSizeChange} controls={panelId} label={resizeLabel} />
      ) : null}
      <div className={styles.header}>
        <h2 id={titleId} className={styles.title}>
          {title}
        </h2>
        <div className={styles.actions}>
          {actions}
          {onOpenChange ? <IconButton icon="close" label={closeLabel} size="sm" tooltip="bottom" onClick={() => onOpenChange(false)} /> : null}
        </div>
      </div>
      <div className={styles.body}>{children}</div>
    </aside>
  );
}
