// Snippet previews (the Insert snippet gallery) in jsdom: the inserter's prepare/insertPrepared
// (preview == inserted result), the preview models, and their static DOM. The importer runs with
// mountInlineProbe (no layout).
import { Editor, type JSONContent } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';
import { afterEach, describe, expect, it } from 'vitest';
import { mountInlineProbe } from '../canvas/probe';
import { buildEditorExtensions } from '../editorExtensions';
import { docOf, node, p, page } from '../schema/testing';
import { createSnippetInserter } from './inserter';
import { snippetToDoc } from './insertSnippet';
import { markdownPreview, nativePreview, renderPreviewPages } from './preview';

const probe = () => Promise.resolve(mountInlineProbe());

let editor: Editor | null = null;
afterEach(() => {
  editor?.destroy();
  editor = null;
  document.body.innerHTML = '';
});

function mount(content: JSONContent): Editor {
  const element = document.createElement('div');
  document.body.append(element);
  editor = new Editor({ element, extensions: buildEditorExtensions(), content });
  return editor;
}

function cursorAt(e: Editor, text: string, offset = 0): void {
  let pos = -1;
  e.state.doc.descendants((n, at) => {
    if (pos < 0 && n.isText && n.text?.includes(text)) pos = at + n.text.indexOf(text) + offset;
  });
  e.view.dispatch(e.state.tr.setSelection(TextSelection.create(e.state.doc, pos)));
}

const heading = (level: number, text: string) => node('heading', { level }, [{ type: 'text', text }]);

describe('prepare and insertPrepared', () => {
  it('runs the generator once: the prepared result is what gets inserted', async () => {
    const e = mount(docOf(page([p('')])));
    const inserter = createSnippetInserter(e, { theme: () => '5ePHB', probe });
    let runs = 0;
    const entry = { name: 'Counter', gen: () => `{{note\nRun ${++runs}\n}}\n` };
    const prepared = inserter.prepare(entry);
    const ready = await prepared;
    expect(ready.kind).toBe('markdown');
    const preview = markdownPreview(e.schema, ready.kind === 'markdown' ? ready.snippet : (null as never));
    expect(renderPreviewPages(preview)!.textContent).toContain('Run 1');
    const outcome = await inserter.insertPrepared(prepared, entry.name);
    expect(outcome).toMatchObject({ kind: 'blocks', message: 'Counter inserted.' });
    expect(runs).toBe(1);
    expect(e.state.doc.textContent).toContain('Run 1');
    expect(inserter.busy).toBe(false);
    inserter.dispose();
  });

  it('prepares native snippets without running them, and rejects on generator errors', async () => {
    const e = mount(docOf(page([p('x')])));
    const inserter = createSnippetInserter(e, { theme: () => '5ePHB', probe });
    await expect(inserter.prepare({ name: 'Skip', gen: '{{skipCounting}}' })).resolves.toEqual({ kind: 'native', action: { kind: 'marker', marker: 'skipCounting' } });
    expect(e.state.doc.child(0).attrs.markers).toEqual([]);
    const broken = inserter.prepare({
      name: 'Broken',
      gen: () => {
        throw new Error('boom');
      },
    });
    await expect(broken).rejects.toThrow('The snippet "Broken" failed: boom');
    await expect(inserter.insertPrepared(broken, 'Broken')).rejects.toThrow('boom');
    expect(inserter.busy).toBe(false);
  });
});

describe('markdownPreview', () => {
  it('a block snippet: one page, cropped to its content, with a note about its CSS', async () => {
    const e = mount(docOf(page([p('x')])));
    const snippet = await snippetToDoc('{{note\n##### Hi\nText\n}}\n\n<style>.note { color: red }</style>\n', { theme: '5ePHB', probe });
    const preview = markdownPreview(e.schema, snippet);
    expect(preview.fit).toBe('content');
    expect(preview.doc?.childCount).toBe(1);
    expect(preview.style).toContain('.note { color: red }');
    expect(preview.note).toBe("Also adds CSS to the brew's style.");
  });

  it('a page snippet: its pages without the blank ones at either end, whole', async () => {
    const e = mount(docOf(page([p('x')])));
    const snippet = await snippetToDoc('\\page\n# One\n\n\\page\n# Two\n\n\\page\n', { theme: '5ePHB', probe });
    const preview = markdownPreview(e.schema, snippet);
    expect(preview.fit).toBe('page');
    expect(preview.doc?.childCount).toBe(2);
    expect(preview.note).toBe('Inserts 2 pages after this section.');
  });

  it('a snippet of nothing shows nothing', async () => {
    const e = mount(docOf(page([p('x')])));
    const preview = markdownPreview(e.schema, await snippetToDoc('\n', { theme: '5ePHB', probe }));
    expect(preview.doc).toBeNull();
    expect(renderPreviewPages(preview)).toBeNull();
  });
});

describe('nativePreview', () => {
  it('Footer from H1: the current page with the footer from the brew’s heading; nothing is dispatched', () => {
    const e = mount(docOf(page([heading(1, 'The Wandering Inn'), p('Text')]), page([p('Other')])));
    cursorAt(e, 'Text');
    const before = e.state.doc;
    const preview = nativePreview(e.state, { kind: 'footer', level: 1 });
    expect(e.state.doc).toBe(before);
    expect(preview.doc?.childCount).toBe(1);
    expect(preview.doc?.child(0).attrs.footer).toBe('The Wandering Inn');
    expect(renderPreviewPages(preview)!.querySelector('.page > .footnote')?.textContent).toBe('The Wandering Inn');
  });

  it('a page break shows the page split at the cursor', () => {
    const e = mount(docOf(page([p('Before'), p('After')])));
    cursorAt(e, 'After');
    const preview = nativePreview(e.state, { kind: 'pageBreak' });
    expect(preview.doc?.childCount).toBe(2);
    expect(preview.doc?.child(1).textContent).toBe('After');
  });

  it('the table of contents lists the brew’s headings on a page of its own', () => {
    const e = mount(docOf(page([heading(1, 'Chapter One'), p('a')]), page([heading(2, 'Section Two')])));
    const pages = renderPreviewPages(nativePreview(e.state, { kind: 'toc' }))!;
    expect(pages.querySelectorAll(':scope > .page')).toHaveLength(1);
    const toc = pages.querySelector('.page > .columnWrapper > div.block.toc');
    expect(toc?.textContent).toContain('Chapter One');
    expect(toc?.textContent).toContain('Section Two');
  });

  it('nothing to change: no pages, a note', () => {
    const e = mount(docOf(page([p('x')], { markers: ['skipCounting'] })));
    const preview = nativePreview(e.state, { kind: 'marker', marker: 'skipCounting' });
    expect(preview.doc).toBeNull();
    expect(preview.note).toBe('Nothing to change here.');
  });
});

describe('renderPreviewPages', () => {
  it('is the read-only editor DOM without ids and without the editor root class', () => {
    const e = mount(docOf(page([node('heading', { level: 1, id: 'hello' }, [{ type: 'text', text: 'Hello' }]), p('Text')])));
    const pages = renderPreviewPages({ doc: e.state.doc, fit: 'page', style: '', note: null })!;
    expect(pages.className).toBe('pages');
    expect(pages.getAttribute('contenteditable')).toBe('false');
    expect(pages.querySelector(':scope > div.page > div.columnWrapper > h1')?.textContent).toBe('Hello');
    expect(pages.querySelectorAll('[id]')).toHaveLength(0);
  });
});
