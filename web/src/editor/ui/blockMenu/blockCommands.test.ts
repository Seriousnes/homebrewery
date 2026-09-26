// P5.7 block commands on pure ProseMirror states.
import { history, undo, undoDepth } from '@tiptap/pm/history';
import type { Node as PMNode } from '@tiptap/pm/model';
import { EditorState, NodeSelection, TextSelection, type Command } from '@tiptap/pm/state';
import { GapCursor } from '@tiptap/pm/gapcursor';
import { describe, expect, it, vi } from 'vitest';
import { DD, DL, DOC, DT, P, PAGE, posOf, schema } from '../../pagination/testing';
import {
  findBlock,
  insertColumnBreak,
  insertDefinitionList,
  insertHorizontalRule,
  insertSpacer,
  removeBlock,
} from './blockCommands';
import { definitionListBackspace, definitionListEnter } from './definitionListKeys';

const atom = (name: string) => schema.nodes[name]!.create();

function stateAt(doc: PMNode, pos: number | ((d: PMNode) => number)): EditorState {
  const state = EditorState.create({ doc, plugins: [history()] });
  const at = typeof pos === 'number' ? pos : pos(doc);
  return state.apply(state.tr.setSelection(TextSelection.create(doc, at)));
}

function run(state: EditorState, command: Command): EditorState | null {
  let next: EditorState | null = null;
  const ok = command(state, (tr) => (next = state.apply(tr)));
  return ok ? next : null;
}

/** Block type names of page 1 (and their text), e.g. ['paragraph:One', 'spacer']. */
function blocks(state: EditorState): string[] {
  const out: string[] = [];
  state.doc.firstChild!.forEach((n) => out.push(n.isTextblock || n.type.name === 'definitionList' ? `${n.type.name}:${n.textContent}` : n.type.name));
  return out;
}

const caret = (state: EditorState) => ({ parent: state.selection.$from.parent.type.name, text: state.selection.$from.parent.textContent, offset: state.selection.$from.parentOffset });

describe('inserting atoms', () => {
  it.each([
    ['spacer', insertSpacer],
    ['columnBreak', insertColumnBreak],
    ['horizontalRule', insertHorizontalRule],
  ] as const)('%s: at the end of a paragraph, after it, caret in the next paragraph', (name, command) => {
    const s = run(stateAt(DOC(PAGE(null, P('One'), P('Two'))), (d) => posOf(d, 'One') + 3), command)!;
    expect(blocks(s)).toEqual(['paragraph:One', name, 'paragraph:Two']);
    expect(caret(s)).toEqual({ parent: 'paragraph', text: 'Two', offset: 0 });
    expect(undoDepth(s)).toBe(1);
    const undone = run(s, undo)!;
    expect(blocks(undone)).toEqual(['paragraph:One', 'paragraph:Two']);
  });

  it('at the end of the last paragraph adds an empty paragraph for the caret', () => {
    const s = run(stateAt(DOC(PAGE(null, P('One'))), (d) => posOf(d, 'One') + 3), insertSpacer)!;
    expect(blocks(s)).toEqual(['paragraph:One', 'spacer', 'paragraph:']);
    expect(caret(s).parent).toBe('paragraph');
    expect(undoDepth(s)).toBe(1);
  });

  it('at the start of a paragraph: before it; in an empty paragraph: before it, the caret stays', () => {
    let s = run(stateAt(DOC(PAGE(null, P('One'))), 2), insertColumnBreak)!;
    expect(blocks(s)).toEqual(['columnBreak', 'paragraph:One']);
    s = run(stateAt(DOC(PAGE(null, P('One'), P(''))), (d) => d.content.size - 2), insertSpacer)!;
    expect(blocks(s)).toEqual(['paragraph:One', 'spacer', 'paragraph:']);
    expect(caret(s)).toEqual({ parent: 'paragraph', text: '', offset: 0 });
  });

  it('in the middle of a paragraph: splits it', () => {
    const s = run(stateAt(DOC(PAGE(null, P('OneTwo'))), (d) => posOf(d, 'Two')), insertHorizontalRule)!;
    expect(blocks(s)).toEqual(['paragraph:One', 'horizontalRule', 'paragraph:Two']);
    expect(caret(s)).toEqual({ parent: 'paragraph', text: 'Two', offset: 0 });
    expect(undoDepth(s)).toBe(1);
  });

  it('with a node selection: after the node; with a gap cursor: at the gap', () => {
    const doc = DOC(PAGE(null, P('One'), atom('spacer'), atom('spacer')));
    const spacerPos = posOf(doc, 'One') + 4;
    let s = EditorState.create({ doc, selection: NodeSelection.create(doc, spacerPos) });
    s = run(s, insertHorizontalRule)!;
    expect(blocks(s)).toEqual(['paragraph:One', 'spacer', 'horizontalRule', 'spacer']);
    expect(s.selection).toBeInstanceOf(NodeSelection);
    const gap = EditorState.create({ doc, selection: new GapCursor(doc.resolve(spacerPos + 1)) });
    s = run(gap, insertSpacer)!;
    expect(blocks(s)).toEqual(['paragraph:One', 'spacer', 'spacer', 'spacer']);
  });

  it('inside a list item goes after the paragraph; before the first paragraph it walks out of the list', () => {
    const list = schema.nodes.bulletList!.create(null, [schema.nodes.listItem!.create(null, P('Item'))]);
    const doc = DOC(PAGE(null, list));
    let s = run(stateAt(doc, (d) => posOf(d, 'Item') + 4), insertSpacer)!;
    expect(s.doc.firstChild!.firstChild!.firstChild!.childCount).toBe(3); // p, spacer, p
    s = run(stateAt(doc, (d) => posOf(d, 'Item')), insertSpacer)!;
    expect(blocks(s)).toEqual(['spacer', 'bulletList']);
  });
});

describe('definition lists', () => {
  it('an empty paragraph becomes a list with an empty term (caret in it)', () => {
    const s = run(stateAt(DOC(PAGE(null, P('One'), P(''))), (d) => d.content.size - 2), insertDefinitionList)!;
    expect(blocks(s)).toEqual(['paragraph:One', 'definitionList:']);
    expect(caret(s).parent).toBe('definitionTerm');
    expect(undoDepth(s)).toBe(1);
  });

  it('a paragraph "Term :: Definition" becomes a term and a description', () => {
    const s = run(stateAt(DOC(PAGE(null, P('Speed :: 30 ft.'))), 3), insertDefinitionList)!;
    const dl = s.doc.firstChild!.firstChild!;
    expect(dl.type.name).toBe('definitionList');
    expect(dl.child(0).type.name).toBe('definitionTerm');
    expect(dl.child(0).textContent).toBe('Speed');
    expect(dl.child(1).textContent).toBe('30 ft.');
    expect(caret(s)).toEqual({ parent: 'definitionDesc', text: '30 ft.', offset: 6 });
  });

  it('a paragraph without :: becomes the term', () => {
    const s = run(stateAt(DOC(PAGE(null, P('Speed'))), 3), insertDefinitionList)!;
    const dl = s.doc.firstChild!.firstChild!;
    expect([dl.child(0).textContent, dl.child(1).textContent]).toEqual(['Speed', '']);
    expect(caret(s)).toEqual({ parent: 'definitionTerm', text: 'Speed', offset: 5 });
  });

  it('keeps inline nodes when splitting at ::', () => {
    const icon = schema.nodes.icon!.create({ font: 'df', glyph: 'd20' });
    const para = schema.nodes.paragraph!.create(null, [icon, schema.text(' Roll :: '), icon, schema.text(' twice')]);
    const s = run(stateAt(DOC(PAGE(null, para)), 3), insertDefinitionList)!;
    const dl = s.doc.firstChild!.firstChild!;
    expect(dl.child(0).childCount).toBe(2); // icon + " Roll"
    expect(dl.child(0).firstChild!.type.name).toBe('icon');
    expect(dl.child(1).firstChild!.type.name).toBe('icon');
    expect(dl.child(1).textContent).toBe(' twice');
  });

  it('removing unwraps the list into paragraphs (text kept) in one step', () => {
    const doc = DOC(PAGE(null, P('Before'), DL(null, DT('Term'), DD('Def')), P('After')));
    const s0 = stateAt(doc, (d) => posOf(d, 'Def') + 1);
    expect(findBlock(s0, 'definitionList')?.node.type.name).toBe('definitionList');
    const s = run(s0, removeBlock('definitionList'))!;
    expect(blocks(s)).toEqual(['paragraph:Before', 'paragraph:Term', 'paragraph:Def', 'paragraph:After']);
    expect(caret(s).text).toBe('Def');
    expect(undoDepth(s)).toBe(1);
  });

  it('removing the list keeps the caret at the same character (UI-6)', () => {
    const doc = DOC(PAGE(null, P('Before'), DL(null, DT('Term'), DD('Def')), P('After')));
    const s = run(stateAt(doc, (d) => posOf(d, 'Def') + 1), removeBlock('definitionList'))!;
    expect(caret(s)).toEqual({ parent: 'paragraph', text: 'Def', offset: 1 });
    // At the end of an item: the end of its paragraph, never between two paragraphs.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const t = run(stateAt(doc, (d) => posOf(d, 'Term') + 4), removeBlock('definitionList'))!;
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
    expect(t.selection.$from.parent.inlineContent).toBe(true);
    expect(caret(t)).toEqual({ parent: 'paragraph', text: 'Term', offset: 4 });
  });

  it('Enter: term → description → term; Enter in an empty item leaves the list', () => {
    let s = stateAt(DOC(PAGE(null, DL(null, DT('Term')))), (d) => posOf(d, 'Term') + 4);
    s = run(s, definitionListEnter)!;
    expect(caret(s).parent).toBe('definitionDesc');
    s = s.apply(s.tr.insertText('Def'));
    s = run(s, definitionListEnter)!;
    expect(caret(s).parent).toBe('definitionTerm');
    s = run(s, definitionListEnter)!; // empty term: out of the list
    expect(blocks(s)).toEqual(['definitionList:TermDef', 'paragraph:']);
    expect(caret(s).parent).toBe('paragraph');
  });

  it('Enter in an empty item in the middle splits the list around a paragraph', () => {
    const s0 = stateAt(DOC(PAGE(null, DL(null, DT('A'), schema.nodes.definitionDesc!.create(), DT('B'), DD('b')))), (d) => posOf(d, 'A') + 3);
    const s = run(s0, definitionListEnter)!;
    expect(blocks(s)).toEqual(['definitionList:A', 'paragraph:', 'definitionList:Bb']);
  });

  it('the list id stays on the first half when an empty item splits it (UI-10)', () => {
    const s0 = stateAt(DOC(PAGE(null, DL({ id: 'stats' }, DT('A'), schema.nodes.definitionDesc!.create(), DT('B'), DD('b')))), (d) => posOf(d, 'A') + 3);
    const s = run(s0, definitionListEnter)!;
    const ids: unknown[] = [];
    s.doc.descendants((n) => {
      if (n.type.name === 'definitionList') ids.push(n.attrs.id);
    });
    expect(ids).toEqual(['stats', null]);
  });

  it('Backspace at the start of the first item makes it a paragraph before the list', () => {
    const s0 = stateAt(DOC(PAGE(null, DL(null, DT('A'), DD('a')))), (d) => posOf(d, 'A'));
    const s = run(s0, definitionListBackspace)!;
    expect(blocks(s)).toEqual(['paragraph:A', 'definitionList:a']);
    expect(run(stateAt(s0.doc, (d) => posOf(d, 'a')), definitionListBackspace)).toBeNull(); // not the first item
  });
});

describe('removing atoms', () => {
  const doc = () => DOC(PAGE(null, P('One'), atom('spacer'), P('Two'), atom('columnBreak'), atom('horizontalRule')));

  it('removes the selected atom', () => {
    const d = doc();
    const pos = posOf(d, 'One') + 4;
    const s = run(EditorState.create({ doc: d, selection: NodeSelection.create(d, pos), plugins: [history()] }), removeBlock('spacer'))!;
    expect(blocks(s)).toEqual(['paragraph:One', 'paragraph:Two', 'columnBreak', 'horizontalRule']);
    expect(undoDepth(s)).toBe(1);
  });

  it('removes the atom right before the caret (start of a text block) or after it (end)', () => {
    let s = run(stateAt(doc(), (d) => posOf(d, 'Two')), removeBlock('spacer'))!;
    expect(blocks(s)).toEqual(['paragraph:One', 'paragraph:Two', 'columnBreak', 'horizontalRule']);
    s = run(stateAt(doc(), (d) => posOf(d, 'Two') + 3), removeBlock('columnBreak'))!;
    expect(blocks(s)).toEqual(['paragraph:One', 'spacer', 'paragraph:Two', 'horizontalRule']);
    expect(caret(s).text).toBe('Two');
  });

  it('finds nothing when the caret is not next to one', () => {
    const s = stateAt(doc(), (d) => posOf(d, 'One') + 1);
    expect(findBlock(s, 'spacer')).toBeNull();
    expect(run(s, removeBlock('horizontalRule'))).toBeNull();
  });

  it('a page never loses its last block', () => {
    const d = DOC(PAGE(null, atom('spacer')));
    const s = run(EditorState.create({ doc: d, selection: NodeSelection.create(d, 1) }), removeBlock('spacer'))!;
    expect(blocks(s)).toEqual(['paragraph:']);
  });
});

describe('definition list Enter into an empty sibling', () => {
  it('moves into the empty description after the term instead of adding one', () => {
    const empty = schema.nodes.definitionDesc!.create();
    const s0 = stateAt(DOC(PAGE(null, DL(null, DT('Speed'), empty))), (d) => posOf(d, 'Speed') + 5);
    const s = run(s0, definitionListEnter)!;
    expect(s.doc.firstChild!.firstChild!.childCount).toBe(2);
    expect(caret(s)).toEqual({ parent: 'definitionDesc', text: '', offset: 0 });
  });
});

describe('caret block decoration', () => {
  it('marks the dt/dd or cell paragraph holding the caret only, and only when focused', async () => {
    const { caretBlockDecorations } = await import('./caretBlock');
    const doc = DOC(PAGE(null, P('x'), DL(null, DT('A'), DD('a'))));
    expect(caretBlockDecorations(stateAt(doc, 2)).find()).toHaveLength(0);
    expect(caretBlockDecorations(stateAt(doc, (d) => posOf(d, 'a')), false).find()).toHaveLength(0);
    const decos = caretBlockDecorations(stateAt(doc, (d) => posOf(d, 'a'))).find();
    expect(decos).toHaveLength(1);
    expect(doc.nodeAt(decos[0]!.from)!.type.name).toBe('definitionDesc');
  });
});
