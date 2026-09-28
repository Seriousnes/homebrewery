// The editor's right-click menu (see contextMenuExtension.ts for when it opens): the UI kit's
// ContextMenu at the pointer, or at the caret from the keyboard, with the entries of
// contextMenuModel.ts. Mount it once next to an editable editor that has HbContextMenu:
//
//   <ContextMenuHost editor={editor} />
//
// The entries are read from the editor state when the menu opens. Picking an item, Escape or Tab
// returns the focus to the editor (before the action runs, so dialogs it opens return there too);
// a click elsewhere leaves the focus where the click put it.
import type { Editor } from '@tiptap/core';
import { useEffect, useState } from 'react';
import { ContextMenu, type MenuEntry } from '@/ui';
import { tableMenuContext } from '../tableMenu/tableMenuContext';
import { tableMenuEntries } from '../tableMenu/tableMenuEntries';
import { textStyleEntries } from '../toolbar/textStyles';
import { onContextMenuRequest } from './contextMenuExtension';
import { contextMenuContext, contextMenuEntries, type ContextMenuDeps } from './contextMenuModel';
import { NATIVE_MENU_HINT, runClipboard, showProperties } from './hostActions';

export interface ContextMenuHostProps {
  editor: Editor | null;
  'data-testid'?: string;
}

interface OpenMenu {
  /** Counts the openings: a new menu is a new list (focus on its first item). */
  n: number;
  point: { x: number; y: number };
  items: MenuEntry[];
}

export function ContextMenuHost({ editor, 'data-testid': testId = 'editor-context-menu' }: ContextMenuHostProps) {
  const [menu, setMenu] = useState<OpenMenu | null>(null);

  useEffect(() => {
    if (!editor) return undefined;
    const unsubscribe = onContextMenuRequest(editor, ({ x, y }) => {
      if (editor.isDestroyed || !editor.isEditable) return false;
      const ctx = contextMenuContext(editor.state);
      const deps: ContextMenuDeps = {
        clipboard: (action) => runClipboard(editor, action),
        properties: () => showProperties(editor),
        textStyles: textStyleEntries(editor),
        ...(ctx.inTable ? { table: tableMenuEntries(editor, tableMenuContext(editor.state)) } : {}),
      };
      const items = contextMenuEntries(editor, ctx, deps);
      setMenu((prev) => ({ n: (prev?.n ?? 0) + 1, point: { x, y }, items }));
      return true;
    });
    return () => {
      unsubscribe();
      setMenu(null);
    };
  }, [editor]);

  if (!editor || !menu) return null;
  return (
    <ContextMenu
      key={menu.n}
      items={menu.items}
      point={menu.point}
      label="Editing"
      footer={NATIVE_MENU_HINT}
      onClose={(returnFocus) => {
        setMenu(null);
        if (returnFocus && !editor.isDestroyed) editor.view.focus();
      }}
      data-testid={testId}
    />
  );
}
