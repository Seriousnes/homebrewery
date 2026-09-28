// The insert-table size picker's model (TableSizePicker.tsx): grid size, limits, keyboard moves.

export const PICKER_ROWS = 10;
export const PICKER_COLS = 8;
export const MAX_ROWS = 100;
export const MAX_COLS = 20;
/** The size the picker starts at (the old fixed table). */
export const DEFAULT_SIZE: TableSize = { rows: 3, cols: 3 };

export interface TableSize {
  rows: number;
  cols: number;
}

export interface TablePick extends TableSize {
  /** Leading header rows: 1 or 0. */
  headerRows: number;
}

/** The grid cell an arrow key (Home, End, PageUp, PageDown) moves to; null for other keys. */
export function moveGridCell(size: TableSize, key: string): TableSize | null {
  const clampRows = (n: number) => Math.min(PICKER_ROWS, Math.max(1, n));
  const clampCols = (n: number) => Math.min(PICKER_COLS, Math.max(1, n));
  switch (key) {
    case 'ArrowRight':
      return { rows: size.rows, cols: clampCols(size.cols + 1) };
    case 'ArrowLeft':
      return { rows: size.rows, cols: clampCols(size.cols - 1) };
    case 'ArrowDown':
      return { rows: clampRows(size.rows + 1), cols: size.cols };
    case 'ArrowUp':
      return { rows: clampRows(size.rows - 1), cols: size.cols };
    case 'Home':
      return { rows: size.rows, cols: 1 };
    case 'End':
      return { rows: size.rows, cols: PICKER_COLS };
    case 'PageUp':
      return { rows: 1, cols: size.cols };
    case 'PageDown':
      return { rows: PICKER_ROWS, cols: size.cols };
    default:
      return null;
  }
}

export const sizeLabel = ({ rows, cols }: TableSize): string => `${rows} × ${cols}`;
