// TocView + refresher in jsdom (no layout, no pagination plugin: every change counts as
// settled). Theme exclusions and page numbers after pagination are covered by e2e/snippets.
import { Editor, type JSONContent } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';
import { afterEach, describe, expect, it } from 'vitest';
import { buildEditorExtensions } from '../editorExtensions';
import { editorNodeViews } from '../nodeviews';
import { navigateToTarget, TOC_ENTRIES_ATTR } from '../nodeviews/TocView';
import { docOf, node, p, page, text } from '../schema/testing';
import { refreshTocs, tocTargets } from './tocPlugin';

let editor: Editor | null = null;
afterEach(() => {
  editor?.destroy();
  editor = null;
  document.body.innerHTML = '';
});

function mount(content: JSONContent): Editor {
  const element = document.createElement('div');
  document.body.append(element);
  editor = new Editor({ element, extensions: buildEditorExtensions({ extensions: editorNodeViews }), content });
  return editor;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const h = (level: number, title: string) => node('heading', { level }, [text(title)]);
const toc = (attrs: Record<string, unknown> = {}) => node('toc', { depth: 3, wide: true, title: 'Contents', ...attrs });

describe('TocView', () => {
  it('renders the entries of the document as upstream markup', async () => {
    const e = mount(docOf(page([toc(), h(1, 'Intro'), p('x')]), page([h(2, 'Part A'), h(4, 'Too deep')]), page([h(1, 'Second')], { markers: ['resetCounting'] })));
    await flush();
    const dom = e.view.dom.querySelector<HTMLElement>('div.block.toc')!;
    expect([...dom.classList].filter((c) => !c.startsWith('ProseMirror'))).toEqual(['block', 'toc', 'wide']);
    expect(dom.getAttribute('data-depth')).toBe('3');
    expect(dom.getAttribute('contenteditable')).toBe('false');
    expect(dom.getAttribute(TOC_ENTRIES_ATTR)).toBe('3');
    expect(dom.querySelector('h1')?.textContent).toBe('Contents');
    const rows = [...dom.querySelectorAll('li > :is(h3, h4) > a, li > a')].map((a) => [a.parentElement!.localName, a.children[0]!.textContent, a.children[1]!.textContent, a.getAttribute('href')]);
    expect(rows).toEqual([
      ['h3', 'Intro', '1', '#intro'],
      ['h4', 'Part A', '2', '#part-a'],
      ['h3', 'Second', '1', '#second'],
    ]);
    expect(dom.querySelectorAll(':scope > ul > li > h3 > a > span.inline-block + span.inline-block')).toHaveLength(2);
  });

  it('refreshes when the document changes, and re-renders only on a difference', async () => {
    const e = mount(docOf(page([toc(), h(1, 'Intro'), p('text')])));
    await flush();
    const dom = e.view.dom.querySelector<HTMLElement>('div.block.toc')!;
    const list = dom.querySelector('ul');
    // An edit outside headings: same markup, elements kept.
    e.commands.insertContentAt(e.state.doc.content.size - 2, ' more');
    await flush();
    expect(dom.querySelector('ul')).toBe(list);
    // An edit in a heading.
    let intro = -1;
    e.state.doc.descendants((n, pos) => {
      if (n.isText && n.text === 'Intro') intro = pos;
    });
    e.view.dispatch(e.state.tr.insertText(' more', intro + 5));
    await flush();
    expect(dom.textContent).toContain('Intro more');
    // A new heading on a new page.
    e.view.dispatch(e.state.tr.insert(e.state.doc.content.size, e.schema.nodeFromJSON(page([h(2, 'Later')]))));
    await flush();
    expect([...dom.querySelectorAll('a')].map((a) => a.textContent)).toEqual(['Intro more1', 'Later2']);
    expect(refreshTocs(e.view)).toBe(0);
    expect(tocTargets(e.view)).toHaveLength(1);
  });

  it('follows attribute changes (title, wide, depth)', async () => {
    const e = mount(docOf(page([toc(), h(1, 'One'), h(4, 'Four')])));
    await flush();
    const dom = e.view.dom.querySelector<HTMLElement>('div.block.toc')!;
    e.view.dispatch(e.state.tr.setNodeAttribute(1, 'wide', false).setNodeAttribute(1, 'title', 'Index').setNodeAttribute(1, 'depth', 6));
    await flush();
    expect(e.view.dom.querySelector('div.block.toc')).toBe(dom);
    expect(dom.classList.contains('wide')).toBe(false);
    expect(dom.classList.contains('toc')).toBe(true);
    expect(dom.querySelector('h1')?.textContent).toBe('Index');
    expect(dom.getAttribute(TOC_ENTRIES_ATTR)).toBe('2');
  });

  it('a click on an entry moves the cursor to the heading', async () => {
    const e = mount(docOf(page([toc(), p('x')]), page([p('y'), h(2, 'Target')])));
    await flush();
    e.view.dispatch(e.state.tr.setSelection(TextSelection.create(e.state.doc, 3)));
    const link = e.view.dom.querySelector<HTMLAnchorElement>('div.block.toc a')!;
    link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(e.state.selection.$head.parent.textContent).toBe('Target');
    expect(navigateToTarget(e.view, '#p1')).toBe(true);
    expect(e.state.selection.$head.index(0)).toBe(0);
    expect(navigateToTarget(e.view, '#nope')).toBe(false);
  });

  it("follows ids with '%' literally, and percent-encoded hrefs too (UI-12)", async () => {
    const custom = (title: string, id: string) => node('heading', { level: 2, id, customId: true }, [text(title)]);
    const e = mount(docOf(page([toc(), p('x')]), page([custom('Sale', '50%-off'), custom('Space', '%20x'), custom('Plain', 'a b'), p('y')])));
    await flush();
    expect(() => navigateToTarget(e.view, '#50%-off')).not.toThrow();
    expect(e.state.selection.$head.parent.textContent).toBe('Sale');
    // The literal id wins over its decoded form.
    expect(navigateToTarget(e.view, '#%20x')).toBe(true);
    expect(e.state.selection.$head.parent.textContent).toBe('Space');
    // A percent-encoded href (pasted or legacy content) still finds its id.
    expect(navigateToTarget(e.view, '#a%20b')).toBe(true);
    expect(e.state.selection.$head.parent.textContent).toBe('Plain');
    // The entry for the '%' id works from a click as well.
    const link = Array.from(e.view.dom.querySelectorAll<HTMLAnchorElement>('div.block.toc a')).find((a) => a.textContent?.includes('Sale'))!;
    e.view.dispatch(e.state.tr.setSelection(TextSelection.create(e.state.doc, 3)));
    link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(e.state.selection.$head.parent.textContent).toBe('Sale');
    expect(navigateToTarget(e.view, '#p1')).toBe(true);
  });

  it('unregisters when the node goes away', async () => {
    const e = mount(docOf(page([toc(), p('x')])));
    await flush();
    expect(tocTargets(e.view)).toHaveLength(1);
    e.view.dispatch(e.state.tr.delete(1, 2));
    expect(tocTargets(e.view)).toHaveLength(0);
  });
});
