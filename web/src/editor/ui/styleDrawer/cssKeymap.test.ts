// The Style drawer's keys, ported from legacy customKeyMaps.js (generalKeymap and cssKeymap).
import { history } from '@codemirror/commands';
import { EditorState } from '@codemirror/state';
import { EditorView, runScopeHandlers } from '@codemirror/view';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cssKeymap, generalKeymap } from './cssKeymap';

// jsdom has no layout: CodeMirror's line commands ask ranges for rects.
const proto = Range.prototype as Partial<Pick<Range, 'getClientRects' | 'getBoundingClientRect'>>;
proto.getClientRects ??= () => Object.assign([], { item: () => null });
const emptyRect = { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0, toJSON: () => ({}) } as DOMRect;
proto.getBoundingClientRect ??= () => emptyRect;

let view: EditorView | null = null;
afterEach(() => {
  view?.destroy();
  view = null;
});

function make(doc: string, anchor: number, head = anchor, format = vi.fn(() => true)) {
  view = new EditorView({
    state: EditorState.create({ doc, selection: { anchor, head }, extensions: [history(), generalKeymap, cssKeymap(format)] }),
    parent: document.body,
  });
  return { view, format };
}

/** Sends a key to CodeMirror's keymaps (jsdom has no platform: Mod is Ctrl). */
function press(v: EditorView, key: string, code: string, keyCode: number, mods: Partial<Record<'ctrlKey' | 'shiftKey' | 'altKey', boolean>> = {}): boolean {
  return runScopeHandlers(v, new KeyboardEvent('keydown', { key, code, keyCode, bubbles: true, ...mods }), 'editor');
}

describe('cssKeymap', () => {
  it('Mod-Shift-F and Alt-Shift-F run the formatter', () => {
    const { view: v, format } = make('.a{b:c}', 0);
    expect(press(v, 'F', 'KeyF', 70, { ctrlKey: true, shiftKey: true })).toBe(true);
    expect(press(v, 'F', 'KeyF', 70, { altKey: true, shiftKey: true })).toBe(true);
    expect(format).toHaveBeenCalledTimes(2);
  });
});

describe('generalKeymap', () => {
  it('Tab inserts a tab at the cursor and indents a multi-line selection; Shift-Tab outdents', () => {
    const { view: v } = make('a\nb', 1);
    expect(press(v, 'Tab', 'Tab', 9)).toBe(true);
    expect(v.state.doc.toString()).toBe('a\t\nb');
    v.dispatch({ selection: { anchor: 0, head: v.state.doc.length } });
    press(v, 'Tab', 'Tab', 9);
    expect(v.state.doc.toString()).toBe('  a\t\n  b');
    press(v, 'Tab', 'Tab', 9, { shiftKey: true });
    expect(v.state.doc.toString()).toBe('a\t\nb');
  });

  it('Mod-D deletes the line; Mod-Z undoes; Mod-Y and Mod-Shift-Z redo', () => {
    const { view: v } = make('one\ntwo\nthree', 5);
    expect(press(v, 'd', 'KeyD', 68, { ctrlKey: true })).toBe(true);
    expect(v.state.doc.toString()).toBe('one\nthree');
    press(v, 'z', 'KeyZ', 90, { ctrlKey: true });
    expect(v.state.doc.toString()).toBe('one\ntwo\nthree');
    press(v, 'y', 'KeyY', 89, { ctrlKey: true });
    expect(v.state.doc.toString()).toBe('one\nthree');
    press(v, 'z', 'KeyZ', 90, { ctrlKey: true });
    press(v, 'Z', 'KeyZ', 90, { ctrlKey: true, shiftKey: true });
    expect(v.state.doc.toString()).toBe('one\nthree');
  });
});
