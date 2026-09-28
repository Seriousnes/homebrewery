// The insert-table size picker (T3): a grid of cells to pick rows × columns with the pointer or
// the arrow keys (Enter inserts), number fields for sizes beyond the grid, and a header row
// option. The TableMenu shows it in a popover (its button outside a table, and the 'insertTable'
// keymap request).
import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Button, Checkbox, TextField } from '@/ui';
import styles from './tableMenu.module.css';
import { DEFAULT_SIZE, MAX_COLS, MAX_ROWS, moveGridCell, PICKER_COLS, PICKER_ROWS, sizeLabel, type TablePick, type TableSize } from './tableSize';

export interface TableSizePickerProps {
  onPick: (pick: TablePick) => void;
}

export function TableSizePicker({ onPick }: TableSizePickerProps) {
  const [size, setSize] = useState<TableSize>(DEFAULT_SIZE);
  const [header, setHeader] = useState(true);
  const [rowsText, setRowsText] = useState(String(DEFAULT_SIZE.rows));
  const [colsText, setColsText] = useState(String(DEFAULT_SIZE.cols));
  const [error, setError] = useState<string>();
  const gridRef = useRef<HTMLDivElement>(null);
  const focusGrid = useRef(false);
  const labelId = useId();

  const choose = (next: TableSize, focus: boolean) => {
    setSize(next);
    setRowsText(String(next.rows));
    setColsText(String(next.cols));
    setError(undefined);
    focusGrid.current = focus;
  };

  // Keyboard moves take the focus along (roving tab stop).
  useEffect(() => {
    if (!focusGrid.current) return;
    focusGrid.current = false;
    gridRef.current?.querySelector<HTMLElement>('[tabindex="0"]')?.focus();
  }, [size]);

  const pick = (s: TableSize) => onPick({ ...s, headerRows: header ? 1 : 0 });

  const onGridKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      pick(size);
      return;
    }
    const next = moveGridCell(size, event.key);
    if (!next) return;
    event.preventDefault();
    choose(next, true);
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const rows = Number(rowsText);
    const cols = Number(colsText);
    if (!Number.isInteger(rows) || !Number.isInteger(cols) || rows < 1 || cols < 1 || rows > MAX_ROWS || cols > MAX_COLS) {
      setError(`Rows from 1 to ${MAX_ROWS}, columns from 1 to ${MAX_COLS}.`);
      return;
    }
    pick({ rows, cols });
  };

  // Cells inside the grid's range of the typed size stay highlighted too.
  const shown = { rows: Math.min(size.rows, PICKER_ROWS), cols: Math.min(size.cols, PICKER_COLS) };
  const rows = Array.from({ length: PICKER_ROWS }, (_, r) => r + 1);
  const cols = Array.from({ length: PICKER_COLS }, (_, c) => c + 1);

  return (
    <div className={styles.picker} data-testid="table-size-picker">
      <p id={labelId} className={styles.pickerLabel} aria-live="polite" data-testid="table-size-label">
        {sizeLabel(size)} table
      </p>
      <div ref={gridRef} role="grid" aria-labelledby={labelId} aria-describedby={`${labelId}-hint`} className={styles.grid} onKeyDown={onGridKeyDown}>
        {rows.map((r) => (
          <div role="row" key={r} className={styles.gridRow}>
            {cols.map((c) => {
              const active = r === shown.rows && c === shown.cols;
              return (
                <div
                  key={c}
                  role="gridcell"
                  tabIndex={active ? 0 : -1}
                  aria-label={`${r} by ${c}`}
                  aria-selected={r <= shown.rows && c <= shown.cols}
                  data-rows={r}
                  data-cols={c}
                  className={styles.gridCell}
                  onPointerEnter={() => choose({ rows: r, cols: c }, false)}
                  onFocus={() => (active ? undefined : choose({ rows: r, cols: c }, false))}
                  onClick={() => pick({ rows: r, cols: c })}
                />
              );
            })}
          </div>
        ))}
      </div>
      <p id={`${labelId}-hint`} className={styles.pickerHint}>
        Arrow keys choose the size, Enter inserts.
      </p>
      <form className={styles.pickerForm} onSubmit={submit} noValidate>
        <div className={styles.pickerFields}>
          <TextField
            label="Rows"
            type="number"
            min={1}
            max={MAX_ROWS}
            inputMode="numeric"
            value={rowsText}
            onChange={(e) => {
              setRowsText(e.target.value);
              setError(undefined);
              const n = Number(e.target.value);
              if (Number.isInteger(n) && n >= 1) setSize((s) => ({ ...s, rows: n }));
            }}
            data-testid="table-rows-input"
          />
          <TextField
            label="Columns"
            type="number"
            min={1}
            max={MAX_COLS}
            inputMode="numeric"
            value={colsText}
            onChange={(e) => {
              setColsText(e.target.value);
              setError(undefined);
              const n = Number(e.target.value);
              if (Number.isInteger(n) && n >= 1) setSize((s) => ({ ...s, cols: n }));
            }}
            data-testid="table-cols-input"
          />
        </div>
        {error ? (
          <p role="alert" className={styles.pickerError}>
            {error}
          </p>
        ) : null}
        <Checkbox label="Header row" checked={header} onChange={(e) => setHeader(e.target.checked)} data-testid="table-header-input" />
        <div className={styles.actions}>
          <Button type="submit" variant="primary" data-testid="table-insert">
            Insert table
          </Button>
        </div>
      </form>
    </div>
  );
}
