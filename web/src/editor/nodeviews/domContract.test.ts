// The editor's DOM (NodeViews) must be the DOM renderHTML emits (plan §3.2 CSS contract), apart
// from editor-only attributes. Checked on the /dev/canvas documents (every S1 construct).
import { Editor, type JSONContent } from '@tiptap/core';
import { afterEach, describe, expect, it } from 'vitest';
import { chromeDoc, s1Doc } from '../../dev/canvas/devDocs';
import { buildEditorExtensions } from '../editorExtensions';
import { docWith, node, p } from '../schema/testing';
import { editorNodeViews } from './index';
import { CHROME_ATTR, OBJECT_ID_ATTR } from './PageView';

let editor: Editor | null = null;
afterEach(() => {
  editor?.destroy();
  editor = null;
});

const EDITOR_ONLY_ATTRS = ['contenteditable', CHROME_ATTR, OBJECT_ID_ATTR, 'draggable', 'translate'];

/** Removes what only the editor adds: page ids, editor attributes, ProseMirror hacks. */
function normalizeEditorDom(root: Element): string {
  const clone = root.cloneNode(true) as Element;
  for (const el of Array.from(clone.querySelectorAll('.ProseMirror-trailingBreak, img.ProseMirror-separator'))) el.remove();
  for (const el of Array.from(clone.querySelectorAll('*'))) {
    for (const name of EDITOR_ONLY_ATTRS) el.removeAttribute(name);
    if (el.classList.contains('page')) el.removeAttribute('id');
    for (const c of Array.from(el.classList)) if (c.startsWith('ProseMirror')) el.classList.remove(c);
    // Objects lane (P5.6): leading header rows get this editor-only decoration class.
    el.classList.remove('hb-header-row');
    if (el.getAttribute('class') === '') el.removeAttribute('class');
  }
  return canonical(clone.innerHTML);
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

function mount(content: JSONContent): Editor {
  const element = document.createElement('div');
  document.body.append(element);
  editor = new Editor({ element, extensions: buildEditorExtensions({ extensions: editorNodeViews }), content });
  return editor;
}

describe('editor DOM = renderHTML (CSS contract)', () => {
  for (const [name, doc] of [
    ['s1 (drop cap, note, stat block, table, wide, column break)', s1Doc],
    ['chrome (cover, objects, counters)', chromeDoc],
  ] as const) {
    it(name, () => {
      const e = mount(doc);
      expect(normalizeEditorDom(e.view.dom)).toBe(canonical(e.getHTML()));
    });
  }

  it('tables have no wrapper div or inline widths, and keep colgroup in sync', () => {
    const table = node('table', undefined, [
      node('tableRow', undefined, [node('tableHeader', undefined, [p('a')]), node('tableHeader', undefined, [p('b')])]),
      node('tableRow', undefined, [node('tableCell', undefined, [p('1')]), node('tableCell', undefined, [p('2')])]),
    ]);
    const e = mount(docWith(p('before'), { type: 'horizontalRule' }, table));
    const tableEl = e.view.dom.querySelector('table')!;
    expect(tableEl.parentElement?.classList.contains('columnWrapper')).toBe(true);
    expect(tableEl.previousElementSibling?.localName).toBe('hr'); // `hr + table` matches
    expect(tableEl.getAttribute('style')).toBeNull();
    expect(tableEl.querySelector('colgroup')).toBeNull();
    expect(e.view.dom.querySelector('.tableWrapper')).toBeNull();

    // A pixel column width adds the colgroup, removing it takes it away; rows stay in place.
    const tbody = tableEl.querySelector('tbody');
    let cellPos = -1;
    e.state.doc.descendants((n, pos) => {
      if (cellPos < 0 && n.type.name === 'tableHeader') cellPos = pos;
    });
    e.view.dispatch(e.state.tr.setNodeAttribute(cellPos, 'colwidth', [120]));
    expect(e.view.dom.querySelector('table')).toBe(tableEl);
    expect(tableEl.querySelector('tbody')).toBe(tbody);
    expect(tableEl.querySelector(':scope > colgroup > col')?.getAttribute('style')).toMatch(/^width: 120px;?$/);
    expect(normalizeEditorDom(e.view.dom)).toBe(canonical(e.getHTML()));
    // (prosemirror-tables copies a column's width to every cell of the column: clear them all.)
    const clear = e.state.tr;
    e.state.doc.descendants((n, pos) => {
      if (n.attrs.colwidth) clear.setNodeAttribute(pos, 'colwidth', null);
    });
    e.view.dispatch(clear);
    expect(tableEl.querySelector('colgroup')).toBeNull();

    // Generic attributes on the table are patched in place.
    let tablePos = -1;
    e.state.doc.descendants((n, pos) => {
      if (tablePos < 0 && n.type.name === 'table') tablePos = pos;
    });
    e.view.dispatch(e.state.tr.setNodeAttribute(tablePos, 'classes', ['wide']));
    expect(e.view.dom.querySelector('table')).toBe(tableEl);
    expect(tableEl.className).toBe('wide');
    expect(normalizeEditorDom(e.view.dom)).toBe(canonical(e.getHTML()));
  });
});
