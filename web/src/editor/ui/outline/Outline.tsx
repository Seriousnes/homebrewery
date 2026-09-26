// The outline panel's content (P3.9, plan §6.2): every page, and on ordinary pages their headings,
// from the document (outlineModel.ts). Choosing an entry scrolls the canvas to it at any zoom; a
// heading also gets the caret (without taking focus from the outline), so typing continues there
// after returning to the canvas. The current page (from the page tracker) is marked with
// aria-current and kept in view in the list, unless the pointer or focus is in the outline.
import type { Editor } from '@tiptap/core';
import { NodeSelection, Selection } from '@tiptap/pm/state';
import clsx from 'clsx';
import { type MouseEvent, useEffect, useRef } from 'react';
import type { PageTracker } from '@/editor/ui/pageNav/pageTracker';
import { usePageTracking } from '@/editor/ui/pageNav/usePageTracker';
import styles from './Outline.module.css';
import { findBlockById, type OutlineEntry, type OutlinePage } from './outlineModel';
import { useOutline } from './useOutline';

export interface OutlineProps {
  editor: Editor | null | undefined;
  tracker: PageTracker | null | undefined;
  /** The navigation landmark's name (default "Outline"). */
  label?: string;
  /** Put the caret at a chosen heading (default true). */
  moveSelection?: boolean;
  className?: string;
  'data-testid'?: string;
}

export function Outline({ editor, tracker, label = 'Outline', moveSelection = true, className, 'data-testid': testId = 'outline' }: OutlineProps) {
  const outline = useOutline(editor);
  const { current } = usePageTracking(tracker);
  const navRef = useRef<HTMLElement>(null);
  const engaged = useRef(false);

  // Keep the current page's entry in view while the user scrolls the canvas.
  useEffect(() => {
    const nav = navRef.current;
    if (!nav || current < 1 || engaged.current || nav.contains(nav.ownerDocument.activeElement)) return;
    const link = nav.querySelector<HTMLElement>(`[data-page="${current}"]`);
    if (link) keepInView(link);
  }, [current, outline]);

  const goToPage = (page: OutlinePage) => {
    if (tracker) {
      tracker.goToPage(page.number);
      return;
    }
    const dom = editor && !editor.isDestroyed ? editor.view.nodeDOM(page.pos) : null;
    if (dom instanceof Element) dom.scrollIntoView({ block: 'start' });
  };

  const goToEntry = (entry: OutlineEntry) => {
    if (!editor || editor.isDestroyed) return;
    const { state, view } = editor;
    const pos = findBlockById(state.doc, entry.id, entry.pos);
    if (pos === null) return;
    const dom = view.nodeDOM(pos);
    if (!(dom instanceof Element)) return;
    if (tracker) tracker.scrollToElement(dom);
    else dom.scrollIntoView({ block: 'start' });
    if (!moveSelection) return;
    const node = state.doc.nodeAt(pos);
    if (!node) return;
    const selection = node.isAtom && NodeSelection.isSelectable(node) ? NodeSelection.create(state.doc, pos) : Selection.near(state.doc.resolve(pos + 1));
    // A selection-only transaction: no history entry, no repagination.
    view.dispatch(state.tr.setSelection(selection));
  };

  const onLinkClick = (event: MouseEvent<HTMLAnchorElement>, go: () => void) => {
    event.preventDefault();
    go();
  };

  return (
    <nav
      ref={navRef}
      aria-label={label}
      className={clsx(styles.outline, className)}
      data-testid={testId}
      onPointerEnter={() => (engaged.current = true)}
      onPointerLeave={() => (engaged.current = false)}
    >
      {outline.length === 0 ? (
        <p className={styles.empty}>No pages yet.</p>
      ) : (
        <ul className={styles.pages}>
          {outline.map((page) => (
            <li key={page.index} className={styles.page}>
              <a
                href={`#${page.id}`}
                className={clsx(styles.link, styles.pageLink)}
                data-page={page.number}
                data-page-type={page.pageType ?? undefined}
                aria-current={page.number === current ? 'location' : undefined}
                title={page.label}
                onClick={(event) => onLinkClick(event, () => goToPage(page))}
              >
                {page.label}
              </a>
              {page.entries.length > 0 ? (
                <ul className={styles.entries}>
                  {page.entries.map((entry, i) => (
                    <li key={`${entry.id}-${i}`}>
                      <a
                        href={`#${entry.id}`}
                        className={styles.link}
                        data-depth={entry.depth}
                        data-entry={entry.id}
                        title={entry.text}
                        onClick={(event) => onLinkClick(event, () => goToEntry(entry))}
                      >
                        {entry.text}
                      </a>
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </nav>
  );
}

/** Scrolls the nearest scrolling ancestor of `el` (only) so `el` is visible. */
function keepInView(el: HTMLElement): void {
  let parent = el.parentElement;
  while (parent) {
    const { overflowY } = getComputedStyle(parent);
    if ((overflowY === 'auto' || overflowY === 'scroll') && parent.scrollHeight > parent.clientHeight) break;
    parent = parent.parentElement;
  }
  if (!parent) return;
  const box = parent.getBoundingClientRect();
  const rect = el.getBoundingClientRect();
  if (rect.top < box.top) parent.scrollTop += rect.top - box.top - 8;
  else if (rect.bottom > box.bottom) parent.scrollTop += rect.bottom - box.bottom + 8;
}
