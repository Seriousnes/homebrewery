import type { Editor } from '@tiptap/core';
import { emitKeymapRequest } from '@/editor/commands/keymap';

/** Asks the editor's host (SourceEditorHost) to open the source dialog; true when one did. */
export const openSourceEditor = (editor: Editor): boolean => editor.isEditable && emitKeymapRequest(editor, 'editSource');
