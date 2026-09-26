// An editable combobox with a list popup (WAI-ARIA APG "combobox with listbox popup, list
// autocomplete"). It replaces upstream's @components/combobox.jsx for the tag, language and theme
// fields of the metadata dialog.
//
// Focus stays in the text box; the highlighted option is announced through
// aria-activedescendant. The list is portaled (it must not be clipped by a scrolling dialog body,
// and a popup opened from a modal dialog has to live in a later layer to stay interactive).
//
// Keys: ArrowDown/ArrowUp open the list and move the highlight (wrapping), Alt+ArrowDown opens it
// without moving, Alt+ArrowUp closes it, Enter picks the highlighted option (or commits the typed
// text when nothing is highlighted), Escape closes the list (the dialog behind it stays open),
// Tab closes it without picking. Typing filters the options.
import clsx from 'clsx';
import {
  type FocusEvent,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Icon, Portal, registerEscape, useDismiss, useFloating, VisuallyHidden } from '@/ui';
import styles from './Combobox.module.css';
import { filterOptions, setRef, type ComboboxFilter, type ComboboxOption } from './comboboxModel';

export interface ComboboxProps {
  /** Visible label (or visually hidden with hideLabel). */
  label: ReactNode;
  hideLabel?: boolean;
  hint?: ReactNode;
  error?: ReactNode;
  /** The text in the box (controlled). */
  value: string;
  onValueChange: (text: string) => void;
  options: readonly ComboboxOption[];
  /** An option was picked (click, or Enter on the highlighted one). */
  onSelect: (option: ComboboxOption) => void;
  /** Enter with no highlighted option: the typed text. */
  onCommit?: (text: string) => void;
  onBlur?: (event: FocusEvent<HTMLInputElement>) => void;
  /** How typed text filters options (default 'includes'). */
  filter?: ComboboxFilter;
  /** At most this many options are shown (default 200). */
  maxOptions?: number;
  /** The option shown as current (check mark), e.g. the chosen theme. */
  currentValue?: string;
  placeholder?: string;
  /** Shown in the list when nothing matches (default "No matches"). */
  emptyMessage?: string;
  /** Show a button that opens the whole list (default true). */
  showToggle?: boolean;
  disabled?: boolean;
  id?: string;
  name?: string;
  className?: string;
  inputRef?: Ref<HTMLInputElement>;
  'data-testid'?: string;
}

export function Combobox({
  label,
  hideLabel = false,
  hint,
  error,
  value,
  onValueChange,
  options,
  onSelect,
  onCommit,
  onBlur,
  filter = 'includes',
  maxOptions = 200,
  currentValue,
  placeholder,
  emptyMessage = 'No matches',
  showToggle = true,
  disabled = false,
  id,
  name,
  className,
  inputRef,
  'data-testid': testId,
}: ComboboxProps) {
  const generated = useId();
  const inputId = id ?? `${generated}-input`;
  const labelId = `${generated}-label`;
  const listId = `${generated}-list`;
  const hintId = hint ? `${generated}-hint` : undefined;
  const errorId = error ? `${generated}-error` : undefined;
  const optionId = (index: number) => `${generated}-option-${index}`;

  const [open, setOpen] = useState(false);
  // Text filters the options only once the user has typed it: a box showing the current value
  // (a theme's name, a language code) lists every option. Picking an option or the toggle
  // button resets this.
  const [typed, setTyped] = useState(false);
  const [active, setActive] = useState(-1);
  const anchorRef = useRef<HTMLDivElement>(null);
  const inputEl = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const close = () => {
    setOpen(false);
    setActive(-1);
  };

  const visible = useMemo(() => filterOptions(options, typed ? value : '', filter, maxOptions), [options, typed, value, filter, maxOptions]);
  const activeOption = active >= 0 ? visible[active] : undefined;

  useFloating(open, anchorRef, listRef, { placement: 'bottom-start', offset: 2, matchAnchorWidth: true });
  useDismiss(open, { floatingRef: listRef, anchorRef, onDismiss: () => close(), escape: false, focusOut: false });

  // Escape closes the list first (registered while open: the latest registration wins).
  useEffect(() => {
    if (!open) return;
    return registerEscape(() => close());
  }, [open]);

  // Keep the highlighted option in view inside the scrolling list.
  useLayoutEffect(() => {
    if (!open || active < 0) return;
    const list = listRef.current;
    const option = list?.querySelector<HTMLElement>(`#${CSS.escape(optionId(active))}`);
    if (!list || !option) return;
    const top = option.offsetTop;
    const bottom = top + option.offsetHeight;
    if (top < list.scrollTop) list.scrollTop = top;
    else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight;
  });

  function openList(all: boolean, highlight: 'none' | 'first' | 'last') {
    const list = filterOptions(options, all ? '' : value, filter, maxOptions);
    if (all) setTyped(false);
    setOpen(true);
    setActive(highlight === 'first' ? nextEnabled(list, -1, 1) : highlight === 'last' ? nextEnabled(list, list.length, -1) : -1);
  }

  function pick(option: ComboboxOption) {
    if (option.disabled) return;
    close();
    setTyped(false);
    onSelect(option);
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        if (!open) openList(!typed, event.altKey ? 'none' : 'first');
        else if (!event.altKey) setActive((i) => nextEnabled(visible, i, 1));
        break;
      case 'ArrowUp':
        event.preventDefault();
        if (event.altKey) close();
        else if (!open) openList(!typed, 'last');
        else setActive((i) => nextEnabled(visible, i < 0 ? visible.length : i, -1));
        break;
      case 'Enter':
        if (open && activeOption) {
          event.preventDefault();
          pick(activeOption);
        } else if (onCommit) {
          event.preventDefault();
          close();
          setTyped(false);
          onCommit(value);
        }
        break;
      case 'Escape':
        // Handled by the escape layer while open; when closed the dialog behind gets it.
        break;
      case 'Tab':
        if (open) close();
        break;
      default:
        break;
    }
  };

  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;
  const groups = groupRuns(visible);

  return (
    <div className={clsx(styles.field, className)} data-testid={testId}>
      <label id={labelId} htmlFor={inputId} className={styles.label}>
        {hideLabel ? <VisuallyHidden>{label}</VisuallyHidden> : label}
      </label>
      <div ref={anchorRef} className={clsx(styles.control, error ? styles.invalid : undefined, disabled && styles.disabled)}>
        <input
          ref={(el) => {
            inputEl.current = el;
            setRef(inputRef, el);
          }}
          id={inputId}
          name={name}
          type="text"
          role="combobox"
          autoComplete="off"
          spellCheck={false}
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          aria-activedescendant={open && activeOption ? optionId(active) : undefined}
          aria-describedby={describedBy}
          aria-invalid={error ? true : undefined}
          placeholder={placeholder}
          disabled={disabled}
          className={styles.input}
          value={value}
          onChange={(event) => {
            onValueChange(event.target.value);
            setTyped(true);
            setOpen(true);
            setActive(-1);
          }}
          onKeyDown={onKeyDown}
          onBlur={(event) => {
            // Leaving for the list itself (a click) is handled by the option's pointer handlers.
            if (!listRef.current?.contains(event.relatedTarget)) close();
            onBlur?.(event);
          }}
        />
        {showToggle ? (
          <button
            type="button"
            tabIndex={-1}
            className={styles.toggle}
            aria-label={open ? 'Hide options' : 'Show options'}
            aria-expanded={open}
            aria-controls={open ? listId : undefined}
            disabled={disabled}
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => {
              if (open) close();
              else openList(true, 'none');
              inputEl.current?.focus();
            }}
          >
            <Icon name={open ? 'chevronUp' : 'chevronDown'} size={14} />
          </button>
        ) : null}
      </div>
      {hint ? (
        <p id={hintId} className={styles.hint}>
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} className={styles.error}>
          <Icon name="error" size={14} />
          {error}
        </p>
      ) : null}
      {/* Mounted only while open: a layer created on opening comes after (above, and not made
          inert by) a dialog the combobox sits in. */}
      {open ? (
        <Portal>
          <div
            ref={listRef}
            id={listId}
            role="listbox"
            aria-labelledby={labelId}
            className={styles.list}
            // Keep focus in the text box while the pointer is on the list.
            onPointerDown={(event) => event.preventDefault()}
          >
            {visible.length === 0 ? <div className={styles.empty}>{emptyMessage}</div> : null}
            {groups.map((run) => {
                const items = run.items.map(({ option, index }) => (
                  <div
                    key={`${option.group ?? ''}\u0000${option.value}`}
                    id={optionId(index)}
                    role="option"
                    aria-selected={index === active}
                    aria-disabled={option.disabled || undefined}
                    data-value={option.value}
                    data-tone={option.tone}
                    className={clsx(styles.option, index === active && styles.active)}
                    onPointerMove={() => {
                      if (!option.disabled && active !== index) setActive(index);
                    }}
                    onClick={() => pick(option)}
                  >
                    {option.image ? <img className={styles.image} src={option.image} alt="" loading="lazy" /> : null}
                    <span className={styles.optionText}>
                      <span className={styles.optionLabel}>{option.label}</span>
                      {option.detail ? <span className={styles.optionDetail}>{option.detail}</span> : null}
                    </span>
                    {currentValue !== undefined && option.value === currentValue ? (
                      <>
                        <Icon name="check" size={14} />
                        <VisuallyHidden>(current)</VisuallyHidden>
                      </>
                    ) : null}
                  </div>
                ));
                if (run.group === undefined) return items;
                const groupId = `${generated}-group-${run.first}`;
                return (
                  <div key={`group-${run.first}`} role="group" aria-labelledby={groupId} className={styles.group}>
                    <div id={groupId} role="presentation" className={styles.groupLabel}>
                      {run.group}
                    </div>
                    {items}
                  </div>
                );
            })}
          </div>
        </Portal>
      ) : null}
    </div>
  );
}

/** The next enabled option index from `from` in direction `step`, wrapping; -1 when none. */
function nextEnabled(list: readonly ComboboxOption[], from: number, step: 1 | -1): number {
  const n = list.length;
  if (n === 0) return -1;
  for (let k = 1; k <= n; k++) {
    const i = (((from + step * k) % n) + n) % n;
    if (!list[i]?.disabled) return i;
  }
  return -1;
}

interface GroupRun {
  group: string | undefined;
  first: number;
  items: { option: ComboboxOption; index: number }[];
}

/** Consecutive options of the same group, in order. */
function groupRuns(list: readonly ComboboxOption[]): GroupRun[] {
  const runs: GroupRun[] = [];
  list.forEach((option, index) => {
    const last = runs.at(-1);
    if (last && last.group === option.group) last.items.push({ option, index });
    else runs.push({ group: option.group, first: index, items: [{ option, index }] });
  });
  return runs;
}
