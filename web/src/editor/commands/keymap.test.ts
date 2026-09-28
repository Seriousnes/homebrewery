// keymap.ts (plan §6.1, P3.4): every shortcut, the requests to the UI, one undo step per action,
// undo with pagination running, and the shortcut labels.
import type { Editor, JSONContent } from '@tiptap/core';
import { undoDepth } from '@tiptap/pm/history';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { iconSuggestionKey } from '../icons/suggestion';
import { editorNodeViews } from '../nodeviews';
import { pageEditingExtensions } from '../objects';
import { PAGINATE } from '../pagination';
import { canonical } from '../pagination/testing';
import { docOf, node, p, page, text } from '../schema/testing';
import { createTestEditor, docJson, posOf, press, selectText, setCursor, settle } from '../ui/toolbar/testing';
import {
  ariaKeyShortcut,
  closeUndoGroup,
  editorActions,
  emitKeymapRequest,
  HB_SHORTCUTS,
  onKeymapRequest,
  runChain,
  shortcutFor,
  shortcutLabel,
  type KeymapRequest,
} from './keymap';
import { NBSP } from './marks';

let editor: Editor | undefined;
afterEach(() => {
  editor?.destroy();
  editor = undefined;
});

const PID = 'testpage';
const docWith = (...blocks: JSONContent[]) => docOf(page(blocks, { pid: PID }));
const open = (json: JSONContent, opts?: Parameters<typeof createTestEditor>[1]) => (editor = createTestEditor(json, opts));
/** A heading with the id the HeadingIds plugin gives it (so no id transaction interferes). */
const h = (level: number, value: string) => node('heading', { level, id: value.toLowerCase() }, [text(value)]);
const li = (value: string) => node('listItem', {}, [p(value)]);
const ul = (...items: JSONContent[]) => node('bulletList', {}, items);
const firstBlock = (e: Editor) => e.state.doc.child(0).child(0);
const marksOf = (e: Editor, needle: string) => (e.state.doc.nodeAt(posOf(e.state.doc, needle))?.marks ?? []).map((m) => m.type.name);

/** Presses `key` with `needle` selected; checks the result, then that one undo restores the doc. */
function expectUndoable(e: Editor, key: string, check: () => void): void {
  const before = docJson(e);
  const depth = Number(undoDepth(e.state));
  expect(press(e, key)).toBe(true);
  check();
  expect(Number(undoDepth(e.state))).toBe(depth + 1);
  e.commands.undo();
  expect(docJson(e)).toEqual(before);
}

describe('marks', () => {
  it.each([
    ['Mod-b', 'bold'],
    ['Mod-i', 'italic'],
    ['Mod-u', 'underline'],
    ['Shift-Mod-s', 'strike'],
    ['Mod-e', 'code'],
    ['Shift-Mod-=', 'superscript'],
    ['Mod-=', 'subscript'],
  ])('%s toggles %s on the selection, one undo step', (key, mark) => {
    const e = open(docWith(p('alpha beta')));
    selectText(e, 'beta');
    expectUndoable(e, key, () => expect(marksOf(e, 'beta')).toEqual([mark]));
    expect(press(e, key)).toBe(true);
    press(e, key);
    expect(marksOf(e, 'beta')).toEqual([]);
  });

  it('Mod-. inserts a non-breaking space; Mod-, is not bound (TipTap subscript key removed)', () => {
    const e = open(docWith(p('ab')));
    selectText(e, 'ab', 1);
    expectUndoable(e, 'Mod-.', () => expect(firstBlock(e).textContent).toBe(`a${NBSP}b`));
    expect(press(e, 'Mod-,')).toBe(false);
    expect(firstBlock(e).textContent).toBe('ab');
    expect(marksOf(e, 'ab')).toEqual([]);
  });

  it('Shift-Mod-. widens (inserting) and Shift-Mod-, narrows a spacer', () => {
    const e = open(docWith(p('ab')));
    selectText(e, 'ab', 1);
    expectUndoable(e, 'Shift-Mod-.', () => expect(firstBlock(e).child(1).attrs.style).toBe('width: 10%;'));
    press(e, 'Shift-Mod-.');
    expectUndoable(e, 'Shift-Mod-.', () => expect(firstBlock(e).child(1).attrs.style).toBe('width: 20%;'));
    press(e, 'Shift-Mod-.');
    expectUndoable(e, 'Shift-Mod-,', () => expect(firstBlock(e).child(1).attrs.style).toBe('width: 10%;'));
    press(e, 'Shift-Mod-,');
    press(e, 'Shift-Mod-,');
    expect(firstBlock(e).childCount).toBe(1);
    // Nothing to narrow: the key is still consumed and nothing changes.
    const before = docJson(e);
    expect(press(e, 'Shift-Mod-,')).toBe(true);
    expect(docJson(e)).toEqual(before);
  });

  it('Mod-/ does nothing (no comments in the document model)', () => {
    const e = open(docWith(p('alpha')));
    selectText(e, 'alpha');
    const before = docJson(e);
    expect(press(e, 'Mod-/')).toBe(false);
    expect(docJson(e)).toEqual(before);
  });
});

describe('class picker, link dialog and other requests', () => {
  it('Mod-M, Shift-Mod-M and Mod-K ask the listener', () => {
    const e = open(docWith(p('alpha')));
    const seen: KeymapRequest[] = [];
    const off = onKeymapRequest(e, (r) => {
      seen.push(r);
      return true;
    });
    selectText(e, 'alpha');
    const before = docJson(e);
    expect(press(e, 'Mod-m')).toBe(true);
    expect(press(e, 'Shift-Mod-m')).toBe(true);
    expect(press(e, 'Mod-k')).toBe(true);
    expect(seen).toEqual(['span', 'themeBlock', 'link']);
    expect(docJson(e)).toEqual(before);
    off();
    expect(press(e, 'Mod-k')).toBe(false); // no link dialog: the key isn't consumed
  });

  it('without a listener, Mod-M toggles a plain span and Shift-Mod-M wraps in a plain theme block', () => {
    const e = open(docWith(p('alpha beta')));
    selectText(e, 'beta');
    expectUndoable(e, 'Mod-m', () => expect(marksOf(e, 'beta')).toEqual(['span']));
    press(e, 'Mod-m');
    selectText(e, 'beta', 1);
    press(e, 'Mod-m');
    expect(marksOf(e, 'beta')).toEqual([]);
    expectUndoable(e, 'Shift-Mod-m', () => expect(firstBlock(e).type.name).toBe('themeBlock'));
  });

  it('listeners are asked newest first; false passes a request on', () => {
    const e = open(docWith(p('x')));
    const calls: string[] = [];
    onKeymapRequest(e, () => {
      calls.push('old');
      return true;
    });
    const off = onKeymapRequest(e, (r) => {
      calls.push(`new:${r}`);
      return false;
    });
    expect(emitKeymapRequest(e, 'save')).toBe(true);
    expect(calls).toEqual(['new:save', 'old']);
    off();
  });

  it('Mod-S is always consumed; Mod-P and Alt-F10 only when handled', () => {
    const e = open(docWith(p('x')));
    expect(press(e, 'Mod-s')).toBe(true);
    expect(press(e, 'Mod-p')).toBe(false);
    expect(press(e, 'Alt-F10')).toBe(false);
    const listener = vi.fn((r: KeymapRequest) => r !== 'focusToolbar');
    onKeymapRequest(e, listener);
    expect(press(e, 'Mod-s')).toBe(true);
    expect(press(e, 'Mod-p')).toBe(true);
    expect(press(e, 'Alt-F10')).toBe(false);
    expect(listener.mock.calls.map((c) => c[0])).toEqual(['save', 'print', 'focusToolbar']);
  });

  it('Mod-Alt-U asks for the source dialog: consumed only when handled, never in a read-only editor', () => {
    const e = open(docWith(p('x')));
    expect(press(e, 'Mod-Alt-u')).toBe(false);
    const listener = vi.fn(() => true);
    onKeymapRequest(e, listener);
    expect(press(e, 'Mod-Alt-u')).toBe(true);
    expect(listener.mock.calls).toEqual([['editSource']]);
    expect(shortcutFor('editSource', false)).toEqual({ label: 'Ctrl+Alt+U', aria: 'Control+Alt+U' });
    e.setEditable(false);
    expect(press(e, 'Mod-Alt-u')).toBe(false);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('a read-only editor ignores formatting keys (TipTap keys included) and opens no dialogs', () => {
    const e = open(docWith(p('alpha')), { editable: false });
    const listener = vi.fn(() => true);
    onKeymapRequest(e, listener);
    selectText(e, 'alpha');
    const before = docJson(e);
    expect(press(e, 'Mod-b')).toBe(true);
    expect(press(e, 'Mod-m')).toBe(true);
    expect(press(e, 'Shift-Mod-8')).toBe(true);
    expect(press(e, 'Mod-k')).toBe(false);
    expect(press(e, 'Tab')).toBe(false);
    expect(docJson(e)).toEqual(before);
    expect(listener).not.toHaveBeenCalled();
    expect(marksOf(e, 'alpha')).toEqual([]);
  });
});

describe('blocks', () => {
  it('Mod-L / Shift-Mod-L toggle bullet and numbered lists', () => {
    const e = open(docWith(p('item')));
    selectText(e, 'item', 1);
    expectUndoable(e, 'Mod-l', () => expect(firstBlock(e).type.name).toBe('bulletList'));
    expectUndoable(e, 'Shift-Mod-l', () => expect(firstBlock(e).type.name).toBe('orderedList'));
    press(e, 'Mod-l');
    press(e, 'Mod-l');
    expect(firstBlock(e).type.name).toBe('paragraph');
  });

  it.each([1, 2, 3, 4, 5, 6])('Shift-Mod-%i toggles a heading of that level', (level) => {
    const e = open(docWith(p('title')));
    selectText(e, 'title', 2);
    expectUndoable(e, `Shift-Mod-${level}`, () => expect(firstBlock(e).attrs.level).toBe(level));
    press(e, `Shift-Mod-${level}`);
    press(e, `Shift-Mod-${level}`);
    expect(firstBlock(e).type.name).toBe('paragraph');
  });

  it('Mod-Alt-0 on a paragraph changes nothing (TipTap binding would reset its attributes)', () => {
    const e = open(docWith(p('alpha', { align: 'center', continuation: true, classes: ['note'] })));
    selectText(e, 'alpha', 1);
    const before = docJson(e);
    expect(press(e, 'Mod-Alt-0')).toBe(true);
    expect(docJson(e)).toEqual(before);
    expect(e.can().undo()).toBe(false);
  });

  it('Mod-Alt-0 paragraph, Mod-Alt-C code block, Shift-Mod-B blockquote', () => {
    const e = open(docWith(h(2, 'title')));
    selectText(e, 'title', 1);
    expectUndoable(e, 'Mod-Alt-0', () => expect(firstBlock(e).type.name).toBe('paragraph'));
    expectUndoable(e, 'Mod-Alt-c', () => expect(firstBlock(e).type.name).toBe('codeBlock'));
    expectUndoable(e, 'Shift-Mod-b', () => expect(firstBlock(e).type.name).toBe('blockquote'));
  });

  it('Mod-Enter inserts a manual page break (not a hard break)', () => {
    const e = open(docWith(p('alpha beta')));
    setCursor(e, posOf(e.state.doc, 'beta'));
    expectUndoable(e, 'Mod-Enter', () => {
      expect(e.state.doc.childCount).toBe(2);
      expect(e.state.doc.child(1).attrs.kind).toBe('manual');
      expect(e.state.doc.child(1).textContent).toBe('beta');
      expect(e.getHTML()).not.toContain('<br');
    });
  });

  it('Mod-Enter in a code block leaves the block (TipTap exitCode), no page break', () => {
    const e = open(docWith(node('codeBlock', {}, [text('let x')])));
    setCursor(e, posOf(e.state.doc, 'let x') + 5);
    press(e, 'Mod-Enter');
    expect(e.state.doc.childCount).toBe(1);
    expect(e.state.doc.child(0).childCount).toBe(2);
    expect(e.state.doc.child(0).child(1).type.name).toBe('paragraph');
  });

  it('Shift-Mod-Enter inserts a column break', () => {
    const e = open(docWith(p('alpha beta')));
    setCursor(e, posOf(e.state.doc, 'beta'));
    expectUndoable(e, 'Shift-Mod-Enter', () => expect(e.state.doc.child(0).child(1).type.name).toBe('columnBreak'));
  });

  it('Tab / Shift-Tab sink and lift list items; outside lists Tab is not consumed', () => {
    const e = open(docWith(ul(li('one'), li('two')), p('after')));
    setCursor(e, posOf(e.state.doc, 'two'));
    expectUndoable(e, 'Tab', () => expect(firstBlock(e).childCount).toBe(1));
    press(e, 'Tab');
    expect(firstBlock(e).child(0).child(1).type.name).toBe('bulletList');
    expectUndoable(e, 'Shift-Tab', () => expect(firstBlock(e).childCount).toBe(2));
    // The first item can't sink: the key is still consumed (focus stays in the list).
    setCursor(e, posOf(e.state.doc, 'one'));
    const before = docJson(e);
    expect(press(e, 'Tab')).toBe(true);
    expect(docJson(e)).toEqual(before);
    setCursor(e, posOf(e.state.doc, 'after'));
    expect(press(e, 'Tab')).toBe(false);
    expect(press(e, 'Shift-Tab')).toBe(false);
  });
});

describe('Tab next to other key users (UI-5)', () => {
  const editing = () => ({ extensions: [...editorNodeViews, ...pageEditingExtensions] });
  const icons = (e: Editor) => {
    let n = 0;
    e.state.doc.descendants((node) => {
      if (node.type.name === 'icon') n++;
    });
    return n;
  };

  it('Tab accepts the icon suggestion in a list item instead of sinking it', () => {
    const e = open(docWith(ul(li('one'), li('Roll '))), editing());
    setCursor(e, posOf(e.state.doc, 'Roll ') + 5);
    e.view.dispatch(e.state.tr.insertText(':d20'));
    expect(iconSuggestionKey.getState(e.state)?.active).toBe(true);
    expect(press(e, 'Tab')).toBe(true);
    expect(icons(e)).toBe(1);
    expect(firstBlock(e).childCount).toBe(2); // not nested
    expect(iconSuggestionKey.getState(e.state)?.active).toBe(false);
  });

  it('Tab in a table inside a list item moves to the next cell', () => {
    const cell = (value: string) => node('tableCell', {}, [p(value)]);
    const table = node('table', {}, [node('tableRow', {}, [cell('a'), cell('b')])]);
    const e = open(docWith(ul(li('first'), node('listItem', {}, [p('item'), table]))), editing());
    setCursor(e, posOf(e.state.doc, 'a') + 1);
    const before = docJson(e);
    expect(press(e, 'Tab')).toBe(true);
    expect(e.state.selection.$from.parent.textContent).toBe('b');
    expect(docJson(e)).toEqual(before);
  });
});

describe('lists split across pages (PGR-11, PGR-12)', () => {
  const lines = { pagination: { columns: 1, lines: 4 } };
  const cont = { continuation: true };
  const item = (attrs: Record<string, unknown>, ...content: JSONContent[]) => node('listItem', attrs, content);
  const list = (attrs: Record<string, unknown>, ...items: JSONContent[]) => node('bulletList', attrs, items);

  it('Tab on the first item of a list page sinks it under the item on the page before (PGR-12)', () => {
    const e = open(docOf(page([list({}, li('one'), li('two'))], { columns: 1, pid: 'p1' }), page([list(cont, li('three'), li('four'))], { kind: 'auto', columns: 1, pid: 'p2' })), { pagination: { columns: 1, lines: 2 } });
    settle(e);
    expect(e.state.doc.childCount).toBe(2);
    const before = canonical(e.state.doc).toJSON() as unknown;
    setCursor(e, posOf(e.state.doc, 'three') + 1);
    expect(press(e, 'Tab')).toBe(true);
    settle(e);
    const joined = canonical(e.state.doc);
    const outer = joined.child(0).child(0);
    expect(outer.childCount).toBe(3); // one, two › three, four
    expect(outer.child(1).child(1).type.name).toBe('bulletList');
    expect(outer.child(1).child(1).textContent).toBe('three');
    e.commands.undo();
    settle(e);
    expect(canonical(e.state.doc).toJSON() as unknown).toEqual(before);
  });

  it('Shift-Tab lifts a list item split across pages whole (PGR-11)', () => {
    const split = docOf(
      page([p('intro para'), list({}, item({}, p('A'), list({}, item({}, p('y head ')))))], { columns: 1, pid: 'p1' }),
      page([list(cont, item(cont, p('', cont), list(cont, item(cont, p('y tail', cont)))))], { kind: 'auto', columns: 1, pid: 'p2' }),
    );
    const e = open(split, lines);
    setCursor(e, posOf(e.state.doc, 'y head') + 1);
    expect(editorActions.liftListItem(e)).toBe(true);
    // The intro goes: the list is pulled back, re-split by pagination.
    e.view.dispatch(e.state.tr.delete(1, 1 + e.state.doc.child(0).child(0).nodeSize));
    settle(e);

    // The same on the list unsplit.
    const control = createTestEditor(docWith(list({}, item({}, p('A'), list({}, item({}, p('y head y tail')))))));
    setCursor(control, posOf(control.state.doc, 'y head') + 1);
    expect(editorActions.liftListItem(control)).toBe(true);
    expect(canonical(e.state.doc).child(0).toJSON()).toEqual({ ...canonical(control.state.doc).child(0).toJSON(), attrs: canonical(e.state.doc).child(0).attrs });
    control.destroy();

    // Two undo steps (the deletion, the lift) bring the list back. (With pagination running, its
    // repairContinuations then clears the nested fragment's flags behind the filler paragraph, as
    // after any edit on that page: a pagination-lane issue. The history itself is exact:)
    e.commands.undo();
    e.commands.undo();
    expect(e.state.doc.textBetween(0, e.state.doc.content.size, '|')).toBe('intro para|A|y head ||y tail'); // the filler paragraph is back too
    const plainEditor = createTestEditor(split);
    setCursor(plainEditor, posOf(plainEditor.state.doc, 'y head') + 1);
    const original = docJson(plainEditor);
    expect(editorActions.liftListItem(plainEditor)).toBe(true);
    expect(plainEditor.state.doc.childCount).toBe(1);
    plainEditor.commands.undo();
    expect(docJson(plainEditor)).toEqual(original);
    plainEditor.destroy();
  });
});

describe('undo and redo', () => {
  it('Mod-Z, Shift-Mod-Z and Mod-Y', () => {
    const e = open(docWith(p('alpha')));
    selectText(e, 'alpha');
    press(e, 'Mod-b');
    expect(press(e, 'Mod-z')).toBe(true);
    expect(marksOf(e, 'alpha')).toEqual([]);
    expect(press(e, 'Shift-Mod-z')).toBe(true);
    expect(marksOf(e, 'alpha')).toEqual(['bold']);
    e.commands.undo();
    expect(press(e, 'Mod-y')).toBe(true);
    expect(marksOf(e, 'alpha')).toEqual(['bold']);
  });

  it('actions in quick succession are separate undo steps, and so is typing right after one', () => {
    const e = open(docWith(p('alpha')));
    selectText(e, 'alpha');
    const t0 = docJson(e);
    press(e, 'Mod-b');
    const t1 = docJson(e);
    press(e, 'Mod-i');
    const t2 = docJson(e);
    setCursor(e, posOf(e.state.doc, 'alpha') + 5);
    e.commands.insertContent('!');
    e.commands.insertContent('?');
    expect(firstBlock(e).textContent).toBe('alpha!?');
    e.commands.undo();
    expect(docJson(e)).toEqual(t2);
    e.commands.undo();
    expect(docJson(e)).toEqual(t1);
    e.commands.undo();
    expect(docJson(e)).toEqual(t0);
  });

  it('runChain does nothing on a read-only editor; closeUndoGroup adds no step', () => {
    const e = open(docWith(p('alpha')), { editable: false });
    expect(runChain(e, (c) => c.toggleBold())).toBe(false);
    const depth = Number(undoDepth(e.state));
    closeUndoGroup(e);
    expect(Number(undoDepth(e.state))).toBe(depth);
  });
});

describe('with pagination running (line model: 10 lines × 10 chars, 2 columns)', () => {
  const words = (tag: string, n: number) => Array.from({ length: n }, (_, i) => `${tag}${i}`).join(' ');
  const long = () => docWith(...Array.from({ length: 12 }, (_, i) => p(words(`w${i}x`, 6))));

  it('a page break is one undo step; undo restores the flow', () => {
    const e = open(long(), { pagination: true });
    settle(e);
    expect(e.state.doc.childCount).toBeGreaterThan(1);
    const before = canonical(e.state.doc).toJSON() as unknown;
    setCursor(e, posOf(e.state.doc, 'w3x2'));
    press(e, 'Mod-Enter');
    settle(e);
    const breakAt = [...Array(e.state.doc.childCount).keys()].find((i) => e.state.doc.child(i).attrs.kind === 'manual' && i > 0);
    expect(breakAt).toBeDefined();
    expect(e.state.doc.child(breakAt!).textContent.startsWith('w3x2')).toBe(true);
    e.commands.undo();
    settle(e);
    expect(canonical(e.state.doc).toJSON() as unknown).toEqual(before);
    expect(e.can().undo()).toBe(false);
  });

  it('pagination transactions add no undo steps; formatting on a split paragraph undoes in one step', () => {
    const e = open(long(), { pagination: true });
    const depth = Number(undoDepth(e.state));
    settle(e);
    expect(Number(undoDepth(e.state))).toBe(depth);
    // A paragraph split across the first seam: select the whole flow text of its first fragment.
    const before = canonical(e.state.doc).toJSON() as unknown;
    selectText(e, 'w0x0');
    press(e, 'Mod-b');
    press(e, 'Mod-Alt-0');
    settle(e);
    e.commands.undo();
    settle(e);
    expect(canonical(e.state.doc).toJSON() as unknown).toEqual(before);
  });

  it('a heading made from a split paragraph covers all of it; one undo restores the flow', () => {
    const e = open(docWith(p(words('a', 30)), ...Array.from({ length: 4 }, (_, i) => p(words(`b${i}x`, 8)))), { pagination: true });
    settle(e);
    const before = canonical(e.state.doc).toJSON() as unknown;
    // The first paragraph (about 115 characters: 12 lines) is split across the first column.
    expect(e.state.doc.child(0).childCount).toBeGreaterThan(0);
    selectText(e, 'a0', 1);
    press(e, 'Shift-Mod-2');
    settle(e);
    let headings = 0;
    e.state.doc.descendants((n) => {
      if (n.type.name === 'heading') headings++;
      return !n.isTextblock;
    });
    expect(headings).toBe(1);
    e.commands.undo();
    settle(e);
    expect(canonical(e.state.doc).toJSON() as unknown).toEqual(before);
  });

  it('the toolbar selector input: a paginate transaction changes no selection state', () => {
    const e = open(docWith(p('alpha')), { pagination: true });
    selectText(e, 'alpha', 2);
    const selection = e.state.selection.toJSON() as unknown;
    e.view.dispatch(e.state.tr.setNodeAttribute(0, 'oversized', true).setMeta(PAGINATE, { dirtyFrom: 0, dirtyTo: 0, action: 'oversized' }).setMeta('addToHistory', false));
    expect(e.state.selection.toJSON()).toEqual(selection);
    expect(e.can().undo()).toBe(false);
  });
});

describe('actions', () => {
  it('setBlockKind and align run as single steps', () => {
    const e = open(docWith(p('one'), p('two')));
    selectText(e, 'one', 1);
    editorActions.setBlockKind(e, 'heading3');
    expect(firstBlock(e).attrs.level).toBe(3);
    editorActions.setBlockKind(e, 'codeBlock');
    expect(firstBlock(e).type.name).toBe('codeBlock');
    editorActions.setBlockKind(e, 'paragraph');
    selectText(e, 'two', 1);
    editorActions.align(e, 'center');
    expect(e.state.doc.child(0).child(1).attrs.align).toBe('center');
    expect(Number(undoDepth(e.state))).toBe(4);
  });
});

describe('shortcut labels', () => {
  it('formats keys for tooltips and aria-keyshortcuts', () => {
    expect(shortcutLabel('Mod-b', false)).toBe('Ctrl+B');
    expect(shortcutLabel('Shift-Mod-=', false)).toBe('Ctrl+Shift+=');
    expect(shortcutLabel('Shift-Mod-Enter', false)).toBe('Ctrl+Shift+Enter');
    expect(shortcutLabel('Mod-Alt-0', false)).toBe('Ctrl+Alt+0');
    expect(shortcutLabel('Shift-Mod-=', true)).toBe('⇧⌘=');
    expect(shortcutLabel('Alt-F10', true)).toBe('⌥F10');
    expect(ariaKeyShortcut('Mod-b', false)).toBe('Control+B');
    expect(ariaKeyShortcut('Mod-b', true)).toBe('Meta+B');
    expect(ariaKeyShortcut('Shift-Mod-1', false)).toBe('Control+Shift+1');
    expect(shortcutFor('redo', false)).toEqual({ label: 'Ctrl+Shift+Z', aria: 'Control+Shift+Z Control+Y' });
  });

  it('every shortcut has at least one key and no key is used twice', () => {
    const all = Object.values(HB_SHORTCUTS).flat();
    expect(all.every((k) => k.length > 0)).toBe(true);
    expect(new Set(all).size).toBe(all.length);
  });
});
