// stepScope.ts (P8.1): what a transaction's steps touched, so whole-document plugins can skip.
import { Editor } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { afterEach, describe, expect, it } from 'vitest';
import { buildEditorExtensions } from '../../editorExtensions';
import { docOf, node, p, page, text } from '../testing';
import { inlineOnly, touchesNode, withinPages } from './stepScope';

let editor: Editor | undefined;
afterEach(() => {
  editor?.destroy();
  editor = undefined;
});

const heading = (level: number, value: string) => node('heading', { level }, [text(value)]);

function mount(): Editor {
  editor = new Editor({
    extensions: buildEditorExtensions(),
    content: docOf(page([heading(1, 'Title'), p('first paragraph'), p('second one')]), page([p('next page text')])),
  });
  return editor;
}

/** Position of the first occurrence of `needle` in the text of `doc`. */
function posOf(doc: PMNode, needle: string): number {
  let found = -1;
  doc.descendants((n, pos) => {
    if (found >= 0) return false;
    if (n.isText && n.text!.includes(needle)) found = pos + n.text!.indexOf(needle);
    return true;
  });
  if (found < 0) throw new Error(`no "${needle}"`);
  return found;
}

const isHeading = (n: PMNode) => n.type.name === 'heading';

describe('stepScope', () => {
  it('typing in a paragraph: inline only, inside one page, no heading touched', () => {
    const e = mount();
    const tr = e.state.tr.insertText('x', posOf(e.state.doc, 'paragraph'));
    expect(inlineOnly(tr)).toBe(true);
    expect(withinPages([tr])).toBe(true);
    expect(touchesNode([tr], isHeading)).toBe(false);
  });

  it('typing in a heading, or changing its attributes, touches it', () => {
    const e = mount();
    expect(touchesNode([e.state.tr.insertText('x', posOf(e.state.doc, 'itle'))], isHeading)).toBe(true);
    const tr = e.state.tr.setNodeAttribute(1, 'level', 2); // the heading starts page 0's content
    expect(e.state.doc.nodeAt(1)?.type.name).toBe('heading');
    expect(touchesNode([tr], isHeading)).toBe(true);
    expect(inlineOnly(tr)).toBe(false);
    expect(withinPages([tr])).toBe(true);
  });

  it('a heading inserted between blocks, or deleted with them, is touched', () => {
    const e = mount();
    const at = posOf(e.state.doc, 'second') - 1; // before the second paragraph
    const insert = e.state.tr.insert(at, e.schema.nodeFromJSON(heading(2, 'New')));
    expect(touchesNode([insert], isHeading)).toBe(true);
    const del = e.state.tr.delete(1, posOf(e.state.doc, 'first') - 1); // the whole heading
    expect(touchesNode([del], isHeading)).toBe(true);
  });

  it('marks are inline only; Enter (a split) is not', () => {
    const e = mount();
    const from = posOf(e.state.doc, 'first');
    expect(inlineOnly(e.state.tr.addMark(from, from + 5, e.schema.marks.bold!.create()))).toBe(true);
    const split = e.state.tr.split(from + 3);
    expect(inlineOnly(split)).toBe(false);
    expect(touchesNode([split], isHeading)).toBe(false);
    expect(withinPages([split])).toBe(true);
  });

  it('a delete across a page boundary and a page attribute leave the pages', () => {
    const e = mount();
    const del = e.state.tr.delete(posOf(e.state.doc, 'one'), posOf(e.state.doc, 'text'));
    expect(withinPages([del])).toBe(false);
    expect(inlineOnly(del)).toBe(false);
    const attr = e.state.tr.setNodeAttribute(0, 'columns', 1);
    expect(withinPages([attr])).toBe(false);
  });
});
