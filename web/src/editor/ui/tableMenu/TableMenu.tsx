// TableMenu (P5.6, T3): the table button of the toolbar lane. Outside a table it opens the size
// picker (rows × columns, header row) and inserts the table; the 'insertTable' keymap request
// (context menu) opens the same picker. Inside a table it is a menu of the table actions
// (tableMenuEntries: rows, columns, cells, header rows, column widths, table classes, delete).
// Every action is one undo step and keeps the caret in the table.
//
//   <TableMenu editor={editor} />
import type { Editor } from '@tiptap/core';
import { isInTable } from '@tiptap/pm/tables';
import { useEditorState } from '@tiptap/react';
import { useEffect, useId, useRef, useState } from 'react';
import { Button, IconButton, MenuButton, Popover } from '@/ui';
import { onKeymapRequest } from '../../commands/keymap';
import { insertTable } from '../../tables/commands';
import { ColumnWidthDialog } from './ColumnWidthDialog';
import { tableMenuContext } from './tableMenuContext';
import { runTableCommand, tableMenuEntries } from './tableMenuEntries';
import type { TablePick } from './tableSize';
import { TableSizePicker } from './TableSizePicker';

export interface TableMenuProps {
  editor: Editor | null;
  label?: string;
  iconOnly?: boolean;
  'data-testid'?: string;
}

export function TableMenu({ editor, label = 'Table', iconOnly = false, 'data-testid': testId = 'table-menu' }: TableMenuProps) {
  // The menu's context (what the table commands can do at the caret) is computed only while the
  // menu is open, not after every transaction (every keystroke, P8.1).
  const [menuOpen, setMenuOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  const pickerId = useId();
  const state = useEditorState({
    editor,
    selector: ({ editor: e }) => (!!e && !e.isDestroyed && e.isEditable ? { inTable: isInTable(e.state) } : null),
  });
  const editable = state !== null;
  const inTable = state?.inTable ?? false;
  const ctx = useEditorState({
    editor,
    selector: ({ editor: e }) => (menuOpen && e && !e.isDestroyed && e.isEditable ? tableMenuContext(e.state) : null),
  });
  /** The column width dialog, with the width of the selected columns when it was opened (the menu has closed since). */
  const [widthDialog, setWidthDialog] = useState<{ width: number | null } | null>(null);

  // The 'insertTable' request (context menu): the picker, where a table can go.
  useEffect(() => {
    if (!editor) return;
    return onKeymapRequest(editor, (request) => {
      if (request !== 'insertTable') return false;
      if (editor.isDestroyed || !editor.isEditable || !insertTable()(editor.state)) return false;
      setPickerOpen(true);
      return true;
    });
  }, [editor]);

  const insert = (pick: TablePick) => {
    setPickerOpen(false);
    if (!editor || editor.isDestroyed) return;
    runTableCommand(editor, insertTable(pick));
    editor.view.focus();
  };

  const entries =
    editor && ctx ? tableMenuEntries(editor, ctx, { onColumnWidth: () => setWidthDialog({ width: ctx.columnWidth }), afterAction: () => editor.view.focus() }) : [];

  const pickerTrigger = {
    ref: anchorRef,
    disabled: !editable,
    'aria-haspopup': 'dialog' as const,
    'aria-expanded': pickerOpen,
    'aria-controls': pickerOpen ? pickerId : undefined,
    onClick: () => setPickerOpen((open) => !open),
    'data-testid': testId,
  };
  const trigger = inTable ? (
    <MenuButton label={label} icon="table" iconOnly={iconOnly} items={entries} disabled={!editable} onOpenChange={setMenuOpen} data-testid={testId} />
  ) : iconOnly ? (
    <IconButton {...pickerTrigger} icon="table" label="Insert table" />
  ) : (
    <Button {...pickerTrigger} icon="table" iconEnd="chevronDown">
      {label}
    </Button>
  );

  return (
    <>
      {trigger}
      <Popover
        open={pickerOpen && !inTable}
        onOpenChange={(open, reason) => {
          setPickerOpen(open);
          if (!open && reason === 'escape' && editor && !editor.isDestroyed) editor.view.focus();
        }}
        anchorRef={anchorRef}
        returnFocus={false}
        id={pickerId}
        aria-label="Insert table"
        data-testid="table-picker"
      >
        <TableSizePicker onPick={insert} />
      </Popover>
      {editor ? <ColumnWidthDialog editor={editor} initial={widthDialog} onClose={() => setWidthDialog(null)} /> : null}
    </>
  );
}
