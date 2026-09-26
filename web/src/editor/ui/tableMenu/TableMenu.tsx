// TableMenu (P5.6): one menu button for the toolbar lane. Outside a table it inserts one; inside
// it adds and deletes rows and columns, merges and splits cells (colspan/rowspan), makes rows
// header rows, sets column widths (colwidth) and toggles the table classes (classTable, frame,
// decoration, wide). Every action is one undo step and keeps the caret in the table.
//
//   <TableMenu editor={editor} />
import type { Editor } from '@tiptap/core';
import type { Command } from '@tiptap/pm/state';
import { addColumnAfter, addColumnBefore, addRowAfter, addRowBefore, deleteColumn, deleteRow, deleteTable, mergeCells, splitCell } from '@tiptap/pm/tables';
import { useEditorState } from '@tiptap/react';
import { useState, type FormEvent } from 'react';
import { Button, Dialog, MenuButton, TextField, type MenuEntry } from '@/ui';
import { insertTable, resetColumnWidths, setColumnWidth, setHeaderRows, TABLE_CLASSES, TABLE_CLASS_LABELS, toggleTableClass } from '../../tables/commands';
import { runBlockCommand } from '../blockMenu/blockCommands';
import styles from './tableMenu.module.css';
import { tableMenuContext, type TableMenuContext } from './tableMenuContext';

export interface TableMenuProps {
  editor: Editor | null;
  label?: string;
  iconOnly?: boolean;
  'data-testid'?: string;
}

function items(editor: Editor, ctx: TableMenuContext, openWidthDialog: () => void): MenuEntry[] {
  const run = (command: Command) => () => runBlockCommand(editor, command);
  if (!ctx.inTable) {
    return [{ id: 'insert-table', label: 'Insert table', icon: 'table', disabled: !ctx.canInsertTable, onSelect: run(insertTable({ rows: 3, cols: 3, headerRows: 1 })) }];
  }
  return [
    {
      type: 'group',
      id: 'rows',
      label: 'Rows',
      items: [
        { id: 'row-before', label: 'Add row above', disabled: !ctx.can.addRowBefore, onSelect: run(addRowBefore) },
        { id: 'row-after', label: 'Add row below', disabled: !ctx.can.addRowAfter, onSelect: run(addRowAfter) },
        { id: 'row-delete', label: 'Delete row', disabled: !ctx.can.deleteRow, onSelect: run(deleteRow) },
        { id: 'row-header', type: 'checkbox', label: 'Header row', checked: ctx.headerRow, onCheckedChange: (on) => runBlockCommand(editor, setHeaderRows(on)) },
      ],
    },
    {
      type: 'group',
      id: 'columns',
      label: 'Columns',
      items: [
        { id: 'col-before', label: 'Add column left', disabled: !ctx.can.addColumnBefore, onSelect: run(addColumnBefore) },
        { id: 'col-after', label: 'Add column right', disabled: !ctx.can.addColumnAfter, onSelect: run(addColumnAfter) },
        { id: 'col-delete', label: 'Delete column', disabled: !ctx.can.deleteColumn, onSelect: run(deleteColumn) },
        { id: 'col-width', label: ctx.columnWidth ? `Column width (${ctx.columnWidth}px)…` : 'Column width…', onSelect: openWidthDialog },
        { id: 'col-reset', label: 'Automatic column widths', disabled: !ctx.can.resetColumnWidths, onSelect: run(resetColumnWidths) },
      ],
    },
    {
      type: 'group',
      id: 'cells',
      label: 'Cells',
      items: [
        { id: 'cells-merge', label: 'Merge cells', disabled: !ctx.can.mergeCells, onSelect: run(mergeCells) },
        { id: 'cells-split', label: 'Split cell', disabled: !ctx.can.splitCell, onSelect: run(splitCell) },
      ],
    },
    {
      type: 'group',
      id: 'style',
      label: 'Table style',
      items: TABLE_CLASSES.map((cls) => ({
        id: `class-${cls}`,
        type: 'checkbox' as const,
        label: TABLE_CLASS_LABELS[cls],
        checked: ctx.classes[cls],
        onCheckedChange: () => runBlockCommand(editor, toggleTableClass(cls)),
      })),
    },
    { type: 'separator', id: 'sep' },
    { id: 'table-delete', label: 'Delete table', icon: 'trash', disabled: !ctx.can.deleteTable, onSelect: run(deleteTable) },
  ];
}

export function TableMenu({ editor, label = 'Table', iconOnly = false, 'data-testid': testId = 'table-menu' }: TableMenuProps) {
  // The menu's context (what the table commands can do at the caret) is computed only while the
  // menu is open, not after every transaction (every keystroke, P8.1).
  const [menuOpen, setMenuOpen] = useState(false);
  const editable = useEditorState({ editor, selector: ({ editor: e }) => !!e && !e.isDestroyed && e.isEditable });
  const ctx = useEditorState({
    editor,
    selector: ({ editor: e }) => (menuOpen && e && !e.isDestroyed && e.isEditable ? tableMenuContext(e.state) : null),
  });
  /** The column width dialog, with the width of the selected columns when it was opened (the menu has closed since). */
  const [widthDialog, setWidthDialog] = useState<{ initial: number | null } | null>(null);
  const widthOpen = widthDialog !== null;
  const setWidthOpen = (open: boolean) => setWidthDialog(open ? (widthDialog ?? { initial: null }) : null);
  const entries = editor && ctx ? items(editor, ctx, () => setWidthDialog({ initial: ctx.columnWidth })) : [];
  return (
    <>
      <MenuButton label={label} icon="table" iconOnly={iconOnly} items={entries} disabled={!editable} onOpenChange={setMenuOpen} data-testid={testId} />
      <Dialog open={widthOpen} onOpenChange={setWidthOpen} title="Column width" size="sm" data-testid="column-width-dialog">
        {widthOpen && editor ? (
          <ColumnWidthForm
            initial={widthDialog.initial}
            onDone={(width) => {
              setWidthOpen(false);
              if (width !== undefined) setColumnWidth(width)(editor.state, editor.view.dispatch);
              requestAnimationFrame(() => editor.view.focus());
            }}
          />
        ) : null}
      </Dialog>
    </>
  );
}

/** Pixel width for the selected columns; "Automatic" clears it. undefined = cancelled. */
function ColumnWidthForm({ initial, onDone }: { initial: number | null; onDone: (width: number | null | undefined) => void }) {
  const [value, setValue] = useState(initial ? String(initial) : '');
  const [error, setError] = useState<string>();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const n = Number(value);
    if (!Number.isFinite(n) || n < 10 || n > 2000) {
      setError('Enter a width from 10 to 2000 pixels.');
      return;
    }
    onDone(Math.round(n));
  };
  return (
    <form onSubmit={submit} noValidate>
      <TextField
        label="Width in pixels"
        type="number"
        min={10}
        max={2000}
        step={1}
        inputMode="numeric"
        value={value}
        error={error}
        data-autofocus=""
        onChange={(e) => {
          setValue(e.target.value);
          setError(undefined);
        }}
        data-testid="column-width-input"
      />
      <div className={styles.actions}>
        <Button type="button" variant="ghost" onClick={() => onDone(undefined)}>
          Cancel
        </Button>
        <Button type="button" variant="secondary" onClick={() => onDone(null)}>
          Automatic
        </Button>
        <Button type="submit" variant="primary" data-testid="column-width-apply">
          Apply
        </Button>
      </div>
    </form>
  );
}
