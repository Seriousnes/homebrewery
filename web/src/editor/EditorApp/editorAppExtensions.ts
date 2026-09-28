// The extension sets of the composed editor (plan §3–§6). EditorCanvas already adds the schema,
// NodeViews (pages, tables, images, theme blocks, TOC, header rows, caret blocks), canvas state,
// paste cleanup and column navigation; these come on top. Build them once per canvas gate
// (useMemo): a new array re-creates the editor from its initial content.
import { Extension, type AnyExtension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { CanvasGate } from '@/editor/canvas/canvasState';
import { hbKeymapExtensions } from '@/editor/commands/keymap';
import { pageEditingExtensions } from '@/editor/objects';
import { paginatedExtensions } from '@/editor/paginatedExtensions';
import { HbContextMenu } from '@/editor/ui/contextMenu/contextMenuExtension';

/** The accessible name of the editor's root (TipTap gives it role="textbox" without one). */
export const EDITOR_LABEL = 'Brew pages';

/**
 * How to reach the editor's controls from the text (P8.2): read by screen readers as the editor's
 * description (EditorApp renders it, visually hidden, and passes its id as `describedBy`).
 */
export const EDITOR_KEYBOARD_HINT =
  'Alt+F10 moves to the editing toolbar; Escape comes back to the text. Shift+Alt+F10 moves to the controls of the table or theme block at the caret. In lists Tab indents and in tables it moves between cells; elsewhere Shift+Tab reaches the toolbars and Tab the panels.';

export interface EditorAccessibilityOptions {
  label: string;
  readOnly: boolean;
  /** The id of an element that describes the editor (aria-describedby), e.g. its keyboard hint. */
  describedBy: string | null;
}

export const editorAccessibilityKey = new PluginKey('hbEditorAccessibility');

/**
 * Names the editor's root element and marks a read-only one (aria-readonly). ProseMirror keeps
 * attributes from its `attributes` prop in sync with the DOM.
 */
export const EditorAccessibility = Extension.create<EditorAccessibilityOptions>({
  name: 'hbEditorAccessibility',
  addOptions() {
    return { label: EDITOR_LABEL, readOnly: false, describedBy: null };
  },
  addProseMirrorPlugins() {
    const attrs: Record<string, string> = { 'aria-label': this.options.label };
    if (this.options.readOnly) attrs['aria-readonly'] = 'true';
    else attrs['aria-multiline'] = 'true';
    if (this.options.describedBy) attrs['aria-describedby'] = this.options.describedBy;
    return [new Plugin({ key: editorAccessibilityKey, props: { attributes: attrs } })];
  },
});

/**
 * The editable editor: keymap (§6.1), pagination with sections, seam editing and history-safe
 * block types (§4), page objects, icon autocomplete and definition-list keys (§4.9, §6.6), and
 * the right-click menu.
 */
export function editingExtensions(gate: CanvasGate, label = EDITOR_LABEL, describedBy: string | null = null): AnyExtension[] {
  return [
    ...hbKeymapExtensions,
    ...paginatedExtensions({ gate }),
    ...pageEditingExtensions,
    HbContextMenu,
    EditorAccessibility.configure({ label, readOnly: false, describedBy }),
  ];
}

/** The read-only editor (share page): pagination on, nothing that edits. */
export function viewingExtensions(gate: CanvasGate, label = EDITOR_LABEL): AnyExtension[] {
  return [...paginatedExtensions({ gate }), EditorAccessibility.configure({ label, readOnly: true, describedBy: null })];
}
