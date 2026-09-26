// What the TableMenu offers for an editor state (plain data for useEditorState).
import type { EditorState } from '@tiptap/pm/state';
import {
  addColumnAfter,
  addColumnBefore,
  addRowAfter,
  addRowBefore,
  deleteColumn,
  deleteRow,
  deleteTable,
  isInTable,
  mergeCells,
  splitCell,
} from '@tiptap/pm/tables';
import { insertTable, isHeaderRowSelected, resetColumnWidths, selectedColumnWidth, tableClasses, type TableClass } from '../../tables/commands';

export interface TableMenuContext {
  inTable: boolean;
  canInsertTable: boolean;
  can: {
    addRowBefore: boolean;
    addRowAfter: boolean;
    deleteRow: boolean;
    addColumnBefore: boolean;
    addColumnAfter: boolean;
    deleteColumn: boolean;
    mergeCells: boolean;
    splitCell: boolean;
    deleteTable: boolean;
    resetColumnWidths: boolean;
  };
  headerRow: boolean;
  columnWidth: number | null;
  classes: Record<TableClass, boolean>;
}

export function tableMenuContext(state: EditorState): TableMenuContext {
  const inTable = isInTable(state);
  return {
    inTable,
    canInsertTable: !inTable && insertTable()(state),
    can: {
      addRowBefore: inTable && addRowBefore(state),
      addRowAfter: inTable && addRowAfter(state),
      deleteRow: inTable && deleteRow(state),
      addColumnBefore: inTable && addColumnBefore(state),
      addColumnAfter: inTable && addColumnAfter(state),
      deleteColumn: inTable && deleteColumn(state),
      mergeCells: inTable && mergeCells(state),
      splitCell: inTable && splitCell(state),
      deleteTable: inTable && deleteTable(state),
      resetColumnWidths: inTable && resetColumnWidths(state),
    },
    headerRow: inTable && isHeaderRowSelected(state),
    columnWidth: inTable ? selectedColumnWidth(state) : null,
    classes: tableClasses(state),
  };
}
