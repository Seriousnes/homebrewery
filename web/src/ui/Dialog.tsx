import clsx from 'clsx';
import {
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useEffectEvent,
  useId,
  useLayoutEffect,
  useRef,
} from 'react';
import styles from './Dialog.module.css';
import { IconButton } from './IconButton';
import { activeElement, focusElement, focusFirst, getTabbables, trapTab } from './internal/focus';
import { isInLaterLayer, isInToastLayer, pushModalLayer, registerEscape, topModalLayer } from './internal/layers';
import { Portal } from './Portal';

export type DialogSize = 'sm' | 'md' | 'lg';

export interface DialogProps {
  open: boolean;
  /** Called with false on Escape, the close button or an overlay click. */
  onOpenChange: (open: boolean) => void;
  /** The dialog's name (an h2, referenced by aria-labelledby). */
  title: ReactNode;
  /** Referenced by aria-describedby. */
  description?: ReactNode;
  children?: ReactNode;
  /** Action row at the bottom (buttons). */
  footer?: ReactNode;
  /** Focused on open. Default: an element with data-autofocus, else the first tabbable in the body, then footer. */
  initialFocusRef?: RefObject<HTMLElement | null>;
  /** Focused on close. Default: whatever had focus when the dialog opened. */
  returnFocusRef?: RefObject<HTMLElement | null>;
  /** Move focus back on close (default true). */
  returnFocus?: boolean;
  closeOnEscape?: boolean;
  closeOnOverlayClick?: boolean;
  showCloseButton?: boolean;
  /** Default 'md'. */
  size?: DialogSize;
  role?: 'dialog' | 'alertdialog';
  className?: string;
  'data-testid'?: string;
}

/**
 * Modal dialog: rendered in a portal layer, everything else inert, Tab kept inside, Escape and
 * the close button close it, focus returns to where it was. Unmounted while closed.
 */
export function Dialog(props: DialogProps) {
  return props.open ? <DialogContent {...props} /> : null;
}

function DialogContent({
  onOpenChange,
  title,
  description,
  children,
  footer,
  initialFocusRef,
  returnFocusRef,
  returnFocus = true,
  closeOnEscape = true,
  closeOnOverlayClick = true,
  showCloseButton = true,
  size = 'md',
  role = 'dialog',
  className,
  'data-testid': testId,
}: DialogProps) {
  const layerRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const footerRef = useRef<HTMLDivElement>(null);
  const pressedOverlay = useRef(false);
  const titleId = useId();
  const descriptionId = useId();

  const focusInitial = useEffectEvent(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const auto = panel.querySelector<HTMLElement>('[data-autofocus]');
    const candidates = [
      initialFocusRef?.current,
      auto,
      bodyRef.current && getTabbables(bodyRef.current)[0],
      footerRef.current && getTabbables(footerRef.current)[0],
    ];
    for (const el of candidates) if (el && focusElement(el)) return;
    focusFirst(panel);
  });
  const restoreFocus = useEffectEvent((previous: Element | null) => {
    if (!returnFocus) return;
    const target = returnFocusRef?.current ?? previous;
    if (target instanceof HTMLElement) focusElement(target);
  });
  const requestClose = useEffectEvent(() => onOpenChange(false));

  // Modal state and focus: inert background on open, focus in; on close the background is
  // restored before focus returns (an inert element can't take focus).
  useLayoutEffect(() => {
    const layer = layerRef.current;
    if (!layer) return;
    const previous = activeElement(layer.ownerDocument);
    const release = pushModalLayer(layer);
    focusInitial();
    return () => {
      release();
      restoreFocus(previous);
    };
  }, []);

  useEffect(() => {
    if (!closeOnEscape) return;
    return registerEscape(() => requestClose());
  }, [closeOnEscape]);

  // Focus that escapes anyway (browsers without inert, programmatic focus) is brought back.
  useEffect(() => {
    const layer = layerRef.current;
    if (!layer) return;
    const doc = layer.ownerDocument;
    const onFocusIn = (event: FocusEvent) => {
      if (topModalLayer() !== layer) return;
      const target = event.target as Node | null;
      if (!target || layer.contains(target) || isInLaterLayer(target, layer) || isInToastLayer(target)) return;
      if (panelRef.current) focusFirst(panelRef.current);
    };
    doc.addEventListener('focusin', onFocusIn);
    return () => doc.removeEventListener('focusin', onFocusIn);
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const panel = panelRef.current;
    // React bubbles events from portals opened inside (menus); only handle our own DOM.
    if (!panel || !panel.contains(event.target as Node)) return;
    trapTab(event, panel);
  };

  return (
    <Portal layerRef={layerRef}>
      <div
        className={styles.overlay}
        onPointerDown={(event) => {
          pressedOverlay.current = event.target === event.currentTarget;
        }}
        onClick={(event) => {
          if (closeOnOverlayClick && pressedOverlay.current && event.target === event.currentTarget) onOpenChange(false);
          pressedOverlay.current = false;
        }}
      >
        <div
          ref={panelRef}
          role={role}
          aria-modal="true"
          aria-labelledby={titleId}
          aria-describedby={description ? descriptionId : undefined}
          tabIndex={-1}
          className={clsx(styles.panel, styles[size], className)}
          data-testid={testId}
          onKeyDown={onKeyDown}
        >
          <div className={styles.header}>
            <h2 id={titleId} className={styles.title}>
              {title}
            </h2>
            {showCloseButton ? (
              <IconButton icon="close" label="Close" tooltip={false} size="sm" onClick={() => onOpenChange(false)} />
            ) : null}
          </div>
          {description ? (
            <div id={descriptionId} className={styles.description}>
              {description}
            </div>
          ) : null}
          {children != null ? (
            <div ref={bodyRef} className={styles.body}>
              {children}
            </div>
          ) : null}
          {footer ? (
            <div ref={footerRef} className={styles.footer}>
              {footer}
            </div>
          ) : null}
        </div>
      </div>
    </Portal>
  );
}
