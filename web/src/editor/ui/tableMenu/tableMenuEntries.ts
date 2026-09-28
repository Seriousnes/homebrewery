// The table actions (T3), shared by the toolbar's TableMenu, the table controls over the table
// at the caret (TableControls) and other menus (the context menu):
//
//   tableMenuEntries(editor, tableMenuContext(editor.state), { onColumnWidth })  → MenuEntry[]
//
// Outside a table the entries are one "Insert table…" item (it opens the size picker: the
// 'insertTable' keymap request); inside one they add and delete rows and columns, merge and split
// cells, set header rows, column widths and the table classes, and delete the table. Every action
// is one undo step (runCommand) and leaves the focus where it is.
import type { Editor } from '@tiptap/core';
import type { Command } from '@tiptap/pm/state';
import { addColumnAfter, addColumnBefore, addRowAfter, addRowBefore, deleteColumn, deleteRow, mergeCells, splitCell } from '@tiptap/pm/tables';
import type { IconName, MenuEntry } from '@/ui';
import { emitKeymapRequest, runCommand } from '../../commands/keymap';
import { removeTable, resetColumnWidths, setHeaderRows, TABLE_CLASSES, TABLE_CLASS_LABELS, toggleTableClass } from '../../tables/commands';
import { openColumnWidthDialog } from '../../tables/controlsStore';
import type { TableMenuContext } from './tableMenuContext';

type CanKey = keyof TableMenuContext['can'];

/** One table action: a button of the table controls and an item of the menus. */
export interface TableAction {
  id: string;
  label: string;
  icon: IconName;
  command: Command;
  /** The context flag that enables it. */
  can: CanKey;
}

export const TABLE_ROW_ACTIONS: readonly TableAction[] = [
  { id: 'row-before', label: 'Add row above', icon: 'rowAbove', command: addRowBefore, can: 'addRowBefore' },
  { id: 'row-after', label: 'Add row below', icon: 'rowBelow', command: addRowAfter, can: 'addRowAfter' },
  { id: 'row-delete', label: 'Delete row', icon: 'rowDelete', command: deleteRow, can: 'deleteRow' },
];

export const TABLE_COLUMN_ACTIONS: readonly TableAction[] = [
  { id: 'col-before', label: 'Add column left', icon: 'columnLeft', command: addColumnBefore, can: 'addColumnBefore' },
  { id: 'col-after', label: 'Add column right', icon: 'columnRight', command: addColumnAfter, can: 'addColumnAfter' },
  { id: 'col-delete', label: 'Delete column', icon: 'columnDelete', command: deleteColumn, can: 'deleteColumn' },
];

export const TABLE_CELL_ACTIONS: readonly TableAction[] = [
  { id: 'cells-merge', label: 'Merge cells', icon: 'cellsMerge', command: mergeCells, can: 'mergeCells' },
  { id: 'cells-split', label: 'Split cell', icon: 'cellSplit', command: splitCell, can: 'splitCell' },
];

export const DELETE_TABLE_ACTION: TableAction = { id: 'table-delete', label: 'Delete table', icon: 'trash', command: removeTable, can: 'deleteTable' };

/** Runs a table command as one undo step (the focus stays where it is). */
export function runTableCommand(editor: Editor, command: Command): boolean {
  return runCommand(editor, command);
}

export interface TableMenuEntryOptions {
  /** Opens the column width dialog (default: the table controls' dialog, tables/controls.ts). */
  onColumnWidth?: () => void;
  /** Outside a table: opens the table size picker (default: the 'insertTable' keymap request). */
  onInsertTable?: () => void;
  /** Runs after every action (e.g. to put the focus back into the editor). */
  afterAction?: () => void;
}

export function tableMenuEntries(
  editor: Editor,
  ctx: TableMenuContext,
  { onColumnWidth = () => void openColumnWidthDialog(editor.view), onInsertTable, afterAction }: TableMenuEntryOptions = {},
): MenuEntry[] {
  const run = (command: Command) => () => {
    runTableCommand(editor, command);
    afterAction?.();
  };
  const item = (action: TableAction) => ({ id: action.id, label: action.label, icon: action.icon, disabled: !ctx.can[action.can], onSelect: run(action.command) });
  if (!ctx.inTable) {
    return [
      {
        id: 'insert-table',
        label: 'Insert table…',
        icon: 'table',
        disabled: !ctx.canInsertTable,
        onSelect: onInsertTable ?? (() => void emitKeymapRequest(editor, 'insertTable')),
      },
    ];
  }
  const [rowBefore, rowAfter, rowDelete] = TABLE_ROW_ACTIONS as [TableAction, TableAction, TableAction];
  const [colBefore, colAfter, colDelete] = TABLE_COLUMN_ACTIONS as [TableAction, TableAction, TableAction];
  return [
    {
      type: 'group',
      id: 'rows',
      label: 'Rows',
      items: [
        item(rowBefore),
        item(rowAfter),
        {
          id: 'row-header',
          type: 'checkbox',
          label: 'Header row',
          checked: ctx.headerRow,
          onCheckedChange: (on) => {
            runTableCommand(editor, setHeaderRows(on));
            afterAction?.();
          },
        },
        item(rowDelete),
      ],
    },
    {
      type: 'group',
      id: 'columns',
      label: 'Columns',
      items: [
        item(colBefore),
        item(colAfter),
        { id: 'col-width', label: ctx.columnWidth ? `Column width (${ctx.columnWidth}px)…` : 'Column width…', onSelect: onColumnWidth },
        { id: 'col-reset', label: 'Automatic column widths', disabled: !ctx.can.resetColumnWidths, onSelect: run(resetColumnWidths) },
        item(colDelete),
      ],
    },
    { type: 'group', id: 'cells', label: 'Cells', items: TABLE_CELL_ACTIONS.map(item) },
    {
      type: 'group',
      id: 'style',
      label: 'Table style',
      items: TABLE_CLASSES.map((cls) => ({
        id: `class-${cls}`,
        type: 'checkbox' as const,
        label: TABLE_CLASS_LABELS[cls],
        checked: ctx.classes[cls],
        onCheckedChange: () => {
          runTableCommand(editor, toggleTableClass(cls));
          afterAction?.();
        },
      })),
    },
    { type: 'separator', id: 'sep' },
    item(DELETE_TABLE_ACTION),
  ];
}
