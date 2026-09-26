import { type ChangeEvent, type FormEvent, type KeyboardEvent, useId, useMemo, useRef, useState } from 'react';
import { Button, Dialog, IconButton, TextField } from '@/ui';
import { classProblem, parseClassInput } from '../../commands/marks';
import styles from './ClassPicker.module.css';
import { type ClassPickerMode, suggestClasses, type ThemeClass } from './themeClasses';

/**
 * How many suggestions the list shows (the best matches; typing narrows them). The list never
 * scrolls: its options are reached through aria-activedescendant, so a scrolling box would hold
 * nothing focusable (axe scrollable-region-focusable).
 */
export const MAX_SUGGESTIONS = 12;

export interface ClassPickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 'span': classes for a span mark (Mod-M); 'themeBlock': wrap blocks (Shift-Mod-M). */
  mode: ClassPickerMode;
  /** The classes the picker starts with (the edited span's). */
  initialClasses?: readonly string[];
  /** Editing an existing span (changes the title and the apply button). */
  editing?: boolean;
  /** Classes of the theme stylesheets (collectThemeClasses). */
  suggestions: readonly ThemeClass[];
  onApply: (classes: string[]) => void;
  /** Shown as a secondary action: remove the span, or unwrap the enclosing theme block. */
  onRemove?: () => void;
  removeLabel?: string;
  'data-testid'?: string;
}

const TEXT: Record<ClassPickerMode, { title: string; editTitle: string; description: string; apply: string; editApply: string }> = {
  span: {
    title: 'Style the selection with classes',
    editTitle: 'Edit the span’s classes',
    description: 'The text gets a span with these classes, like {{class text}}. Classes come from the theme and the brew’s style.',
    apply: 'Apply span',
    editApply: 'Save classes',
  },
  themeBlock: {
    title: 'Wrap in a theme block',
    editTitle: 'Wrap in a theme block',
    description: 'The selected blocks go into a block with these classes, like {{note …}}. Classes come from the theme and the brew’s style.',
    apply: 'Wrap',
    editApply: 'Wrap',
  },
};

/**
 * The class picker (plan §6.1): a modal dialog with the chosen classes as removable chips and a
 * searchable list of the theme's classes. The field is a combobox: ArrowUp/ArrowDown move through
 * the suggestions, Enter adds the highlighted one or what was typed (Space and comma also add a
 * typed class), Enter on an empty field applies, Backspace on an empty field removes the last
 * class, Escape closes. Unmount it closed (Dialog does).
 */
export function ClassPicker(props: ClassPickerProps) {
  return props.open ? <ClassPickerContent {...props} /> : null;
}

function ClassPickerContent({
  onOpenChange,
  mode,
  initialClasses = [],
  editing = false,
  suggestions,
  onApply,
  onRemove,
  removeLabel,
  'data-testid': testId,
}: ClassPickerProps) {
  const [classes, setClasses] = useState<string[]>(() => [...initialClasses]);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(-1);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const formId = useId();
  const listId = useId();
  const optionId = (i: number) => `${listId}-option-${i}`;
  const text = TEXT[mode];

  const matches = useMemo(() => suggestClasses(suggestions, query, mode, classes), [suggestions, query, mode, classes]);
  const shown = matches.slice(0, MAX_SUGGESTIONS);
  const activeIndex = active >= 0 && active < shown.length ? active : -1;

  /** Adds classes; returns false (and shows why) when one is invalid. */
  const add = (names: readonly string[]): boolean => {
    for (const name of names) {
      const problem = classProblem(name);
      if (problem) {
        setError(problem);
        return false;
      }
    }
    setClasses((current) => [...current, ...names.filter((n, i) => !current.includes(n) && names.indexOf(n) === i)]);
    setQuery('');
    setActive(-1);
    setError(null);
    return true;
  };

  const remove = (name: string) => {
    setClasses((current) => current.filter((c) => c !== name));
    inputRef.current?.focus();
  };

  const onChange = (event: ChangeEvent<HTMLInputElement>) => {
    const value = event.target.value;
    setError(null);
    // Space or comma after a name adds it (like a tag field).
    if (/[\s,]$/.test(value) && value.trim() !== '') {
      if (!add(parseClassInput(value))) setQuery(value.trim());
      return;
    }
    setQuery(value.replace(/^[\s,]+/, ''));
    setActive(-1);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (shown.length === 0) return;
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      const next = activeIndex < 0 ? (step > 0 ? 0 : shown.length - 1) : (activeIndex + step + shown.length) % shown.length;
      setActive(next);
    } else if (event.key === 'Enter') {
      if (activeIndex >= 0) {
        event.preventDefault();
        add([shown[activeIndex]!.name]);
      } else if (query.trim() !== '') {
        event.preventDefault();
        add(parseClassInput(query));
      }
      // An empty field: the form submits (applies).
    } else if (event.key === 'Backspace' && query === '' && classes.length > 0) {
      event.preventDefault();
      setClasses((current) => current.slice(0, -1));
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const pending = parseClassInput(query);
    if (pending.length > 0) {
      const problem = pending.map(classProblem).find((p) => p !== null);
      if (problem) {
        setError(problem);
        return;
      }
    }
    const all = [...classes, ...pending.filter((n) => !classes.includes(n))];
    onApply(all);
    onOpenChange(false);
  };

  const countText = query.trim() === '' ? `${matches.length} theme classes` : `${matches.length} matching ${matches.length === 1 ? 'class' : 'classes'}`;

  return (
    <Dialog
      open
      onOpenChange={onOpenChange}
      title={editing ? text.editTitle : text.title}
      description={text.description}
      initialFocusRef={inputRef}
      size="md"
      data-testid={testId}
      footer={
        <div className={styles.footer}>
          {onRemove ? (
            <Button
              variant="ghost"
              onClick={() => {
                onRemove();
                onOpenChange(false);
              }}
              data-testid={testId ? `${testId}-remove` : undefined}
            >
              {removeLabel ?? (mode === 'span' ? 'Remove span' : 'Unwrap block')}
            </Button>
          ) : null}
          <span className={styles.spacer} />
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form={formId} data-testid={testId ? `${testId}-apply` : undefined}>
            {editing ? text.editApply : text.apply}
          </Button>
        </div>
      }
    >
      <form id={formId} onSubmit={submit} className={styles.form} noValidate>
        <div className={styles.chosen}>
          <span className={styles.chosenLabel} id={`${listId}-chosen`}>
            Classes
          </span>
          {classes.length === 0 ? (
            <span className={styles.none}>{mode === 'span' ? 'None (a plain span)' : 'None (a plain block)'}</span>
          ) : (
            <ul className={styles.chips} aria-labelledby={`${listId}-chosen`} data-testid={testId ? `${testId}-chosen` : undefined}>
              {classes.map((name) => (
                <li key={name} className={styles.chip}>
                  <span className={styles.chipName}>{name}</span>
                  <IconButton icon="close" size="sm" label={`Remove class ${name}`} tooltip={false} onClick={() => remove(name)} className={styles.chipRemove} />
                </li>
              ))}
            </ul>
          )}
        </div>
        <TextField
          ref={inputRef}
          label="Add a class"
          hint="Type to search; Enter, Space or comma adds it. Enter on an empty field applies."
          error={error ?? undefined}
          value={query}
          onChange={onChange}
          onKeyDown={onKeyDown}
          role="combobox"
          aria-expanded={shown.length > 0}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={activeIndex >= 0 ? optionId(activeIndex) : undefined}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          data-testid={testId ? `${testId}-input` : undefined}
        />
        <div className={styles.listFrame}>
          <ul id={listId} role="listbox" aria-label="Theme classes" className={styles.list} data-testid={testId ? `${testId}-options` : undefined}>
            {shown.map((c, i) => (
              <li
                key={c.name}
                id={optionId(i)}
                role="option"
                aria-selected={i === activeIndex}
                className={styles.option}
                data-active={i === activeIndex || undefined}
                // Keep the focus (and the caret) in the field.
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  add([c.name]);
                  inputRef.current?.focus();
                }}
                onMouseMove={() => setActive(i)}
              >
                <span className={styles.optionName}>{c.name}</span>
                {(mode === 'span' ? c.inline : c.block) ? <span className={styles.optionHint}>{mode === 'span' ? 'on spans' : 'on blocks'}</span> : null}
              </li>
            ))}
          </ul>
          {shown.length === 0 ? (
            <p className={styles.empty}>{query.trim() ? `No theme class matches “${query.trim()}”. Enter adds it anyway.` : 'The theme has no classes to suggest.'}</p>
          ) : null}
        </div>
        <p className={styles.count} role="status" aria-live="polite">
          {countText}
          {matches.length > shown.length ? `, showing the first ${shown.length}: type to narrow them` : ''}
        </p>
      </form>
    </Dialog>
  );
}
