import type { Editor } from '@tiptap/core';
import { useEditorState } from '@tiptap/react';
import { type ToolbarState, toolbarStateOf } from './toolbarState';

/**
 * The toolbar's view of the editor. Re-renders only when the selected state changes (deep
 * equality), so pagination's transactions never re-render the toolbar.
 */
export function useToolbarState(editor: Editor): ToolbarState {
  return useEditorState({ editor, selector: ({ editor: e }) => toolbarStateOf(e) });
}
