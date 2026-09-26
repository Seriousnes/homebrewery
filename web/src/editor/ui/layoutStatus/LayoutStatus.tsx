import type { Editor } from '@tiptap/core';
import clsx from 'clsx';
import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Button, Popover, Spinner, VisuallyHidden, type DismissReason } from '@/ui';
import { OversizeList } from '../oversize/OversizeList';
import styles from './LayoutStatus.module.css';
import { EMPTY_LAYOUT_STATUS, createLayoutStatusStore } from './layoutStatusStore';

export interface LayoutStatusProps {
  /** The paginated editor (null while it mounts). */
  editor: Editor | null;
  /** How long a pass runs before "Laying out pages…" shows (ms, default LAYOUT_BUSY_DELAY_MS). */
  delayMs?: number;
  className?: string;
}

const subscribeNothing = () => () => {};
const emptySnapshot = () => EMPTY_LAYOUT_STATUS;

/**
 * Pagination status for the editor chrome (P4.8, plan §4.7):
 * - "Laying out pages…" (a polite live region) while a pass runs longer than `delayMs`, and
 *   "Waiting for images…" while pages wait for an image's size;
 * - a "N layout warnings" button when pages are oversized, opening the warnings with their fixes
 *   (make wide, allow splitting, shrink image, go to page). A click on a page's "Oversized" badge
 *   in the canvas opens the same warnings, for that page, next to the badge.
 *
 * Mount it once per paginated editor, outside the canvas (it renders chrome, not brew content).
 */
export function LayoutStatus({ editor, delayMs, className }: LayoutStatusProps) {
  const store = useMemo(() => (editor ? createLayoutStatusStore(editor, { delayMs }) : null), [editor, delayMs]);
  const status = useSyncExternalStore(store ? store.subscribe : subscribeNothing, store ? store.getSnapshot : emptySnapshot);
  const [open, setOpen] = useState(false);
  const [onlyPage, setOnlyPage] = useState<number | null>(null);
  const [fromBadge, setFromBadge] = useState(false);
  const anchorRef = useRef<HTMLElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const titleId = useId();
  const popoverId = useId();

  const count = status.oversized.length;
  const shown = onlyPage === null ? status.oversized : status.oversized.filter((w) => w.index === onlyPage);
  const isOpen = open && shown.length > 0 && editor !== null;

  // A click on a page's "Oversized" badge (PageView chrome) opens that page's warnings there.
  useEffect(() => {
    if (!editor) return;
    let dom: HTMLElement;
    try {
      dom = editor.view.dom;
    } catch {
      return;
    }
    const onClick = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      const badge = target?.closest('.hb-oversized-badge');
      if (!(badge instanceof HTMLElement) || !dom.contains(badge)) return;
      const page = badge.closest('.page');
      const index = page ? Array.prototype.indexOf.call(dom.children, page) : -1;
      if (index < 0) return;
      anchorRef.current = badge;
      setOnlyPage(index);
      setFromBadge(true);
      setOpen(true);
    };
    dom.addEventListener('click', onClick);
    return () => dom.removeEventListener('click', onClick);
  }, [editor]);

  const close = (reason?: DismissReason) => {
    setOpen(false);
    // A badge can't take focus back: the editor does.
    if (fromBadge && reason === 'escape' && editor && !editor.isDestroyed) editor.view.focus();
  };

  const busyText = status.busy ? 'Laying out pages…' : status.waiting ? 'Waiting for images…' : '';
  const warningsText = count === 0 ? '' : `${count} layout warning${count === 1 ? '' : 's'}`;

  return (
    <div className={clsx(styles.root, className)} data-testid="layout-status">
      <span role="status" className={styles.status} data-testid="layout-status-text" data-busy={status.busy ? 'true' : 'false'}>
        {busyText && (
          <>
            <Spinner decorative size={12} className={styles.spinner} />
            {busyText}
          </>
        )}
        <VisuallyHidden>{warningsText}</VisuallyHidden>
      </span>
      {count > 0 && (
        <Button
          ref={buttonRef}
          size="sm"
          variant="ghost"
          icon="warning"
          className={styles.warnings}
          aria-haspopup="dialog"
          aria-expanded={isOpen && !fromBadge}
          aria-controls={isOpen && !fromBadge ? popoverId : undefined}
          data-testid="layout-warnings"
          onClick={() => {
            anchorRef.current = buttonRef.current;
            setOnlyPage(null);
            setFromBadge(false);
            setOpen(!isOpen || fromBadge);
          }}
        >
          {warningsText}
        </Button>
      )}
      {editor && (
        <Popover
          open={isOpen}
          onOpenChange={(next, reason) => (next ? setOpen(true) : close(reason))}
          anchorRef={anchorRef}
          id={popoverId}
          aria-labelledby={titleId}
          placement="bottom-end"
          returnFocus={!fromBadge}
          className={styles.popover}
          data-testid="layout-warnings-popover"
        >
          <h2 id={titleId} className={styles.title}>
            Layout warnings
          </h2>
          <OversizeList
            editor={editor}
            warnings={shown}
            labelledBy={titleId}
            onAction={() => {
              setOpen(false);
              if (!editor.isDestroyed) editor.view.focus();
            }}
          />
        </Popover>
      )}
    </div>
  );
}
