// Snippet insertion in jsdom: the importer runs with mountInlineProbe (no layout; the style
// below stands in for the theme), then the transactions are checked on a real editor with undo.
import { Editor, type JSONContent } from '@tiptap/core';
import { GapCursor } from '@tiptap/pm/gapcursor';
import { AllSelection, TextSelection } from '@tiptap/pm/state';
import { undo, undoDepth } from '@tiptap/pm/history';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mountInlineProbe } from '../canvas/probe';
import { buildEditorExtensions } from '../editorExtensions';
import { docOf, node, p, page } from '../schema/testing';
import { createSnippetInserter } from './inserter';
import { insertPagesTr, insertSnippet, snippetToDoc, type SnippetToDocOptions } from './insertSnippet';
import { footerTextBefore, pageBreakTr, pageMarkerTr } from './nativeCommands';

const probe = () => Promise.resolve(mountInlineProbe());
const opts: SnippetToDocOptions = { theme: '5ePHB', probe };

let editor: Editor | null = null;
let sheet: HTMLStyleElement;
beforeEach(() => {
  sheet = document.createElement('style');
  sheet.textContent = '.page { position: relative } .pageNumber, .footnote { position: absolute }';
  document.head.appendChild(sheet);
});
afterEach(() => {
  editor?.destroy();
  editor = null;
  sheet.remove();
  document.body.innerHTML = '';
});

function mount(content: JSONContent): Editor {
  const element = document.createElement('div');
  document.body.append(element);
  editor = new Editor({ element, extensions: buildEditorExtensions(), content });
  return editor;
}

/** Puts the cursor at the first occurrence of `text` + offset. */
function cursorAt(e: Editor, text: string, offset = 0): void {
  let found = -1;
  e.state.doc.descendants((n, pos) => {
    if (found >= 0) return false;
    if (n.isText && n.text?.includes(text)) found = pos + n.text.indexOf(text) + offset;
    return true;
  });
  if (found < 0) throw new Error(`no "${text}"`);
  e.view.dispatch(e.state.tr.setSelection(TextSelection.create(e.state.doc, found)));
}

/** The document as plain JSON. */
const json = (e: Editor): JSONContent => e.getJSON() as JSONContent;
const pageTypes = (e: Editor) => json(e).content!.map((pg) => (pg.content ?? []).map((b) => b.type).join(','));
const pageKinds = (e: Editor) => json(e).content!.map((pg) => String(pg.attrs?.kind));
/** Page texts joined with '#', blocks with '|'. */
const plain = (e: Editor) => {
  const pages: string[] = [];
  e.state.doc.forEach((pg) => pages.push(pg.textBetween(0, pg.content.size, '|')));
  return pages.join('#');
};

describe('insertSnippet', () => {
  it('replaces an empty paragraph with the snippet blocks (one undo step)', async () => {
    const e = mount(docOf(page([p('Before'), p(''), p('After')])));
    cursorAt(e, 'Before', 6);
    e.commands.setTextSelection(e.state.selection.from + 2); // into the empty paragraph
    const depth = Number(undoDepth(e.state));
    const result = await insertSnippet(e, '{{note\n##### A Note\nSome text.\n}}\n', opts);
    expect(result.kind).toBe('blocks');
    expect(pageTypes(e)).toEqual(['paragraph,themeBlock,paragraph']);
    expect(json(e).content![0]!.content![1]!.attrs?.classes).toEqual(['note']);
    // The cursor goes after the block (as upstream's after the inserted text): the next paragraph.
    expect(e.state.selection.$from.parent.textContent).toBe('After');
    expect(e.state.selection.$from.parentOffset).toBe(0);
    expect(undoDepth(e.state)).toBe(depth + 1);
    undo(e.state, e.view.dispatch);
    expect(pageTypes(e)).toEqual(['paragraph,paragraph,paragraph']);
  });

  it('keeps the empty line after a block at the end of the page, so the next snippet goes after it', async () => {
    const e = mount(docOf(page([p('')])));
    await insertSnippet(e, '{{note\nFirst\n}}\n', opts);
    expect(pageTypes(e)).toEqual(['themeBlock,paragraph']);
    expect(e.state.selection.$from.parent.type.name).toBe('paragraph');
    expect(e.state.selection.$from.depth).toBe(2);
    await insertSnippet(e, '{{descriptive\nSecond\n}}\n', opts);
    expect(pageTypes(e)).toEqual(['themeBlock,themeBlock,paragraph']);
    // Text-ending snippets replace the empty paragraph.
    await insertSnippet(e, '## Heading\n\nText.\n', opts);
    expect(pageTypes(e)).toEqual(['themeBlock,themeBlock,heading,paragraph']);
    expect(plain(e)).toBe('First|Second|Heading|Text.');
  });

  it('moves the cursor after an inserted block when text follows it', async () => {
    const e = mount(docOf(page([p(''), p('Next')])));
    await insertSnippet(e, '{{note\nMiddle\n}}\n', opts);
    expect(pageTypes(e)).toEqual(['themeBlock,paragraph']);
    expect(e.state.selection.$from.parent.textContent).toBe('Next');
    // Inside a note, at its end: the empty line stays inside the note, after the table.
    const f = mount(docOf(page([node('themeBlock', { classes: ['note'] }, [p('')])])));
    f.commands.setTextSelection(3);
    await insertSnippet(f, '| a | b |\n|---|---|\n| 1 | 2 |\n', opts);
    expect(json(f).content![0]!.content![0]!.content!.map((n) => n.type)).toEqual(['table', 'paragraph']);
    expect(f.state.selection.$from.node(2).type.name).toBe('themeBlock');
  });

  it('merges a single plain paragraph into the current one', async () => {
    const e = mount(docOf(page([p('Hello world')])));
    cursorAt(e, 'world');
    await insertSnippet(e, '[Click here](#p3) to go to page 3\n', opts);
    expect(pageTypes(e)).toEqual(['paragraph']);
    expect(plain(e)).toBe('Hello Click here to go to page 3world');
    expect(e.state.doc.firstChild!.firstChild!.nodeAt(6)?.marks.map((m) => m.type.name)).toEqual(['link']);
  });

  it('inserts inline atoms (horizontal spacing) into the paragraph', async () => {
    const e = mount(docOf(page([p('ab')])));
    cursorAt(e, 'ab', 1);
    await insertSnippet(e, ' {{width:100px}} ', opts);
    const para = json(e).content![0]!.content![0]!;
    expect(para.content?.map((n) => n.type)).toContain('inlineBox');
  });

  it('splits the paragraph around block snippets', async () => {
    const e = mount(docOf(page([p('Hello world')])));
    cursorAt(e, 'world');
    await insertSnippet(e, '\n::::\n', opts);
    expect(pageTypes(e)[0]).toMatch(/^paragraph,(spacer,)+paragraph$/);
  });

  it('lifts page-level pieces onto the current page and section', async () => {
    const e = mount(docOf(page([p('One')]), page([p('Two')], { kind: 'auto' })));
    cursorAt(e, 'One');
    await insertSnippet(e, '{{frontCover}}\n\n{{pageNumber,auto}}\n\n{{footnote PART 2 | TEST}}\n', opts);
    const [first, second] = json(e).content!;
    expect(first!.attrs).toMatchObject({ markers: ['frontCover'], pageNumber: true, footer: 'PART 2 | TEST' });
    // Section settings reach the auto page; the marker stays on its page.
    expect(second!.attrs).toMatchObject({ markers: [], pageNumber: true, footer: 'PART 2 | TEST' });
    expect(pageTypes(e)).toEqual(['paragraph', 'paragraph']);
    undo(e.state, e.view.dispatch);
    expect(json(e).content![0]!.attrs).toMatchObject({ markers: [], pageNumber: false, footer: null });
  });

  it('inserts \\page snippets as manual pages after the current section', async () => {
    const e = mount(docOf(page([p('Intro')]), page([p('Flow')], { kind: 'auto' }), page([p('Next section')])));
    cursorAt(e, 'Intro');
    const result = await insertSnippet(e, '# Cover\n\nCover text.\n\\page\n## Second\n\nMore.\n\\page\n', opts);
    expect(result).toMatchObject({ kind: 'pages', pages: 2 });
    expect(pageKinds(e)).toEqual(['manual', 'auto', 'manual', 'manual', 'manual']);
    expect(plain(e)).toBe('Intro#Flow#Cover|Cover text.#Second|More.#Next section');
    // The cursor moves to the first inserted page.
    expect(e.state.selection.$head.index(0)).toBe(2);
    undo(e.state, e.view.dispatch);
    expect(plain(e)).toBe('Intro#Flow#Next section');
  });

  it('replaces an empty current page, keeping its section settings', async () => {
    const e = mount(docOf(page([p('Intro')]), page([p('')], { pageNumber: true, columns: 1 })));
    e.commands.setTextSelection(e.state.doc.content.size - 2);
    await insertSnippet(e, '# Cover\n\\page\n', opts);
    // Nothing follows: the page after the trailing \page stays and takes the cursor (as upstream).
    expect(plain(e)).toBe('Intro#Cover#');
    expect(e.state.selection.$head.index(0)).toBe(2);
    expect(json(e).content![1]!.attrs).toMatchObject({ kind: 'manual', pageNumber: true, columns: 1 });
  });

  it('keeps an empty current page that carries objects or markers, inserting after it (UI-3)', async () => {
    const object = { id: 'o1', kind: 'text', classes: ['banner'], style: 'position: absolute; top: 0px; left: 0px;', text: 'Chapter 1' };
    const e = mount(docOf(page([p('Intro')]), page([p('')], { markers: ['skipCounting'], objects: [object] })));
    e.commands.setTextSelection(e.state.doc.content.size - 2);
    await insertSnippet(e, '# Cover\n\\page\n', opts);
    expect(json(e).content![1]!.attrs).toMatchObject({ markers: ['skipCounting'], objects: [expect.objectContaining({ id: 'o1', text: 'Chapter 1' })] });
    expect(plain(e)).toBe('Intro##Cover#');
    // The cursor is on the page left after the trailing \page, as when a blank page is replaced.
    expect(e.state.selection.$head.index(0)).toBe(3);
  });

  it('inserts pages with everything selected (Mod-A) after the last section (UI-4)', () => {
    const e = mount(docOf(page([p('One')]), page([p('Two')])));
    e.view.dispatch(e.state.tr.setSelection(new AllSelection(e.state.doc)));
    const cover = e.schema.nodeFromJSON(page([node('heading', { level: 1 }, [{ type: 'text', text: 'Cover' }])], { markers: ['frontCover'] }));
    const inserted = insertPagesTr(e.state, [cover]);
    expect(inserted).not.toBeNull();
    e.view.dispatch(inserted!.tr);
    expect(plain(e)).toBe('One#Two#Cover');
    expect(e.state.selection.$head.index(0)).toBe(2);
  });

  it('snippetToDoc reports CSS the snippet carries', async () => {
    const doc = await snippetToDoc('Text\n\n<style>.x { color: red }</style>\n', opts);
    expect(doc.style).toContain('.x { color: red }');
    expect(doc.pageSnippet).toBe(false);
  });
});

describe('createSnippetInserter', () => {
  it('runs generators, native actions and queues insertions', async () => {
    const e = mount(docOf(page([p('Chapter')])));
    const styles: string[] = [];
    const inserter = createSnippetInserter(e, { theme: () => '5ePHB', probe, onStyle: (css) => styles.push(css) });
    cursorAt(e, 'Chapter', 7);
    const [a, b] = await Promise.all([
      inserter.insert({ name: 'One', gen: () => '\n\n{{note\nFirst\n}}\n' }),
      inserter.insert({ name: 'Two', gen: 'Second\n\n<style>.y { color: blue }</style>\n' }),
    ]);
    expect(a.kind).toBe('blocks');
    expect(b.kind).toBe('blocks');
    expect(plain(e)).toContain('First');
    expect(plain(e)).toContain('Second');
    expect(styles).toEqual(['.y { color: blue }']);
    const toc = await inserter.insert({ name: 'Table of Contents', gen: '\\page' });
    expect(toc.kind).toBe('native');
    expect(e.state.doc.childCount).toBe(2);
    expect(inserter.busy).toBe(false);
    inserter.dispose();
  });

  it('reports generator errors', async () => {
    const e = mount(docOf(page([p('x')])));
    const inserter = createSnippetInserter(e, { theme: () => '5ePHB', probe });
    await expect(
      inserter.insert({
        name: 'Broken',
        gen: () => {
          throw new Error('boom');
        },
      }),
    ).rejects.toThrow('The snippet "Broken" failed: boom');
  });
});

describe('native commands', () => {
  it('footerTextBefore finds the last heading of the level before the cursor', () => {
    const e = mount(
      docOf(
        page([node('heading', { level: 1 }, [{ type: 'text', text: 'Part One' }]), p('a'), node('heading', { level: 2 }, [{ type: 'text', text: 'Sub' }])]),
        page([p('b'), node('heading', { level: 1 }, [{ type: 'text', text: 'Part Two' }])]),
      ),
    );
    cursorAt(e, 'b');
    expect(footerTextBefore(e.state.doc, e.state.selection.from, 1)).toBe('Part One');
    expect(footerTextBefore(e.state.doc, e.state.selection.from, 2)).toBe('Sub');
    expect(footerTextBefore(e.state.doc, e.state.selection.from, 3)).toBe('PART 1 | SECTION NAME');
    expect(footerTextBefore(e.state.doc, e.state.doc.content.size, 1)).toBe('Part Two');
  });

  it('native actions change settings in one undo step', () => {
    const e = mount(docOf(page([node('heading', { level: 1 }, [{ type: 'text', text: 'Part One' }]), p('text')]), page([p('more')], { kind: 'auto' })));
    const inserter = createSnippetInserter(e, { theme: () => '5ePHB', probe });
    cursorAt(e, 'more');
    for (const action of [
      { kind: 'footer', level: 1 },
      { kind: 'pageNumber' },
      { kind: 'marker', marker: 'skipCounting' },
    ] as const) {
      const depth = Number(undoDepth(e.state));
      expect(inserter.runNative(action).kind).toBe('native');
      expect(undoDepth(e.state)).toBe(depth + 1);
    }
    const [first, second] = json(e).content!;
    expect(first!.attrs).toMatchObject({ footer: 'Part One', pageNumber: true, markers: [] });
    // Section settings live on the section's first page (the section sync, part of Pagination,
    // copies them to auto pages); the marker is on the cursor's page.
    expect(second!.attrs).toMatchObject({ markers: ['skipCounting'] });
    // Again: nothing to change.
    expect(inserter.runNative({ kind: 'pageNumber' }).kind).toBe('nothing');
    undo(e.state, e.view.dispatch);
    expect(json(e).content![1]!.attrs?.markers).toEqual([]);
  });

  it('inserts a live toc node (the empty line stays after it at the end of a page)', () => {
    const e = mount(docOf(page([p('')])));
    const inserter = createSnippetInserter(e, { theme: () => '5ePHB', probe });
    inserter.runNative({ kind: 'toc' });
    expect(json(e).content![0]!.content).toEqual([{ type: 'toc', attrs: { depth: 6, wide: true, title: 'Contents' } }, { type: 'paragraph', attrs: expect.anything() as unknown }]);
    // Before an atom: the empty paragraph is replaced, and a gap cursor sits between the two.
    const f = mount(docOf(page([p(''), node('horizontalRule')])));
    createSnippetInserter(f, { theme: () => '5ePHB', probe }).runNative({ kind: 'toc' });
    expect(pageTypes(f)).toEqual(['toc,horizontalRule']);
    expect(f.state.selection).toBeInstanceOf(GapCursor);
  });

  it('page markers go to the last page with everything selected (Mod-A), never throwing (UI-4)', async () => {
    const e = mount(docOf(page([p('One')]), page([p('Two')])));
    e.view.dispatch(e.state.tr.setSelection(new AllSelection(e.state.doc)));
    const tr = pageMarkerTr(e.state, 'skipCounting');
    expect(tr).not.toBeNull();
    e.view.dispatch(tr!);
    expect(json(e).content!.map((pg) => pg.attrs?.markers as unknown)).toEqual([[], ['skipCounting']]);
    const inserter = createSnippetInserter(e, { theme: () => '5ePHB', probe });
    e.view.dispatch(e.state.tr.setSelection(new AllSelection(e.state.doc)));
    await expect(inserter.insert({ name: 'Restart page numbering', gen: '{{resetCounting}}' })).resolves.toMatchObject({ kind: 'native' });
    expect(json(e).content![1]!.attrs?.markers).toEqual(['skipCounting', 'resetCounting']);
  });

  it('a native action that throws rejects the insertion instead of throwing (UI-4)', async () => {
    const e = mount(docOf(page([p('One')])));
    const inserter = createSnippetInserter(e, { theme: () => '5ePHB', probe });
    const dispatch = vi.spyOn(e.view, 'dispatch').mockImplementation(() => {
      throw new RangeError('boom');
    });
    let pending: Promise<unknown> | null = null;
    expect(() => {
      pending = inserter.insert({ name: 'Skip page numbering', gen: '{{skipCounting}}' });
    }).not.toThrow();
    dispatch.mockRestore();
    await expect(pending).rejects.toThrow('boom');
  });

  it('page break splits the page into a new manual section with the same settings', () => {
    const e = mount(docOf(page([p('First half'), p('Second')], { pageNumber: true, footer: 'F', markers: ['frontCover'] })));
    cursorAt(e, 'half');
    e.view.dispatch(pageBreakTr(e.state)!);
    expect(plain(e)).toBe('First #half|Second');
    const [a, b] = json(e).content!;
    expect(b!.attrs).toMatchObject({ kind: 'manual', pageNumber: true, footer: 'F', markers: [] });
    expect(a!.attrs?.markers).toEqual(['frontCover']);
    expect(e.state.selection.$head.index(0)).toBe(1);
    // At the end of the last block: a new empty page.
    e.commands.setTextSelection(e.state.doc.content.size - 2);
    e.view.dispatch(pageBreakTr(e.state)!);
    expect(e.state.doc.childCount).toBe(3);
    expect(plain(e)).toBe('First #half|Second#');
  });

  it('page break inside a table goes after the table', () => {
    const cell = (t: string) => node('tableCell', undefined, [p(t)]);
    const table = node('table', undefined, [node('tableRow', undefined, [cell('A'), cell('B')])]);
    const e = mount(docOf(page([p('x'), table, p('after')])));
    cursorAt(e, 'A');
    e.view.dispatch(pageBreakTr(e.state)!);
    expect(pageTypes(e)).toEqual(['paragraph,table', 'paragraph']);
  });
});
