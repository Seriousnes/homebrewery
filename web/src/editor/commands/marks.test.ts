// marks.ts: nbsp, inlineBox spacers, span marks with classes, links (plan §6.1).
import type { Editor, JSONContent } from '@tiptap/core';
import type { Command } from '@tiptap/pm/state';
import { afterEach, describe, expect, it } from 'vitest';
import { docOf, node, p, page, text } from '../schema/testing';
import { createTestEditor, posOf, selectNode, selectText, setCursor } from '../ui/toolbar/testing';
import { toolbarStateOf } from '../ui/toolbar/toolbarState';
import {
  applyLink,
  applySpan,
  classProblem,
  cleanClassList,
  hrefProblem,
  insertNbsp,
  linkTarget,
  narrowSpacer,
  NBSP,
  normalizeHref,
  parseClassInput,
  removeLink,
  removeSpan,
  spacerAt,
  spacerWidth,
  spanTarget,
  widenSpacer,
  withSpacerWidth,
} from './marks';

let editor: Editor | undefined;
afterEach(() => {
  editor?.destroy();
  editor = undefined;
});

/** A one-page document; the page has a pid, so no pid-assignment transaction interferes. */
const docWith = (...blocks: JSONContent[]) => docOf(page(blocks, { pid: 'testpage' }));
const open = (json: JSONContent) => (editor = createTestEditor(json));
const run = (e: Editor, cmd: Command) => cmd(e.state, (tr) => e.view.dispatch(tr));
const firstParagraph = (e: Editor) => e.state.doc.child(0).child(0);
const spanClasses = (e: Editor, needle: string): string[][] => {
  const n = e.state.doc.nodeAt(posOf(e.state.doc, needle));
  return (n?.marks ?? []).filter((m) => m.type.name === 'span').map((m) => m.attrs.classes as string[]);
};

describe('insertNbsp', () => {
  it('inserts U+00A0 at the cursor and replaces a selection', () => {
    const e = open(docWith(p('one two')));
    selectText(e, 'one', 3);
    expect(run(e, insertNbsp)).toBe(true);
    expect(firstParagraph(e).textContent).toBe(`one${NBSP} two`);
    selectText(e, 'two');
    run(e, insertNbsp);
    expect(firstParagraph(e).textContent).toBe(`one${NBSP} ${NBSP}`);
  });

  it('is not available in a selected atom', () => {
    const e = open(docWith(p('a'), node('columnBreak')));
    selectNode(e, 4);
    expect(insertNbsp(e.state)).toBe(false);
  });
});

describe('spacers', () => {
  it('parses and writes percent widths', () => {
    expect(spacerWidth('width: 20%;')).toBe(20);
    expect(spacerWidth('height: 1em; width:35.5%')).toBe(35.5);
    expect(spacerWidth('width: 100px;')).toBeNull();
    expect(spacerWidth(null)).toBeNull();
    expect(withSpacerWidth(null, 10)).toBe('width: 10%;');
    expect(withSpacerWidth('height: 1em; width: 10%;', 20)).toBe('height: 1em; width: 20%;');
    expect(withSpacerWidth('color: red;', 30, undefined)).toBe('color: red; width: 30%;');
  });

  it('widen inserts a 10% spacer with the cursor after it, then widens it up to 100%', () => {
    const e = open(docWith(p('ab')));
    selectText(e, 'ab', 1);
    expect(run(e, widenSpacer)).toBe(true);
    const box = firstParagraph(e).child(1);
    expect(box.type.name).toBe('inlineBox');
    expect(box.attrs.style).toBe('width: 10%;');
    expect(e.state.selection.from).toBe(posOf(e.state.doc, 'b'));
    for (let i = 0; i < 12; i++) run(e, widenSpacer);
    expect(firstParagraph(e).child(1).attrs.style).toBe('width: 100%;');
    expect(widenSpacer(e.state)).toBe(false); // at the maximum
  });

  it('widens a spacer after the cursor or a selected one; keeps other declarations', () => {
    const e = open(docWith(node('paragraph', {}, [text('a'), node('inlineBox', { style: 'height: 2em; width: 20%;' }), text('b')])));
    setCursor(e, posOf(e.state.doc, 'a'));
    expect(spacerAt(e.state)).toBeNull();
    setCursor(e, posOf(e.state.doc, 'a') + 1);
    expect(spacerAt(e.state)?.width).toBe(20);
    run(e, widenSpacer);
    expect(firstParagraph(e).child(1).attrs.style).toBe('height: 2em; width: 30%;');
    selectNode(e, posOf(e.state.doc, 'a') + 1);
    run(e, narrowSpacer);
    expect(firstParagraph(e).child(1).attrs.style).toBe('height: 2em; width: 20%;');
  });

  it('narrow removes the spacer at 0 and does nothing without one', () => {
    const e = open(docWith(node('paragraph', {}, [text('a'), node('inlineBox', { style: 'width: 20%;' }), text('b')])));
    setCursor(e, posOf(e.state.doc, 'b'));
    run(e, narrowSpacer);
    expect(firstParagraph(e).child(1).attrs.style).toBe('width: 10%;');
    run(e, narrowSpacer);
    expect(firstParagraph(e).textContent).toBe('ab');
    expect(firstParagraph(e).childCount).toBe(1);
    expect(narrowSpacer(e.state)).toBe(false);
  });

  it('leaves an inlineBox without a percent width alone and inserts a new spacer', () => {
    const e = open(docWith(node('paragraph', {}, [text('a'), node('inlineBox', { style: 'width: 100px;' }), text('b')])));
    setCursor(e, posOf(e.state.doc, 'b'));
    run(e, widenSpacer);
    expect(firstParagraph(e).childCount).toBe(4);
    expect(firstParagraph(e).child(1).attrs.style).toBe('width: 100px;');
    expect(firstParagraph(e).child(2).attrs.style).toBe('width: 10%;');
  });
});

describe('classes', () => {
  it('parses input and rejects reserved classes', () => {
    expect(parseClassInput(' note, wide  frame ')).toEqual(['note', 'wide', 'frame']);
    expect(classProblem('note')).toBeNull();
    expect(classProblem('page')).toMatch(/reserved/);
    expect(classProblem('inline-block')).toMatch(/reserved/);
    expect(classProblem('ProseMirror-selectednode')).toMatch(/reserved/);
    expect(classProblem('a b')).toMatch(/spaces/);
    expect(cleanClassList(['note', 'block', 'note', 'wide'])).toEqual(['note', 'wide']);
  });

  it('refuses what the server drops: over 256 characters, NUL, U+0085 (UI-11)', () => {
    expect(classProblem('x'.repeat(256))).toBeNull();
    expect(classProblem('x'.repeat(300))).toMatch(/256/);
    expect(classProblem('a\u0000b')).not.toBeNull();
    expect(classProblem('a\u0085b')).toMatch(/spaces/);
    expect(cleanClassList(['x'.repeat(300), 'a\u0000b', 'a\u0085b', 'ok'])).toEqual(['ok']);
  });
});

describe('span marks', () => {
  it('adds a span with classes over the selection', () => {
    const e = open(docWith(p('roll initiative now')));
    selectText(e, 'initiative');
    expect(spanTarget(e.state)).toBeNull();
    expect(run(e, applySpan(['monster', 'block', 'monster']))).toBe(true);
    expect(spanClasses(e, 'initiative')).toEqual([['monster']]);
    expect(spanClasses(e, 'roll')).toEqual([]);
    expect(e.getHTML()).toContain('<span class="inline-block monster">initiative</span>');
  });

  it('edits the span at the cursor (whole range), keeping style, id and attributes', () => {
    const e = open(
      docWith(node('paragraph', {}, [text('a '), text('stat', [{ type: 'span', attrs: { classes: ['x'], style: 'color: red;', id: 'k' } }]), text(' b')])),
    );
    selectText(e, 'stat', 2);
    const target = spanTarget(e.state);
    expect(target && [target.from, target.to]).toEqual([posOf(e.state.doc, 'stat'), posOf(e.state.doc, 'stat') + 4]);
    run(e, applySpan(['y', 'z']));
    const mark = e.state.doc.nodeAt(posOf(e.state.doc, 'stat'))!.marks[0]!;
    expect(mark.attrs).toMatchObject({ classes: ['y', 'z'], style: 'color: red;', id: 'k' });
    expect(e.state.doc.nodeAt(posOf(e.state.doc, 'stat'))!.text).toBe('stat');
  });

  it('nests a new span in part of a span and keeps the nesting order when the outer one is edited', () => {
    const outer = { type: 'span', attrs: { classes: ['outer'] } };
    const e = open(docWith(node('paragraph', {}, [text('one two three', [outer])])));
    selectText(e, 'two');
    run(e, applySpan(['inner']));
    expect(spanClasses(e, 'two')).toEqual([['outer'], ['inner']]);
    selectText(e, 'one', 1); // cursor in the outer span only
    expect(spanTarget(e.state)?.mark.attrs.classes).toEqual(['outer']);
    run(e, applySpan(['changed']));
    expect(spanClasses(e, 'one')).toEqual([['changed']]);
    expect(spanClasses(e, 'two')).toEqual([['changed'], ['inner']]);
    expect(e.getHTML()).toContain('<span class="inline-block changed">one <span class="inline-block inner">two</span> three</span>');
  });

  it('with an empty selection outside a span, stores the span for the next typing; again edits it', () => {
    const e = open(docWith(p('ab')));
    selectText(e, 'ab', 1);
    run(e, applySpan(['note']));
    expect(e.state.storedMarks?.[0]?.attrs.classes).toEqual(['note']);
    expect(spanTarget(e.state)?.from).toBe(spanTarget(e.state)?.to);
    run(e, applySpan(['wide']));
    expect(e.state.storedMarks?.map((m) => m.attrs.classes as string[])).toEqual([['wide']]);
    e.commands.insertContent('X');
    expect(spanClasses(e, 'X')).toEqual([['wide']]);
  });

  it('removes the targeted span only', () => {
    const outer = { type: 'span', attrs: { classes: ['outer'] } };
    const inner = { type: 'span', attrs: { classes: ['inner'] } };
    const e = open(docWith(node('paragraph', {}, [text('one ', [outer]), text('two', [outer, inner]), text(' three', [outer])])));
    selectText(e, 'two');
    expect(spanTarget(e.state)?.mark.attrs.classes).toEqual(['inner']);
    expect(run(e, removeSpan)).toBe(true);
    expect(spanClasses(e, 'two')).toEqual([['outer']]);
    selectText(e, 'three', 2);
    run(e, removeSpan);
    expect(spanClasses(e, 'two')).toEqual([]);
    expect(removeSpan(e.state)).toBe(false);
  });
});

describe('links', () => {
  it('normalizes bare domains and checks the URL policy', () => {
    expect(normalizeHref(' example.com/a ')).toBe('https://example.com/a');
    expect(normalizeHref('www.dndbeyond.com')).toBe('https://www.dndbeyond.com');
    expect(normalizeHref('#p3')).toBe('#p3');
    expect(normalizeHref('/share/abc')).toBe('/share/abc');
    expect(normalizeHref('mailto:a@b.c')).toBe('mailto:a@b.c');
    expect(normalizeHref('notes')).toBe('notes');
    expect(hrefProblem('')).toMatch(/Enter/);
    expect(hrefProblem('javascript:alert(1)')).toMatch(/http/);
    expect(hrefProblem('https://example.com')).toBeNull();
    expect(hrefProblem('#heading')).toBeNull();
  });

  it('links the selection, then edits the whole link from a cursor inside it', () => {
    const e = open(docWith(p('see the rules here')));
    selectText(e, 'rules');
    expect(run(e, applyLink('https://a.example'))).toBe(true);
    selectText(e, 'rules', 2);
    expect(linkTarget(e.state)).toMatchObject({ href: 'https://a.example' });
    run(e, applyLink('#p2'));
    const marks = e.state.doc.nodeAt(posOf(e.state.doc, 'rules'))!.marks;
    expect(marks.map((m) => [m.type.name, m.attrs.href as string])).toEqual([['link', '#p2']]);
    expect(e.state.doc.nodeAt(posOf(e.state.doc, 'rules'))!.text).toBe('rules');
  });

  it('inserts the text (or the address) as a link at an empty cursor, then continues unlinked', () => {
    const e = open(docWith(p('ab')));
    selectText(e, 'ab', 1);
    run(e, applyLink('https://x.example', 'the site'));
    expect(firstParagraph(e).textContent).toBe('athe siteb');
    expect(e.state.doc.nodeAt(posOf(e.state.doc, 'the site'))!.marks[0]!.attrs.href).toBe('https://x.example');
    expect(e.state.selection.from).toBe(posOf(e.state.doc, 'b'));
    e.commands.insertContent('!');
    expect(e.state.doc.nodeAt(posOf(e.state.doc, '!'))!.marks).toEqual([]);
    selectText(e, 'b', 1);
    run(e, applyLink('https://y.example'));
    expect(firstParagraph(e).textContent).toContain('bhttps://y.example');
  });

  it('refuses unsafe addresses and removes links', () => {
    const e = open(docWith(p('see the rules here')));
    selectText(e, 'rules');
    expect(applyLink('javascript:alert(1)')(e.state)).toBe(false);
    run(e, applyLink('https://a.example'));
    selectText(e, 'rules', 1);
    expect(run(e, removeLink)).toBe(true);
    expect(e.state.doc.nodeAt(posOf(e.state.doc, 'rules'))!.marks).toEqual([]);
    expect(removeLink(e.state)).toBe(false);
  });
});

describe('in a code block (UI-7)', () => {
  const code = () => docWith(node('codeBlock', {}, [text('code text')]));

  it('spacers, spans and links refuse a code block and leave it unchanged', () => {
    const e = open(code());
    setCursor(e, posOf(e.state.doc, 'code') + 4);
    const before = e.state.doc;
    expect(widenSpacer(e.state)).toBe(false);
    expect(run(e, widenSpacer)).toBe(false);
    expect(run(e, applyLink('https://x.test', 'L'))).toBe(false);
    selectText(e, 'text');
    expect(run(e, applySpan(['x']))).toBe(false);
    expect(run(e, applyLink('https://x.test'))).toBe(false);
    expect(e.state.doc.eq(before)).toBe(true);
    expect(e.state.doc.child(0).childCount).toBe(1);
  });

  it('the toolbar disables its mark, link and span controls there', () => {
    const e = open(docWith(p('plain'), node('codeBlock', {}, [text('code text')])));
    setCursor(e, posOf(e.state.doc, 'plain') + 1);
    expect(toolbarStateOf(e).inText).toBe(true);
    setCursor(e, posOf(e.state.doc, 'code') + 1);
    expect(toolbarStateOf(e).inText).toBe(false);
  });
});
