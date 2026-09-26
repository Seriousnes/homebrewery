// The inspector (P3.5, plan §6.2): the right-hand panel's content.
//
//   Element tab  breadcrumbs of the element chain around the selection; classes (chips with
//                theme suggestions), style, id and attributes of the inspected element.
//   Page tab     section settings (columns, page numbers, footer, classes, style) written to the
//                section's manual page and its auto pages; this page's markers (cover type,
//                skip/restart counting) and attributes; its objects (select → focus the object,
//                edit its classes and style).
//
// Every edit is validated first (commands/attrs.ts) and applied as one undo step; an invalid value
// shows an inline error and changes nothing. The panel follows the editor through InspectorStore
// (useSyncExternalStore), so pagination transactions that only move content don't re-render it.
// Mount it inside a Drawer (or any container); it has no chrome of its own. In a read-only editor
// the fields are disabled (they show the values; the objects list still selects), following
// editor.setEditable.
import type { Editor } from '@tiptap/core';
import { clsx } from 'clsx';
import { memo, useCallback, useMemo, useState, useSyncExternalStore } from 'react';
import { useUiStore } from '@/app/uiStore';
import { Tabs, VisuallyHidden } from '@/ui';
import { AnnounceContext } from './announce';
import type { ClassPickerMode } from '../classPicker/themeClasses';
import { documentClassNames, filterClassSuggestions, rankClassSuggestions, themeClasses, type ClassSuggester } from './classNames';
import styles from './Inspector.module.css';
import { InspectorStore } from './model';
import { NodePanel } from './NodePanel';
import { focusPageObject, type PageObjectRef } from './objectFocus';
import { PagePanel } from './PagePanel';

export type InspectorTab = 'node' | 'page';

export interface InspectorProps {
  editor: Editor;
  /**
   * Class names to suggest in the class fields, instead of the default: the classes of the
   * canvas's theme and brew stylesheets (the class picker's collectThemeClasses, ranked by its
   * suggestClasses) plus those the document already uses.
   */
  classSuggestions?: readonly string[] | (() => readonly string[]);
  /** The objects list's "select". Default: focusPageObject (scroll into view, focus, OBJECT_SELECT_EVENT). */
  onSelectObject?: (ref: PageObjectRef) => void;
  className?: string;
  'data-testid'?: string;
}

/** Whether the editor is editable, following editor.setEditable (which emits 'update'). */
function useEditable(editor: Editor): boolean {
  const subscribe = useCallback(
    (notify: () => void) => {
      editor.on('update', notify);
      editor.on('transaction', notify);
      return () => {
        editor.off('update', notify);
        editor.off('transaction', notify);
      };
    },
    [editor],
  );
  return useSyncExternalStore(subscribe, () => !editor.isDestroyed && editor.isEditable);
}

/**
 * Memoized: it follows the editor through its own store, so a parent that re-renders (e.g. on
 * every CSS keystroke) doesn't re-render it.
 */
export const Inspector = memo(function Inspector({ editor, classSuggestions, onSelectObject, className, 'data-testid': testId }: InspectorProps) {
  const store = useMemo(() => new InspectorStore(editor), [editor]);
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const readOnly = !useEditable(editor);
  const storedTab = useUiStore((s) => s.inspectorTab);
  const setTab = useUiStore((s) => s.setInspectorTab);
  const tab: InspectorTab = storedTab === 'page' ? 'page' : 'node';

  // Polite announcements (refused edits). The counter makes a repeated message speak again.
  const [message, setMessage] = useState({ text: '', n: 0 });
  const announce = useCallback((text: string) => setMessage((m) => ({ text, n: m.n + 1 })), []);

  /** A suggester for a class field (called when it gets focus): 'span' ranks inline classes first. */
  const suggestions = useCallback(
    (mode: ClassPickerMode): ClassSuggester => {
      if (classSuggestions) {
        const names = typeof classSuggestions === 'function' ? classSuggestions() : classSuggestions;
        return (query, applied) => filterClassSuggestions(names, query, applied);
      }
      const theme = themeClasses();
      const used = editor.isDestroyed ? [] : documentClassNames(editor.state.doc);
      return (query, applied) => rankClassSuggestions(theme, used, query, mode, applied);
    },
    [classSuggestions, editor],
  );

  const selectObject = useCallback(
    (ref: PageObjectRef) => (onSelectObject ? onSelectObject(ref) : void focusPageObject(editor, ref)),
    [editor, onSelectObject],
  );

  return (
    <AnnounceContext value={announce}>
      <div className={clsx(styles.inspector, className)} data-testid={testId}>
        <Tabs
          label="Inspector"
          value={tab}
          onValueChange={(id) => setTab(id)}
          className={styles.tabs}
          items={[
            {
              id: 'node',
              label: 'Element',
              content: <NodePanel editor={editor} store={store} snapshot={snapshot} suggestions={suggestions} readOnly={readOnly} />,
            },
            {
              id: 'page',
              label: 'Page',
              content: <PagePanel editor={editor} page={snapshot.page} suggestions={suggestions} onSelectObject={selectObject} readOnly={readOnly} />,
            },
          ]}
        />
        <VisuallyHidden role="status" aria-live="polite" data-testid="inspector-announcer">
          <span key={message.n}>{message.text}</span>
        </VisuallyHidden>
      </div>
    </AnnounceContext>
  );
});
