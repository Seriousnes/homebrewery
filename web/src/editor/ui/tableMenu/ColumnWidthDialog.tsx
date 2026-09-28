// The column width dialog of the table UI: a pixel width for the selected columns (colwidth), or
// "Automatic" to clear it. Used by the TableMenu and the table controls.
import type { Editor } from '@tiptap/core';
import { useState, type FormEvent } from 'react';
import { Button, Dialog, TextField } from '@/ui';
import { setColumnWidth } from '../../tables/commands';
import { runTableCommand } from './tableMenuEntries';
import styles from './tableMenu.module.css';

export interface ColumnWidthDialogProps {
  editor: Editor;
  /** Open with the width of the selected columns when it opened (null: automatic); null = closed. */
  initial: { width: number | null } | null;
  onClose: () => void;
}

export function ColumnWidthDialog({ editor, initial, onClose }: ColumnWidthDialogProps) {
  const open = initial !== null;
  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onClose())} title="Column width" size="sm" data-testid="column-width-dialog">
      {open ? (
        <ColumnWidthForm
          initial={initial.width}
          onDone={(width) => {
            onClose();
            if (width !== undefined && !editor.isDestroyed) runTableCommand(editor, setColumnWidth(width));
            requestAnimationFrame(() => {
              if (!editor.isDestroyed) editor.view.focus();
            });
          }}
        />
      ) : null}
    </Dialog>
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
