import {
  cloneElement,
  type FocusEvent,
  type PointerEvent,
  type ReactElement,
  type ReactNode,
  useEffect,
  useEffectEvent,
  useId,
  useRef,
  useState,
} from 'react';
import { registerEscape } from './internal/layers';
import type { Placement } from './internal/position';
import { useFloating } from './internal/useFloating';
import { Portal } from './Portal';
import styles from './Tooltip.module.css';

export interface TooltipProps {
  content: ReactNode;
  /** Shown after the content in a muted style, e.g. "Ctrl+B". */
  shortcut?: string;
  /** One focusable element; it gets aria-describedby unless `describe` is false. */
  children: ReactElement<{ 'aria-describedby'?: string }>;
  placement?: Placement;
  /** Hover delay in ms (default 500; 0 while another tooltip was just open). */
  delay?: number;
  /**
   * Add the content as the child's description (default true). Pass false when it repeats the
   * child's accessible name (IconButton's label).
   */
  describe?: boolean;
  disabled?: boolean;
}

const HIDE_GRACE_MS = 120;
const WARM_MS = 400;
let lastClosedAt = -Infinity;

function isKeyboardFocus(el: Element | null): boolean {
  try {
    return el?.matches(':focus-visible') ?? false;
  } catch {
    return false;
  }
}

/**
 * Hover and keyboard-focus tooltip (WCAG 1.4.13: hoverable, dismissible with Escape, persistent
 * while hovered or focused). Mouse clicks don't show it; touch doesn't either.
 */
export function Tooltip({ content, shortcut, children, placement = 'top', delay = 500, describe = true, disabled = false }: TooltipProps) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLElement | null>(null);
  const wrapperRef = useRef<HTMLSpanElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const tooltipId = useId();
  const descriptionId = useId();

  const clear = () => {
    if (timer.current !== undefined) clearTimeout(timer.current);
    timer.current = undefined;
  };
  const show = (wait: number) => {
    clear();
    if (disabled) return;
    anchorRef.current = (wrapperRef.current?.firstElementChild as HTMLElement | null) ?? null;
    const ms = performance.now() - lastClosedAt < WARM_MS ? 0 : wait;
    if (ms <= 0) setOpen(true);
    else timer.current = setTimeout(() => setOpen(true), ms);
  };
  const hide = (wait = 0) => {
    clear();
    if (wait <= 0) setOpen(false);
    else timer.current = setTimeout(() => setOpen(false), wait);
  };
  const onEscape = useEffectEvent(() => hide());

  useEffect(() => clear, []);
  useEffect(() => {
    if (!open) return;
    const unregister = registerEscape(() => onEscape());
    return () => {
      unregister();
      lastClosedAt = performance.now();
    };
  }, [open]);

  useFloating(open, anchorRef, tooltipRef, { placement, offset: 6 });

  const onPointerEnter = (event: PointerEvent) => {
    if (event.pointerType !== 'touch') show(delay);
  };
  const onPointerLeave = () => hide(HIDE_GRACE_MS);
  const onFocus = (event: FocusEvent) => {
    if (isKeyboardFocus(event.target)) show(0);
  };
  const onBlur = () => hide();

  const describedBy = describe ? [children.props['aria-describedby'], descriptionId].filter(Boolean).join(' ') : undefined;
  const child = describe ? cloneElement(children, { 'aria-describedby': describedBy }) : children;

  return (
    <span
      ref={wrapperRef}
      className={styles.anchor}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      onPointerDown={() => hide()}
      onFocus={onFocus}
      onBlur={onBlur}
    >
      {child}
      {describe ? (
        <span id={descriptionId} hidden>
          {content}
          {shortcut ? ` (${shortcut})` : null}
        </span>
      ) : null}
      {open ? (
        <Portal>
          <div
            ref={tooltipRef}
            id={tooltipId}
            role="tooltip"
            className={styles.tooltip}
            onPointerEnter={clear}
            onPointerLeave={onPointerLeave}
          >
            <span>{content}</span>
            {shortcut ? <kbd className={styles.shortcut}>{shortcut}</kbd> : null}
          </div>
        </Portal>
      ) : null}
    </span>
  );
}
