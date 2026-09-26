// CodeMirror 6 editor for one snippet's Homebrewery markdown. It has no history of its own: every
// change goes to the SnippetsEditorStore (typing merges into one undo step there), and Mod-Z /
// Mod-Shift-Z / Mod-Y run the store's undo and redo, so undo covers the whole snippets editor.
// Changes that would take the snippets over the size limit are refused before they apply.
import { defaultKeymap } from '@codemirror/commands';
import { syntaxHighlighting } from '@codemirror/language';
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search';
import { Annotation, Compartment, EditorSelection, EditorState } from '@codemirror/state';
import { drawSelection, dropCursor, EditorView, highlightActiveLine, highlightSpecialChars, keymap } from '@codemirror/view';
import { clsx } from 'clsx';
import { type Ref, useEffect, useImperativeHandle, useLayoutEffect, useRef } from 'react';
import { styleEditorTheme } from '@/editor/ui/styleDrawer/editorTheme';
import { minimalChange } from '@/editor/ui/styleDrawer/formatCss';
import { useResolvedScheme } from '@/editor/ui/styleDrawer/useResolvedScheme';
import { hbfmHighlight, hbfmLanguage } from './hbfmLanguage';
import type { SnippetsEditorStore } from './snippetsEditorStore';
import styles from './SnippetsEditor.module.css';

export interface SnippetBodyEditorHandle {
  view: EditorView | null;
  focus: () => void;
}

export interface SnippetBodyEditorProps {
  store: SnippetsEditorStore;
  /** The snippet being edited. */
  snippetKey: string;
  /** Its markdown as the store has it. */
  value: string;
  /** Accessible name of the text area. */
  label: string;
  describedBy?: string;
  readOnly?: boolean;
  className?: string;
  'data-testid'?: string;
  ref?: Ref<SnippetBodyEditorHandle | null>;
}

/** Marks transactions that show the store's text (another snippet, undo, redo): not reported back. */
const External = Annotation.define<boolean>();

const ariaAttributes = (label: string, describedBy: string | undefined) =>
  EditorView.contentAttributes.of({ 'aria-label': label, 'aria-multiline': 'true', ...(describedBy ? { 'aria-describedby': describedBy } : {}) });

export function SnippetBodyEditor({ store, snippetKey, value, label, describedBy, readOnly = false, className, 'data-testid': testId, ref }: SnippetBodyEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const scheme = useResolvedScheme();
  const compartments = useRef({ theme: new Compartment(), readOnly: new Compartment(), aria: new Compartment() });
  // What the listeners work on (the view outlives a change of snippet).
  const latest = useRef({ store, key: snippetKey });
  useLayoutEffect(() => {
    latest.current = { store, key: snippetKey };
  });
  const shownKey = useRef(snippetKey);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const c = compartments.current;
    const undo = () => {
      latest.current.store.undo();
      return true;
    };
    const redo = () => {
      latest.current.store.redo();
      return true;
    };
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: value,
        extensions: [
          highlightSpecialChars(),
          drawSelection(),
          dropCursor(),
          highlightActiveLine(),
          highlightSelectionMatches(),
          search(),
          keymap.of([
            { key: 'Mod-z', run: undo, preventDefault: true },
            { key: 'Mod-Shift-z', run: redo, preventDefault: true },
            { key: 'Mod-y', run: redo, preventDefault: true },
            ...defaultKeymap,
            ...searchKeymap,
          ]),
          hbfmLanguage,
          syntaxHighlighting(hbfmHighlight),
          EditorView.lineWrapping,
          c.theme.of(styleEditorTheme(scheme === 'dark')),
          c.readOnly.of([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]),
          c.aria.of(ariaAttributes(label, describedBy)),
          // Refuse what doesn't fit before it reaches the text.
          EditorState.transactionFilter.of((tr) => {
            if (!tr.docChanged || tr.annotation(External)) return tr;
            const { store: current, key } = latest.current;
            if (current.fits(key, { gen: tr.newDoc.toString() })) return tr;
            current.refuseSize();
            return [];
          }),
          EditorView.updateListener.of((update) => {
            if (!update.docChanged || update.transactions.every((tr) => tr.annotation(External))) return;
            const { store: current, key } = latest.current;
            current.update(key, 'gen', update.state.doc.toString());
          }),
          EditorView.domEventHandlers({
            blur: () => {
              latest.current.store.breakMerge();
              return false;
            },
          }),
        ],
      }),
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // The initial props only: later changes go through the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Show the store's text: another snippet (from the top), or an undo/redo (the caret goes to the
  // end of what changed). The editor's own edits are already in the store, so they match.
  useLayoutEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (shownKey.current !== snippetKey) {
      shownKey.current = snippetKey;
      view.dispatch({
        changes: { from: 0, to: current.length, insert: value },
        selection: EditorSelection.cursor(0),
        annotations: External.of(true),
        effects: EditorView.scrollIntoView(0),
      });
      return;
    }
    const change = minimalChange(current, value);
    if (!change) return;
    view.dispatch({
      changes: change,
      selection: EditorSelection.cursor(change.from + change.insert.length),
      annotations: External.of(true),
      scrollIntoView: true,
    });
  }, [snippetKey, value]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: compartments.current.theme.reconfigure(styleEditorTheme(scheme === 'dark')) });
  }, [scheme]);
  useEffect(() => {
    viewRef.current?.dispatch({
      effects: compartments.current.readOnly.reconfigure([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]),
    });
  }, [readOnly]);
  useEffect(() => {
    viewRef.current?.dispatch({ effects: compartments.current.aria.reconfigure(ariaAttributes(label, describedBy)) });
  }, [label, describedBy]);

  useImperativeHandle(
    ref,
    (): SnippetBodyEditorHandle => ({
      get view() {
        return viewRef.current;
      },
      focus: () => viewRef.current?.focus(),
    }),
    [],
  );

  return <div ref={hostRef} className={clsx(styles.editorHost, className)} data-scheme={scheme} data-testid={testId} />;
}
