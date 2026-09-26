// Page-level shortcuts of the composed editor (plan §6.1):
// - Mod-S: HbKeymap raises a 'save' request while the editor has focus; `onSave` answers it
//   (autosave.saveNow). Outside the editor, autosave's own window listener saves; with
//   `saveKeyOnWindow` (pages that never save) this hook takes Mod-S there instead, so the
//   browser's "Save page" dialog doesn't open.
// - Mod-P: the keymap's 'print' request in the editor, and a window listener everywhere else on
//   the page (a read-only editor never has focus), both calling `onPrint` (the canvas print).
import type { Editor } from '@tiptap/core';
import { useEffect, useRef } from 'react';
import { onKeymapRequest } from '@/editor/commands/keymap';
import { isSaveShortcut } from '@/editor/save';
import { isPrintShortcut } from './editorAppModel';

export interface EditorShortcutsOptions {
  editor: Editor | null;
  onSave: () => void;
  onPrint: () => void;
  /** Also handle Mod-S on the window (default false: autosave's listener does it). */
  saveKeyOnWindow?: boolean;
}

export function useEditorShortcuts({ editor, onSave, onPrint, saveKeyOnWindow = false }: EditorShortcutsOptions): void {
  const latest = useRef({ onSave, onPrint });
  useEffect(() => {
    latest.current = { onSave, onPrint };
  });

  useEffect(() => {
    if (!editor) return;
    return onKeymapRequest(editor, (request) => {
      if (request === 'save') {
        latest.current.onSave();
        return true;
      }
      if (request === 'print') {
        latest.current.onPrint();
        return true;
      }
      return false;
    });
  }, [editor]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (isPrintShortcut(event)) {
        event.preventDefault();
        latest.current.onPrint();
      } else if (saveKeyOnWindow && isSaveShortcut(event)) {
        event.preventDefault();
        latest.current.onSave();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [saveKeyOnWindow]);
}
