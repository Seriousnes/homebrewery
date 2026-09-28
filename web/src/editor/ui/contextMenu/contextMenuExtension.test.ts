// HbContextMenu: which right-clicks and keys open the editor's menu (and suppress the browser's),
// and where the caret goes first. Layout-free (jsdom): posAtCoords is stubbed.
import type { Editor, JSONContent } from '@tiptap/core';
import { NodeSelection, TextSelection } from '@tiptap/pm/state';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DOC, P, PAGE, posOf, schema } from '../../pagination/testing';
import { createTestEditor, press, selectText } from '../toolbar/testing';
import { HbContextMenu, isContextMenuKey, onContextMenuRequest, selectionForContextClick, type ContextMenuRequest } from './contextMenuExtension';

const DOCUMENT = DOC(PAGE(null, P('Alpha beta gamma.'), schema.nodes.spacer!.create(), P('Delta.')));

let editor: Editor | undefined;
let host: HTMLElement | undefined;
afterEach(() => {
  editor?.destroy();
  host?.remove();
  editor = undefined;
  host = undefined;
});

function open(): { e: Editor; requests: ContextMenuRequest[] } {
  host = document.createElement('div');
  document.body.append(host);
  editor = createTestEditor(DOCUMENT.toJSON() as JSONContent, { extensions: [HbContextMenu], element: host });
  const requests: ContextMenuRequest[] = [];
  onContextMenuRequest(editor, (r) => (requests.push(r), true));
  return { e: editor, requests };
}

/** Where posAtCoords "finds" the pointer. */
function pointerAt(e: Editor, pos: number, inside = -1) {
  vi.spyOn(e.view, 'posAtCoords').mockReturnValue({ pos, inside });
}

function rightClick(e: Editor, init: MouseEventInit = {}, target: Element = e.view.dom.querySelector('p')!) {
  const opts = { bubbles: true, cancelable: true, button: 2, clientX: 40, clientY: 50, ...init };
  const down = new MouseEvent('mousedown', opts);
  target.dispatchEvent(down);
  const menu = new MouseEvent('contextmenu', opts);
  target.dispatchEvent(menu);
  return { down, menu };
}

describe('right-click', () => {
  it('opens the menu at the pointer and suppresses the browser menu; the caret moves to the click', () => {
    const { e, requests } = open();
    selectText(e, 'Delta', 1);
    const at = posOf(e.state.doc, 'beta') + 2;
    pointerAt(e, at);
    const { down, menu } = rightClick(e);
    expect(down.defaultPrevented).toBe(true); // no native caret move
    expect(menu.defaultPrevented).toBe(true);
    expect(requests).toEqual([{ x: 40, y: 50, origin: 'pointer' }]);
    expect(e.state.selection.empty).toBe(true);
    expect(e.state.selection.from).toBe(at);
  });

  it('inside the selection keeps it', () => {
    const { e, requests } = open();
    selectText(e, 'beta gamma');
    const before = e.state.selection;
    pointerAt(e, posOf(e.state.doc, 'gamma'));
    rightClick(e);
    expect(requests).toHaveLength(1);
    expect(e.state.selection.eq(before)).toBe(true);
  });

  it('Shift+right-click keeps the browser menu (not prevented, no request)', () => {
    const { e, requests } = open();
    pointerAt(e, 3);
    const { down, menu } = rightClick(e, { shiftKey: true });
    expect(down.defaultPrevented).toBe(false);
    expect(menu.defaultPrevented).toBe(false);
    expect(requests).toEqual([]);
  });

  it('a read-only editor, or one without a host, keeps the browser menu', () => {
    const { e, requests } = open();
    pointerAt(e, 3);
    e.setEditable(false);
    expect(rightClick(e).menu.defaultPrevented).toBe(false);
    expect(requests).toEqual([]);
    editor?.destroy();
    host!.innerHTML = '';
    editor = createTestEditor(DOCUMENT.toJSON() as JSONContent, { extensions: [HbContextMenu], element: host });
    pointerAt(editor, 3);
    expect(rightClick(editor).menu.defaultPrevented).toBe(false);
  });

  it('a form field inside the canvas keeps the browser menu', () => {
    const { e, requests } = open();
    pointerAt(e, 3);
    const input = document.createElement('input');
    e.view.dom.querySelector('p')!.append(input);
    const { menu } = rightClick(e, {}, input);
    input.remove();
    expect(menu.defaultPrevented).toBe(false);
    expect(requests).toEqual([]);
  });

  it('a request nobody handles leaves the browser menu', () => {
    const { e } = open();
    const storage = (e.storage as unknown as { hbContextMenu: { listeners: Set<unknown> } }).hbContextMenu;
    storage.listeners.clear();
    onContextMenuRequest(e, () => false);
    pointerAt(e, 3);
    expect(rightClick(e).menu.defaultPrevented).toBe(false);
  });
});

describe('keyboard', () => {
  it('Shift+F10 and the ContextMenu key open the menu at the caret, without moving it', () => {
    const { e, requests } = open();
    selectText(e, 'beta');
    const before = e.state.selection;
    expect(press(e, 'Shift-F10')).toBe(true);
    const menuKey = new KeyboardEvent('keydown', { key: 'ContextMenu', bubbles: true, cancelable: true });
    expect(e.view.someProp('handleKeyDown', (f) => f(e.view, menuKey))).toBe(true);
    expect(requests.map((r) => r.origin)).toEqual(['keyboard', 'keyboard']);
    expect(e.state.selection.eq(before)).toBe(true);
  });

  it('other F10 combinations are not the menu key', () => {
    const ev = (init: KeyboardEventInit) => new KeyboardEvent('keydown', init);
    expect(isContextMenuKey(ev({ key: 'F10', shiftKey: true }))).toBe(true);
    expect(isContextMenuKey(ev({ key: 'ContextMenu' }))).toBe(true);
    expect(isContextMenuKey(ev({ key: 'F10' }))).toBe(false);
    expect(isContextMenuKey(ev({ key: 'F10', shiftKey: true, altKey: true }))).toBe(false); // theme block controls
    expect(isContextMenuKey(ev({ key: 'F10', altKey: true }))).toBe(false); // the toolbar
  });

  it('a read-only editor leaves the keys alone', () => {
    const { e, requests } = open();
    e.setEditable(false);
    expect(press(e, 'Shift-F10')).toBe(false);
    expect(requests).toEqual([]);
  });
});

describe('selectionForContextClick', () => {
  const doc = DOCUMENT;
  const spacer = doc.child(0).child(0).nodeSize + 1;

  it('outside a range: a caret at the click; inside: keep', () => {
    const range = TextSelection.create(doc, posOf(doc, 'beta'), posOf(doc, 'beta') + 4);
    expect(selectionForContextClick(range, posOf(doc, 'beta') + 2, -1)).toBeNull();
    const moved = selectionForContextClick(range, posOf(doc, 'Delta'), -1);
    expect(moved?.empty).toBe(true);
    expect(moved?.from).toBe(posOf(doc, 'Delta'));
  });

  it('on an atom: node-selects it (and keeps an existing node selection of it)', () => {
    const caret = TextSelection.create(doc, 3);
    const selected = selectionForContextClick(caret, spacer, spacer);
    expect(selected).toBeInstanceOf(NodeSelection);
    expect(selected?.from).toBe(spacer);
    expect(selectionForContextClick(NodeSelection.create(doc, spacer), spacer, spacer)).toBeNull();
  });

  it('the caret where it already is: nothing to do', () => {
    expect(selectionForContextClick(TextSelection.create(doc, 3), 3, -1)).toBeNull();
  });
});
