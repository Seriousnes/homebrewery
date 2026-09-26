// The Style drawer's content (P3.6, plan §6.2): the brew's CSS in a CodeMirror 6 editor with
// Prettier formatting (Format button, Mod-Shift-F / Alt-Shift-F), theme class completion, and a
// slot for Style-view snippets (the snippets lane renders its menu there and inserts through the
// API it gets).
//
//   const [css, setCss] = useState(brew.style);
//   <StyleDrawer value={css} onChange={setCss} snippets={(api) => <StyleSnippets onInsert={api.insert} />} />
//   <EditorCanvas userCss={css} … />     // restyles within userCssDelayMs (150 ms), then repaginates
//
// Mount it inside a Drawer (or any container with a height); it fills it.
import { clsx } from 'clsx';
import { type ReactNode, type Ref, useCallback, useId, useImperativeHandle, useMemo, useState } from 'react';
import { Button, Toolbar } from '@/ui';
import { themeClasses } from '../inspector/classNames';
import { loadPrettier } from './formatCss';
import { FORMAT_KEYSHORTCUTS, FORMAT_SHORTCUT } from './shortcuts';
import styles from './StyleDrawer.module.css';
import type { FormatOutcome } from './formatView';
import { StyleEditor, type StyleEditorApi, type StyleEditorHandle } from './StyleEditor';

export interface StyleDrawerProps {
  /** The brew's CSS. */
  value: string;
  /** Every edit (pass it on to EditorCanvas `userCss`; the canvas debounces). */
  onChange: (css: string) => void;
  /** Style-view snippets: toolbar content, or a function that gets the editor API. */
  snippets?: ReactNode | ((api: StyleEditorApi) => ReactNode);
  /** Class names for completion after "." (default: the canvas theme's classes). */
  classNames?: () => readonly string[];
  readOnly?: boolean;
  className?: string;
  'data-testid'?: string;
  ref?: Ref<StyleEditorHandle | null>;
}

/**
 * The StyleEditor's handle behind a stable object (no ref read during render): snippets get the
 * API while rendering and call it later, from events.
 */
function createEditorBridge() {
  let handle: StyleEditorHandle | null = null;
  const api: StyleEditorApi = {
    insert: (text) => handle?.insert(text),
    focus: () => handle?.focus(),
    getValue: () => handle?.getValue() ?? '',
  };
  /** The drawer's own handle: delegates to the editor mounted now. */
  const proxy: StyleEditorHandle = {
    ...api,
    get view() {
      return handle?.view ?? null;
    },
    format: () => handle?.format() ?? Promise.resolve({ kind: 'unavailable', message: 'The editor is not ready.' }),
  };
  return {
    api,
    proxy,
    attach: (next: StyleEditorHandle | null) => {
      handle = next;
    },
    handle: () => handle,
  };
}

function describeOutcome(outcome: FormatOutcome): string {
  switch (outcome.kind) {
    case 'formatted':
      return 'CSS formatted.';
    case 'unchanged':
      return 'The CSS is already formatted.';
    case 'stale':
      return 'The CSS changed while it was being formatted. Try again.';
    case 'unavailable':
      return 'Formatting is not available right now.';
    case 'error': {
      const where = outcome.line !== null ? ` (line ${outcome.line}${outcome.column !== null ? `, column ${outcome.column}` : ''})` : '';
      return `Can’t format: ${outcome.message}${where}.`;
    }
  }
}

export function StyleDrawer({ value, onChange, snippets, classNames, readOnly = false, className, 'data-testid': testId, ref }: StyleDrawerProps) {
  const hintId = useId();
  const [bridge] = useState(createEditorBridge);
  const [status, setStatus] = useState<{ text: string; error: boolean; n: number }>({ text: '', error: false, n: 0 });
  const [formatting, setFormatting] = useState(false);
  useImperativeHandle(ref, () => bridge.proxy, [bridge]);

  const onFormat = useCallback((outcome: FormatOutcome) => {
    setStatus((s) => ({ text: describeOutcome(outcome), error: outcome.kind === 'error' || outcome.kind === 'unavailable', n: s.n + 1 }));
  }, []);
  const format = async () => {
    const editor = bridge.handle();
    if (!editor || formatting) return;
    setFormatting(true);
    try {
      await editor.format();
    } finally {
      setFormatting(false);
    }
  };
  const names = useMemo(() => classNames ?? (() => themeClasses().map((c) => c.name)), [classNames]);

  return (
    <div className={clsx(styles.drawer, className)} data-testid={testId}>
      <Toolbar label="Style tools" className={styles.toolbar}>
        <Button
          size="sm"
          icon="braces"
          loading={formatting}
          disabled={readOnly}
          aria-keyshortcuts={FORMAT_KEYSHORTCUTS}
          title={`Format CSS (${FORMAT_SHORTCUT})`}
          onPointerEnter={() => void loadPrettier().catch(() => {})}
          onFocus={() => void loadPrettier().catch(() => {})}
          onClick={() => void format()}
          data-testid="style-format"
        >
          Format
        </Button>
        {typeof snippets === 'function' ? snippets(bridge.api) : snippets}
      </Toolbar>
      <StyleEditor
        ref={(handle) => bridge.attach(handle)}
        value={value}
        onChange={onChange}
        describedBy={hintId}
        classNames={names}
        onFormat={onFormat}
        readOnly={readOnly}
        className={styles.editor}
        data-testid="style-editor"
      />
      <div className={styles.footer}>
        <p id={hintId} className={styles.hint}>
          {FORMAT_SHORTCUT} formats. Tab indents; Esc then Tab leaves the editor.
        </p>
        <p role="status" aria-live="polite" className={clsx(styles.status, status.error && styles.statusError)} data-testid="style-status">
          <span key={status.n}>{status.text}</span>
        </p>
      </div>
    </div>
  );
}
