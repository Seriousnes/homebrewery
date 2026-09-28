// The searchable, grouped snippet list shared by SnippetPicker (a popover) and SnippetGallery (a
// dialog): a search field (a combobox) over a listbox of snippets grouped like upstream's menus,
// one group per snippet group and submenu ("License › Creative Commons › Text Declarations").
// The focus stays in the search field; Up/Down (wrapping), Page Up/Down and Ctrl+Home/End move
// the active option, Enter picks it. Mount it while its popup is open: the query starts empty.
import clsx from 'clsx';
import { useEffect, useId, useMemo, useState, type KeyboardEvent, type RefObject } from 'react';
import { TextField } from '@/ui';
import { filterSections, snippetSections, type SnippetEntry } from '@/editor/snippets/snippetTree';
import type { ThemeSnippetGroup } from '@/editor/snippets/themeSnippets';
import styles from './SnippetList.module.css';

export interface SnippetListProps {
  /** Snippet groups of one view (see groupsForView). */
  groups: readonly ThemeSnippetGroup[];
  /** Enter or a click on an enabled option. */
  onPick: (entry: SnippetEntry) => void;
  /** The active option changed (null: nothing matches). */
  onActiveChange?: (entry: SnippetEntry | null) => void;
  /** The groups are still loading. */
  loading?: boolean;
  inputRef?: RefObject<HTMLInputElement | null>;
  className?: string;
  listClassName?: string;
}

const PAGE_STEP = 8;

export function SnippetList({ groups, onPick, onActiveChange, loading = false, inputRef, className, listClassName }: SnippetListProps) {
  const [query, setQuery] = useState('');
  const [activeId, setActiveId] = useState<string | null>(null);
  const baseId = useId();
  const listboxId = `${baseId}-listbox`;
  const optionId = (entry: SnippetEntry) => `${baseId}-${entry.id}`;

  const sections = useMemo(() => snippetSections(groups), [groups]);
  const filtered = useMemo(() => filterSections(sections, query), [sections, query]);
  const options = useMemo(() => filtered.flatMap((s) => s.entries), [filtered]);
  const enabled = useMemo(() => options.filter((o) => !o.disabled), [options]);
  // The active option: the one chosen, while it is still listed; else the first enabled one.
  const active = enabled.find((o) => o.id === activeId) ?? enabled[0] ?? null;

  useEffect(() => {
    if (!active) return;
    document.getElementById(optionId(active))?.scrollIntoView({ block: 'nearest' });
    // optionId only depends on baseId.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  useEffect(() => {
    onActiveChange?.(active);
    // Reported when the active entry changes, not when the callback does.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  const pick = (entry: SnippetEntry) => {
    if (!entry.disabled) onPick(entry);
  };

  const move = (delta: number | 'first' | 'last') => {
    if (!enabled.length) return;
    const index = active ? enabled.indexOf(active) : -1;
    let next: number;
    if (delta === 'first') next = 0;
    else if (delta === 'last') next = enabled.length - 1;
    else if (Math.abs(delta) === 1) next = (index + delta + enabled.length) % enabled.length;
    else next = Math.max(0, Math.min(enabled.length - 1, index + delta));
    setActiveId(enabled[next]!.id);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const ctrl = event.ctrlKey || event.metaKey;
    if (event.key === 'ArrowDown') move(1);
    else if (event.key === 'ArrowUp') move(-1);
    else if (event.key === 'PageDown') move(PAGE_STEP);
    else if (event.key === 'PageUp') move(-PAGE_STEP);
    else if (ctrl && event.key === 'Home') move('first');
    else if (ctrl && event.key === 'End') move('last');
    else if (event.key === 'Enter') {
      if (active) pick(active);
    } else return;
    event.preventDefault();
  };

  const count = options.length;
  const status = loading ? 'Loading snippets…' : count === 0 ? 'No snippets match.' : `${count} snippet${count === 1 ? '' : 's'}`;

  return (
    <div className={clsx(styles.root, className)}>
      <TextField
        ref={inputRef}
        label="Search snippets"
        hideLabel
        type="search"
        placeholder="Search snippets"
        autoComplete="off"
        spellCheck={false}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded="true"
        aria-controls={listboxId}
        aria-activedescendant={active ? optionId(active) : undefined}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={onKeyDown}
        className={styles.search}
      />
      <div id={listboxId} role="listbox" aria-label="Snippets" aria-busy={loading || undefined} className={clsx(styles.list, listClassName)}>
        {filtered.map((section) => {
          const headingId = `${baseId}-${section.id}`;
          return (
            <div key={section.id} role="group" aria-labelledby={headingId} className={styles.group}>
              <div id={headingId} role="presentation" className={section.path.length > 1 ? styles.subheading : styles.heading}>
                {section.label}
              </div>
              {section.entries.map((entry) => (
                <div
                  key={entry.id}
                  id={optionId(entry)}
                  role="option"
                  aria-selected={entry === active}
                  aria-disabled={entry.disabled || undefined}
                  className={styles.option}
                  data-snippet={entry.path.join(' › ')}
                  // Keep the focus in the search field.
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseMove={() => {
                    if (!entry.disabled && entry !== active) setActiveId(entry.id);
                  }}
                  onClick={() => pick(entry)}
                >
                  <span className={styles.name}>{entry.name}</span>
                  {entry.experimental ? <span className={styles.badge}>beta</span> : null}
                  {entry.disabled ? <span className={styles.badge}>disabled</span> : null}
                  {entry.hint ? <span className={styles.hint}>{entry.hint}</span> : null}
                </div>
              ))}
            </div>
          );
        })}
      </div>
      <div role="status" className={styles.status}>
        {status}
      </div>
    </div>
  );
}
