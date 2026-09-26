// The brew snippets editor (plan §6.3: user snippets are Homebrewery markdown and go through the
// same pipeline as theme snippets). A list of the brew's own snippets, grouped the way the Insert
// menu's "Brew Snippets" group shows them, and the selected snippet's name, group and body. Every
// change reaches the Insert menu at once and is saved with the brew (EditorApp passes the store's
// value to autosave's getSnippets). Import and export use upstream's "\snippet name" text form.
// User themes' snippets are listed read-only; one can be copied into the brew's own.
//
// Keys: Mod-Z undoes the last snippet edit anywhere in the editor, Mod-Shift-Z and Mod-Y redo. In
// the list, arrows / Home / End select, Enter goes to the name, Delete deletes (undoable).
import clsx from 'clsx';
import { type KeyboardEvent, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { ThemeSnippetRef } from '@/editor/canvas/themeLoader';
import { isMacPlatform, shortcutFor } from '@/editor/commands/keymap';
import { Button, Icon, IconButton, TextField, Toolbar, ToolbarGroup, ToolbarSeparator, VisuallyHidden } from '@/ui';
import { formatSize, plural, userThemeSnippets } from './helpers';
import { SnippetBodyEditor } from './SnippetBodyEditor';
import type { SnippetsEditorStore } from './snippetsEditorStore';
import {
  countErrors,
  displayOrder,
  type EditableSnippet,
  groupNames,
  groupSnippets,
  MAX_SNIPPET_LABEL_LENGTH,
  NEW_SNIPPET_NAME,
  type SnippetIssue,
  snippetIssues,
  uniqueName,
} from './snippetsModel';
import { SnippetTextDialog } from './SnippetTextDialog';
import styles from './SnippetsEditor.module.css';

export interface SnippetsEditorProps {
  store: SnippetsEditorStore;
  /** The brew's title: the Insert menu lists snippets without a group under it. */
  brewTitle: string;
  /** The theme chain's snippet sources (EditorCanvas's chain.snippets); user themes' are shown read-only. */
  themeSnippets?: readonly ThemeSnippetRef[] | null;
  readOnly?: boolean;
  className?: string;
  'data-testid'?: string;
}

export function SnippetsEditor({ store, brewTitle, themeSnippets, readOnly = false, className, 'data-testid': testId = 'snippets-editor' }: SnippetsEditorProps) {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const { snippets, selected, canUndo, canRedo, size, maxSize, notice } = snapshot;
  const issues = useMemo(() => snippetIssues(snippets, brewTitle), [snippets, brewTitle]);
  const groups = useMemo(() => groupSnippets(snippets, brewTitle), [snippets, brewTitle]);
  const ordered = useMemo(() => displayOrder(snippets, brewTitle), [snippets, brewTitle]);
  const themes = useMemo(() => userThemeSnippets(themeSnippets), [themeSnippets]);
  const current = snippets.find((s) => s.key === selected) ?? null;
  const [dialog, setDialog] = useState<'import' | 'export' | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const newRef = useRef<HTMLButtonElement>(null);
  const undoKey = shortcutFor('undo');
  const redoKey = shortcutFor('redo');
  const ids = useId();
  const errors = countErrors(issues);
  const rootRef = useRef<HTMLDivElement>(null);

  // An edit (an undo, a delete) can remove the focused element, the body editor or an option;
  // focus then falls to <body>. Keep it in the editor: on the selected option, else New snippet.
  const focusWasInside = useRef(false);
  useEffect(() => {
    const onFocusIn = (event: FocusEvent) => {
      focusWasInside.current = rootRef.current?.contains(event.target as Node) ?? false;
    };
    document.addEventListener('focusin', onFocusIn);
    return () => document.removeEventListener('focusin', onFocusIn);
  }, []);
  useLayoutEffect(() => {
    const active = document.activeElement;
    if (!focusWasInside.current || (active && active !== document.body)) return;
    const option = selected ? listRef.current?.querySelector<HTMLElement>(`[data-key="${selected}"]`) : null;
    (option ?? newRef.current)?.focus();
  }, [snapshot, selected]);

  const focusOption = (key: string | null) => {
    // After React rendered the new selection.
    requestAnimationFrame(() => {
      const option = key ? listRef.current?.querySelector<HTMLElement>(`[data-key="${key}"]`) : null;
      (option ?? newRef.current)?.focus();
    });
  };

  const add = () => {
    if (readOnly) return;
    const group = current?.group ?? '';
    const key = store.add({ group, name: uniqueName(snippets, NEW_SNIPPET_NAME, group, brewTitle), gen: '' });
    if (key) {
      store.announce(`Added “${store.get(key)?.name}”.`);
      requestAnimationFrame(() => {
        nameRef.current?.focus();
        nameRef.current?.select();
      });
    }
  };

  /** The snippet shown next to `key` in the list (for the selection after deleting it). */
  const neighbour = (key: string): string | null => {
    const at = ordered.findIndex((s) => s.key === key);
    return ordered[at + 1]?.key ?? ordered[at - 1]?.key ?? null;
  };

  const remove = (key: string, refocus: 'list' | 'none' = 'list') => {
    if (readOnly) return;
    const snippet = store.get(key);
    const next = neighbour(key);
    if (!snippet || !store.remove(key, next)) return;
    store.announce(`Deleted “${snippet.name.trim() || 'Unnamed snippet'}”. ${undoKey.label} undoes it.`);
    if (refocus === 'list') focusOption(next);
  };

  const move = (key: string, delta: -1 | 1) => {
    if (readOnly) return;
    const group = groups.find((g) => g.snippets.some((s) => s.key === key));
    const list = group?.snippets ?? [];
    const at = list.findIndex((s) => s.key === key);
    const other = list[at + delta];
    if (other) store.swap(key, other.key);
  };

  const onRootKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // Portaled dialogs bubble here through React: their fields keep their own undo.
    if (event.defaultPrevented || readOnly || !event.currentTarget.contains(event.target as Node)) return;
    const mod = isMacPlatform() ? event.metaKey : event.ctrlKey;
    if (!mod || event.altKey) return;
    const key = event.key.toLowerCase();
    if (key === 'z' && !event.shiftKey) {
      event.preventDefault();
      store.undo();
    } else if ((key === 'z' && event.shiftKey) || (key === 'y' && !event.shiftKey)) {
      event.preventDefault();
      store.redo();
    }
  };

  const onListKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey || !ordered.length) return;
    const at = ordered.findIndex((s) => s.key === selected);
    let next: EditableSnippet | undefined;
    switch (event.key) {
      case 'ArrowDown':
        next = ordered[Math.min(ordered.length - 1, at + 1)];
        break;
      case 'ArrowUp':
        next = ordered[Math.max(0, at - 1)];
        break;
      case 'Home':
        next = ordered[0];
        break;
      case 'End':
        next = ordered[ordered.length - 1];
        break;
      case 'Enter':
        event.preventDefault();
        nameRef.current?.focus();
        return;
      case 'Delete':
        if (selected) {
          event.preventDefault();
          remove(selected);
        }
        return;
      default:
        return;
    }
    event.preventDefault();
    if (next) {
      store.select(next.key);
      focusOption(next.key);
    }
  };

  const copyThemeSnippet = (theme: string, snippet: { name: string; gen: string }) => {
    if (readOnly) return;
    const key = store.add({ group: '', name: uniqueName(snippets, snippet.name, '', brewTitle), gen: snippet.gen });
    if (key) store.announce(`Copied “${snippet.name}” from ${theme} to the brew’s snippets.`);
  };

  const focusKey = selected ?? ordered[0]?.key ?? null;
  const currentIssues = current ? (issues.get(current.key) ?? []) : [];
  const issueOf = (field: SnippetIssue['field'], severity: SnippetIssue['severity']) =>
    currentIssues.filter((i) => i.field === field && i.severity === severity).map((i) => i.message);
  const orderInGroup = current ? (groups.find((g) => g.snippets.includes(current))?.snippets ?? []) : [];
  const indexInGroup = current ? orderInGroup.indexOf(current) : -1;
  const bodyHintId = `${ids}-body-hint`;
  const bodyWarningId = `${ids}-body-warning`;
  const genWarnings = issueOf('gen', 'warning');

  return (
    <div ref={rootRef} className={clsx(styles.editor, className)} onKeyDown={onRootKeyDown} data-testid={testId}>
      <Toolbar label="Snippet tools" className={styles.toolbar}>
        <Button ref={newRef} size="sm" variant="ghost" icon="plus" disabled={readOnly} onClick={add} data-testid="snippets-new">
          New snippet
        </Button>
        <ToolbarGroup label="History">
          <IconButton
            icon="undo"
            size="sm"
            label="Undo snippet edit"
            shortcut={undoKey.label}
            aria-keyshortcuts={undoKey.aria}
            aria-disabled={!canUndo || readOnly}
            onClick={() => store.undo()}
            data-testid="snippets-undo"
          />
          <IconButton
            icon="redo"
            size="sm"
            label="Redo snippet edit"
            shortcut={redoKey.label}
            aria-keyshortcuts={redoKey.aria}
            aria-disabled={!canRedo || readOnly}
            onClick={() => store.redo()}
            data-testid="snippets-redo"
          />
        </ToolbarGroup>
        <ToolbarSeparator />
        <Button size="sm" variant="ghost" aria-haspopup="dialog" disabled={readOnly} onClick={() => setDialog('import')} data-testid="snippets-import">
          Import…
        </Button>
        <Button size="sm" variant="ghost" aria-haspopup="dialog" aria-disabled={!snippets.length} onClick={() => setDialog('export')} data-testid="snippets-export">
          Export…
        </Button>
      </Toolbar>

      <div className={styles.scroll}>
        <p className={styles.intro}>
          The Insert menu lists these under <strong>Brew Snippets</strong>. Each one is Homebrewery markdown.
        </p>

        {groups.length ? (
          <div ref={listRef} role="listbox" aria-label="Brew snippets" className={styles.list} onKeyDown={onListKeyDown} data-testid="snippets-list">
            {groups.map((group) => (
              <div key={group.label} role="group" aria-label={group.label} className={styles.group}>
                <div className={styles.groupLabel} aria-hidden="true">
                  {group.label}
                </div>
                {group.snippets.map((snippet) => {
                  const problems = (issues.get(snippet.key) ?? []).some((i) => i.severity === 'error');
                  const isSelected = snippet.key === selected;
                  return (
                    <div
                      key={snippet.key}
                      role="option"
                      aria-selected={isSelected}
                      tabIndex={snippet.key === focusKey ? 0 : -1}
                      className={clsx(styles.option, isSelected && styles.selected)}
                      onClick={() => store.select(snippet.key)}
                      data-key={snippet.key}
                      data-testid="snippet-option"
                    >
                      <span className={clsx(styles.optionName, !snippet.name.trim() && styles.unnamed)}>{snippet.name.trim() || 'Unnamed snippet'}</span>
                      {problems ? (
                        <>
                          <Icon name="warning" size={14} className={styles.optionIssue} />
                          <VisuallyHidden>(needs attention)</VisuallyHidden>
                        </>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        ) : (
          <p className={styles.empty} data-testid="snippets-empty">
            This brew has no snippets yet. <em>New snippet</em> adds one.
          </p>
        )}

        {current ? (
          <section className={styles.details} aria-labelledby={`${ids}-details`} data-testid="snippet-details">
            <h3 id={`${ids}-details`} className={styles.heading}>
              Edit snippet
            </h3>
            <TextField
              ref={nameRef}
              label="Name"
              value={current.name}
              required
              maxLength={MAX_SNIPPET_LABEL_LENGTH}
              readOnly={readOnly}
              autoComplete="off"
              spellCheck={false}
              error={issueOf('name', 'error').join(' ') || undefined}
              onChange={(e) => store.update(current.key, 'name', e.target.value)}
              onBlur={() => store.breakMerge()}
              data-testid="snippet-name"
            />
            <TextField
              label="Group"
              value={current.group}
              maxLength={MAX_SNIPPET_LABEL_LENGTH}
              readOnly={readOnly}
              autoComplete="off"
              list={`${ids}-groups`}
              hint={`A submenu of Brew Snippets. Empty: “${brewTitle}”.`}
              error={issueOf('group', 'error').join(' ') || undefined}
              onChange={(e) => store.update(current.key, 'group', e.target.value)}
              onBlur={() => store.breakMerge()}
              data-testid="snippet-group"
            />
            <datalist id={`${ids}-groups`}>
              {groupNames(snippets).map((g) => (
                <option key={g} value={g} />
              ))}
            </datalist>
            <div className={styles.bodyField}>
              <span className={styles.label} id={`${ids}-body-label`}>
                Body
              </span>
              <SnippetBodyEditor
                store={store}
                snippetKey={current.key}
                value={current.gen}
                label="Body"
                describedBy={genWarnings.length ? `${bodyHintId} ${bodyWarningId}` : bodyHintId}
                readOnly={readOnly}
                className={styles.body}
                data-testid="snippet-body"
              />
              <p id={bodyHintId} className={styles.hint}>
                Homebrewery markdown, e.g. <code>{'{{note'}</code> … <code>{'}}'}</code>. A <code>\page</code> line starts new pages.
              </p>
              {genWarnings.length ? (
                <p id={bodyWarningId} className={styles.warning} data-testid="snippet-body-warning">
                  <Icon name="info" size={14} />
                  {genWarnings.join(' ')}
                </p>
              ) : null}
            </div>
            <div className={styles.actions} role="group" aria-label="Snippet actions">
              <Button
                size="sm"
                icon="copy"
                aria-disabled={readOnly}
                onClick={() => {
                  if (readOnly) return;
                  const key = store.duplicate(current.key, uniqueName(snippets, `${current.name.trim() || 'Snippet'} copy`, current.group, brewTitle));
                  if (key) store.announce(`Duplicated as “${store.get(key)?.name}”.`);
                }}
                data-testid="snippet-duplicate"
              >
                Duplicate
              </Button>
              <Button size="sm" icon="chevronUp" aria-disabled={readOnly || indexInGroup <= 0} onClick={() => move(current.key, -1)} data-testid="snippet-move-up">
                Move up
              </Button>
              <Button
                size="sm"
                icon="chevronDown"
                aria-disabled={readOnly || indexInGroup < 0 || indexInGroup >= orderInGroup.length - 1}
                onClick={() => move(current.key, 1)}
                data-testid="snippet-move-down"
              >
                Move down
              </Button>
              <Button size="sm" variant="danger" icon="trash" aria-disabled={readOnly} onClick={() => remove(current.key)} data-testid="snippet-delete">
                Delete
              </Button>
            </div>
          </section>
        ) : null}

        {themes.length ? (
          <section className={styles.themes} aria-labelledby={`${ids}-themes`} data-testid="theme-snippets">
            <h3 id={`${ids}-themes`} className={styles.heading}>
              From your themes
            </h3>
            <p className={styles.hint}>Read-only here: change them in the theme’s own brew. A copy becomes a brew snippet you can change.</p>
            {themes.map((theme) => (
              <div key={theme.name} role="group" aria-label={`Theme ${theme.name}`} className={styles.theme}>
                <h4 className={styles.themeName}>{theme.name}</h4>
                <ul className={styles.themeList}>
                  {theme.snippets.map((snippet, i) => (
                    <li key={`${snippet.name}-${i}`}>
                      <details className={styles.themeSnippet} data-testid="theme-snippet">
                        <summary>{snippet.name}</summary>
                        <pre className={styles.code}>{snippet.gen}</pre>
                        <Button size="sm" icon="copy" aria-disabled={readOnly} onClick={() => copyThemeSnippet(theme.name, snippet)} data-testid="theme-snippet-copy">
                          Copy to brew snippets
                        </Button>
                      </details>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </section>
        ) : null}
      </div>

      <div className={styles.footer}>
        <p className={styles.status} data-testid="snippets-status">
          {plural(snippets.length, 'snippet', 'snippets')} · {formatSize(size)} of {formatSize(maxSize)}
          {errors ? ` · ${plural(errors, 'needs', 'need')} attention` : ''}
        </p>
        <p role="status" className={clsx(styles.notice, notice?.tone === 'error' && styles.noticeError)} data-testid="snippets-notice">
          {notice ? <span key={notice.id}>{notice.message}</span> : null}
        </p>
      </div>

      <SnippetTextDialog
        mode={dialog}
        onClose={() => setDialog(null)}
        store={store}
        snippets={snippets}
        brewTitle={brewTitle}
      />
    </div>
  );
}
