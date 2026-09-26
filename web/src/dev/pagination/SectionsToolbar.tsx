import type { Editor } from '@tiptap/core';
import { useCallback, useSyncExternalStore } from 'react';
import { sectionStartAt } from '@/editor/commands/sections';
import { Button, Select, Toolbar } from '@/ui';
import styles from './SectionsToolbar.module.css';

const COLUMN_OPTIONS = [
  { value: 'theme', label: 'Theme default' },
  { value: '1', label: '1 column' },
  { value: '2', label: '2 columns' },
];

const BLOCK_OPTIONS = [
  { value: 'paragraph', label: 'Paragraph' },
  { value: 'h1', label: 'Heading 1' },
  { value: 'h2', label: 'Heading 2' },
  { value: 'h3', label: 'Heading 3' },
  { value: 'h4', label: 'Heading 4' },
];

/** "columns|blockType" at the cursor: one string, so the snapshot compares by value. */
function readSelection(editor: Editor | null): string {
  if (!editor || editor.isDestroyed) return 'theme|paragraph';
  const state = editor.state;
  const head = state.doc.child(sectionStartAt(state));
  const columns = head.attrs.columns === 1 || head.attrs.columns === 2 ? String(head.attrs.columns) : 'theme';
  const parent = state.selection.$head.parent;
  const block = parent.type.name === 'heading' ? `h${String(parent.attrs.level)}` : 'paragraph';
  return `${columns}|${block}`;
}

/**
 * /dev/sections toolbar: a page break (Mod-Enter), the columns of the section at the cursor
 * (setSectionAttrs) and the block type (setParagraph / setHeading, history-safe).
 */
export function SectionsToolbar({ editor }: { editor: Editor | null }) {
  const subscribe = useCallback(
    (listener: () => void) => {
      if (!editor) return () => {};
      editor.on('transaction', listener);
      return () => {
        editor.off('transaction', listener);
      };
    },
    [editor],
  );
  const [columns, block] = useSyncExternalStore(subscribe, () => readSelection(editor)).split('|') as [string, string];
  const run = (fn: (e: Editor) => void) => {
    if (!editor || editor.isDestroyed) return;
    fn(editor);
    editor.view.focus();
  };
  return (
    <Toolbar label="Sections" className={styles.toolbar} data-testid="sections-toolbar">
      <Button size="sm" onClick={() => run((e) => e.commands.insertPageBreak())} aria-keyshortcuts="Control+Enter" data-testid="page-break">
        Page break
      </Button>
      <Select
        label="Section columns"
        options={COLUMN_OPTIONS}
        value={columns}
        className={styles.field}
        data-testid="section-columns"
        onChange={(event) => {
          const value = event.target.value;
          run((e) => e.commands.setSectionAttrs({ columns: value === 'theme' ? null : value === '1' ? 1 : 2 }));
        }}
      />
      <Select
        label="Block type"
        options={BLOCK_OPTIONS}
        value={block}
        className={styles.field}
        data-testid="block-type"
        onChange={(event) => {
          const value = event.target.value;
          run((e) => (value === 'paragraph' ? e.commands.setParagraph() : e.commands.setHeading({ level: Number(value.slice(1)) as 1 | 2 | 3 | 4 })));
        }}
      />
    </Toolbar>
  );
}
