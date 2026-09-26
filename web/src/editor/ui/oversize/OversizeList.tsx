import type { Editor } from '@tiptap/core';
import type { Command } from '@tiptap/pm/state';
import { Button, Icon } from '@/ui';
import { allowSplitting, goToPage, makeWide, shrinkImages, type OversizeWarning } from './oversize';
import styles from './OversizeList.module.css';

export type OversizeAction = 'wide' | 'split' | 'shrink' | 'goto';

export interface OversizeListProps {
  editor: Editor;
  warnings: readonly OversizeWarning[];
  /** Called after an action ran (the caller closes its popover and focuses the editor). */
  onAction?: (action: OversizeAction, page: number) => void;
  /** id of the heading that names the list */
  labelledBy?: string;
}

/**
 * Layout warnings (P4.8): one item per oversized page, with the fixes that apply to its block
 * (make wide, allow splitting, shrink images) and "Go to page". Each fix is one undo step;
 * pagination re-checks the page and the warning clears once the block fits.
 */
export function OversizeList({ editor, warnings, onAction, labelledBy }: OversizeListProps) {
  const run = (command: Command, action: OversizeAction, page: number) => {
    if (editor.isDestroyed) return;
    const done = command(editor.state, editor.view.dispatch, editor.view);
    if (done && action !== 'goto') goToPage(page)(editor.state, editor.view.dispatch, editor.view);
    if (done) onAction?.(action, page);
  };
  return (
    <ul className={styles.list} aria-labelledby={labelledBy}>
      {warnings.map((w) => {
        const page = w.index + 1;
        return (
          <li key={w.pid ?? `page-${w.index}`} className={styles.item} data-testid={`oversize-${w.index}`}>
            <p className={styles.message}>
              <Icon name="warning" size={16} />
              <span>
                <strong>Page {page}:</strong> {w.label} is taller than a column, so it can&rsquo;t move to another page.
              </span>
            </p>
            <div className={styles.actions} role="group" aria-label={`Fixes for page ${page}`}>
              {w.fixes.makeWide && (
                <Button size="sm" onClick={() => run(makeWide(w.index), 'wide', w.index)}>
                  Make wide
                </Button>
              )}
              {w.fixes.allowSplitting && (
                <Button size="sm" onClick={() => run(allowSplitting(w.index), 'split', w.index)}>
                  Allow splitting
                </Button>
              )}
              {w.fixes.shrinkImages && (
                <Button size="sm" onClick={() => run(shrinkImages(w.index), 'shrink', w.index)}>
                  Shrink image
                </Button>
              )}
              <Button size="sm" variant="ghost" onClick={() => run(goToPage(w.index), 'goto', w.index)}>
                Go to page {page}
              </Button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
