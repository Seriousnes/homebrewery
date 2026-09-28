// CodeMirror 6 HTML editor of the source dialog. The Style drawer's setup and look (styleDrawer:
// editorTheme, StyleDrawer.module.css colour variables), with the HTML language. Uncontrolled:
// `initialValue` is read on mount (give it a new React key for new text), every edit is reported.
//
// Keys: CodeMirror's defaults (Mod-[ / Mod-] indent, Mod-F search, Mod-Z undo …) and Mod-Enter,
// which runs `onSubmit` (Apply). Tab is left to the browser, so it moves focus on and the dialog
// keeps its tab order; Escape closes open panels first, then the dialog.
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, isolateHistory } from '@codemirror/commands';
import { html } from '@codemirror/lang-html';
import { bracketMatching, foldGutter, foldKeymap, HighlightStyle, indentOnInput, syntaxHighlighting } from '@codemirror/language';
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search';
import { Compartment, EditorState, Prec } from '@codemirror/state';
import { drawSelection, EditorView, highlightActiveLine, highlightActiveLineGutter, highlightSpecialChars, keymap, lineNumbers } from '@codemirror/view';
import { tags as t } from '@lezer/highlight';
import { clsx } from 'clsx';
import { type Ref, useEffect, useImperativeHandle, useLayoutEffect, useRef } from 'react';
import { styleEditorTheme, styleHighlight } from '../styleDrawer/editorTheme';
import styleDrawerStyles from '../styleDrawer/StyleDrawer.module.css';
import { useResolvedScheme } from '../styleDrawer/useResolvedScheme';
import styles from './SourceEditor.module.css';

/** HTML tokens the CSS highlight style has no colour for. */
const htmlHighlight = HighlightStyle.define([
  { tag: [t.attributeValue], color: 'var(--hb-css-string)' },
  { tag: [t.angleBracket], color: 'var(--hb-css-comment)' },
  { tag: [t.character], color: 'var(--hb-css-atom)' },
]);

export interface SourceCodeEditorHandle {
  focus: () => void;
  /** Replaces the selection with `text` (one undo step) and focuses the editor. */
  insert: (text: string) => void;
  getValue: () => string;
  view: EditorView | null;
}

export interface SourceCodeEditorProps {
  initialValue: string;
  onChange: (text: string) => void;
  /** Mod-Enter. */
  onSubmit?: () => void;
  label: string;
  describedBy?: string;
  className?: string;
  'data-testid'?: string;
  ref?: Ref<SourceCodeEditorHandle | null>;
}

export function SourceCodeEditor({ initialValue, onChange, onSubmit, label, describedBy, className, 'data-testid': testId, ref }: SourceCodeEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const scheme = useResolvedScheme();
  const themeCompartment = useRef(new Compartment());
  const latest = useRef({ onChange, onSubmit });
  useLayoutEffect(() => {
    latest.current = { onChange, onSubmit };
  });

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: initialValue,
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightSpecialChars(),
          history(),
          foldGutter({ openText: '▾', closedText: '▸' }),
          drawSelection(),
          indentOnInput(),
          syntaxHighlighting(styleHighlight),
          syntaxHighlighting(htmlHighlight),
          bracketMatching(),
          closeBrackets(),
          autocompletion(),
          highlightActiveLine(),
          highlightSelectionMatches(),
          search(),
          Prec.highest(
            keymap.of([
              {
                key: 'Mod-Enter',
                run: () => {
                  latest.current.onSubmit?.();
                  return true;
                },
                preventDefault: true,
              },
            ]),
          ),
          keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...foldKeymap, ...completionKeymap]),
          html(),
          EditorView.lineWrapping,
          themeCompartment.current.of(styleEditorTheme(scheme === 'dark')),
          // data-autofocus: the dialog focuses the code first.
          EditorView.contentAttributes.of({ 'aria-label': label, 'data-autofocus': '', ...(describedBy ? { 'aria-describedby': describedBy } : {}) }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) latest.current.onChange(update.state.doc.toString());
          }),
        ],
      }),
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // The initial props only: the dialog remounts the editor (a new key) for new text.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: themeCompartment.current.reconfigure(styleEditorTheme(scheme === 'dark')) });
  }, [scheme]);

  useImperativeHandle(
    ref,
    (): SourceCodeEditorHandle => ({
      focus: () => viewRef.current?.focus(),
      insert: (text: string) => {
        const view = viewRef.current;
        if (!view) return;
        view.dispatch(view.state.replaceSelection(text), { annotations: [isolateHistory.of('full')], scrollIntoView: true });
        view.focus();
      },
      getValue: () => viewRef.current?.state.doc.toString() ?? '',
      get view() {
        return viewRef.current;
      },
    }),
    [],
  );

  return <div ref={hostRef} className={clsx(styleDrawerStyles.editorHost, styles.code, className)} data-scheme={scheme} data-testid={testId} />;
}
