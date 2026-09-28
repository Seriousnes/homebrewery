// blocks.ts: read-outs for the toolbar, alignment, column breaks, the manual page break stand-in,
// theme-block wrapping (plan §6.1, §6.2).
import type { Editor, JSONContent } from '@tiptap/core';
import { undoDepth } from '@tiptap/pm/history';
import type { Node as PMNode } from '@tiptap/pm/model';
import { AttrStep } from '@tiptap/pm/transform';
import type { Command, Transaction } from '@tiptap/pm/state';
import { afterEach, describe, expect, it } from 'vitest';
import { docOf, node, p, page, text } from '../schema/testing';
import { createTestEditor, posOf, selectNode, selectText, setCursor } from '../ui/toolbar/testing';
import {
  alignOf,
  blockKindOf,
  headingKind,
  inBlockquote,
  inListItem,
  insertColumnBreak,
  kindLevel,
  kindType,
  listKindOf,
  setAlign,
  setTextBlockKind,
  setTextStyle,
  themeBlockAt,
  themeBoxesAt,
  toggleTextBlockKind,
  toggleThemeBox,
  unwrapThemeBlock,
  wrapInThemeBlock,
} from './blocks';
import { mountPaginated, type MountedEditor } from '../pagination/testEditor';
import { DD, DL, DOC, DT, P, PAGE, canonical, pageTexts, posOf as posIn } from '../pagination/testing';
import { runChain } from './keymap';

let editor: Editor | undefined;
afterEach(() => {
  editor?.destroy();
  editor = undefined;
});

const PID = 'testpage';
const docWith = (...blocks: JSONContent[]) => docOf(page(blocks, { pid: PID }));
const open = (json: JSONContent) => (editor = createTestEditor(json));
const run = (e: Editor, cmd: Command): boolean => cmd(e.state, (tr) => e.view.dispatch(tr));
const h = (level: number, value: string, attrs: Record<string, unknown> = {}) => node('heading', { level, ...attrs }, [text(value)]);
const li = (...content: JSONContent[]) => node('listItem', {}, content);
const ul = (...items: JSONContent[]) => node('bulletList', {}, items);
const quote = (...content: JSONContent[]) => node('blockquote', {}, content);
const block = (classes: string[], ...content: JSONContent[]) => node('themeBlock', { classes }, content);

/** Page contents as nested [type, text | children] for compact assertions. */
function shape(e: Editor): unknown[] {
  const walk = (n: PMNode): unknown =>
    n.isTextblock ? [n.type.name, n.textContent] : n.isAtom ? n.type.name : [n.type.name, ...mapChildren(n)];
  const mapChildren = (n: PMNode) => {
    const out: unknown[] = [];
    n.forEach((c) => out.push(walk(c)));
    return out;
  };
  return mapChildren(e.state.doc).map((pg) => (pg as unknown[]).slice(1));
}

describe('read-outs', () => {
  it('block kind, list kind, blockquote, list item', () => {
    const e = open(docWith(p('para'), h(2, 'head'), node('codeBlock', {}, [text('code')]), ul(li(p('item'))), quote(p('quoted'))));
    selectText(e, 'para', 1);
    expect(blockKindOf(e.state)).toBe('paragraph');
    selectText(e, 'head', 1);
    expect(blockKindOf(e.state)).toBe('heading2');
    selectText(e, 'code', 1);
    expect(blockKindOf(e.state)).toBe('codeBlock');
    e.commands.setTextSelection({ from: posOf(e.state.doc, 'para'), to: posOf(e.state.doc, 'head') + 2 });
    expect(blockKindOf(e.state)).toBe('mixed');
    selectText(e, 'item', 1);
    expect([listKindOf(e.state), inListItem(e.state), inBlockquote(e.state)]).toEqual(['bulletList', true, false]);
    selectText(e, 'quoted', 1);
    expect([listKindOf(e.state), inListItem(e.state), inBlockquote(e.state)]).toEqual([null, false, true]);
  });

  it('block kind of definition list parts is definitionList; of a selected atom null', () => {
    const e = open(docWith(node('definitionList', {}, [node('definitionTerm', {}, [text('Term')]), node('definitionDesc', {}, [text('Desc')])]), node('columnBreak'), p('x')));
    selectText(e, 'Term', 1);
    expect(blockKindOf(e.state)).toBe('definitionList');
    const breakPos = e.state.doc.child(0).child(0).nodeSize + 1;
    selectNode(e, breakPos);
    expect(blockKindOf(e.state)).toBeNull();
  });

  it('kind helpers', () => {
    const e = open(docWith(p('x')));
    expect(kindType(e.schema, 'heading2')).toEqual({ type: e.schema.nodes.heading, attrs: { level: 2 } });
    expect(kindType(e.schema, 'codeBlock')?.attrs).toBeNull();
    expect(headingKind(3)).toBe('heading3');
    expect(headingKind(9)).toBe('heading6');
    expect(kindLevel('heading4')).toBe(4);
    expect(kindLevel('codeBlock')).toBeNull();
  });
});

describe('alignment', () => {
  it('reads and sets the align of the selected paragraphs with attribute steps', () => {
    const e = open(docWith(p('one', { align: 'center' }), h(1, 'title'), p('two')));
    selectText(e, 'one', 1);
    expect(alignOf(e.state)).toBe('center');
    selectText(e, 'title', 1);
    expect(alignOf(e.state)).toBeUndefined();
    expect(setAlign('right')(e.state)).toBe(false);
    e.commands.setTextSelection({ from: posOf(e.state.doc, 'one'), to: posOf(e.state.doc, 'two') + 1 });
    expect(alignOf(e.state)).toBe('mixed');
    let seen: Transaction | undefined;
    setAlign('right')(e.state, (tr) => {
      seen = tr;
      e.view.dispatch(tr);
    });
    expect(seen!.steps.every((s) => s instanceof AttrStep)).toBe(true);
    expect(alignOf(e.state)).toBe('right');
    expect(e.state.doc.child(0).child(1).attrs.align).toBeUndefined(); // the heading has none
    run(e, setAlign(null));
    expect(alignOf(e.state)).toBeNull();
  });
});

describe('block type changes (over commands/blockType.ts)', () => {
  it('a list item paragraph lifts out of the list to become a heading', () => {
    const e = open(docWith(node('bulletList', {}, [node('listItem', {}, [p('item')])])));
    selectText(e, 'item', 1);
    expect(e.commands.command(setTextBlockKind('heading2'))).toBe(true);
    expect(shape(e)).toEqual([[['heading', 'item']]]);
  });


  it('keep the attributes both types have (classes, style); headings have no align', () => {
    const e = open(docWith(p('alpha', { classes: ['note'], style: 'color: red;', align: 'center', attributes: { title: 't' } })));
    selectText(e, 'alpha', 1);
    expect(e.commands.command(setTextBlockKind('heading2'))).toBe(true);
    expect(e.state.doc.child(0).child(0).attrs).toMatchObject({ level: 2, classes: ['note'], style: 'color: red;', attributes: { title: 't' } });
    e.commands.command(setTextBlockKind('heading4'));
    expect(e.state.doc.child(0).child(0).attrs.level).toBe(4);
    e.commands.command(setTextBlockKind('paragraph'));
    expect(e.state.doc.child(0).child(0).attrs).toMatchObject({ classes: ['note'], style: 'color: red;', align: null, id: null, continuation: false });
  });

  it('is a no-op (false, no step) when the blocks already have the kind', () => {
    const e = open(docWith(p('alpha', { align: 'right' })));
    selectText(e, 'alpha', 1);
    expect(e.can().command(setTextBlockKind('paragraph'))).toBe(false);
    expect(e.can().command(toggleTextBlockKind('paragraph'))).toBe(false);
    expect(e.commands.command(setTextBlockKind('paragraph'))).toBe(false);
    expect(e.state.doc.child(0).child(0).attrs.align).toBe('right');
  });

  it('toggles a heading back to a paragraph; heading ids: generated ones go, author ids stay custom', () => {
    const e = open(docWith(node('heading', { level: 1, id: 'title' }, [text('Title')]), p('intro', { id: 'intro-para' })));
    selectText(e, 'Title', 1);
    e.commands.command(toggleTextBlockKind('heading1'));
    expect(e.state.doc.child(0).child(0).type.name).toBe('paragraph');
    expect(e.state.doc.child(0).child(0).attrs.id).toBeNull();
    selectText(e, 'intro', 1);
    e.commands.command(toggleTextBlockKind('heading3'));
    expect(e.state.doc.child(0).child(1).attrs).toMatchObject({ level: 3, id: 'intro-para', customId: true });
  });

  it('converts every selected text block, leaving definition list parts alone', () => {
    const e = open(docWith(p('one'), node('definitionList', {}, [node('definitionTerm', {}, [text('Term')]), node('definitionDesc', {}, [text('Desc')])]), p('two')));
    e.commands.setTextSelection({ from: posOf(e.state.doc, 'one'), to: posOf(e.state.doc, 'two') + 3 });
    e.commands.command(setTextBlockKind('codeBlock'));
    expect(shape(e)).toEqual([[['codeBlock', 'one'], ['definitionList', ['definitionTerm', 'Term'], ['definitionDesc', 'Desc']], ['codeBlock', 'two']]]);
  });
});

describe('insertColumnBreak', () => {
  it('splits a paragraph in the middle, the second part is no continuation', () => {
    const e = open(docWith(p('alpha beta', { continuation: true, align: 'center' })));
    selectText(e, 'beta');
    e.commands.setTextSelection(posOf(e.state.doc, 'beta'));
    expect(run(e, insertColumnBreak)).toBe(true);
    expect(shape(e)).toEqual([[['paragraph', 'alpha '], 'columnBreak', ['paragraph', 'beta']]]);
    const page0 = e.state.doc.child(0);
    expect(page0.child(0).attrs.continuation).toBe(true);
    expect(page0.child(2).attrs).toMatchObject({ continuation: false, align: 'center' });
    expect(e.state.selection.from).toBe(posOf(e.state.doc, 'beta'));
  });

  it('goes before a block at its start and after it at its end (with a paragraph for the cursor)', () => {
    const e = open(docWith(p('first'), p('second')));
    setCursor(e, posOf(e.state.doc, 'second'));
    run(e, insertColumnBreak);
    expect(shape(e)).toEqual([[['paragraph', 'first'], 'columnBreak', ['paragraph', 'second']]]);
    setCursor(e, posOf(e.state.doc, 'second') + 6);
    run(e, insertColumnBreak);
    expect(shape(e)).toEqual([[['paragraph', 'first'], 'columnBreak', ['paragraph', 'second'], 'columnBreak', ['paragraph', '']]]);
    expect(e.state.selection.$from.parent.content.size).toBe(0);
    setCursor(e, posOf(e.state.doc, 'first') + 5);
    run(e, insertColumnBreak);
    expect(shape(e)[0]).toEqual([['paragraph', 'first'], 'columnBreak', 'columnBreak', ['paragraph', 'second'], 'columnBreak', ['paragraph', '']]);
  });

  it('replaces the selection, and splits a list item paragraph inside the item', () => {
    const e = open(docWith(ul(li(p('one two three')))));
    selectText(e, 'two ');
    run(e, insertColumnBreak);
    expect(shape(e)).toEqual([[['bulletList', ['listItem', ['paragraph', 'one '], 'columnBreak', ['paragraph', 'three']]]]]);
  });

  it('at the start of a list item, goes before the whole list when the item cannot hold it first', () => {
    const e = open(docWith(p('intro'), ul(li(p('one')), li(p('two')))));
    setCursor(e, posOf(e.state.doc, 'one'));
    run(e, insertColumnBreak);
    expect(shape(e)).toEqual([[['paragraph', 'intro'], 'columnBreak', ['bulletList', ['listItem', ['paragraph', 'one']], ['listItem', ['paragraph', 'two']]]]]);
  });
});

describe('theme blocks', () => {
  it('wraps the selected blocks and unwraps them again', () => {
    const e = open(docWith(p('one'), p('two'), p('three')));
    e.commands.setTextSelection({ from: posOf(e.state.doc, 'one') + 1, to: posOf(e.state.doc, 'two') + 1 });
    expect(run(e, wrapInThemeBlock(['note', 'page']))).toBe(true);
    expect(shape(e)).toEqual([[['themeBlock', ['paragraph', 'one'], ['paragraph', 'two']], ['paragraph', 'three']]]);
    expect(e.state.doc.child(0).child(0).attrs.classes).toEqual(['note']);
    selectText(e, 'two', 1);
    expect(themeBlockAt(e.state)?.node.attrs.classes).toEqual(['note']);
    expect(run(e, unwrapThemeBlock)).toBe(true);
    expect(shape(e)).toEqual([[['paragraph', 'one'], ['paragraph', 'two'], ['paragraph', 'three']]]);
    expect(unwrapThemeBlock(e.state)).toBe(false);
  });

  it('nests inside a theme block and wraps a whole list from a list item', () => {
    const e = open(docWith(block(['monster'], p('name'), p('stats')), ul(li(p('item')))));
    selectText(e, 'stats', 1);
    run(e, wrapInThemeBlock(['descriptive']));
    expect(shape(e)[0]).toEqual([['themeBlock', ['paragraph', 'name'], ['themeBlock', ['paragraph', 'stats']]], ['bulletList', ['listItem', ['paragraph', 'item']]]]);
    selectText(e, 'stats', 1);
    expect(themeBlockAt(e.state)?.node.attrs.classes).toEqual(['descriptive']);
    selectText(e, 'item', 1);
    run(e, wrapInThemeBlock(['wide']));
    expect(shape(e)[0]).toEqual([['themeBlock', ['paragraph', 'name'], ['themeBlock', ['paragraph', 'stats']]], ['themeBlock', ['bulletList', ['listItem', ['paragraph', 'item']]]]]);
  });

  it('a selection across pages wraps the part on its first page', () => {
    const e = open(docOf(page([p('one'), p('two')], { pid: PID }), page([p('three')], { pid: 'second00', kind: 'auto' })));
    e.commands.setTextSelection({ from: posOf(e.state.doc, 'two') + 1, to: posOf(e.state.doc, 'three') + 2 });
    run(e, wrapInThemeBlock([]));
    expect(shape(e)).toEqual([[['paragraph', 'one'], ['themeBlock', ['paragraph', 'two']]], [['paragraph', 'three']]]);
  });
});

describe('text styles: definition lists', () => {
  const dl = (...items: [string, string][]) =>
    node('definitionList', {}, items.flatMap(([t, d]) => [node('definitionTerm', {}, t ? [text(t)] : []), node('definitionDesc', {}, d ? [text(d)] : [])]));
  const style = (e: Editor, kind: Parameters<typeof setTextStyle>[0]) => runChain(e, (c) => c.command(setTextStyle(kind)));

  it('a paragraph becomes a term and a description, split at "::"; the caret ends the description', () => {
    const e = open(docWith(p('Armor Class :: 15 (natural armor)'), p('after')));
    selectText(e, 'Armor', 2);
    expect(style(e, 'definitionList')).toBe(true);
    expect(shape(e)).toEqual([[['definitionList', ['definitionTerm', 'Armor Class'], ['definitionDesc', '15 (natural armor)']], ['paragraph', 'after']]]);
    expect(e.state.selection.$from.parent.type.name).toBe('definitionDesc');
    expect(e.state.selection.$from.parentOffset).toBe('15 (natural armor)'.length);
    expect(blockKindOf(e.state)).toBe('definitionList');
    expect(e.can().command(setTextStyle('definitionList'))).toBe(false); // already one
    e.commands.undo();
    expect(shape(e)).toEqual([[['paragraph', 'Armor Class :: 15 (natural armor)'], ['paragraph', 'after']]]);
  });

  it('several blocks become one list (a heading too, marks kept); without "::" the block is the term', () => {
    const e = open(docWith(node('paragraph', {}, [text('Speed', [{ type: 'bold' }]), text(' :: 30 ft.')]), h(3, 'Senses'), p('rest')));
    e.commands.setTextSelection({ from: posOf(e.state.doc, 'Speed') + 1, to: posOf(e.state.doc, 'Senses') + 2 });
    expect(style(e, 'definitionList')).toBe(true);
    expect(shape(e)).toEqual([[['definitionList', ['definitionTerm', 'Speed'], ['definitionDesc', '30 ft.'], ['definitionTerm', 'Senses'], ['definitionDesc', '']], ['paragraph', 'rest']]]);
    expect(e.state.doc.child(0).child(0).child(0).child(0).marks.map((m) => m.type.name)).toEqual(['bold']);
  });

  it('merges a definition list in the selection', () => {
    const e = open(docWith(p('A :: a'), dl(['B', 'b'])));
    e.commands.setTextSelection({ from: posOf(e.state.doc, 'A') + 1, to: posOf(e.state.doc, 'B') + 1 });
    expect(blockKindOf(e.state)).toBe('mixed');
    expect(style(e, 'definitionList')).toBe(true);
    expect(shape(e)).toEqual([[['definitionList', ['definitionTerm', 'A'], ['definitionDesc', 'a'], ['definitionTerm', 'B'], ['definitionDesc', 'b']]]]);
  });

  it('a list item’s first paragraph can’t become one: nothing changes', () => {
    const e = open(docWith(ul(li(p('item :: x')))));
    selectText(e, 'item', 1);
    const before = e.state.doc;
    expect(style(e, 'definitionList')).toBe(false);
    expect(e.state.doc.eq(before)).toBe(true);
    expect(undoDepth(e.state)).toBe(0);
  });

  it('another style turns the whole list into "Term :: Description" blocks; the caret keeps its place', () => {
    const e = open(docWith(dl(['Str', '18'], ['Dex', ''], ['', 'lone'])));
    selectText(e, '18', 1);
    expect(style(e, 'heading2')).toBe(true);
    expect(shape(e)).toEqual([[['heading', 'Str :: 18'], ['heading', 'Dex'], ['heading', 'lone']]]);
    expect(e.state.doc.child(0).child(0).attrs.level).toBe(2);
    expect(e.state.selection.$from.parent.textContent.slice(e.state.selection.$from.parentOffset)).toBe('8');
    // …and back: the round trip is exact.
    e.commands.setTextSelection({ from: posOf(e.state.doc, 'Str') + 1, to: posOf(e.state.doc, 'lone') + 1 });
    style(e, 'definitionList');
    expect(shape(e)).toEqual([
      [['definitionList', ['definitionTerm', 'Str'], ['definitionDesc', '18'], ['definitionTerm', 'Dex'], ['definitionDesc', ''], ['definitionTerm', 'lone'], ['definitionDesc', '']]],
    ]);
    selectText(e, 'Dex', 1);
    expect(style(e, 'paragraph')).toBe(true);
    expect(shape(e)).toEqual([[['paragraph', 'Str :: 18'], ['paragraph', 'Dex'], ['paragraph', 'lone']]]);
    expect(undoDepth(e.state)).toBe(3);
  });
});

describe('text styles: split across pages (line layout, 10 lines of 10 characters)', () => {
  let m: MountedEditor | undefined;
  afterEach(() => {
    m?.destroy();
    m = undefined;
  });
  const words = (tag: string, n: number) => {
    let s = '';
    for (let i = 0; s.length < n; i++) s += `${tag}${i} `;
    return s.slice(0, n);
  };
  const mount = (doc: PMNode) => {
    m = mountPaginated(doc, { lines: { columns: 1 } });
    m.settle();
    return m;
  };
  const types = (x: MountedEditor) => {
    const out: string[] = [];
    canonical(x.editor.state.doc).child(0).forEach((b) => out.push(b.type.name));
    return out;
  };

  it('a split paragraph becomes one definition list; one undo restores the pages', () => {
    const x = mount(DOC(PAGE({ columns: 1, pid: 'aaaaaaaa' }, P(words('a', 50)), P(`Term :: ${words('b', 72)}`))));
    const before = x.editor.state.doc;
    expect(before.childCount).toBe(2);
    x.select(posIn(before, 'Term') + 1);
    expect(runChain(x.editor, (c) => c.command(setTextStyle('definitionList')))).toBe(true);
    x.settle();
    expect(types(x)).toEqual(['paragraph', 'definitionList']);
    expect(canonical(x.editor.state.doc).child(0).child(1).child(1).textContent).toBe(words('b', 72));
    expect(x.editor.commands.undo()).toBe(true);
    x.settle();
    expect(pageTexts(x.editor.state.doc)).toEqual(pageTexts(before));
  });

  it('a definition list split across pages becomes paragraphs, all of it; one undo restores it', () => {
    const items = Array.from({ length: 8 }, (_, k) => [DT(`t${k}`), DD(`d${k}`)]).flat();
    const x = mount(DOC(PAGE({ columns: 1, pid: 'aaaaaaaa' }, P(words('a', 50)), DL(null, ...items))));
    const before = x.editor.state.doc;
    expect(before.childCount).toBe(2);
    x.select(posIn(before, 't0') + 1);
    expect(runChain(x.editor, (c) => c.command(setTextStyle('paragraph')))).toBe(true);
    x.settle();
    expect(types(x)).toEqual(['paragraph', ...Array.from({ length: 8 }, () => 'paragraph')]);
    expect(pageTexts(canonical(x.editor.state.doc)).flat().slice(1)).toEqual(Array.from({ length: 8 }, (_, k) => `t${k} :: d${k}`));
    expect(x.editor.commands.undo()).toBe(true);
    x.settle();
    expect(pageTexts(x.editor.state.doc)).toEqual(pageTexts(before));
  });
});

describe('text styles: theme boxes', () => {
  it('wraps in a box, swaps the box class (keeping wide), and takes the box off', () => {
    const e = open(docWith(p('one'), p('two')));
    selectText(e, 'one', 1);
    expect(themeBoxesAt(e.state)).toEqual([]);
    expect(run(e, toggleThemeBox('note'))).toBe(true);
    expect(shape(e)).toEqual([[['themeBlock', ['paragraph', 'one']], ['paragraph', 'two']]]);
    expect(themeBoxesAt(e.state)).toEqual(['note']);
    const boxPos = 1; // the first block of the first page
    e.view.dispatch(e.state.tr.setNodeAttribute(boxPos, 'classes', ['note', 'wide']));
    expect(run(e, toggleThemeBox('descriptive'))).toBe(true);
    expect(e.state.doc.child(0).child(0).attrs.classes).toEqual(['descriptive', 'wide']);
    expect(themeBoxesAt(e.state)).toEqual(['descriptive']);
    expect(run(e, toggleThemeBox('descriptive'))).toBe(true);
    expect(shape(e)).toEqual([[['paragraph', 'one'], ['paragraph', 'two']]]);
  });

  it('takes off the box with the class, not an inner theme block; nested boxes read out', () => {
    const e = open(docWith(block(['quote'], block(['monster'], p('inside')))));
    selectText(e, 'inside', 1);
    expect(themeBoxesAt(e.state)).toEqual(['quote']);
    expect(run(e, toggleThemeBox('quote'))).toBe(true);
    expect(shape(e)).toEqual([[['themeBlock', ['paragraph', 'inside']]]]);
    expect(e.state.doc.child(0).child(0).attrs.classes).toEqual(['monster']);
  });
});
