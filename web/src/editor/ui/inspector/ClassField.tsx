import { clsx } from 'clsx';
import { type KeyboardEvent, useId, useLayoutEffect, useRef, useState } from 'react';
import type { EditResult } from '@/editor/commands/attrs';
import { Icon, IconButton, Portal, useDismiss, useFloating } from '@/ui';
import { useAnnounce } from './announce';
import type { ClassSuggester } from './classNames';
import styles from './Inspector.module.css';

export interface ClassFieldProps {
  /** Group label, e.g. "Classes". */
  label: string;
  /** Accessible name of the text box, e.g. "Add class". */
  addLabel?: string;
  classes: readonly string[];
  /**
   * Called when the text box gets focus (the theme's sheets may have changed since): returns the
   * suggester used while typing.
   */
  suggestions: () => ClassSuggester;
  /** Validates and applies the typed class names (one undo step). */
  onAdd: (text: string) => EditResult;
  /** Removes one class (one undo step). */
  onRemove: (name: string) => EditResult;
  'data-testid'?: string;
}

/**
 * Applied classes as removable chips, plus a combobox (ARIA 1.2 list autocomplete) that adds
 * classes: type one or more names (spaces, commas or dots separate them), or pick a suggestion
 * with the arrow keys and Enter.
 */
export function ClassField({ label, addLabel = 'Add class', classes, suggestions, onAdd, onRemove, 'data-testid': testId }: ClassFieldProps) {
  const id = useId();
  const labelId = `${id}-label`;
  const listId = `${id}-list`;
  const errorId = `${id}-error`;
  const optionId = (i: number) => `${id}-opt-${i}`;
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const chipRefs = useRef(new Map<string, HTMLButtonElement>());
  const [text, setText] = useState('');
  const [suggester, setSuggester] = useState<{ suggest: ClassSuggester } | null>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [error, setError] = useState<string | null>(null);
  /** After a chip is removed: the class whose chip takes focus next ('' = the text box). */
  const focusAfterRemove = useRef<string | null>(null);
  const announce = useAnnounce();

  // The name being typed: the last one (names are separated like parseClassInput does it).
  const options = open && suggester ? suggester.suggest(text.split(/[\s,.]+/).at(-1) ?? '', classes) : [];
  const expanded = open && options.length > 0;

  useFloating(expanded, inputRef, listRef, { placement: 'bottom-start', matchAnchorWidth: true, offset: 2 });
  useDismiss(expanded, { floatingRef: listRef, anchorRef: inputRef, onDismiss: () => setOpen(false), escape: false });

  // Keep the active option visible while arrowing through a long list.
  useLayoutEffect(() => {
    if (active >= 0) document.getElementById(optionId(active))?.scrollIntoView?.({ block: 'nearest' });
  });

  // After a chip is removed (the new class list is rendered), focus the chip that took its place.
  useLayoutEffect(() => {
    const next = focusAfterRemove.current;
    if (next === null) return;
    focusAfterRemove.current = null;
    const target = next === '' ? inputRef.current : chipRefs.current.get(next);
    (target ?? inputRef.current)?.focus();
  }, [classes]);

  const fail = (message: string) => {
    setError(message);
    announce(`${label}: ${message}`);
  };

  const add = (value: string) => {
    const result = onAdd(value);
    if (!result.ok) {
      fail(result.error);
      return;
    }
    setText('');
    setOpen(false);
    setActive(-1);
    setError(null);
  };

  /** Adds the typed names, with the name being typed replaced by the picked suggestion. */
  const pick = (name: string) => {
    const parts = text.split(/([\s,.]+)/);
    parts[parts.length - 1] = name;
    add(parts.join(''));
    inputRef.current?.focus();
  };

  const remove = (name: string, index: number) => {
    const result = onRemove(name);
    if (!result.ok) {
      fail(result.error);
      return;
    }
    focusAfterRemove.current = classes[index + 1] ?? classes[index - 1] ?? '';
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    switch (event.key) {
      case 'ArrowDown': {
        event.preventDefault();
        if (!open) {
          setOpen(true);
          setActive(0);
        } else if (options.length) setActive((a) => (a + 1) % options.length);
        break;
      }
      case 'ArrowUp': {
        if (!expanded) return;
        event.preventDefault();
        setActive((a) => (a <= 0 ? options.length - 1 : a - 1));
        break;
      }
      case 'Enter': {
        event.preventDefault();
        const option = expanded && active >= 0 ? options[active] : undefined;
        if (option !== undefined) pick(option);
        else if (text.trim()) add(text);
        break;
      }
      case 'Escape': {
        if (expanded) {
          event.preventDefault();
          event.stopPropagation();
          setOpen(false);
          setActive(-1);
        } else if (text) {
          event.preventDefault();
          event.stopPropagation();
          setText('');
          setError(null);
        }
        break;
      }
      case 'Tab':
        setOpen(false);
        break;
    }
  };

  return (
    <div role="group" aria-labelledby={labelId} className={styles.field} data-testid={testId}>
      <span id={labelId} className={styles.fieldLabel}>
        {label}
      </span>
      {classes.length > 0 ? (
        <ul className={styles.chips} aria-labelledby={labelId}>
          {classes.map((name, index) => (
            <li key={name} className={styles.chip}>
              <span className={styles.chipText}>{name}</span>
              <button
                type="button"
                ref={(el) => {
                  if (el) chipRefs.current.set(name, el);
                  else chipRefs.current.delete(name);
                }}
                className={styles.chipRemove}
                aria-label={`Remove class ${name}`}
                title={`Remove ${name}`}
                onClick={() => remove(name, index)}
              >
                <Icon name="close" size={12} />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className={styles.none}>None</p>
      )}
      <div className={styles.comboRow}>
        <input
          ref={inputRef}
          type="text"
          role="combobox"
          aria-label={addLabel}
          aria-autocomplete="list"
          aria-expanded={expanded}
          aria-controls={listId}
          aria-activedescendant={expanded && active >= 0 ? optionId(active) : undefined}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          autoComplete="off"
          spellCheck={false}
          placeholder={`${addLabel}…`}
          className={styles.comboInput}
          value={text}
          data-testid={testId ? `${testId}-input` : undefined}
          onFocus={() => setSuggester({ suggest: suggestions() })}
          onChange={(event) => {
            setText(event.target.value);
            setOpen(event.target.value.trim() !== '');
            setActive(-1);
            setError(null);
          }}
          onKeyDown={onKeyDown}
        />
        <IconButton
          icon="plus"
          size="sm"
          label={addLabel}
          tooltip={false}
          onClick={() => {
            if (text.trim()) add(text);
            else inputRef.current?.focus();
          }}
        />
      </div>
      {error ? (
        <p id={errorId} className={styles.error}>
          <Icon name="error" size={14} />
          {error}
        </p>
      ) : null}
      {/* Always in the DOM (hidden when closed), so aria-controls points at an element. */}
      <Portal>
        <ul
          ref={listRef}
          id={listId}
          role="listbox"
          aria-label={`${label} suggestions`}
          className={clsx(styles.listbox, !expanded && styles.hidden)}
          hidden={!expanded}
          data-testid={testId ? `${testId}-list` : undefined}
        >
          {options.map((name, i) => (
            <li
              key={name}
              id={optionId(i)}
              role="option"
              aria-selected={i === active}
              className={clsx(styles.option, i === active && styles.optionActive)}
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => pick(name)}
            >
              {name}
            </li>
          ))}
        </ul>
      </Portal>
    </div>
  );
}
