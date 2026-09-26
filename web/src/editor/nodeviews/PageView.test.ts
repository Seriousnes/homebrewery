import { Editor, type JSONContent } from '@tiptap/core';
import { NodeSelection } from '@tiptap/pm/state';
import { afterEach, describe, expect, it } from 'vitest';
import { buildEditorExtensions } from '../editorExtensions';
import { docOf, normalize, p, page, schema, toHtml } from '../schema/testing';
import { editorNodeViews, PageView } from './index';
import { CHROME_ATTR, OBJECT_ID_ATTR, OVERSIZED_BADGE_CLASS, OVERSIZED_CLASS } from './PageView';

const objects = [
  { id: 'o1', kind: 'image', classes: ['watercolor4'], style: 'position:absolute;top:0;left:0', src: '/assets/bird.webp' },
  { id: 'o2', kind: 'text', classes: ['banner'], style: 'position:absolute;bottom:4cm', text: 'HOMEBREW' },
];

const richDoc: JSONContent = docOf(
  page([p('Cover text')], {
    kind: 'manual',
    markers: ['frontCover'],
    objects,
    footer: 'A footer',
    pageNumber: true,
    columns: 1,
    classes: ['wide-page'],
    style: 'background: red;',
    attributes: { 'data-testid': 'cover' },
  }),
  page([p('Second page')], { kind: 'auto', pageNumber: true, footer: 'Part 1' }),
  page([p('Third page')], { kind: 'manual', columns: 2 }),
);

let editor: Editor | null = null;

function mount(content: JSONContent = richDoc): Editor {
  const element = document.createElement('div');
  document.body.append(element);
  editor = new Editor({
    element,
    extensions: buildEditorExtensions({ extensions: editorNodeViews }),
    content,
  });
  return editor;
}

afterEach(() => {
  editor?.destroy();
  editor = null;
  document.body.innerHTML = '';
});

const pagesOf = (e: Editor): HTMLElement[] => Array.from(e.view.dom.children) as HTMLElement[];

/** Attributes as a sorted list, without the editor-only ones. */
function attrsOf(el: Element, ignore: string[] = []): string[] {
  const skip = new Set(['contenteditable', CHROME_ATTR, OBJECT_ID_ATTR, 'draggable', 'translate', ...ignore]);
  return Array.from(el.attributes)
    .filter((a) => !skip.has(a.name))
    .map((a) => `${a.name}=${a.value}`)
    .sort();
}

/** Shape of a page element: tag, attributes and children (flow excluded). */
function shape(el: Element, ignore: string[] = []): unknown {
  return {
    tag: el.localName,
    attrs: attrsOf(el, ignore),
    children: Array.from(el.children).map((c) =>
      c.classList.contains('columnWrapper')
        ? { tag: 'div', attrs: attrsOf(c), flow: true }
        : { tag: c.localName, attrs: attrsOf(c), text: c.textContent },
    ),
  };
}

function setPageAttrs(e: Editor, index: number, attrs: Record<string, unknown>): void {
  let pos = 0;
  for (let i = 0; i < index; i++) pos += e.state.doc.child(i).nodeSize;
  const node = e.state.doc.child(index);
  e.view.dispatch(e.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, ...attrs }));
}

describe('PageView DOM', () => {
  it('matches Page.renderHTML for every page (ids come from PageIndexIds)', () => {
    const e = mount();
    const expected = document.createElement('div');
    expected.innerHTML = toHtml(normalize(e.getJSON()));
    const rendered = Array.from(expected.children);
    const pages = pagesOf(e);
    expect(pages).toHaveLength(3);
    pages.forEach((pageEl, i) => {
      // renderHTML has no index id; PageView has no generic id (the decoration owns it).
      expect(shape(pageEl, ['id'])).toEqual(shape(rendered[i]!, ['id']));
      expect(pageEl.id).toBe(`p${i + 1}`);
    });
  });

  it('renders chrome in contract order, non-editable, outside the column wrapper', () => {
    const e = mount();
    const cover = pagesOf(e)[0]!;
    const children = Array.from(cover.children);
    expect(children.map((c) => `${c.localName}.${Array.from(c.classList).join('.')}`)).toEqual([
      'span.inline-block.frontCover',
      'img.watercolor4',
      'span.inline-block.banner',
      'span.inline-block.footnote',
      'span.inline-block.pageNumber.auto',
      'div.columnWrapper',
    ]);
    for (const c of children.slice(0, -1)) expect(c.getAttribute('contenteditable')).toBe('false');
    expect(children[1]!.getAttribute(OBJECT_ID_ATTR)).toBe('o1');
    expect(children[1]!.getAttribute('draggable')).toBe('false');
    expect(children[2]!.getAttribute(OBJECT_ID_ATTR)).toBe('o2');
    expect(children[2]!.textContent).toBe('HOMEBREW');
    expect(cover.querySelector(':scope > .columnWrapper > p')?.textContent).toBe('Cover text');
    expect(cover.className).toBe('page hb-cols-1 wide-page');
    expect(cover.getAttribute('style')).toBe('background: red;');
    expect(cover.getAttribute('data-testid')).toBe('cover');
    expect(cover.getAttribute('data-kind')).toBe('manual');
  });

  it('maps object ids to the rendered (normalized) chrome, skipping bad markers and objects', () => {
    const e = mount(
      docOf(
        page([p('x')], {
          markers: ['frontCover', 'frontCover', 'not a class!'],
          objects: [{ id: 'broken', kind: 'image', classes: [], style: '' }, ...objects],
        }),
      ),
    );
    const chrome = Array.from(pagesOf(e)[0]!.children).filter((c) => !c.classList.contains('columnWrapper'));
    expect(chrome.map((c) => [c.className, c.getAttribute(OBJECT_ID_ATTR)])).toEqual([
      ['inline-block frontCover', null],
      ['watercolor4', 'o1'],
      ['inline-block banner', 'o2'],
    ]);
  });

  it('keeps only pages as children of the ProseMirror root, which has the pages class', () => {
    const e = mount();
    expect(e.view.dom.classList.contains('pages')).toBe(true);
    expect(Array.from(e.view.dom.children).every((c) => c.classList.contains('page'))).toBe(true);
  });
});

describe('PageView.update', () => {
  it('patches attributes in place: same page element, same column wrapper', () => {
    const e = mount();
    const before = pagesOf(e)[1]!;
    const wrapper = before.querySelector(':scope > .columnWrapper');
    const paragraph = wrapper?.firstElementChild;

    setPageAttrs(e, 1, { footer: 'Part 2', columns: 2, markers: ['skipCounting'] });
    const after = pagesOf(e)[1]!;
    expect(after).toBe(before);
    expect(after.querySelector(':scope > .columnWrapper')).toBe(wrapper);
    expect(wrapper?.firstElementChild).toBe(paragraph);
    expect(after.className).toBe('page hb-cols-2');
    expect(after.getAttribute('data-footer')).toBe('Part 2');
    expect(after.getAttribute('data-markers')).toBe('["skipCounting"]');
    expect(Array.from(after.children).map((c) => c.className)).toEqual([
      'inline-block skipCounting',
      'inline-block footnote',
      'inline-block pageNumber auto',
      'columnWrapper',
    ]);
    expect(after.querySelector('.footnote')?.textContent).toBe('Part 2');
    expect(after.id).toBe('p2');
  });

  // RV-9: a marker or object class `columnWrapper` rendered chrome that `:scope > .columnWrapper`
  // picked instead of the flow (the patch then copied an empty wrapper in as chrome).
  it('keeps exactly one column wrapper, the flow, when markers or objects carry reserved classes', () => {
    const e = mount();
    const before = pagesOf(e)[1]!;
    const wrapper = before.querySelector(':scope > div.columnWrapper');
    setPageAttrs(e, 1, {
      footer: 'Part 2',
      markers: ['columnWrapper', 'skipCounting', 'page'],
      objects: [{ id: 'o9', kind: 'text', classes: ['columnWrapper', 'banner'], style: 'position:absolute', text: 'banner' }],
    });
    const after = pagesOf(e)[1]!;
    expect(after.querySelectorAll(':scope > .columnWrapper')).toHaveLength(1);
    expect(after.querySelector(':scope > .columnWrapper')).toBe(wrapper);
    expect(wrapper?.textContent).toBe('Second page');
    expect(Array.from(after.children).map((c) => c.className)).toEqual([
      'inline-block skipCounting',
      'inline-block banner',
      'inline-block footnote',
      'inline-block pageNumber auto',
      'columnWrapper',
    ]);
  });

  it('moves, restyles and retexts objects in place: the same elements (an image is not loaded again, P8.1)', () => {
    const e = mount();
    const cover = pagesOf(e)[0]!;
    const image = cover.querySelector(`[${OBJECT_ID_ATTR}="o1"]`)!;
    const banner = cover.querySelector(`[${OBJECT_ID_ATTR}="o2"]`)!;
    setPageAttrs(e, 0, {
      objects: [
        { ...objects[0]!, style: 'position:absolute;top:60px;left:40px', classes: ['watercolor2'] },
        { ...objects[1]!, text: 'NEW TITLE' },
      ],
      oversized: true,
    });
    expect(cover.querySelector(`[${OBJECT_ID_ATTR}="o1"]`)).toBe(image);
    expect(cover.querySelector(`[${OBJECT_ID_ATTR}="o2"]`)).toBe(banner);
    expect(image.getAttribute('style')).toContain('top: 60px');
    expect(image.className).toBe('watercolor2');
    expect(banner.textContent).toBe('NEW TITLE');
    expect(image.getAttribute(CHROME_ATTR)).toBe('');
    expect(cover.lastElementChild!.className).toBe(OVERSIZED_BADGE_CLASS);
    // An object added: the chrome is rebuilt, in contract order.
    setPageAttrs(e, 0, { objects: [...objects, { id: 'o3', kind: 'text', classes: [], style: 'position:absolute', text: 'three' }], oversized: false });
    expect(Array.from(cover.children).map((c) => c.getAttribute(OBJECT_ID_ATTR) ?? c.className)).toEqual([
      'inline-block frontCover',
      'o1',
      'o2',
      'o3',
      'inline-block footnote',
      'inline-block pageNumber auto',
      'columnWrapper',
    ]);
  });

  it('removes attributes and chrome that are no longer rendered', () => {
    const e = mount();
    setPageAttrs(e, 0, {
      footer: null,
      pageNumber: false,
      markers: [],
      objects: [],
      columns: null,
      classes: [],
      style: null,
      attributes: {},
    });
    const cover = pagesOf(e)[0]!;
    expect(cover.className).toBe('page');
    expect(Array.from(cover.children).map((c) => c.className)).toEqual(['columnWrapper']);
    for (const name of ['data-footer', 'data-page-number', 'data-markers', 'data-objects', 'style', 'data-testid']) {
      expect(cover.hasAttribute(name), name).toBe(false);
    }
    expect(cover.id).toBe('p1');
    expect(shape(cover, ['id'])).toEqual(
      shape(
        (() => {
          const d = document.createElement('div');
          d.innerHTML = toHtml(normalize(docOf(e.getJSON().content[0]!)));
          return d.firstElementChild!;
        })(),
        ['id'],
      ),
    );
  });

  it('keeps classes it did not write (ProseMirror-selectednode) across a patch', () => {
    const e = mount();
    e.view.dispatch(e.state.tr.setSelection(NodeSelection.create(e.state.doc, 0)));
    const cover = pagesOf(e)[0]!;
    expect(cover.classList.contains('ProseMirror-selectednode')).toBe(true);
    // setNodeMarkup maps a NodeSelection of the node away, so patch the view directly, as an
    // attribute change that keeps the selection would.
    const docView = (e.view as unknown as { docView: { children: { spec: PageView }[] } }).docView;
    const node = e.state.doc.child(0);
    docView.children[0]!.spec.update(node.type.create({ ...node.attrs, classes: ['other'] }, node.content));
    expect(pagesOf(e)[0]).toBe(cover);
    expect(cover.classList.contains('ProseMirror-selectednode')).toBe(true);
    expect(cover.classList.contains('other')).toBe(true);
    expect(cover.classList.contains('wide-page')).toBe(false);
  });

  it('shows and hides the oversize badge', () => {
    const e = mount();
    setPageAttrs(e, 2, { oversized: true });
    const third = pagesOf(e)[2]!;
    expect(third.classList.contains(OVERSIZED_CLASS)).toBe(true);
    const badge = third.lastElementChild!;
    expect(badge.className).toBe(OVERSIZED_BADGE_CLASS);
    expect(badge.getAttribute('contenteditable')).toBe('false');
    // oversized is not saved meaningfully and not part of renderHTML
    expect(third.hasAttribute('data-oversized')).toBe(false);
    setPageAttrs(e, 2, { oversized: false });
    expect(pagesOf(e)[2]).toBe(third);
    expect(third.classList.contains(OVERSIZED_CLASS)).toBe(false);
    expect(third.querySelector(`.${OVERSIZED_BADGE_CLASS}`)).toBeNull();
  });

  it('keeps p{n} ids in step when pages are inserted before (only the ids change)', async () => {
    const e = mount();
    await new Promise<void>((resolve) => queueMicrotask(resolve)); // PageIds assigns pids after init
    const before = pagesOf(e);
    const wrappers = before.map((x) => x.querySelector(':scope > .columnWrapper'));
    const newPage = e.schema.nodeFromJSON(page([p('New first page')], { pid: 'newpage1' }));
    e.view.dispatch(e.state.tr.insert(0, newPage));
    const after = pagesOf(e);
    // The existing pages keep their elements (only their ids change).
    after.slice(1).forEach((x, i) => expect(x).toBe(before[i]));
    after.slice(1).forEach((x, i) => expect(x.querySelector(':scope > .columnWrapper')).toBe(wrappers[i]));
    expect(after.map((x) => x.id)).toEqual(['p1', 'p2', 'p3', 'p4']);
    expect(after.map((x) => x.querySelector('p')?.textContent)).toEqual(['New first page', 'Cover text', 'Second page', 'Third page']);
  });

  it('keeps the elements of later pages when a page is removed (P8.1)', async () => {
    const e = mount();
    await new Promise<void>((resolve) => queueMicrotask(resolve)); // PageIds assigns pids after init
    const before = pagesOf(e);
    const wrappers = before.map((x) => x.querySelector(':scope > .columnWrapper'));
    // Remove the second page: the third page's element must stay (not the second's, re-rendered).
    const first = e.state.doc.child(0).nodeSize;
    e.view.dispatch(e.state.tr.delete(first, first + e.state.doc.child(1).nodeSize));
    const after = pagesOf(e);
    expect(after).toHaveLength(2);
    expect(after[0]).toBe(before[0]);
    expect(after[1]).toBe(before[2]);
    expect(after[1]!.querySelector(':scope > .columnWrapper')).toBe(wrappers[2]);
    expect(after.map((x) => x.id)).toEqual(['p1', 'p2']);
  });

  it('typing in the flow does not touch the chrome', () => {
    const e = mount();
    const cover = pagesOf(e)[0]!;
    const footnote = cover.querySelector('.footnote');
    e.commands.insertContentAt(2, 'Hello ');
    expect(pagesOf(e)[0]).toBe(cover);
    expect(cover.querySelector('.footnote')).toBe(footnote);
    expect(cover.querySelector('.columnWrapper > p')?.textContent).toBe('Hello Cover text');
  });
});

describe('PageView events and mutations', () => {
  const view = () => new PageView(schema.nodeFromJSON(normalize(richDoc).content![0]!));

  it('stops events in the chrome only', () => {
    const v = view();
    const footnote = v.dom.querySelector('.footnote')!;
    const banner = v.dom.querySelector('.banner')!;
    const p1 = document.createElement('p');
    v.contentDOM.append(p1);
    const ev = (target: EventTarget) => {
      const event = new MouseEvent('mousedown', { bubbles: true });
      Object.defineProperty(event, 'target', { value: target });
      return event;
    };
    expect(v.stopEvent(ev(footnote))).toBe(true);
    expect(v.stopEvent(ev(banner))).toBe(true);
    expect(v.stopEvent(ev(v.dom))).toBe(false); // page margin: caret placement is ProseMirror's
    expect(v.stopEvent(ev(p1))).toBe(false);
    expect(v.stopEvent(ev(v.contentDOM))).toBe(false);
  });

  it('ignores mutations outside the flow', () => {
    const v = view();
    const footnote = v.dom.querySelector('.footnote')!;
    const p1 = document.createElement('p');
    v.contentDOM.append(p1);
    const record = (type: MutationRecordType, target: Node, removed: Node[] = []) =>
      ({ type, target, removedNodes: removed, addedNodes: [], attributeName: null }) as unknown as MutationRecord;
    expect(v.ignoreMutation(record('attributes', v.dom))).toBe(true);
    expect(v.ignoreMutation(record('characterData', footnote.firstChild!))).toBe(true);
    expect(v.ignoreMutation(record('childList', footnote))).toBe(true);
    expect(v.ignoreMutation(record('attributes', v.contentDOM))).toBe(true);
    expect(v.ignoreMutation(record('childList', v.contentDOM))).toBe(false);
    expect(v.ignoreMutation(record('characterData', p1))).toBe(false);
    expect(v.ignoreMutation(record('childList', v.dom, [v.contentDOM]))).toBe(false);
    expect(v.ignoreMutation({ type: 'selection', target: footnote })).toBe(false);
  });
});
