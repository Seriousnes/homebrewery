// What ContextMenuHost does besides rendering the menu: the actions that reach outside the editor
// (the inspector panel, the clipboard) and the menu's hint.
import type { Editor } from '@tiptap/core';
import { NodeSelection } from '@tiptap/pm/state';
import { uiStore } from '@/app/uiStore';
import { type ClipboardAction, copySelection, pasteClipboard } from './clipboard';
import { blockTarget } from './contextMenuModel';

/** Shown under the items: the way to the browser's own menu. */
export const NATIVE_MENU_HINT = 'Shift+right-click: browser menu';

/** Opens the inspector on the block at the selection (a theme block is node-selected first). */
export function showProperties(editor: Editor): void {
  if (editor.isDestroyed) return;
  const target = blockTarget(editor.state);
  const sel = editor.state.selection;
  if (target && target.node.type.name === 'themeBlock' && !(sel instanceof NodeSelection && sel.from === target.pos)) {
    editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, target.pos)));
  }
  const ui = uiStore.getState();
  ui.setInspectorTab('node');
  ui.setPanelOpen('inspector', true);
}

export function runClipboard(editor: Editor, action: ClipboardAction): void {
  if (action === 'cut' || action === 'copy') void copySelection(editor, action === 'cut');
  else void pasteClipboard(editor, action === 'pastePlain');
}
