// S1 go/no-go (d): paste from Word and Google Docs yields clean nodes, from the clipboard HTML
// those applications write (fixtures/*.html). ProseMirror's own paste path runs
// (transformPastedHTML → the canvas's ExternalPaste cleanup → the schema's parse rules):
// Chromium gets a real `paste` ClipboardEvent on the editor; Firefox keeps the data of a
// synthetic ClipboardEvent from page scripts, so there the same path is entered through
// EditorView.pasteHTML.
import { readFileSync } from 'node:fs';
import type { JSONContent } from '@tiptap/core';
import { expect, test, type Page } from '@playwright/test';
import { openCanvas, setCaret, settle } from './helpers';


const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

async function paste(page: Page, html: string, text: string): Promise<JSONContent> {
  await setCaret(page, 2);
  const handled = await page.evaluate(
    ([h, t]) => {
      const view = window.__editor!.view;
      const data = new DataTransfer();
      data.setData('text/html', h);
      data.setData('text/plain', t);
      const event = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true });
      if (event.clipboardData?.getData('text/html') !== h) return view.pasteHTML(h); // Firefox
      view.dom.dispatchEvent(event);
      return event.defaultPrevented;
    },
    [html, text] as const,
  );
  expect(handled, 'ProseMirror handled the paste').toBe(true);
  await settle(page);
  return page.evaluate(() => window.__editor!.getJSON());
}

interface Flat {
  type: string;
  attrs?: Record<string, unknown>;
  marks: string[];
  text?: string;
  depth: number;
}

function flatten(nodes: JSONContent[] | undefined, depth = 0, out: Flat[] = []): Flat[] {
  for (const n of nodes ?? []) {
    out.push({ type: n.type ?? '', attrs: n.attrs, marks: (n.marks ?? []).map((m) => m.type), text: n.text, depth });
    flatten(n.content, depth + 1, out);
  }
  return out;
}

const PLAIN = 'The Wandering Inn\nTravelers speak of an inn…';

for (const [name, file] of [
  ['Word', 'word-paste.html'],
  ['Google Docs', 'gdocs-paste.html'],
] as const) {
  test(`S1 (d) paste from ${name} yields clean nodes`, { tag: name === 'Word' ? '@smoke' : [] }, async ({ page }) => {
    await openCanvas(page, { doc: 'blank' });
    const doc = await paste(page, fixture(file), PLAIN);
    const json = JSON.stringify(doc);
    // No office/Docs debris anywhere in the document.
    expect(json).not.toMatch(/mso-|Mso|WordSection|docs-internal-guid|font-family|aria-level|"dir"|"role"|o:p/);

    const flat = flatten(doc.content);
    // Everything stays on the one page (pasting doesn't create pages or break the page shell).
    expect(doc.content?.map((n) => n.type)).toEqual(['page']);
    for (const f of flat) {
      if (!f.attrs) continue;
      if ('classes' in f.attrs) expect(f.attrs.classes, `${f.type} classes`).toEqual([]);
      if ('style' in f.attrs) expect(f.attrs.style, `${f.type} style`).toBeNull();
      if ('attributes' in f.attrs) expect(f.attrs.attributes, `${f.type} attributes`).toEqual({});
    }
    expect(
      flat.some((f) => f.type === 'rawHtml'),
      'nothing kept as raw HTML',
    ).toBe(false);

    const marks = (text: string) => flat.find((f) => f.text?.includes(text))?.marks ?? [];
    expect(flat.find((f) => f.type === 'heading')?.attrs?.level).toBe(1);
    expect(marks('never')).toContain('bold');
    expect(marks('smile')).toContain('italic');
    expect(marks('always')).toContain('underline');
    expect(marks('the Hearth')).toEqual(expect.arrayContaining(['bold', 'italic']));
    expect(marks('the Homebrewery')).toEqual(['link']);
    const lists = flat.filter((f) => f.type === 'bulletList' || f.type === 'orderedList');
    expect(lists.map((l) => l.type)).toEqual(['bulletList', 'bulletList', 'orderedList']);
    expect(lists[1]!.depth).toBeGreaterThan(lists[0]!.depth);
    expect(flat.filter((f) => f.type === 'listItem')).toHaveLength(5);
    expect(flat.filter((f) => f.type === 'tableCell' || f.type === 'tableHeader')).toHaveLength(4);

    // Rendered with the theme: the pasted content is inside the page's column wrapper.
    const rendered = await page.evaluate(() => ({
      inWrapper: document.querySelectorAll('.page > .columnWrapper > h1, .page > .columnWrapper > ul, .page > .columnWrapper > ol').length,
      styled: document.querySelectorAll('.page [style*="mso"], .page [class^="Mso"]').length,
    }));
    expect(rendered.inWrapper).toBe(3);
    expect(rendered.styled).toBe(0);
  });
}

test('S1 (d) the editor’s own clipboard HTML keeps its classes', async ({ page }) => {
  await openCanvas(page, { doc: 'blank' });
  // What copying a note block in this editor puts on the clipboard.
  const copied = await page.evaluate(() => {
    const editor = window.__editor!;
    const { doc } = editor.state;
    const Slice = doc.slice(0, 0).constructor as new (content: unknown, openStart: number, openEnd: number) => never;
    const Fragment = doc.content.constructor as unknown as { from: (node: unknown) => unknown };
    const note = editor.schema.nodeFromJSON({
      type: 'themeBlock',
      attrs: { classes: ['note'] },
      content: [
        { type: 'heading', attrs: { level: 5 }, content: [{ type: 'text', text: 'Kept' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'A note' }] },
      ],
    });
    return editor.view.serializeForClipboard(new Slice(Fragment.from(note), 0, 0)).dom.innerHTML;
  });
  const doc = await paste(page, copied, 'Kept');
  const flat = flatten(doc.content);
  expect(flat.find((f) => f.type === 'themeBlock')?.attrs?.classes).toEqual(['note']);
});

// RV-5: data-pm-slice alone (any ProseMirror-based app, or text that mentions it) is external HTML.
test('S1 (d) another ProseMirror app’s clipboard HTML is cleaned', async ({ page }) => {
  await openCanvas(page, { doc: 'blank' });
  const doc = await paste(
    page,
    '<div data-pm-slice="1 1 []" data-panel-type="info" class="ak-editor-panel"><p class="x" style="position: fixed">Panel text</p></div>',
    'Panel text',
  );
  const flat = flatten(doc.content);
  expect(flat.some((f) => f.type === 'rawHtml')).toBe(false);
  expect(flat.some((f) => f.text === 'Panel text')).toBe(true);
  expect(JSON.stringify(doc)).not.toMatch(/ak-editor-panel|position: fixed|data-panel-type/);
});
