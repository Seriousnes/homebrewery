// CodeMirror 6 CSS editor for the brew's style (P3.6). Controlled: `value` in, `onChange` per edit.
// The Style drawer passes the value straight on to EditorCanvas `userCss`, which debounces it
// (userCssDelayMs, 150 ms) and repaginates once the CSS is applied.
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, isolateHistory } from '@codemirror/commands';
import { css, cssLanguage } from '@codemirror/lang-css';
import { bracketMatching, foldGutter, foldKeymap, indentOnInput, syntaxHighlighting } from '@codemirror/language';
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search';
import { Annotation, Compartment, EditorState, Transaction } from '@codemirror/state';
import {
  crosshairCursor,
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
} from '@codemirror/view';
import { clsx } from 'clsx';
import { type Ref, useEffect, useImperativeHandle, useLayoutEffect, useRef } from 'react';
import { classNameCompletion } from './classCompletion';
import { cssKeymap, generalKeymap } from './cssKeymap';
import { styleEditorTheme, styleHighlight } from './editorTheme';
import { minimalChange } from './formatCss';
import { formatView, type FormatOutcome } from './formatView';
import styles from './StyleDrawer.module.css';
import { useResolvedScheme } from './useResolvedScheme';

/** What style snippets (and other tools) may do with the editor. */
export interface StyleEditorApi {
  /** Replaces the selection with `text` (one undo step) and focuses the editor. */
  insert: (text: string) => void;
  focus: () => void;
  /** The CSS as it is in the editor now. */
  getValue: () => string;
}

export interface StyleEditorHandle extends StyleEditorApi {
  view: EditorView | null;
  /** Formats the selection, or everything when nothing is selected (one undo step). */
  format: () => Promise<FormatOutcome>;
}

export interface StyleEditorProps {
  value: string;
  onChange: (css: string) => void;
  /** Accessible name of the text area (default "Brew CSS"). */
  label?: string;
  /** Id of help text (keys) for aria-describedby. */
  describedBy?: string;
  /** Class names offered after "." in selectors. */
  classNames?: () => readonly string[];
  /** Called with the outcome of every format (button or keys). */
  onFormat?: (outcome: FormatOutcome) => void;
  readOnly?: boolean;
  className?: string;
  'data-testid'?: string;
  ref?: Ref<StyleEditorHandle | null>;
}

/** Echoes of the editor's own edits kept for recognising a late render (see pendingEchoes). */
const MAX_PENDING_ECHOES = 20;

/** Marks transactions that sync the editor to a new `value` (they are not reported back). */
const External = Annotation.define<boolean>();

export function StyleEditor({
  value,
  onChange,
  label = 'Brew CSS',
  describedBy,
  classNames,
  onFormat,
  readOnly = false,
  className,
  'data-testid': testId,
  ref,
}: StyleEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const scheme = useResolvedScheme();
  const compartments = useRef({ theme: new Compartment(), readOnly: new Compartment(), aria: new Compartment() });

  // The latest callbacks, for CodeMirror's listeners and the imperative handle.
  const latest = useRef({ onChange, onFormat, classNames });
  useLayoutEffect(() => {
    latest.current = { onChange, onFormat, classNames };
  });
  /** Formats and reports the outcome (keys, button and handle all come here). */
  const format = useRef(async (): Promise<FormatOutcome> => {
    const view = viewRef.current;
    if (!view) return { kind: 'unavailable', message: 'The editor is not ready.' };
    const outcome = await formatView(view);
    latest.current.onFormat?.(outcome);
    return outcome;
  });

  /**
   * Texts reported through onChange that the parent has not rendered back yet, oldest first. A
   * `value` among them is an echo (possibly of an older edit, when the parent renders after further
   * typing): the editor already has newer text, so it is left alone. Anything else is a new value
   * from outside.
   */
  const pendingEchoes = useRef<string[]>([]);

  // Create the view once; later prop changes go through compartments and the value sync below.
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const c = compartments.current;
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightSpecialChars(),
          history(),
          foldGutter({ openText: '▾', closedText: '▸' }),
          drawSelection(),
          dropCursor(),
          EditorState.allowMultipleSelections.of(true),
          indentOnInput(),
          syntaxHighlighting(styleHighlight),
          bracketMatching(),
          closeBrackets(),
          autocompletion(),
          rectangularSelection(),
          crosshairCursor(),
          highlightActiveLine(),
          highlightSelectionMatches(),
          search(),
          keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...foldKeymap, ...completionKeymap]),
          generalKeymap,
          cssKeymap(() => {
            void format.current();
            return true;
          }),
          css(),
          cssLanguage.data.of({ autocomplete: classNameCompletion(() => latest.current.classNames?.() ?? []) }),
          EditorView.lineWrapping,
          c.theme.of(styleEditorTheme(scheme === 'dark')),
          c.readOnly.of([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]),
          c.aria.of(EditorView.contentAttributes.of({ 'aria-label': label, ...(describedBy ? { 'aria-describedby': describedBy } : {}) })),
          EditorView.updateListener.of((update) => {
            if (update.docChanged && !update.transactions.some((tr) => tr.annotation(External))) {
              const text = update.state.doc.toString();
              const pending = pendingEchoes.current;
              pending.push(text);
              if (pending.length > MAX_PENDING_ECHOES) pending.splice(0, pending.length - MAX_PENDING_ECHOES);
              latest.current.onChange(text);
            }
          }),
        ],
      }),
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // The initial props only: later changes are applied by the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A new value from outside (a loaded brew, a reset): replace the text, outside the undo history.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const pending = pendingEchoes.current;
    const echo = pending.lastIndexOf(value);
    if (echo >= 0) {
      pending.splice(0, echo + 1);
      return;
    }
    pending.length = 0;
    const current = view.state.doc.toString();
    if (value === current) return;
    const change = minimalChange(current, value)!;
    view.dispatch({ changes: change, annotations: [External.of(true), Transaction.addToHistory.of(false)] });
  }, [value]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: compartments.current.theme.reconfigure(styleEditorTheme(scheme === 'dark')) });
  }, [scheme]);
  useEffect(() => {
    viewRef.current?.dispatch({
      effects: compartments.current.readOnly.reconfigure([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]),
    });
  }, [readOnly]);
  useEffect(() => {
    viewRef.current?.dispatch({
      effects: compartments.current.aria.reconfigure(
        EditorView.contentAttributes.of({ 'aria-label': label, ...(describedBy ? { 'aria-describedby': describedBy } : {}) }),
      ),
    });
  }, [label, describedBy]);

  useImperativeHandle(
    ref,
    (): StyleEditorHandle => ({
      get view() {
        return viewRef.current;
      },
      insert: (text: string) => {
        const view = viewRef.current;
        if (!view) return;
        view.dispatch(view.state.replaceSelection(text), { annotations: [isolateHistory.of('full'), Transaction.userEvent.of('input.snippet')], scrollIntoView: true });
        view.focus();
      },
      focus: () => viewRef.current?.focus(),
      getValue: () => viewRef.current?.state.doc.toString() ?? '',
      format: () => format.current(),
    }),
    [],
  );

  return <div ref={hostRef} className={clsx(styles.editorHost, className)} data-scheme={scheme} data-testid={testId} />;
}
