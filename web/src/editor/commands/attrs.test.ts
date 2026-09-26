// Inspector commands (P3.5): validation, the transactions they build, and undo (one step per edit).
import { Editor, Extension, type AnyExtension, type JSONContent } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { afterEach, describe, expect, it } from 'vitest';
import { buildEditorExtensions } from '../editorExtensions';
import { endOfFirstBlock, moveBoundary, pageAt } from '../pagination/boundary';
import { sectionSyncPlugin } from '../pagination/sections';
import type { PageAttrs } from '../schema';
import { docOf, node, p, page, text } from '../schema/testing';
import {
  addClasses,
  addPageObjectClasses,
  addSectionClasses,
  collectIds,
  coverOf,
  decodeCss,
  editClasses,
  editId,
  editMarkers,
  editPageObject,
  editSection,
  editStyle,
  genericValues,
  INSPECTOR_META,
  isUnsafeCss,
  markRangeAt,
  parseClassInput,
  removeAttribute,
  removeClass,
  sectionRange,
  sectionSettings,
  setAttribute,
  splitDeclarations,
  validateAttributeName,
  validateClassName,
  validateColumns,
  validateFooter,
  validateId,
  validateStyle,
  withCover,
  withMarker,
  type EditTarget,
} from './attrs';

let editor: Editor | null = null;
afterEach(() => {
  editor?.destroy();
  editor = null;
});

/** A headless editor, after the heading-id pass that runs in a microtask after mount. */
async function makeEditor(content: JSONContent, extensions: AnyExtension[] = []): Promise<Editor> {
  editor = new Editor({ extensions: buildEditorExtensions({ extensions }), content });
  await new Promise((resolve) => setTimeout(resolve, 0));
  return editor;
}

/** Position of the first node matching `test`. */
function posOf(doc: PMNode, test: (n: PMNode) => boolean): number {
  let found = -1;
  doc.descendants((n, pos) => {
    if (found < 0 && test(n)) found = pos;
    return found < 0;
  });
  if (found < 0) throw new Error('node not found');
  return found;
}

/** toMatchObject pattern: an edit refused with an error that mentions `text`. */
const refused = (text: string): { ok: false; error: string } => ({ ok: false, error: expect.stringContaining(text) as string });
const byText = (value: string) => (n: PMNode) => n.isTextblock && n.textContent === value;
const nodeAt = (e: Editor, pos: number) => e.state.doc.nodeAt(pos)!;
const run = (e: Editor) => [e.state, (tr: Parameters<typeof e.view.dispatch>[0]) => e.view.dispatch(tr)] as const;
const undo = (e: Editor) => e.commands.undo();
const redo = (e: Editor) => e.commands.redo();

describe('validateClassName / parseClassInput', () => {
  it('accepts class names and drops a leading dot', () => {
    expect(validateClassName('wide')).toEqual({ ok: true, value: 'wide' });
    expect(validateClassName('.frame')).toEqual({ ok: true, value: 'frame' });
    expect(validateClassName('Überschrift_2')).toEqual({ ok: true, value: 'Überschrift_2' });
  });

  it('rejects reserved, editor and malformed names with a reason', () => {
    for (const bad of ['block', 'page', 'columnWrapper', 'hb-continued', 'ProseMirror-selectednode', 'tiptap']) {
      const result = validateClassName(bad);
      expect(result.ok, bad).toBe(false);
    }
    expect(validateClassName('width:100px')).toMatchObject(refused('Style field'));
    expect(validateClassName('#intro')).toMatchObject(refused('Id field'));
    expect(validateClassName('a{b}')).toMatchObject({ ok: false });
    expect(validateClassName('x'.repeat(257))).toMatchObject({ ok: false });
    expect(validateClassName('   ')).toMatchObject({ ok: false });
    // .NET's char.IsWhiteSpace (the server drops such a class) includes U+0085, JS \s doesn't (UI-11).
    expect(validateClassName('a\u0085b')).toMatchObject(refused('space'));
    expect(validateClassName('a\u0000b')).toMatchObject({ ok: false });
  });

  it('splits on spaces, commas and dots and de-duplicates', () => {
    expect(parseClassInput('monster,frame')).toEqual({ ok: true, value: ['monster', 'frame'] });
    expect(parseClassInput('.monster.frame wide')).toEqual({ ok: true, value: ['monster', 'frame', 'wide'] });
    expect(parseClassInput('wide wide')).toEqual({ ok: true, value: ['wide'] });
    expect(parseClassInput(' ')).toMatchObject({ ok: false });
    expect(parseClassInput('wide block')).toMatchObject(refused('block'));
  });
});

describe('validateStyle', () => {
  it('normalizes declarations the way the DOM serializes them', () => {
    expect(validateStyle('color:red')).toEqual({ ok: true, value: 'color: red;' });
    expect(validateStyle('  color: red;  margin-top: 4px ')).toEqual({ ok: true, value: 'color: red; margin-top: 4px;' });
    expect(validateStyle('')).toEqual({ ok: true, value: null });
    expect(validateStyle('   ')).toEqual({ ok: true, value: null });
  });

  it('rejects declarations the browser drops, naming them', () => {
    const result = validateStyle('color: red; colr: blue');
    expect(result).toMatchObject(refused('colr: blue'));
    expect(validateStyle('color: nonsense-value')).toMatchObject({ ok: false });
    expect(validateStyle('just words')).toMatchObject(refused('just words'));
  });

  it('rejects selectors and braces, but not braces inside strings', () => {
    expect(validateStyle('.page { color: red }')).toMatchObject(refused('selectors'));
    expect(validateStyle('font-family: "a{b}"')).toMatchObject({ ok: true });
  });

  it('rejects script-capable CSS like the server (CssPolicy)', () => {
    expect(isUnsafeCss('width: expression(alert(1))')).toBe(true);
    expect(isUnsafeCss('background: url("javascript:alert(1)")')).toBe(true);
    expect(isUnsafeCss('background: url(java\\73 cript:x)')).toBe(true);
    expect(isUnsafeCss('behavior: url(x.htc)')).toBe(true);
    expect(isUnsafeCss('-moz-binding: url(x)')).toBe(true);
    expect(isUnsafeCss('scroll-behavior: smooth')).toBe(false);
    expect(isUnsafeCss('background: url(https://x/javascript:1.png)')).toBe(false);
    expect(validateStyle('background: url("javascript:alert(1)")')).toMatchObject(refused('javascript:'));
  });

  // The cases of the server's CssPolicyTests (tests/Homebrewery.Api.Tests/Documents/CssPolicyTests.cs).
  it.each([
    'scroll-behavior: smooth;',
    'overscroll-behavior: contain;',
    'font-family: "Expression (Bold)";',
    "font-family: 'My Expression(1)', serif",
    'background-image: url(https://e.x/javascript:1.png);',
    "background-image: url('/img/vbscript:x.png')",
    'content: "behavior: none"',
    'color: red; --my-expression: 1',
  ])('accepts what the server accepts: %s (UI-11)', (style) => {
    expect(isUnsafeCss(style)).toBe(false);
  });

  it.each([
    'behavior:url(x.htc)',
    'color: red; behavior: url(x.htc)',
    '-ms-behavior: url(x.htc)',
    '_behavior: url(x.htc)',
    'width:expression(alert(1))',
    'width: EXPRESSION (alert(1))',
    'background:url(javascript:alert(1))',
    'background:url( javascript:alert(1))',
    'background:url("javascript:x")',
    "background:url('vbscript:x')",
    'background:url(java\\73 cript:alert(1))',
    'java\\73 cript:',
    'expr/**/ession(',
    'width: expr\\65 ssion(alert(1))',
    '-moz-binding:url(x)',
    'width: \\"; x: expression(alert(1)); y: "',
    'font-family: "a"; width: expression(alert(1))',
    // A comment start inside a string is text: the comment after it still hides nothing.
    '--a: "/*"; --b: expr/**/ession(1)',
    "--a: '/*'; background: url(java/**/script:x)",
    'width: expression\u0085(1)',
  ])('refuses what the server refuses: %s (UI-11)', (style) => {
    expect(isUnsafeCss(style)).toBe(true);
  });

  it('refuses a style whose string holds a comment start before unsafe CSS (UI-11)', () => {
    expect(validateStyle('--a: "/*"; --b: expr/**/ession(1)')).toMatchObject(refused('expression()'));
  });

  it('rejects styles over 4096 characters', () => {
    expect(validateStyle(`--x: ${'a'.repeat(4100)}`)).toMatchObject(refused('4096'));
  });

  it('splits declarations outside quotes, parentheses and comments', () => {
    expect(splitDeclarations('a: 1; b: url(x;y); c: "p;q" ; /* d; */ e: 2;')).toEqual(['a: 1', 'b: url(x;y)', 'c: "p;q"', 'e: 2']);
    expect(decodeCss('java\\73 cript/* x */:')).toBe('javascript:');
  });
});

describe('validateId / collectIds', () => {
  const doc = async () =>
    (await makeEditor(
      docOf(
        page([
          node('heading', { level: 1 }, [text('Title')]),
          p('One', { id: 'one' }),
          node('paragraph', undefined, [text('span', [{ type: 'span', attrs: { id: 'sp', classes: ['x'] } }])]),
        ]),
      ),
    )).state.doc;

  it('collects node, heading and span ids', async () => {
    const ids = collectIds(await doc());
    expect([...ids.keys()].sort()).toEqual(['one', 'sp', 'title']);
  });

  it('accepts unique ids and trims a leading #', async () => {
    expect(validateId('#intro', await doc())).toEqual({ ok: true, value: 'intro' });
    expect(validateId('', await doc())).toEqual({ ok: true, value: null });
  });

  it('rejects duplicates (generated heading ids too), spaces and page ids', async () => {
    const d = await doc();
    expect(validateId('one', d)).toMatchObject(refused('already uses'));
    expect(validateId('title', d)).toMatchObject({ ok: false });
    expect(validateId('sp', d)).toMatchObject({ ok: false });
    expect(validateId('two words', d)).toMatchObject(refused('spaces'));
    expect(validateId('p3', d)).toMatchObject(refused('reserved'));
    expect(validateId('p12', d)).toMatchObject({ ok: false });
    expect(validateId('p3a', d)).toMatchObject({ ok: true });
  });

  it('does not count the element’s own id', async () => {
    const d = await doc();
    const pos = posOf(d, byText('One'));
    expect(validateId('one', d, (at) => at === pos)).toEqual({ ok: true, value: 'one' });
  });
});

describe('validateAttributeName and other validators', () => {
  it('allows SAFE_ATTR names, lower-cased', () => {
    expect(validateAttributeName('data-Foo')).toEqual({ ok: true, value: 'data-foo' });
    expect(validateAttributeName('aria-label')).toMatchObject({ ok: true });
    expect(validateAttributeName('title', 'paragraph')).toMatchObject({ ok: true });
  });

  it('rejects unsafe, reserved and own attributes', () => {
    expect(validateAttributeName('onclick')).toMatchObject(refused('data-'));
    expect(validateAttributeName('style')).toMatchObject({ ok: false });
    expect(validateAttributeName('data-pid')).toMatchObject(refused('editor'));
    expect(validateAttributeName('title', 'image')).toMatchObject(refused('own'));
    expect(validateAttributeName('')).toMatchObject({ ok: false });
  });

  it('footer and columns', () => {
    expect(validateFooter('  Part 1 | The Inn ')).toEqual({ ok: true, value: 'Part 1 | The Inn' });
    expect(validateFooter('a\nb')).toEqual({ ok: true, value: 'a b' });
    expect(validateFooter('')).toEqual({ ok: true, value: null });
    expect(validateFooter('x'.repeat(501))).toMatchObject({ ok: false });
    expect(validateColumns(1)).toEqual({ ok: true, value: 1 });
    expect(validateColumns(null)).toEqual({ ok: true, value: null });
    expect(validateColumns(3)).toMatchObject({ ok: false });
    expect(validateColumns('2')).toMatchObject({ ok: false });
  });

  it('marker helpers keep one cover type', () => {
    expect(withCover(['skipCounting', 'frontCover'], 'backCover')).toEqual(['backCover', 'skipCounting']);
    expect(withCover(['frontCover', 'custom'], null)).toEqual(['custom']);
    expect(coverOf(['skipCounting', 'partCover'])).toBe('partCover');
    expect(withMarker(['frontCover'], 'skipCounting', true)).toEqual(['frontCover', 'skipCounting']);
    expect(withMarker(['frontCover', 'skipCounting'], 'skipCounting', false)).toEqual(['frontCover']);
  });
});

describe('generic edits on nodes', () => {
  const content = () => docOf(page([p('Alpha'), p('Beta', { classes: ['note'] })]));

  it('adds a class as one undo step, and undo/redo restore it', async () => {
    const e = await makeEditor(content());
    const pos = posOf(e.state.doc, byText('Alpha'));
    const target: EditTarget = { kind: 'node', pos };
    const metas: unknown[] = [];
    e.on('transaction', ({ transaction }) => metas.push(transaction.getMeta(INSPECTOR_META)));
    expect(addClasses(...run(e), target, 'wide frame')).toEqual({ ok: true, changed: true });
    expect(nodeAt(e, pos).attrs.classes).toEqual(['wide', 'frame']);
    expect(metas).toContain(true);
    undo(e);
    expect(nodeAt(e, pos).attrs.classes).toEqual([]);
    redo(e);
    expect(nodeAt(e, pos).attrs.classes).toEqual(['wide', 'frame']);
  });

  it('each edit is its own undo step, even in quick succession and right after typing', async () => {
    const e = await makeEditor(content());
    const pos = posOf(e.state.doc, byText('Alpha'));
    e.commands.setTextSelection(pos + 2);
    e.commands.insertContent('x'); // typing, then two quick edits
    const target: EditTarget = { kind: 'node', pos };
    addClasses(...run(e), target, 'one');
    editStyle(...run(e), target, 'color: red');
    expect(nodeAt(e, pos).attrs).toMatchObject({ classes: ['one'], style: 'color: red;' });
    undo(e);
    expect(nodeAt(e, pos).attrs).toMatchObject({ classes: ['one'], style: null });
    undo(e);
    expect(nodeAt(e, pos).attrs).toMatchObject({ classes: [], style: null });
    expect(nodeAt(e, pos).textContent).toBe('Axlpha');
    undo(e);
    expect(nodeAt(e, pos).textContent).toBe('Alpha');
  });

  it('invalid input changes nothing and adds no undo step', async () => {
    const e = await makeEditor(content());
    const pos = posOf(e.state.doc, byText('Beta'));
    const before = e.state.doc;
    const target: EditTarget = { kind: 'node', pos };
    expect(addClasses(...run(e), target, 'block')).toMatchObject({ ok: false });
    expect(addClasses(...run(e), target, 'note')).toMatchObject(refused('already'));
    expect(editStyle(...run(e), target, 'colr: red')).toMatchObject({ ok: false });
    expect(editId(...run(e), target, 'p1')).toMatchObject({ ok: false });
    expect(setAttribute(...run(e), target, 'onclick', 'x')).toMatchObject({ ok: false });
    expect(e.state.doc).toBe(before);
    expect(e.can().undo()).toBe(false);
  });

  it('an unchanged value dispatches nothing', async () => {
    const e = await makeEditor(content());
    const pos = posOf(e.state.doc, byText('Beta'));
    const before = e.state.doc;
    expect(editClasses(...run(e), { kind: 'node', pos }, ['note'])).toEqual({ ok: true, changed: false });
    expect(editStyle(...run(e), { kind: 'node', pos }, '')).toEqual({ ok: true, changed: false });
    expect(e.state.doc).toBe(before);
  });

  it('removes a class, sets and clears a style', async () => {
    const e = await makeEditor(content());
    const pos = posOf(e.state.doc, byText('Beta'));
    const target: EditTarget = { kind: 'node', pos };
    expect(removeClass(...run(e), target, 'note')).toEqual({ ok: true, changed: true });
    expect(nodeAt(e, pos).attrs.classes).toEqual([]);
    editStyle(...run(e), target, 'margin-top:0');
    expect(nodeAt(e, pos).attrs.style).toBe('margin-top: 0px;');
    editStyle(...run(e), target, '');
    expect(nodeAt(e, pos).attrs.style).toBeNull();
  });

  it('sets, renames and removes attributes', async () => {
    const e = await makeEditor(content());
    const pos = posOf(e.state.doc, byText('Alpha'));
    const target: EditTarget = { kind: 'node', pos };
    expect(setAttribute(...run(e), target, 'data-a', '1')).toMatchObject({ ok: true, changed: true });
    expect(setAttribute(...run(e), target, 'Title', 'Hi')).toMatchObject({ ok: true });
    expect(nodeAt(e, pos).attrs.attributes).toEqual({ 'data-a': '1', title: 'Hi' });
    expect(setAttribute(...run(e), target, 'data-a', '2')).toMatchObject(refused('already set'));
    expect(setAttribute(...run(e), target, 'data-a', '2', 'data-a')).toMatchObject({ ok: true });
    expect(setAttribute(...run(e), target, 'data-b', '2', 'data-a')).toMatchObject({ ok: true });
    expect(nodeAt(e, pos).attrs.attributes).toEqual({ 'data-b': '2', title: 'Hi' });
    expect(setAttribute(...run(e), target, 'title', 'x', 'data-b')).toMatchObject({ ok: false });
    expect(removeAttribute(...run(e), target, 'title')).toEqual({ ok: true, changed: true });
    expect(nodeAt(e, pos).attrs.attributes).toEqual({ 'data-b': '2' });
  });

  it('ids: unique, and a heading’s id becomes custom (clearing hands it back to the slug)', async () => {
    const e = await makeEditor(docOf(page([node('heading', { level: 2 }, [text('Rumors')]), p('Body')])));
    const hpos = posOf(e.state.doc, (n) => n.type.name === 'heading');
    expect(nodeAt(e, hpos).attrs).toMatchObject({ id: 'rumors', customId: false });
    const target: EditTarget = { kind: 'node', pos: hpos };
    expect(editId(...run(e), target, 'rumors')).toEqual({ ok: true, changed: false });
    expect(editId(...run(e), target, 'gossip')).toEqual({ ok: true, changed: true });
    expect(nodeAt(e, hpos).attrs).toMatchObject({ id: 'gossip', customId: true });
    const ppos = posOf(e.state.doc, byText('Body'));
    expect(editId(...run(e), { kind: 'node', pos: ppos }, 'gossip')).toMatchObject({ ok: false });
    expect(editId(...run(e), target, '')).toEqual({ ok: true, changed: true });
    expect(nodeAt(e, hpos).attrs).toMatchObject({ id: 'rumors', customId: false });
    undo(e);
    expect(nodeAt(e, hpos).attrs).toMatchObject({ id: 'gossip', customId: true });
  });

  it('refuses nodes without generic attributes', async () => {
    const e = await makeEditor(docOf(page([node('definitionList', undefined, [node('definitionTerm', undefined, [text('T')]), node('definitionDesc', undefined, [text('D')])])])));
    const pos = posOf(e.state.doc, (n) => n.type.name === 'definitionTerm');
    expect(addClasses(...run(e), { kind: 'node', pos }, 'x')).toMatchObject({ ok: false });
  });
});

describe('split blocks (continuations)', () => {
  // A paragraph split across a manual page and its auto page.
  const content = () =>
    docOf(
      page([p('Head part', { id: 'lead' })]),
      page([p('tail part', { continuation: true }), p('Other')], { kind: 'auto' }),
    );

  it('shared attributes go to every fragment, the id to the head; one undo step', async () => {
    const e = await makeEditor(content());
    const tail = posOf(e.state.doc, byText('tail part'));
    const head = posOf(e.state.doc, byText('Head part'));
    const target: EditTarget = { kind: 'node', pos: tail };
    expect(genericValues(e.state, target)?.id).toBe('lead');
    addClasses(...run(e), target, 'wide');
    expect(nodeAt(e, head).attrs.classes).toEqual(['wide']);
    expect(nodeAt(e, tail).attrs.classes).toEqual(['wide']);
    expect(editId(...run(e), target, 'lead')).toEqual({ ok: true, changed: false }); // its own id
    editId(...run(e), target, 'opening');
    expect(nodeAt(e, head).attrs.id).toBe('opening');
    expect(nodeAt(e, tail).attrs.id).toBeNull();
    undo(e);
    expect(nodeAt(e, head).attrs.id).toBe('lead');
    undo(e);
    expect(nodeAt(e, head).attrs.classes).toEqual([]);
    expect(nodeAt(e, tail).attrs.classes).toEqual([]);
  });
});

describe('span marks', () => {
  const span = (attrs: Record<string, unknown>) => ({ type: 'span', attrs });
  const content = () =>
    docOf(page([node('paragraph', undefined, [text('plain '), text('styled', [span({ classes: ['a'] })]), text(' after')])]));

  it('finds the mark range around a position', async () => {
    const e = await makeEditor(content());
    const pos = posOf(e.state.doc, (n) => n.type.name === 'paragraph') + 1 + 'plain '.length + 2;
    const mark = e.state.doc.resolve(pos).marks()[0]!;
    const range = markRangeAt(e.state.doc, pos, mark);
    expect(range && e.state.doc.textBetween(range.from, range.to)).toBe('styled');
    const end = range!.to;
    expect(markRangeAt(e.state.doc, end, mark)?.from).toBe(range!.from);
  });

  it('edits a span’s classes, style and attributes over its whole range, one undo step each', async () => {
    const e = await makeEditor(content());
    const pos = posOf(e.state.doc, (n) => n.type.name === 'paragraph') + 1 + 'plain '.length + 1;
    const range = markRangeAt(e.state.doc, pos, e.state.doc.resolve(pos).marks()[0]!)!;
    const target: EditTarget = { kind: 'mark', ...range };
    expect(addClasses(...run(e), target, 'b')).toEqual({ ok: true, changed: true });
    const marksAfter = e.state.doc.resolve(pos).marks();
    expect(marksAfter).toHaveLength(1);
    expect(marksAfter[0]!.attrs.classes).toEqual(['a', 'b']);
    const range2 = markRangeAt(e.state.doc, pos, marksAfter[0]!)!;
    expect(e.state.doc.textBetween(range2.from, range2.to)).toBe('styled');
    // The old target (old attributes) is stale now.
    expect(addClasses(...run(e), target, 'c')).toMatchObject({ ok: false });
    undo(e);
    expect(e.state.doc.resolve(pos).marks()[0]!.attrs.classes).toEqual(['a']);
  });

  it('span ids are unique against nodes', async () => {
    const e = await makeEditor(docOf(page([p('x', { id: 'taken' }), node('paragraph', undefined, [text('s', [span({})])])])));
    const pos = posOf(e.state.doc, byText('s')) + 1;
    const range = markRangeAt(e.state.doc, pos, e.state.doc.resolve(pos).marks()[0]!)!;
    expect(editId(...run(e), { kind: 'mark', ...range }, 'taken')).toMatchObject({ ok: false });
    expect(editId(...run(e), { kind: 'mark', ...range }, 'free')).toEqual({ ok: true, changed: true });
  });
});

/** The section sync alone (the Pagination extension includes it; pagination needs a layout). */
const SectionSync = Extension.create({ name: 'testSectionSync', addProseMirrorPlugins: () => [sectionSyncPlugin()] });

describe('section settings', () => {
  // Section 1: pages 0–2 (manual + 2 auto), section 2: pages 3–4.
  const content = () =>
    docOf(
      page([p('s1 p0')], { columns: 2 }),
      page([p('s1 p1')], { kind: 'auto', columns: 2 }),
      page([p('s1 p2')], { kind: 'auto', columns: 2 }),
      page([p('s2 p3')], { pageNumber: true }),
      page([p('s2 p4')], { kind: 'auto', pageNumber: true }),
    );

  it('finds the section of a page', async () => {
    const e = await makeEditor(content());
    expect(sectionRange(e.state.doc, 0)).toEqual({ start: 0, end: 2 });
    expect(sectionRange(e.state.doc, 2)).toEqual({ start: 0, end: 2 });
    expect(sectionRange(e.state.doc, 4)).toEqual({ start: 3, end: 4 });
    expect(sectionSettings(e.state.doc, 4)).toMatchObject({ pageNumber: true, columns: null });
  });

  it('writes the section’s first page only', async () => {
    const e = await makeEditor(content());
    expect(editSection(...run(e), 2, { columns: 1 })).toEqual({ ok: true, changed: true });
    expect(e.state.doc.content.content.map((pg) => (pg.attrs as PageAttrs).columns)).toEqual([1, 2, 2, null, null]);
  });

  it('with the section sync, auto pages follow, not the next section; one undo step', async () => {
    const e = await makeEditor(content(), [SectionSync]);
    const attrs = () => e.state.doc.content.content.map((pg) => pg.attrs as PageAttrs);
    expect(editSection(...run(e), 1, { columns: 1, footer: ' Part 1 ', pageNumber: true })).toEqual({ ok: true, changed: true });
    expect(attrs().map((a) => a.columns)).toEqual([1, 1, 1, null, null]);
    expect(attrs().map((a) => a.footer)).toEqual(['Part 1', 'Part 1', 'Part 1', null, null]);
    expect(attrs().map((a) => a.pageNumber)).toEqual([true, true, true, true, true]);
    undo(e);
    expect(attrs().map((a) => a.columns)).toEqual([2, 2, 2, null, null]);
    expect(attrs().map((a) => a.footer)).toEqual([null, null, null, null, null]);
    expect(attrs().map((a) => a.pageNumber)).toEqual([false, false, false, true, true]);
  });

  it('section classes and style, validated', async () => {
    const e = await makeEditor(content(), [SectionSync]);
    expect(addSectionClasses(...run(e), 4, 'journal')).toEqual({ ok: true, changed: true });
    expect(e.state.doc.child(3).attrs.classes).toEqual(['journal']);
    expect(e.state.doc.child(4).attrs.classes).toEqual(['journal']);
    expect(editSection(...run(e), 3, { style: 'background: red' })).toMatchObject({ ok: true });
    expect(e.state.doc.child(4).attrs.style).toBe('background: red;');
    const before = e.state.doc;
    expect(editSection(...run(e), 3, { style: 'nope' })).toMatchObject({ ok: false });
    expect(editSection(...run(e), 3, { columns: 3 as never })).toMatchObject({ ok: false });
    expect(editSection(...run(e), 3, { classes: ['page'] })).toMatchObject({ ok: false });
    expect(editSection(...run(e), 3, { footer: 'x'.repeat(600) })).toMatchObject({ ok: false });
    expect(editSection(...run(e), 9, { pageNumber: false })).toMatchObject({ ok: false });
    expect(e.state.doc).toBe(before);
  });
});

describe('markers and page objects', () => {
  const objects = [
    { id: 'o1', kind: 'image', src: 'https://example.com/a.png', classes: ['banner'], style: 'position: absolute; top: 0px;' },
    { id: 'o2', kind: 'text', text: 'Art by X', classes: ['artist'], style: '' },
  ];
  const content = () => docOf(page([p('Cover')], { markers: ['skipCounting'], objects }), page([p('Next')], { kind: 'auto' }));

  it('markers belong to one page; one undo step', async () => {
    const e = await makeEditor(content());
    expect(editMarkers(...run(e), 0, withCover(e.state.doc.child(0).attrs.markers as string[], 'frontCover'))).toEqual({ ok: true, changed: true });
    expect(e.state.doc.child(0).attrs.markers).toEqual(['frontCover', 'skipCounting']);
    expect(e.state.doc.child(1).attrs.markers).toEqual([]);
    expect(editMarkers(...run(e), 1, ['resetCounting'])).toMatchObject({ ok: true });
    expect(e.state.doc.child(1).attrs.markers).toEqual(['resetCounting']);
    expect(editMarkers(...run(e), 0, ['bad marker'])).toMatchObject({ ok: false });
    undo(e);
    undo(e);
    expect(e.state.doc.child(0).attrs.markers).toEqual(['skipCounting']);
  });

  it('edits a page object’s classes and style', async () => {
    const e = await makeEditor(content());
    expect(addPageObjectClasses(...run(e), 0, 'o2', 'watercolor4')).toEqual({ ok: true, changed: true });
    expect(editPageObject(...run(e), 0, 'o1', { style: 'position:absolute;top:10px' })).toEqual({ ok: true, changed: true });
    const list = e.state.doc.child(0).attrs.objects as { id: string; classes: string[]; style: string }[];
    expect(list.find((o) => o.id === 'o2')?.classes).toEqual(['artist', 'watercolor4']);
    expect(list.find((o) => o.id === 'o1')?.style).toBe('position: absolute; top: 10px;');
    expect(editPageObject(...run(e), 0, 'o1', { style: 'top: {' })).toMatchObject({ ok: false });
    expect(editPageObject(...run(e), 0, 'nope', { style: '' })).toMatchObject({ ok: false });
    undo(e);
    expect((e.state.doc.child(0).attrs.objects as { style: string }[])[0]!.style).toBe('position: absolute; top: 0px;');
  });

  it("edits on an auto page are undone after pagination moved the page's boundary (UI-1)", async () => {
    const e = await makeEditor(docOf(page([p('Cover')]), page([p('Next'), p('More')], { kind: 'auto', objects })));
    const pid = e.state.doc.child(1).attrs.pid as string;
    expect(pid).toBeTruthy();
    expect(editPageObject(...run(e), 1, 'o1', { style: 'position:absolute;top:10px' })).toMatchObject({ ok: true });
    expect(editMarkers(...run(e), 1, ['skipCounting'])).toMatchObject({ ok: true });
    // A pull, as pagination does it: join page 2 into page 1, split after its first block.
    const tr = e.state.tr.setMeta('addToHistory', false);
    moveBoundary(tr, 0, endOfFirstBlock(pageAt(e.state.doc, 1)!));
    e.view.dispatch(tr);
    expect(e.state.doc.child(1).attrs.pid).toBe(pid);
    expect(e.state.doc.child(1).textContent).toBe('More');
    undo(e);
    expect(e.state.doc.child(1).attrs.markers).toEqual([]);
    undo(e);
    expect((e.state.doc.child(1).attrs.objects as { style: string }[])[0]!.style).toBe('position: absolute; top: 0px;');
  });
});
