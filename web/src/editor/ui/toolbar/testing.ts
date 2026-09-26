// Test helpers for the keymap, commands and toolbar (Vitest, jsdom). Not used by the app.
import { Editor, type AnyExtension, type JSONContent } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { NodeSelection, TextSelection } from '@tiptap/pm/state';
import { hbKeymapExtensions } from '../../commands/keymap';
import { buildEditorExtensions } from '../../editorExtensions';
import { Pagination, settleNow } from '../../pagination';
import { lineLayout, type LineMeasure } from '../../pagination/testing';

export interface TestEditorOptions {
  /** Extra extensions (after the keymap ones). */
  extensions?: AnyExtension[];
  /** Adds the paginator with the line-model layout (settle with settle(editor)). */
  pagination?: boolean | { lines?: number; chars?: number; columns?: number };
  editable?: boolean;
  /** Mount the editor in this element (attached, so focus works). */
  element?: HTMLElement;
}

/** A headless editor: schema, history, the keymap extensions (and optionally pagination). */
export function createTestEditor(content: JSONContent, opts: TestEditorOptions = {}): Editor {
  const extensions: AnyExtension[] = [...hbKeymapExtensions];
  if (opts.pagination) {
    const line = typeof opts.pagination === 'object' ? opts.pagination : {};
    extensions.push(
      Pagination.configure({
        layout: (view) => {
          const layout = lineLayout(() => view.state.doc, line);
          return {
            measure: (page) => layout.measure(page),
            chooseCut: (page, m) => layout.chooseCut(page, m as LineMeasure),
            pullTarget: (page, m, next) => layout.pullTarget(page, m as LineMeasure, next),
          };
        },
        requestFrame: () => 0,
        cancelFrame: () => {},
      }),
    );
  }
  extensions.push(...(opts.extensions ?? []));
  return new Editor({
    extensions: buildEditorExtensions({ extensions }),
    content,
    editable: opts.editable ?? true,
    ...(opts.element ? { element: opts.element } : {}),
  });
}

/** Runs pagination to the end (the editor must have been created with `pagination`). */
export function settle(editor: Editor): void {
  settleNow(editor.view);
}

const SHIFTED: Record<string, string> = { '=': '+', '.': '>', ',': '<', '/': '?', '1': '!', '2': '@', '3': '#', '4': '$', '5': '%', '6': '^', '7': '&', '8': '*', '0': ')' };
const KEY_CODES: Record<string, number> = { '=': 187, '.': 190, ',': 188, '/': 191, Enter: 13, Tab: 9, F10: 121, Escape: 27 };

/**
 * A keydown event for a ProseMirror key name ("Shift-Mod-=") as a US keyboard sends it: `key`
 * is the shifted character, `keyCode` the physical key (prosemirror-keymap falls back to it).
 * Mod is Ctrl (jsdom's navigator.platform is not a Mac).
 */
export function keyEvent(name: string): KeyboardEvent {
  const parts = name.split(/-(?!$)/);
  const base = parts.pop() ?? '';
  const mods = new Set(parts);
  const shift = mods.has('Shift');
  const key = shift && base.length === 1 ? (SHIFTED[base] ?? base.toUpperCase()) : base;
  const event = new KeyboardEvent('keydown', {
    key,
    ctrlKey: mods.has('Mod') || mods.has('Ctrl'),
    shiftKey: shift,
    altKey: mods.has('Alt'),
    metaKey: mods.has('Meta'),
    bubbles: true,
    cancelable: true,
  });
  const keyCode = KEY_CODES[base] ?? (base.length === 1 ? base.toUpperCase().charCodeAt(0) : 0);
  Object.defineProperty(event, 'keyCode', { value: keyCode });
  Object.defineProperty(event, 'which', { value: keyCode });
  return event;
}

/** Sends a key through the editor's keymaps. true when a handler consumed it. */
export function press(editor: Editor, name: string): boolean {
  const event = keyEvent(name);
  return editor.view.someProp('handleKeyDown', (f) => f(editor.view, event)) === true;
}

/** Position right before the first character of `needle` (throws when absent). */
export function posOf(doc: PMNode, needle: string, occurrence = 0): number {
  let found = -1;
  let seen = 0;
  doc.descendants((node, pos) => {
    if (found >= 0) return false;
    if (node.isText) {
      let index = node.text!.indexOf(needle);
      while (index >= 0) {
        if (seen === occurrence) {
          found = pos + index;
          return false;
        }
        seen++;
        index = node.text!.indexOf(needle, index + 1);
      }
    }
    return true;
  });
  if (found < 0) throw new Error(`"${needle}" not found`);
  return found;
}

/** Selects `needle` (or puts the cursor at `offset` inside it when offset is given). */
export function selectText(editor: Editor, needle: string, offset?: number): void {
  const from = posOf(editor.state.doc, needle);
  const selection =
    offset === undefined
      ? TextSelection.create(editor.state.doc, from, from + needle.length)
      : TextSelection.create(editor.state.doc, from + offset);
  editor.view.dispatch(editor.state.tr.setSelection(selection));
}

/** Puts the cursor at a document position. */
export function setCursor(editor: Editor, pos: number): void {
  editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, pos)));
}

/** Selects the node at `pos`. */
export function selectNode(editor: Editor, pos: number): void {
  editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, pos)));
}

/** The document's JSON with page pids removed (pids are assigned per editor). */
export function docJson(editor: Editor): JSONContent {
  const json = editor.getJSON();
  const strip = (node: JSONContent) => {
    if (node.type === 'page' && node.attrs) {
      const { pid: _pid, ...attrs } = node.attrs;
      node.attrs = attrs;
    }
    node.content?.forEach(strip);
  };
  strip(json);
  return json;
}
