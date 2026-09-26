import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { SnippetsEditorStore } from './snippetsEditorStore';

/**
 * How often, at most, edits reach the page (ms). Each report re-renders the whole editor page
 * (the Insert menu's groups, autosave's dirty state), so typing reports its latest value at the
 * end of each such window instead of on every keystroke. Read `store.value()` where the very
 * latest value matters (autosave's getSnippets).
 */
export const SNIPPETS_REPORT_MS = 120;

/**
 * The snippets editor's store for this editor page: created once from `value` (the brew's stored
 * snippets), reporting changes through `onChange` (at most every `reportMs`, the latest value;
 * pending changes are reported when the page unmounts), and replaced by a `value` it did not
 * report (a loaded or restored brew). Keep it for the page's lifetime (EditorApp): closing the
 * panel keeps the list and its undo history.
 *
 *   const [snippets, setSnippets] = useState(brew.snippets);
 *   const store = useSnippetsEditor(snippets, setSnippets);   // autosave: getSnippets: () => store.value()
 */
export function useSnippetsEditor(value: unknown, onChange: (value: unknown) => void, reportMs = SNIPPETS_REPORT_MS): SnippetsEditorStore {
  const [store] = useState(() => new SnippetsEditorStore(value));
  const latest = useRef(onChange);
  useLayoutEffect(() => {
    latest.current = onChange;
  });
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      if (timer === null) return;
      clearTimeout(timer);
      timer = null;
      latest.current(store.value());
    };
    store.setOnChange(() => {
      if (reportMs <= 0) {
        latest.current(store.value());
        return;
      }
      timer ??= setTimeout(flush, reportMs);
    });
    return () => {
      store.setOnChange(undefined);
      flush();
    };
  }, [store, reportMs]);
  useEffect(() => {
    store.sync(value);
  }, [store, value]);
  return store;
}
