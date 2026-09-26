// TagInput, ported from legacy/client/homebrew/editor/tagInput/tagInput.jsx: a combobox to add
// values (typed text, or a suggestion) and a list of chips. A chip's text is a button that edits
// it in place (Enter saves, Escape cancels, leaving the field saves a valid change); its x button
// removes it. The metadata dialog uses it for tags and for invited authors.
//
// Differences from upstream: invalid input shows an inline error instead of the browser's
// validation bubble; focus moves to a sensible place after a chip is removed or edited; the value
// list is controlled (onChange gets the new list, upstream reported it from an effect).
import clsx from 'clsx';
import { type KeyboardEvent, type ReactNode, useId, useMemo, useRef, useState } from 'react';
import { IconButton } from '@/ui';
import { Combobox } from './Combobox';
import type { ComboboxOption } from './comboboxModel';
import styles from './TagInput.module.css';

export interface TagInputProps {
  /** The field's label, e.g. "Tags". */
  label: string;
  values: readonly string[];
  /** The whole new list after an add, edit or remove. */
  onChange: (values: string[]) => void;
  /** Offered while typing (values already in the list are left out). */
  suggestions?: readonly ComboboxOption[];
  /** Why `raw` can't be added (index set when editing that chip); null when it can. */
  validate?: (raw: string, values: readonly string[], context: { index?: number; suggested: boolean }) => string | null;
  /** Turns accepted input into the stored value (default: trimmed). */
  normalize?: (raw: string) => string;
  /** Styling hook per value (data-tone on the chip), e.g. a tag's type. */
  toneOf?: (value: string) => string | undefined;
  /** Used in button names: "Remove tag dragons", "Edit tag dragons". */
  itemName?: string;
  placeholder?: string;
  hint?: ReactNode;
  /** An error from outside (the server); a local validation error takes precedence. */
  error?: ReactNode;
  /** Show the values without editing controls. */
  readOnly?: boolean;
  /** Filter mode for suggestions (default 'startsWith', as upstream). */
  filter?: 'startsWith' | 'includes';
  className?: string;
  'data-testid'?: string;
}

const trim = (raw: string) => raw.trim();

export function TagInput({
  label,
  values,
  onChange,
  suggestions = [],
  validate,
  normalize = trim,
  toneOf,
  itemName = 'item',
  placeholder,
  hint,
  error,
  readOnly = false,
  filter = 'startsWith',
  className,
  'data-testid': testId,
}: TagInputProps) {
  const [draft, setDraft] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ index: number; text: string; problem: string | null } | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listLabelId = useId();

  const available = useMemo(() => {
    const taken = new Set(values.map((v) => v.toLowerCase()));
    return suggestions.filter((s) => !taken.has(s.value.toLowerCase()));
  }, [suggestions, values]);

  /**
   * Focus the chip button at `index` (clamped), or the text box when the list is empty, after
   * React rendered. Skipped when focus moved on meanwhile (e.g. a quick click opened an edit).
   */
  const focusChip = (index: number) => {
    const from = document.activeElement;
    requestAnimationFrame(() => {
      const active = document.activeElement;
      if (active && active !== from && active !== document.body) return;
      const buttons = listRef.current?.querySelectorAll<HTMLButtonElement>('[data-chip-edit]');
      const target = buttons && buttons.length > 0 ? buttons[Math.max(0, Math.min(index, buttons.length - 1))] : inputRef.current;
      target?.focus();
    });
  };

  const add = (raw: string, suggested: boolean) => {
    const reason = validate?.(raw, values, { suggested }) ?? (raw.trim() ? null : 'Enter a value.');
    if (reason) {
      setProblem(reason);
      return;
    }
    const value = normalize(raw);
    if (values.some((v) => v.toLowerCase() === value.toLowerCase())) {
      setProblem('That value is already in the list.');
      return;
    }
    setProblem(null);
    setDraft('');
    onChange([...values, value]);
  };

  const remove = (index: number) => {
    onChange(values.filter((_, i) => i !== index));
    focusChip(index);
  };

  const commitEdit = (keepFocus: boolean) => {
    if (!editing) return;
    const { index, text } = editing;
    const current = values[index];
    if (current === undefined || text.trim() === current) {
      setEditing(null);
      if (keepFocus) focusChip(index);
      return;
    }
    const reason = validate?.(text, values, { index, suggested: false }) ?? (text.trim() ? null : 'Enter a value.');
    if (reason) {
      if (keepFocus) setEditing({ index, text, problem: reason });
      else setEditing(null); // leaving the field with an invalid change drops it
      return;
    }
    const value = normalize(text);
    if (values.some((v, i) => i !== index && v.toLowerCase() === value.toLowerCase())) {
      if (keepFocus) setEditing({ index, text, problem: 'That value is already in the list.' });
      else setEditing(null);
      return;
    }
    setEditing(null);
    onChange(values.map((v, i) => (i === index ? value : v)));
    if (keepFocus) focusChip(index);
  };

  const onEditKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || !editing) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      commitEdit(true);
    } else if (event.key === 'Escape') {
      // Keep the dialog open: this Escape only cancels the edit.
      event.preventDefault();
      event.stopPropagation();
      const { index } = editing;
      setEditing(null);
      focusChip(index);
    }
  };

  const shownError = problem ?? error;

  return (
    <div className={clsx(styles.tagInput, className)} data-testid={testId}>
      {readOnly ? (
        <span id={listLabelId} className={styles.readOnlyLabel}>
          {label}
        </span>
      ) : (
        <Combobox
          label={label}
          value={draft}
          onValueChange={(text) => {
            setDraft(text);
            if (problem) setProblem(null);
          }}
          options={available}
          filter={filter}
          onSelect={(option) => add(option.value, true)}
          onCommit={(text) => add(text, false)}
          placeholder={placeholder}
          hint={hint}
          error={shownError}
          showToggle={available.length > 0}
          inputRef={inputRef}
          className={styles.combobox}
        />
      )}
      {values.length > 0 ? (
        <ul ref={listRef} className={styles.list} aria-label={readOnly ? undefined : `${label}: ${values.length}`} aria-labelledby={readOnly ? listLabelId : undefined}>
          {values.map((value, index) =>
            editing?.index === index ? (
              <li key={`edit-${index}`} className={styles.editing}>
                <input
                  // A fresh text box for the edit: focus it right away.
                  autoFocus
                  type="text"
                  className={styles.editInput}
                  aria-label={`Edit ${itemName} ${value}`}
                  aria-invalid={editing.problem ? true : undefined}
                  aria-describedby={editing.problem ? `${listLabelId}-edit-error` : undefined}
                  value={editing.text}
                  onFocus={(event) => event.currentTarget.select()}
                  onChange={(event) => setEditing({ index, text: event.target.value, problem: null })}
                  onKeyDown={onEditKeyDown}
                  onBlur={() => commitEdit(false)}
                />
                {editing.problem ? (
                  <span id={`${listLabelId}-edit-error`} className={styles.editError} role="alert">
                    {editing.problem}
                  </span>
                ) : null}
              </li>
            ) : (
              <li key={`${value}-${index}`} className={styles.chip} data-tone={toneOf?.(value)}>
                {readOnly ? (
                  <span className={styles.chipText}>{value}</span>
                ) : (
                  <>
                    <button
                      type="button"
                      data-chip-edit=""
                      className={styles.chipText}
                      aria-label={`Edit ${itemName} ${value}`}
                      onClick={() => setEditing({ index, text: value, problem: null })}
                    >
                      {value}
                    </button>
                    <IconButton
                      icon="close"
                      size="sm"
                      label={`Remove ${itemName} ${value}`}
                      tooltip={false}
                      className={styles.remove}
                      onClick={() => remove(index)}
                    />
                  </>
                )}
              </li>
            ),
          )}
        </ul>
      ) : readOnly ? (
        <p className={styles.none}>None</p>
      ) : null}
    </div>
  );
}
