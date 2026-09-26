// The export's DOM is the DOM of a read-only editor (plan §3.2 CSS contract): theme CSS,
// canvas.css and the brew's CSS must lay out the file as they lay out the editor. Compared on the
// dev documents (every construct the S1 and objects lanes render), with the editor's own
// differences normalized: header rows (a decoration in the editor, a real <thead> in the file)
// and the attributes only the editor needs.
import { Editor, type JSONContent } from '@tiptap/core';
import { afterEach, describe, expect, it } from 'vitest';
import { chromeDoc, continuedDoc, s1Doc, tallDoc } from '../../dev/canvas/devDocs';
import { exportDevDocs } from '../../dev/export/devDocs';
import { objectsDevDocs } from '../../dev/objects/devDocs';
import { buildEditorExtensions } from '../editorExtensions';
import { editorNodeViews } from '../nodeviews';
import { CHROME_ATTR, OBJECT_ID_ATTR } from '../nodeviews/PageView';
import { docOf, node, p, page, text } from '../schema/testing';
import { HEADER_ROW_CLASS } from '../tables/headerRows';
import { fillTocs, SEPARATOR_CLASS, serializeBrew, stripActiveContent, TRAILING_BREAK_CLASS } from './serialize';

let editor: Editor | null = null;
afterEach(() => {
  editor?.destroy();
  editor = null;
  document.body.innerHTML = '';
});

function mount(content: JSONContent): Editor {
  const element = document.createElement('div');
  document.body.append(element);
  editor = new Editor({ element, extensions: buildEditorExtensions({ extensions: editorNodeViews }), content, editable: false });
  return editor;
}

/** Attributes the editor writes for itself (the export leaves them out on purpose). */
const EDITOR_ONLY_ATTRS = [CHROME_ATTR, OBJECT_ID_ATTR, 'draggable', 'loading', 'data-objects'];

/**
 * jsdom doesn't reflect the contentEditable property ProseMirror sets on leaf nodes as an
 * attribute, so the comparison leaves contenteditable out (a test below checks the export's, and
 * e2e/export compares the DOM in real browsers).
 */
function withoutContentEditable(root: Element): Element {
  const clone = root.cloneNode(true) as Element;
  for (const el of Array.from(clone.querySelectorAll('[contenteditable]'))) el.removeAttribute('contenteditable');
  return clone;
}

/** The editor's pages with header rows moved into <thead>, as the export writes them. */
function normalizeEditorDom(root: Element): Element {
  const clone = withoutContentEditable(root);
  for (const el of Array.from(clone.querySelectorAll('*'))) {
    for (const name of EDITOR_ONLY_ATTRS) el.removeAttribute(name);
    el.classList.remove('ProseMirror-selectednode');
    if (el.getAttribute('class') === '') el.removeAttribute('class');
  }
  for (const table of Array.from(clone.querySelectorAll('table'))) {
    const tbody = table.querySelector(':scope > tbody');
    const rows = Array.from(tbody?.children ?? []).filter((r) => r.classList.contains(HEADER_ROW_CLASS));
    if (!tbody || rows.length === 0) continue;
    const thead = document.createElement('thead');
    for (const row of rows) {
      row.classList.remove(HEADER_ROW_CLASS);
      if (row.getAttribute('class') === '') row.removeAttribute('class');
      thead.append(row);
    }
    table.insertBefore(thead, tbody);
  }
  return clone;
}

/** HTML with every element's attributes in name order (attribute order has no meaning). */
function canonical(html: string): string {
  const root = document.createElement('div');
  root.innerHTML = html;
  for (const el of Array.from(root.querySelectorAll('*'))) {
    const attrs = Array.from(el.attributes)
      .map((a) => [a.name, a.value] as const)
      .sort(([a], [b]) => a.localeCompare(b));
    for (const [name] of attrs) el.removeAttribute(name);
    for (const [name, value] of attrs) el.setAttribute(name, value);
  }
  return root.innerHTML;
}

/** Whether this ProseMirror build adds separator images here (Chromium and Safari user agents). */
function editorAddsSeparators(): boolean {
  const e = mount(docOf(page([node('paragraph', undefined, [text('x'), node('icon', { font: 'fas', glyph: 'fa-dice' })])])));
  const found = e.view.dom.querySelector(`img.${SEPARATOR_CLASS}`) !== null;
  e.destroy();
  editor = null;
  return found;
}

/** A document with the inline and raw constructs the dev documents don't have. */
const inlineDoc = docOf(
  page([
    node('paragraph', undefined, [text('Ends with an icon '), node('icon', { font: 'fas', glyph: 'fa-dice-d20' })]),
    node('paragraph', undefined, [text('Link around an icon: '), { type: 'icon', attrs: { font: 'fas', glyph: 'fa-link' }, marks: [{ type: 'link', attrs: { href: '#p1' } }] }]),
    node('paragraph', undefined, [text('Ends with a break'), { type: 'hardBreak' }]),
    node('paragraph', undefined, [text('Trailing newline in code: '), { type: 'text', text: 'a', marks: [{ type: 'code' }] }]),
    p(''),
    node('heading', { level: 2 }, [text('Raw')]),
    node('rawHtml', { html: '<section class="custom"><p>Raw <b>section</b></p></section>' }),
    node('paragraph', undefined, [text('Inline raw '), node('rawInline', { html: '<svg width="10" height="10"><circle r="4"></circle></svg>' })]),
    node('codeBlock', { language: 'css' }, [text('.page { color: red }\n')]),
    node('blockquote', undefined, [p('Quoted.')]),
    node('bulletList', undefined, [node('listItem', undefined, [p('One')]), node('listItem', undefined, [p('Two')])]),
    node('orderedList', { start: 3 }, [node('listItem', undefined, [p('Three')])]),
    node('toc', { depth: 2, wide: true, title: 'In this brew' }),
  ]),
);

const DOCS: [string, JSONContent][] = [
  ['s1', s1Doc],
  ['chrome (cover, objects, counters)', chromeDoc],
  ['tall and continued list items', tallDoc],
  ['continued items', continuedDoc],
  ['export dev doc (TOC, header rows, objects, images, stat block)', exportDevDocs.inn!.content],
  ...Object.entries(objectsDevDocs).map(([name, doc]) => [`objects: ${name}`, doc] as [string, JSONContent]),
  ['inline and raw constructs', inlineDoc],
];

describe('serializeBrew = the read-only editor DOM', () => {
  for (const [name, content] of DOCS) {
    it(name, () => {
      const separators = editorAddsSeparators();
      const e = mount(content);
      const serialized = serializeBrew(e.state.doc, { separators });
      fillTocs(serialized, e.state.doc);
      expect(canonical(withoutContentEditable(serialized.pages).innerHTML)).toBe(canonical(normalizeEditorDom(e.view.dom).innerHTML));
    });
  }

  it('writes the root as a read-only ProseMirror root', () => {
    const e = mount(s1Doc);
    const { pages } = serializeBrew(e.state.doc);
    expect(pages.className).toBe('pages ProseMirror');
    expect(pages.getAttribute('contenteditable')).toBe('false');
    expect(Array.from(pages.children).map((c) => c.id)).toEqual(Array.from(e.view.dom.children).map((c) => c.id));
  });
});

describe('serializeBrew details', () => {
  it('numbers the pages p1…pN, replacing author ids', () => {
    const doc = mount(docOf(page([p('a')], { id: 'mine' }), page([p('b')]))).state.doc;
    const { pages } = serializeBrew(doc);
    expect(Array.from(pages.children).map((c) => c.id)).toEqual(['p1', 'p2']);
  });

  it('moves leading header rows into <thead>, unless a header cell spans into the body', () => {
    const cell = (type: string, value: string, attrs?: Record<string, unknown>) => node(type, attrs, [p(value)]);
    const table = (rows: JSONContent[]) => node('table', undefined, rows);
    const row = (...cells: JSONContent[]) => node('tableRow', undefined, cells);
    const plain = table([row(cell('tableHeader', 'h1'), cell('tableHeader', 'h2')), row(cell('tableHeader', 'h3'), cell('tableHeader', 'h4')), row(cell('tableCell', 'a'), cell('tableCell', 'b'))]);
    const spanning = table([row(cell('tableHeader', 'h', { rowspan: 2 }), cell('tableHeader', 'x')), row(cell('tableCell', 'b'))]);
    const none = table([row(cell('tableCell', 'a'), cell('tableHeader', 'b'))]);
    const doc = mount(docOf(page([plain, spanning, none]))).state.doc;
    const tables = Array.from(serializeBrew(doc).pages.querySelectorAll('table'));
    expect(tables[0]!.querySelectorAll('thead > tr')).toHaveLength(2);
    expect(tables[0]!.querySelectorAll('tbody > tr')).toHaveLength(1);
    expect(tables[0]!.firstElementChild?.localName).toBe('thead');
    expect(tables[1]!.querySelector('thead')).toBeNull();
    expect(tables[2]!.querySelector('thead')).toBeNull();
  });

  it('adds the trailing break and the separator where ProseMirror does', () => {
    const doc = mount(inlineDoc).state.doc;
    const withSep = serializeBrew(doc);
    const paragraphs = Array.from(withSep.pages.querySelectorAll('.columnWrapper > p'));
    // "…icon": separator after the icon, then the break.
    expect(Array.from(paragraphs[0]!.childNodes).slice(-3).map((n) => (n as Element).localName ?? '#text')).toEqual(['i', 'img', 'br']);
    expect(paragraphs[0]!.querySelector(`img.${SEPARATOR_CLASS}`)?.getAttribute('alt')).toBe('');
    // Ends with a linked icon: the separator goes inside the link, the break after it.
    expect(paragraphs[1]!.querySelector(`a > i + img.${SEPARATOR_CLASS}`)).not.toBeNull();
    expect(paragraphs[1]!.lastElementChild?.className).toBe(TRAILING_BREAK_CLASS);
    // Ends in text: nothing.
    expect(paragraphs[3]!.querySelector(`.${TRAILING_BREAK_CLASS}`)).toBeNull();
    // Ends with a hard break: a trailing break, no separator (a <br> is editable).
    expect(paragraphs[2]!.querySelectorAll('br')).toHaveLength(2);
    expect(paragraphs[2]!.querySelector(`img.${SEPARATOR_CLASS}`)).toBeNull();
    // Empty: a trailing break.
    expect(paragraphs[4]!.innerHTML).toBe(`<br class="${TRAILING_BREAK_CLASS}">`);
    // Without separators (Firefox's DOM).
    expect(serializeBrew(doc, { separators: false }).pages.querySelector(`img.${SEPARATOR_CLASS}`)).toBeNull();
  });

  it('fills TOCs, honouring the exclusions', () => {
    const doc = mount(exportDevDocs.inn!.content).state.doc;
    const serialized = serializeBrew(doc);
    expect(serialized.tocs).toHaveLength(1);
    expect(serialized.tocs[0]!.el.textContent).toBe('');
    fillTocs(serialized, doc);
    const all = serialized.tocs[0]!.el.textContent ?? '';
    expect(all).toContain('Chapter One: Arrival');
    expect(all).toContain('Innkeeper');
    fillTocs(serialized, doc, (heading) => heading.text === 'Innkeeper');
    expect(serialized.tocs[0]!.el.textContent).not.toContain('Innkeeper');
    expect(serialized.tocs[0]!.el.getAttribute('data-toc-entries')).toBe(String(serialized.tocs[0]!.el.querySelectorAll('li').length));
    expect(serialized.headings.map((h) => h.textContent)).toContain('Innkeeper');
  });

  it('marks every node without a content hole contenteditable=false, as ProseMirror does (not <br>)', () => {
    const doc = mount(docOf(page([...inlineDoc.content![0]!.content!, node('horizontalRule'), node('spacer'), node('columnBreak')]))).state.doc;
    const { pages } = serializeBrew(doc);
    for (const selector of ['i.fas', 'section.custom', 'svg', 'hr', 'div.blank', 'div.columnSplit', '.toc']) {
      expect(pages.querySelector(selector)?.getAttribute('contenteditable'), selector).toBe('false');
    }
    for (const el of Array.from(pages.querySelectorAll('p, h2, li, pre, blockquote, ul, ol, .columnWrapper, br, img.ProseMirror-separator'))) {
      expect(el.hasAttribute('contenteditable'), el.outerHTML.slice(0, 40)).toBe(false);
    }
  });

  it('never writes loading=lazy, editor state or the page objects copy', () => {
    const doc = mount(exportDevDocs.inn!.content).state.doc;
    const { pages } = serializeBrew(doc);
    expect(pages.querySelector('[loading]')).toBeNull();
    expect(pages.querySelector(`[${CHROME_ATTR}], [${OBJECT_ID_ATTR}], [data-objects], [draggable]`)).toBeNull();
    expect(pages.querySelector('.hb-oversized, .hb-oversized-badge')).toBeNull();
    // The chrome is still there: objects, footer, page number.
    expect(pages.querySelector('#p1 > img[src="/assets/naturalCritLogoRed.svg"]')).not.toBeNull();
    expect(pages.querySelector('#p1 > span.footnote')?.textContent).toBe('The Exported Inn');
    expect(pages.querySelector('#p1 > span.pageNumber.auto')).not.toBeNull();
  });
});

describe('stripActiveContent', () => {
  it('removes scripts, handlers, script URLs and document-changing elements', () => {
    const root = document.createElement('div');
    root.innerHTML = [
      '<script>alert(1)</script>',
      '<img src="x.png" onerror="alert(1)" alt="">',
      '<a href="javascript:alert(1)">x</a>',
      '<a href=" JaVaScRiPt:alert(1)">y</a>',
      '<a href="https://example.com/">ok</a>',
      '<img src="data:text/html,<b>" alt="">',
      '<img src="data:image/png;base64,AAAA" alt="kept">',
      '<svg><script>alert(1)</script><a xlink:href="javascript:alert(1)"></a></svg>',
      '<base href="https://evil.example/">',
      '<meta http-equiv="refresh" content="0;url=https://evil.example/">',
      '<link rel="stylesheet" href="https://evil.example/x.css">',
      '<iframe srcdoc="<script>alert(1)</script>"></iframe>',
      '<noscript><p>x</p></noscript>',
      '<template><script>alert(1)</script></template>',
    ].join('');
    const removed = stripActiveContent(root);
    expect(removed).toBeGreaterThanOrEqual(12);
    expect(root.querySelector('script, base, meta, link, noscript, template, iframe')).toBeNull();
    expect(root.innerHTML).not.toMatch(/javascript:|onerror|data:text/i);
    expect(root.querySelector('a[href="https://example.com/"]')).not.toBeNull();
    expect(root.querySelector('img[alt="kept"]')?.getAttribute('src')).toBe('data:image/png;base64,AAAA');
  });
});
