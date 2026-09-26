import { Editor, type JSONContent } from '@tiptap/core';
import { Fragment, Slice, type ResolvedPos } from '@tiptap/pm/model';
import * as pmView from '@tiptap/pm/view';
import type { EditorView } from '@tiptap/pm/view';
import { afterEach, describe, expect, it } from 'vitest';
import gdocsHtml from '../../../e2e/canvas/fixtures/gdocs-paste.html?raw';
import wordHtml from '../../../e2e/canvas/fixtures/word-paste.html?raw';
import { buildEditorExtensions } from '../editorExtensions';
import { docWith, p } from '../schema/testing';
import { cleanExternalHtml, ExternalPaste, isEditorClipboardHtml, transformPastedHtml } from './pasteCleanup';

// ProseMirror's clipboard parser (the paste path, including transformPastedHTML). Exported for
// tests only, untyped.
const parseFromClipboard = (
  pmView as unknown as {
    __parseFromClipboard: (view: EditorView, text: string, html: string | null, plainText: boolean, $context: ResolvedPos) => Slice | null;
  }
).__parseFromClipboard;

let editor: Editor | null = null;
afterEach(() => {
  editor?.destroy();
  editor = null;
});

function pasteSlice(html: string): JSONContent[] {
  const element = document.createElement('div');
  document.body.append(element);
  editor = new Editor({ element, extensions: buildEditorExtensions({ extensions: [ExternalPaste] }), content: docWith(p('x')) });
  const slice = parseFromClipboard(editor.view, '', html, false, editor.state.doc.resolve(3));
  if (!slice) throw new Error('no slice');
  return slice.content.toJSON() as JSONContent[];
}

type Flat = { type: string; attrs?: Record<string, unknown>; marks?: string[]; text?: string; depth: number };
function flatten(nodes: JSONContent[], depth = 0, out: Flat[] = []): Flat[] {
  for (const n of nodes) {
    out.push({ type: n.type!, attrs: n.attrs, marks: n.marks?.map((m) => m.type), text: n.text, depth });
    if (n.content) flatten(n.content, depth + 1, out);
  }
  return out;
}

const marksOf = (flat: Flat[], text: string) => flat.find((f) => f.text?.includes(text))?.marks ?? [];

/** Every generic attribute is empty: no classes, style, id or attributes came through. */
function expectClean(nodes: JSONContent[]): void {
  const json = JSON.stringify(nodes);
  expect(json).not.toMatch(/mso-|Mso|docs-internal-guid|WordSection|font-family|aria-level|"dir"/);
  for (const f of flatten(nodes)) {
    if (!f.attrs) continue;
    if ('classes' in f.attrs) expect(f.attrs.classes, f.type).toEqual([]);
    if ('style' in f.attrs) expect(f.attrs.style, f.type).toBeNull();
    if ('id' in f.attrs && f.type !== 'heading') expect(f.attrs.id, f.type).toBeNull();
    if ('attributes' in f.attrs) expect(f.attrs.attributes, f.type).toEqual({});
  }
  expect(flatten(nodes).some((f) => f.type === 'rawHtml')).toBe(false);
}

/** What copying `nodes` in this editor puts on the clipboard (ProseMirror's serializeForClipboard). */
function copiedHtml(nodes: JSONContent[], openStart = 0, openEnd = 0): string {
  const element = document.createElement('div');
  document.body.append(element);
  const source = new Editor({ element, extensions: buildEditorExtensions({ extensions: [ExternalPaste] }), content: docWith(p('x')) });
  try {
    const fragment = Fragment.fromArray(nodes.map((n) => source.schema.nodeFromJSON(n)));
    return source.view.serializeForClipboard(new Slice(fragment, openStart, openEnd)).dom.innerHTML;
  } finally {
    source.destroy();
  }
}

const note = { type: 'themeBlock', attrs: { classes: ['note'] }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Kept' }] }] };

describe('isEditorClipboardHtml', () => {
  it('recognises this editor’s clipboard HTML', () => {
    const html = copiedHtml([note]);
    expect(html).toMatch(/data-pm-slice=/);
    expect(isEditorClipboardHtml(html)).toBe(true);
    expect(transformPastedHtml(html)).toBe(html);
    expect(isEditorClipboardHtml(wordHtml)).toBe(false);
  });

  it('recognises copied table cells (ProseMirror wraps them in table › tbody first)', () => {
    const row = { type: 'tableRow', content: [{ type: 'tableCell', attrs: { classes: ['x'] }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'c' }] }] }] };
    const html = copiedHtml([row]);
    expect(html).toMatch(/^<table data-pm-slice="0 0 -2 \[\]">/);
    expect(isEditorClipboardHtml(html)).toBe(true);
  });

  // RV-5: a regex over the HTML text treated any ProseMirror-based app's clipboard (Confluence,
  // GitLab, Outline …), and any text that mentions data-pm-slice=, as this editor's.
  it.each([
    ['ProseMirror HTML from another app', '<div data-pm-slice="1 1 []" data-panel-type="info" class="ak-editor-panel"><p>Panel text</p></div>'],
    ['text that mentions the attribute', '<p class="MsoNormal" style="color:red;position:fixed">Set data-pm-slice="1 1 []" in the clipboard</p>'],
    ['a marker that is not on the slice element', '<div data-pm-slice="0 0 []"><p data-hb-clipboard="1" class="note">x</p></div>'],
  ])('is false for %s', (_name, html) => {
    expect(isEditorClipboardHtml(html)).toBe(false);
  });
});

describe('cleanExternalHtml', () => {
  it('reduces Word HTML to semantic HTML', () => {
    const html = cleanExternalHtml(wordHtml);
    expect(html).not.toMatch(/class=|style=|lang=|mso|<o:p|<!--|<meta|<link|<style|<span|<font/i);
    expect(html).toContain('<h1>The\nWandering Inn</h1>');
    expect(html).toContain('<b>never\nin the same place</b>');
    expect(html).toContain('<p align="center">A centered warning.</p>');
    expect(html).toMatch(
      /<ul><li><p>Cedar smoke in the common room<\/p><ul><li><p>Stronger <b>after midnight<\/b><\/p><\/li><\/ul><\/li><li><p>Rain that never falls outside<\/p><\/li><\/ul>/,
    );
    expect(html).toMatch(/<ol><li><p>Pay in silver<\/p><\/li><li><p>Sleep <i>soundly<\/i><\/p><\/li><\/ol>/);
    expect(html).toContain('<a href="https://homebrewery.naturalcrit.com/">the Homebrewery</a>');
    expect(html).toMatch(/<table>\s*<tbody><tr>\s*<td>/);
  });

  it('reduces Google Docs HTML to semantic HTML', () => {
    const html = cleanExternalHtml(gdocsHtml);
    expect(html).not.toMatch(/class=|style=|dir=|role=|aria-|id=|docs-internal-guid|<span|<b style/i);
    expect(html).toContain('<h1>The Wandering Inn</h1>');
    expect(html).toContain('<strong>never in the same place</strong>');
    expect(html).toContain('<em>smile</em>');
    expect(html).toContain('<u>always</u>');
    expect(html).toContain('<em><strong>the Hearth</strong></em>');
    expect(html).toContain('<p align="center">A centered warning.</p>');
    // nested list moved into the previous item
    expect(html).toMatch(
      /<li><p>Cedar smoke in the common room<\/p><ul><li><p>Stronger <strong>after midnight<\/strong><\/p><\/li><\/ul><\/li>/,
    );
    expect(html).toContain('<a href="https://homebrewery.naturalcrit.com/">the Homebrewery</a>'); // no <u> in links
    expect(html).toMatch(/^<h1>/);
  });
});

describe('paste through the editor (transformPastedHTML + schema parse rules)', () => {
  for (const [name, html] of [
    ['Word', wordHtml],
    ['Google Docs', gdocsHtml],
  ] as const) {
    it(`${name}: clean nodes with bold, italic, underline, lists, table and link`, () => {
      const nodes = pasteSlice(html);
      expectClean(nodes);
      const flat = flatten(nodes);
      const types = flat.map((f) => f.type);
      expect(types).toContain('heading');
      expect(flat.find((f) => f.type === 'heading')?.attrs?.level).toBe(1);
      expect(marksOf(flat, 'never')).toContain('bold');
      expect(marksOf(flat, 'smile')).toContain('italic');
      expect(marksOf(flat, 'always')).toContain('underline');
      expect(marksOf(flat, 'the Hearth')).toEqual(expect.arrayContaining(['bold', 'italic']));
      expect(marksOf(flat, 'after midnight')).toContain('bold');
      expect(marksOf(flat, 'the Homebrewery')).toEqual(['link']);
      expect(flat.find((f) => f.type === 'paragraph' && f.attrs?.align === 'center')).toBeDefined();

      // Lists: a bullet list with a nested bullet list, and an ordered list.
      const lists = flat.filter((f) => f.type === 'bulletList' || f.type === 'orderedList');
      expect(lists.map((l) => l.type)).toEqual(['bulletList', 'bulletList', 'orderedList']);
      expect(lists[1]!.depth).toBeGreaterThan(lists[0]!.depth);
      expect(flat.filter((f) => f.type === 'listItem')).toHaveLength(5);

      // Table with 2 × 2 cells.
      expect(types).toContain('table');
      expect(flat.filter((f) => f.type === 'tableCell' || f.type === 'tableHeader')).toHaveLength(4);
      expect(marksOf(flat, 'd6')).toContain('bold');
    });
  }

  it('keeps the editor’s own clipboard HTML as it is (classes of theme blocks survive)', () => {
    const nodes = pasteSlice(copiedHtml([note]));
    expect(nodes[0]).toMatchObject({ type: 'themeBlock', attrs: { classes: ['note'], attributes: {} } });
    expect(JSON.stringify(nodes)).not.toMatch(/data-hb-clipboard|data-pm-slice/);
  });

  // RV-6: an inline SVG icon lost every attribute (<svg><path></path></svg>, a 300×150 box)
  // and split its paragraph in three.
  it('drops inline SVG, MathML and media from web pages instead of leaving empty boxes', () => {
    const html =
      '<p>Click the <svg viewBox="0 0 16 16" width="16" height="16"><path d="M0 0h16v16H0z"></path></svg> button <math><mi>x</mi></math><video src="v.mp4"></video><audio src="a.mp3"></audio><canvas></canvas> to continue</p>';
    expect(cleanExternalHtml(html)).toBe('<p>Click the  button  to continue</p>');
    const nodes = pasteSlice(html);
    expectClean(nodes);
    expect(flatten(nodes).map((f) => f.type)).toEqual(['paragraph', 'text']);
  });

  it('cleans foreign ProseMirror HTML and HTML that merely mentions data-pm-slice (RV-5)', () => {
    const foreign = pasteSlice('<div data-pm-slice="1 1 []" data-panel-type="info" class="ak-editor-panel"><p>Panel text</p></div>');
    expectClean(foreign);
    expect(flatten(foreign).find((f) => f.text === 'Panel text')).toBeDefined();
    const mention = pasteSlice(
      '<p class="MsoNormal" style="color:red;position:fixed">Set data-pm-slice="1 1 []" in the clipboard</p><div class="WordSection1" id="w"><h2>Heading</h2><p>Body text</p></div>',
    );
    expectClean(mention);
    expect(flatten(mention).map((f) => f.type)).toContain('heading');
  });

  // SEC-2: the client read the scheme from the first 256 characters only, so 256+ ignored
  // characters in front of javascript: made a pasted link look relative. The server refuses it,
  // and the refused save stopped autosave for the whole brew.
  it('drops links whose scheme hides behind 256 or more ignored characters', () => {
    for (const prefix of [' '.repeat(300), '\u0001'.repeat(256), '\t\n'.repeat(200)]) {
      const nodes = pasteSlice(`<p><a href="${prefix}javascript:alert(1)">x</a> <a href="${'a'.repeat(300)}:x">y</a></p>`);
      expect(flatten(nodes).filter((f) => f.marks?.includes('link'))).toEqual([]);
      expect(flatten(nodes).map((f) => f.text ?? '').join('')).toBe('x y');
    }
  });
});
