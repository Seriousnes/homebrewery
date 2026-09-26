// Icon picker (P5.5): a dialog that searches the four icon fonts (Dice, Elderberry Inn, Game
// Icons, Font Awesome) and inserts the chosen icon. The search field is a combobox: ArrowDown /
// ArrowUp move through the results (aria-activedescendant), Enter inserts, typing keeps
// filtering; the results can also be clicked.
import type { Editor } from '@tiptap/core';
import { useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Dialog, IconButton, Select, TextField } from '@/ui';
import { ICON_SETS, iconClasses, searchIcons, type IconEntry, type IconSetId } from '../../icons/catalog';
import { insertIcon } from '../../icons/extension';
import styles from './iconPicker.module.css';

/** Results shown at once; the count says how many more matched. */
const RESULT_LIMIT = 240;

export interface IconPickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called with the chosen icon; the dialog closes. */
  onPick: (icon: IconEntry) => void;
  /** Initial search text. */
  initialQuery?: string;
}

export function IconPicker({ open, onOpenChange, onPick, initialQuery = '' }: IconPickerProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Insert icon" size="lg" data-testid="icon-picker">
      {open ? <IconPickerBody onPick={onPick} initialQuery={initialQuery} onClose={() => onOpenChange(false)} /> : null}
    </Dialog>
  );
}

function IconPickerBody({ onPick, initialQuery, onClose }: { onPick: (icon: IconEntry) => void; initialQuery: string; onClose: () => void }) {
  const [query, setQuery] = useState(initialQuery);
  const [set, setSet] = useState<IconSetId | ''>('');
  const [active, setActive] = useState(0);
  const listId = useId();
  const listRef = useRef<HTMLUListElement>(null);
  const { results, total } = useMemo(() => searchIcons(query, { set: set || null, limit: RESULT_LIMIT }), [query, set]);
  const current = Math.min(active, Math.max(0, results.length - 1));
  const optionId = (i: number) => `${listId}-o${i}`;

  const choose = (icon: IconEntry | undefined) => {
    if (!icon) return;
    onPick(icon);
    onClose();
  };

  const move = (to: number) => {
    if (results.length === 0) return;
    const next = Math.max(0, Math.min(results.length - 1, to));
    setActive(next);
    listRef.current?.querySelector(`#${CSS.escape(optionId(next))}`)?.scrollIntoView?.({ block: 'nearest' });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    const columns = columnCount(listRef.current);
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        move(current + (e.altKey ? 1 : columns));
        return;
      case 'ArrowUp':
        e.preventDefault();
        move(current - (e.altKey ? 1 : columns));
        return;
      case 'PageDown':
        e.preventDefault();
        move(current + columns * 4);
        return;
      case 'PageUp':
        e.preventDefault();
        move(current - columns * 4);
        return;
      case 'Enter':
        e.preventDefault();
        choose(results[current]);
        return;
      default:
    }
  };

  const countText =
    total === 0 ? 'No icons match.' : total > results.length ? `Showing ${results.length} of ${total} icons. Refine the search to see more.` : `${total} icon${total === 1 ? '' : 's'}`;

  return (
    <div className={styles.picker}>
      <div className={styles.filters}>
        <TextField
          className={styles.search}
          label="Search icons"
          hint="Arrow keys choose, Enter inserts."
          value={query}
          autoComplete="off"
          spellCheck={false}
          data-autofocus=""
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={results.length ? optionId(current) : undefined}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
          data-testid="icon-search"
        />
        <Select
          label="Icon font"
          value={set}
          options={[{ value: '', label: 'All icon fonts' }, ...ICON_SETS.map((s) => ({ value: s.id, label: s.label }))]}
          onChange={(e) => {
            setSet(e.target.value as IconSetId | '');
            setActive(0);
          }}
          data-testid="icon-set"
        />
      </div>
      <p className={styles.count} aria-live="polite" data-testid="icon-count">
        {countText}
      </p>
      <ul ref={listRef} id={listId} role="listbox" aria-label="Icons" className={styles.results} data-testid="icon-results">
        {results.map((icon, i) => (
          <li
            key={icon.name}
            id={optionId(i)}
            role="option"
            aria-selected={i === current}
            className={styles.result}
            data-icon={icon.name}
            title={`:${icon.name}:`}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => choose(icon)}
          >
            <span className={`${styles.glyph} hb-canvas`} aria-hidden="true">
              <i className={iconClasses(icon)} />
            </span>
            <span className={styles.resultLabel}>{icon.label}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Columns of the results grid (items sharing the first item's top). */
function columnCount(list: HTMLElement | null): number {
  const items = list ? Array.from(list.children) : [];
  const first = items[0]?.getBoundingClientRect().top;
  if (first === undefined) return 1;
  let n = 0;
  for (const item of items) {
    if (Math.abs(item.getBoundingClientRect().top - first) > 1) break;
    n++;
  }
  return Math.max(1, n);
}

export interface IconPickerButtonProps {
  editor: Editor | null;
  disabled?: boolean;
}

/** Toolbar button that opens the picker and inserts the icon at the selection. */
export function IconPickerButton({ editor, disabled }: IconPickerButtonProps) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <IconButton
        icon="insert"
        label="Insert icon"
        disabled={disabled || !editor}
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        data-testid="insert-icon"
      />
      <IconPicker
        open={open}
        onOpenChange={setOpen}
        onPick={(icon) => {
          if (!editor || editor.isDestroyed) return;
          insertIcon(icon)(editor.state, editor.view.dispatch);
          // After the dialog returns focus to the button.
          requestAnimationFrame(() => editor.view.focus());
        }}
      />
    </>
  );
}
