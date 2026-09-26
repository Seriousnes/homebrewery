// blocks.ts: read-outs for the toolbar, alignment, column breaks, the manual page break stand-in,
// theme-block wrapping (plan §6.1, §6.2).
import type { Editor, JSONContent } from '@tiptap/core';
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
  themeBlockAt,
  toggleTextBlockKind,
  unwrapThemeBlock,
  wrapInThemeBlock,
} from './blocks';

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

  it('block kind of definition list parts is other; of a selected atom null', () => {
    const e = open(docWith(node('definitionList', {}, [node('definitionTerm', {}, [text('Term')]), node('definitionDesc', {}, [text('Desc')])]), node('columnBreak'), p('x')));
    selectText(e, 'Term', 1);
    expect(blockKindOf(e.state)).toBe('other');
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
