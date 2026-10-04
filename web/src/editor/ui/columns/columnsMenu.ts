// The Columns menu (toolbar) and submenu (context menu): one or two columns for the section at the
// cursor, or for every section at once. Built when the menu opens, from the editor as it is then.
//
//   This section (pages 1–3)   ( ) 1 column   (•) 2 columns   ( ) Theme default (2 columns)
//   ─────────────────────────
//   Every page                 1 column on every page · 2 columns on every page · Theme default…
//
// Each choice is one undo step. The inspector's Page tab has the same setting ("Columns").
import type { Editor } from '@tiptap/core';
import type { MenuEntry } from '@/ui';
import { sectionRange, type ColumnsSetting, type Dispatch } from '../../commands/attrs';
import { columnsAt, renderedColumnsAt, setAllColumns, setSectionColumns } from '../../commands/columns';
import { selectionPageIndex } from '../../commands/sections';

export const COLUMN_LABELS: Record<'1' | '2' | 'theme', string> = { '1': '1 column', '2': '2 columns', theme: 'Theme default' };

const keyOf = (columns: ColumnsSetting): '1' | '2' | 'theme' => (columns === null ? 'theme' : columns === 1 ? '1' : '2');

/**
 * "Theme default", with the column count the canvas shows ("Theme default (2 columns)") while the
 * section follows the theme (`section` null) and the count can be read. The toolbar menu, the
 * context menu and the inspector's Columns field all use it. `pageIndex`: a page of the section
 * (default: the page at the cursor).
 */
export function themeDefaultLabel(editor: Editor, section: ColumnsSetting, pageIndex?: number): string {
  const rendered = section === null && !editor.isDestroyed ? renderedColumnsAt(editor.view, pageIndex) : null;
  return rendered === 1 || rendered === 2 ? `${COLUMN_LABELS.theme} (${COLUMN_LABELS[keyOf(rendered)]})` : COLUMN_LABELS.theme;
}

export interface ColumnsEntriesOptions {
  /** Runs after a choice (e.g. focus the editor). */
  afterSelect?: () => void;
}

/** The menu entries for the editor's state now (see the top of the file). */
export function columnsEntries(editor: Editor, opts: ColumnsEntriesOptions = {}): MenuEntry[] {
  const state = editor.state;
  const info = columnsAt(state);
  const disabled = !editor.isEditable;
  const { start, end } = sectionRange(state.doc, selectionPageIndex(state));
  const pages = start === end ? `page ${start + 1}` : `pages ${start + 1}–${end + 1}`;
  // What the theme gives this page, shown while the section follows the theme (the canvas shows it).
  const themeLabel = themeDefaultLabel(editor, info.section);
  const label = (columns: ColumnsSetting) => (columns === null ? themeLabel : COLUMN_LABELS[keyOf(columns)]);

  const run = (edit: () => void) => () => {
    if (editor.isDestroyed || !editor.isEditable) return;
    edit();
    opts.afterSelect?.();
  };
  const dispatch: Dispatch = (tr) => editor.view.dispatch(tr);
  const choices: ColumnsSetting[] = [1, 2, null];

  return [
    {
      type: 'group',
      id: 'columns-section',
      label: `This section (${pages})`,
      items: choices.map((columns) => ({
        id: `columns-section-${keyOf(columns)}`,
        type: 'radio' as const,
        label: label(columns),
        checked: info.section === columns,
        disabled,
        onSelect: run(() => setSectionColumns(editor.state, dispatch, columns)),
      })),
    },
    { type: 'separator', id: 'columns-sep' },
    {
      type: 'group',
      id: 'columns-all',
      label: 'Every page',
      items: choices.map((columns) => ({
        id: `columns-all-${keyOf(columns)}`,
        label: `${COLUMN_LABELS[keyOf(columns)]} on every page`,
        disabled: disabled || info.all === columns,
        onSelect: run(() => setAllColumns(editor.state, dispatch, columns)),
      })),
    },
  ];
}

/** The toolbar button's text and accessible name for the setting of the section at the cursor. */
export function columnsButtonLabel(section: ColumnsSetting): { text: string; name: string } {
  return section === null
    ? { text: 'Columns', name: 'Columns: theme default' }
    : { text: COLUMN_LABELS[keyOf(section)], name: `Columns: ${COLUMN_LABELS[keyOf(section)]}` };
}
