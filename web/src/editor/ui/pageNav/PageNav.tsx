// Page navigation (P3.9), ported from the page controls of
// legacy/client/homebrew/brewRenderer/toolBar/toolBar.jsx: previous page, the current page (type
// a number and press Enter to jump), the page count, next page.
//
// It is a labelled group meant to sit inside the editor's Toolbar (roving focus); it also works
// on its own. The buttons use aria-disabled rather than disabled so focus stays on them at the
// first or last page.
import clsx from 'clsx';
import { type KeyboardEvent, useId, useRef, useState } from 'react';
import { IconButton, ToolbarGroup, VisuallyHidden } from '@/ui';
import styles from './PageNav.module.css';
import type { PageTracker } from './pageTracker';
import { usePageTracking } from './usePageTracker';

export interface PageNavProps {
  tracker: PageTracker | null | undefined;
  /** The group's accessible name (default "Pages"). */
  label?: string;
  className?: string;
  'data-testid'?: string;
}

export function PageNav({ tracker, label = 'Pages', className, 'data-testid': testId = 'page-nav' }: PageNavProps) {
  const { current, total, atStart, atEnd } = usePageTracking(tracker);
  // Text while the user types a page number; null shows the current page.
  const [typed, setTyped] = useState<string | null>(null);
  const totalId = useId();
  const prevRef = useRef<HTMLButtonElement>(null);
  const nextRef = useRef<HTMLButtonElement>(null);

  const commit = () => {
    if (typed === null) return;
    const page = Number.parseInt(typed, 10);
    setTyped(null);
    if (Number.isFinite(page) && page !== current) tracker?.goToPage(page);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      commit();
      event.currentTarget.select();
    } else if (event.key === 'Escape' && typed !== null) {
      event.preventDefault();
      setTyped(null);
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      // The toolbar leaves arrow keys to text boxes; at either end of the text they move on to
      // the neighbouring button, so the box is not a dead end for keyboard users.
      const input = event.currentTarget;
      const { selectionStart, selectionEnd, value } = input;
      const atStart = selectionStart === 0 && selectionEnd === 0;
      const atEnd = selectionStart === value.length && selectionEnd === value.length;
      if (event.key === 'ArrowLeft' && atStart && prevRef.current) {
        event.preventDefault();
        prevRef.current.focus();
      } else if (event.key === 'ArrowRight' && atEnd && nextRef.current) {
        event.preventDefault();
        nextRef.current.focus();
      }
    } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      // Up/Down step through pages from the box, like a number field.
      event.preventDefault();
      setTyped(null);
      if (event.key === 'ArrowUp') tracker?.goToPrevious();
      else tracker?.goToNext();
    }
  };

  const noPages = total === 0;
  const width = `${Math.max(2, String(total).length) + 1.5}ch`;

  return (
    <ToolbarGroup label={label} className={clsx(styles.pageNav, className)} data-testid={testId}>
      <IconButton
        icon="chevronLeft"
        ref={prevRef}
        label="Previous page"
        tooltip="bottom"
        aria-disabled={noPages || atStart || undefined}
        onClick={() => tracker?.goToPrevious()}
        data-testid="page-prev"
      />
      <span className={styles.position}>
        <input
          type="text"
          inputMode="numeric"
          autoComplete="off"
          className={styles.input}
          style={{ width }}
          aria-label="Current page"
          aria-describedby={totalId}
          value={typed ?? (noPages ? '' : String(current))}
          disabled={noPages}
          onFocus={(event) => event.currentTarget.select()}
          onChange={(event) => setTyped(event.target.value.replace(/[^0-9]/g, ''))}
          onKeyDown={onKeyDown}
          onBlur={commit}
          data-testid="page-input"
        />
        <span id={totalId} className={styles.total} data-testid="page-total">
          <span aria-hidden="true">/ {total}</span>
          <VisuallyHidden>of {total} pages</VisuallyHidden>
        </span>
      </span>
      <IconButton
        icon="chevronRight"
        ref={nextRef}
        label="Next page"
        tooltip="bottom"
        aria-disabled={noPages || atEnd || undefined}
        onClick={() => tracker?.goToNext()}
        data-testid="page-next"
      />
    </ToolbarGroup>
  );
}
