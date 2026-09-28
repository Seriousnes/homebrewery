// Opens the source dialog on the keymap's 'editSource' request (its shortcut, the app bar's
// Source button, the context menu). The dialog and CodeMirror's HTML language load on first use.
import type { Editor } from '@tiptap/core';
import { lazy, Suspense, useEffect, useState } from 'react';
import { onKeymapRequest } from '@/editor/commands/keymap';

const SourceEditorDialog = lazy(() => import('./SourceEditorDialog').then((m) => ({ default: m.SourceEditorDialog })));

export function SourceEditorHost({ editor }: { editor: Editor | null }) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!editor) return;
    return onKeymapRequest(editor, (request) => {
      if (request !== 'editSource' || !editor.isEditable) return false;
      setOpen(true);
      return true;
    });
  }, [editor]);

  if (!editor || !open) return null;
  return (
    <Suspense fallback={null}>
      <SourceEditorDialog editor={editor} open onOpenChange={setOpen} />
    </Suspense>
  );
}
