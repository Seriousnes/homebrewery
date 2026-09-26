// "Select → focus the object" (P3.5 objects list): with and without the objects lane's extension.
import { Editor, type AnyExtension } from '@tiptap/core';
import { afterEach, describe, expect, it } from 'vitest';
import { buildEditorExtensions } from '@/editor/editorExtensions';
import { editorNodeViews } from '@/editor/nodeviews';
import { PageObjects } from '@/editor/objects/extension';
import { selectedObject } from '@/editor/objects/state';
import { docOf, p, page } from '@/editor/schema/testing';
import { focusPageObject, OBJECT_SELECT_EVENT, pageObjectElement, type PageObjectRef } from './objectFocus';

let editor: Editor | null = null;
let host: HTMLElement | null = null;
afterEach(() => {
  editor?.destroy();
  host?.remove();
  editor = null;
  host = null;
});

const objects = [
  { id: 'o1', kind: 'text', text: 'Art by X', classes: ['artist'], style: 'position: absolute; top: 0px;' },
  { id: 'o2', kind: 'image', src: 'https://example.com/a.png', classes: [], style: '' },
];

function mount(extensions: AnyExtension[] = []): Editor {
  host = document.createElement('div');
  document.body.append(host);
  editor = new Editor({
    element: host,
    extensions: buildEditorExtensions({ extensions: [...editorNodeViews, ...extensions] }),
    content: docOf(page([p('One')]), page([p('Two')], { objects })),
  });
  return editor;
}

describe('focusPageObject', () => {
  it('finds the object element PageView rendered', () => {
    const e = mount();
    expect(pageObjectElement(e, { pageIndex: 1, id: 'o1' })?.textContent).toBe('Art by X');
    expect(pageObjectElement(e, { pageIndex: 0, id: 'o1' })).toBeNull();
    expect(pageObjectElement(e, { pageIndex: 7, id: 'o1' })).toBeNull();
  });

  it('without the objects extension: dispatches OBJECT_SELECT_EVENT (bubbling) on the element', () => {
    const e = mount();
    const seen: PageObjectRef[] = [];
    e.view.dom.addEventListener(OBJECT_SELECT_EVENT, (event) => seen.push((event as CustomEvent<PageObjectRef>).detail));
    expect(focusPageObject(e, { pageIndex: 1, id: 'o2' })).toBe(true);
    expect(seen).toEqual([{ pageIndex: 1, id: 'o2' }]);
    expect(focusPageObject(e, { pageIndex: 1, id: 'missing' })).toBe(false);
    expect(seen).toHaveLength(1);
  });

  it('with the objects extension: the object becomes the selected object', () => {
    const e = mount([PageObjects]);
    expect(focusPageObject(e, { pageIndex: 1, id: 'o1' })).toBe(true);
    expect(selectedObject(e.state)).toEqual({ pagePos: e.state.doc.child(0).nodeSize, id: 'o1' });
  });
});
