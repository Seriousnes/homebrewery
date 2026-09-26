import { Editor, type JSONContent } from '@tiptap/core';
import { Fragment, type Node as PMNode, type Slice as PMSlice } from '@tiptap/pm/model';
import { afterEach, describe, expect, it } from 'vitest';
import { buildEditorExtensions } from '../../editorExtensions';
import { docOf, node, p, page, text } from '../testing';
import { LAYOUT_NEUTRAL_META, headingIdUpdates, pagesNeedingIds } from './index';

let editor: Editor | undefined;
afterEach(() => {
  editor?.destroy();
  editor = undefined;
});

async function mount(content: JSONContent): Promise<Editor> {
  editor = new Editor({ extensions: buildEditorExtensions(), content });
  await Promise.resolve(); // the one-time fix after mount runs in a microtask
  return editor;
}

const heading = (level: number, value: string, attrs: Record<string, unknown> = {}) =>
  node('heading', { level, ...attrs }, value ? [text(value)] : undefined);

function headingIds(e: Editor): (string | null)[] {
  const ids: (string | null)[] = [];
  e.state.doc.descendants((n) => {
    if (n.type.name === 'heading') ids.push(n.attrs.id as string | null);
  });
  return ids;
}

describe('headingIds', () => {
  it('assigns unique slugs across the document on mount, keeping custom ids', async () => {
    const e = await mount(
      docOf(
        page([heading(1, 'The Wandering Inn'), heading(2, 'Title'), heading(2, 'Custom', { id: 'title', customId: true })]),
        page([heading(2, 'Title'), node('themeBlock', { classes: ['note'] }, [heading(5, 'Rumors'), p('x')]), heading(3, '')]),
      ),
    );
    // "title" is taken by the custom heading, so the generated ones become title-1, title-2.
    expect(headingIds(e)).toEqual(['the-wandering-inn', 'title-1', 'title', 'title-2', 'rumors', null]);
  });

  it('updates the id when the heading text changes, outside the undo history', async () => {
    const e = await mount(docOf(page([heading(1, 'Old name'), p('body')])));
    expect(headingIds(e)).toEqual(['old-name']);
    e.commands.setTextSelection({ from: 2, to: 5 }); // "Old"
    e.commands.insertContent('New');
    expect(headingIds(e)).toEqual(['new-name']);
    e.commands.undo();
    expect(e.state.doc.firstChild?.firstChild?.textContent).toBe('Old name');
    expect(headingIds(e)).toEqual(['old-name']);
  });

  it('marks its transactions layout-neutral and keeps them out of history', async () => {
    const e = await mount(docOf(page([heading(1, 'A')])));
    const metas: unknown[] = [];
    e.on('transaction', ({ appendedTransactions }) => {
      for (const tr of appendedTransactions) {
        if (tr.getMeta(LAYOUT_NEUTRAL_META)) metas.push(tr.getMeta('addToHistory'));
      }
    });
    e.commands.insertContentAt(2, 'B');
    expect(metas).toEqual([false]);
  });

  // RV-11: custom ids were never deduplicated (a copied custom-id heading duplicated its id), and
  // a heading "P2" took page 2's DOM id p2 (#p2 page links).
  it('keeps ids unique: a repeated custom id becomes a generated one, page ids p{n} are taken', async () => {
    const e = await mount(
      docOf(
        page([heading(2, 'Intro', { id: 'intro', customId: true }), heading(2, 'Intro', { id: 'intro', customId: true }), heading(2, 'P2')]),
        page([p('x')]),
      ),
    );
    expect(headingIds(e)).toEqual(['intro', 'intro-1', 'p2-1']);
    const customIds: unknown[] = [];
    e.state.doc.descendants((n) => {
      if (n.type.name === 'heading') customIds.push(n.attrs.customId);
    });
    expect(customIds).toEqual([true, false, false]);
  });

  it('a pasted copy of a custom-id heading gets a new id; the original keeps its own', async () => {
    for (const where of ['before', 'after'] as const) {
      const e = await mount(docOf(page([p('first'), heading(2, 'Intro', { id: 'intro', customId: true }), p('last')])));
      const original = e.state.doc.firstChild!.child(1);
      const html = clipboardHtml(e, original);
      const target = where === 'before' ? 1 + e.state.doc.firstChild!.child(0).nodeSize : e.state.doc.firstChild!.content.size + 1;
      e.commands.setTextSelection(target - 1);
      pasteHtml(e, html);
      const found: { text: string; id: unknown; customId: unknown; pos: number }[] = [];
      e.state.doc.descendants((n, pos) => {
        if (n.type.name === 'heading') found.push({ text: n.textContent, id: n.attrs.id, customId: n.attrs.customId, pos });
      });
      expect(found, where).toHaveLength(2);
      const [a, b] = found;
      const [copy, orig] = where === 'before' ? [a!, b!] : [b!, a!];
      expect(orig, where).toMatchObject({ id: 'intro', customId: true });
      expect(copy, where).toMatchObject({ id: 'intro-1', customId: false });
      e.destroy();
    }
  });

  it('headingIdUpdates matches upstream slugs (marked-gfm-heading-id)', () => {
    const doc = docNode(
      docOf(
        page([
          heading(1, 'Hello, World!'),
          heading(2, 'Hello, World!'),
          heading(2, '  Spaces  around '),
          heading(3, 'Ünïcödé Straße 42'),
          heading(3, "Don’t stop — go"),
          node('heading', { level: 3 }, [text('With '), node('icon', { font: 'df', glyph: 'd12-2' }), text(' icon')]),
        ]),
      ),
    );
    expect(headingIdUpdates(doc).map((u) => u.id)).toEqual([
      'hello-world',
      'hello-world-1',
      'spaces--around',
      'ünïcödé-straße-42',
      'dont-stop--go',
      'with--icon',
    ]);
  });
});

describe('pageIds', () => {
  it('gives pages without a pid a new one and fixes duplicates', async () => {
    const e = await mount(docOf(page([p('a')], { pid: 'aaaaaaaa' }), page([p('b')]), page([p('c')], { pid: 'aaaaaaaa' })));
    const pids: string[] = [];
    e.state.doc.forEach((pg) => pids.push(pg.attrs.pid as string));
    expect(pids[0]).toBe('aaaaaaaa');
    expect(pids[1]).toMatch(/^[0-9a-z]{8}$/);
    expect(pids[2]).toMatch(/^[0-9a-z]{8}$/);
    expect(new Set(pids).size).toBe(3);
    expect(pagesNeedingIds(e.state.doc)).toEqual([]);
  });

  // RV-12: the first page in document order kept a duplicated pid, so pasting a copy of a page
  // before it moved the original's identity to the copy.
  it('a page pasted before its original gets a new pid; the original keeps its own', async () => {
    const e = await mount(docOf(page([p('one')], { pid: 'pid00001' }), page([p('two')], { pid: 'pid00002' }), page([p('three')], { pid: 'pid00003' })));
    const doc = e.state.doc;
    const start2 = doc.child(0).nodeSize;
    const start3 = start2 + doc.child(1).nodeSize;
    // From inside page 1 to inside page 3: the slice holds the whole of page 2.
    const slice = doc.slice(3, start3 + 3);
    const html = e.view.serializeForClipboard(slice).dom.innerHTML;
    e.commands.setTextSelection(1); // start of page 1's text
    pasteHtml(e, html);
    const pages: { text: string; pid: string }[] = [];
    e.state.doc.forEach((pg) => pages.push({ text: pg.textContent, pid: pg.attrs.pid as string }));
    expect(new Set(pages.map((x) => x.pid)).size).toBe(pages.length);
    // The originals keep their pids.
    expect(pages.find((x) => x.text === 'two' && x.pid === 'pid00002')).toBeDefined();
    expect(pages.filter((x) => x.text === 'two')).toHaveLength(2);
    expect(pages.find((x) => x.text === 'three')?.pid).toBe('pid00003');
    const copies = pages.filter((x) => x.text === 'two');
    expect(copies[0]!.pid).not.toBe('pid00002'); // the pasted copy (first in document order)
    expect(copies[1]!.pid).toBe('pid00002');
  });

  it('pagesNeedingIds keeps a duplicate pid on the page `keeps` names', () => {
    const doc = docNode(docOf(page([p('copy')], { pid: 'orig0001' }), page([p('a')], { pid: 'aaaa0001' }), page([p('original')], { pid: 'orig0001' })));
    const originalPos = doc.child(0).nodeSize + doc.child(1).nodeSize;
    expect(pagesNeedingIds(doc)).toEqual([originalPos]); // mount-time fix: first in document order
    expect(pagesNeedingIds(doc, (pos, pid) => pos === originalPos && pid === 'orig0001')).toEqual([0]);
  });

  it('assigns a pid to pages added later', async () => {
    const e = await mount(docOf(page([p('a')], { pid: 'aaaaaaaa' })));
    e.commands.insertContentAt(e.state.doc.content.size, { type: 'page', content: [{ type: 'paragraph' }] });
    expect(e.state.doc.childCount).toBe(2);
    expect(e.state.doc.child(1).attrs.pid).toMatch(/^[0-9a-z]{8}$/);
  });
});

describe('page DOM ids and root class', () => {
  it('renders .ProseMirror.pages with only pages, id="p{n}" by index', async () => {
    const e = await mount(docOf(page([p('one')]), page([p('two')]), page([p('three')])));
    const root = e.view.dom;
    expect(root.classList.contains('pages')).toBe(true);
    expect(Array.from(root.children).map((c) => [c.className, c.id])).toEqual([
      ['page', 'p1'],
      ['page', 'p2'],
      ['page', 'p3'],
    ]);
    // Deleting the first page renumbers the others.
    e.commands.deleteRange({ from: 0, to: e.state.doc.child(0).nodeSize });
    expect(Array.from(root.children).map((c) => c.id)).toEqual(['p1', 'p2']);
    expect(root.querySelector('#p1 p')?.textContent).toBe('two');
  });
});

// A ProseMirror node from JSON, without mounting an editor.
function docNode(json: JSONContent) {
  const probe = new Editor({ extensions: buildEditorExtensions(), content: json });
  const doc = probe.state.doc;
  probe.destroy();
  return doc;
}

/** What copying `node` (a block of the first page) in `e` puts on the clipboard. */
function clipboardHtml(e: Editor, node: PMNode): string {
  const Slice = e.state.doc.slice(0, 0).constructor as new (content: Fragment, openStart: number, openEnd: number) => PMSlice;
  return e.view.serializeForClipboard(new Slice(Fragment.from(node), 0, 0)).dom.innerHTML;
}

/** ProseMirror's paste path (jsdom has no ClipboardEvent). */
function pasteHtml(e: Editor, html: string): void {
  e.view.pasteHTML(html, new Event('paste') as ClipboardEvent);
}
