// Inline images (plan §6.6): natural size capture and the editor rendering (jsdom: no layout,
// so load and natural sizes are simulated).
import { Editor } from '@tiptap/core';
import { afterEach, describe, expect, it } from 'vitest';
import { buildEditorExtensions } from '../editorExtensions';
import { docOf, node, page, text } from '../schema/testing';
import { heightOnly, ImageWithView, NATURAL_ATTR, NATURAL_SIZE_META, naturalSizeTransaction } from './imageView';

let editor: Editor | null = null;
afterEach(() => {
  editor?.destroy();
  editor = null;
});

function mount(imageAttrs: Record<string, unknown>) {
  const element = document.createElement('div');
  document.body.append(element);
  editor = new Editor({
    element,
    extensions: buildEditorExtensions({ extensions: [ImageWithView] }),
    // (With a pid, so the page isn't re-rendered when the PageIds plugin assigns one.)
    content: docOf(page([node('paragraph', undefined, [text('A '), node('image', { src: 'https://example.com/i.png', ...imageAttrs })])], { pid: 'aaaaaaaa' })),
  });
  return editor;
}

function loaded(img: HTMLImageElement, width: number, height: number) {
  Object.defineProperty(img, 'complete', { configurable: true, get: () => true });
  Object.defineProperty(img, 'naturalWidth', { configurable: true, get: () => width });
  Object.defineProperty(img, 'naturalHeight', { configurable: true, get: () => height });
}

describe('heightOnly', () => {
  it('is true only when the style sizes the image by height alone', () => {
    expect(heightOnly('height: 100%;')).toBe(true);
    expect(heightOnly('height: 100%; width: auto;')).toBe(true);
    expect(heightOnly('height: 100%; width: 50%;')).toBe(false);
    expect(heightOnly('width: 50%;')).toBe(false);
    expect(heightOnly('max-height: 10px;')).toBe(false);
    expect(heightOnly(null)).toBe(false);
  });
});

describe('ImageView', () => {
  it('renders like renderHTML without a stored size (--HB_src kept)', () => {
    const e = mount({ style: 'width: 50%;' });
    const img = e.view.dom.querySelector('img:not(.ProseMirror-separator)') as HTMLImageElement;
    expect(img.getAttribute('src')).toBe('https://example.com/i.png');
    expect(img.getAttribute('loading')).toBe('lazy');
    expect(img.getAttribute('style')?.replace(/\s/g, '')).toContain('--HB_src:url(https://example.com/i.png)');
    expect(img.hasAttribute(NATURAL_ATTR)).toBe(false);
    expect(img.hasAttribute('width')).toBe(false);
  });

  it('with a stored natural size: width/height attributes, the marker and the width variable', () => {
    const e = mount({ width: 400, height: 300, style: 'float: right;' });
    const img = e.view.dom.querySelector('img:not(.ProseMirror-separator)') as HTMLImageElement;
    expect(img.getAttribute('width')).toBe('400');
    expect(img.getAttribute('height')).toBe('300');
    expect(img.hasAttribute(NATURAL_ATTR)).toBe(true);
    expect(img.getAttribute('style')).toMatch(/float: right;\s*--hb-natural-width: 400px;$/);
  });

  it('leaves the width free when the author sets only a height', () => {
    const e = mount({ width: 400, height: 300, style: 'height: 100%;' });
    const img = e.view.dom.querySelector('img:not(.ProseMirror-separator)') as HTMLImageElement;
    expect(img.hasAttribute(NATURAL_ATTR)).toBe(true);
    expect(img.getAttribute('style')).not.toContain('--hb-natural-width');
  });

  it('patches the same element on attribute changes and keeps the selection class', () => {
    const e = mount({});
    const img = e.view.dom.querySelector('img:not(.ProseMirror-separator)') as HTMLImageElement;
    e.commands.setNodeSelection(4);
    expect(img.classList.contains('ProseMirror-selectednode')).toBe(true);
    e.view.dispatch(e.state.tr.setNodeAttribute(4, 'width', 10).setNodeAttribute(4, 'height', 20).setNodeAttribute(4, 'classes', ['wrapLeft']));
    expect(e.view.dom.querySelector('img:not(.ProseMirror-separator)')).toBe(img);
    expect(img.className).toBe('wrapLeft ProseMirror-selectednode');
    expect(img.getAttribute('width')).toBe('10');
  });
});

describe('natural size capture', () => {
  it('records the natural size of a loaded image, outside the undo history', () => {
    const e = mount({});
    const img = e.view.dom.querySelector('img:not(.ProseMirror-separator)') as HTMLImageElement;
    loaded(img, 640, 480);
    const tr = naturalSizeTransaction(e.view, [img])!;
    expect(tr.getMeta('addToHistory')).toBe(false);
    expect(tr.getMeta(NATURAL_SIZE_META)).toBe(true);
    e.view.dispatch(tr);
    expect(e.state.doc.nodeAt(4)!.attrs).toMatchObject({ width: 640, height: 480 });
    expect(e.can().undo()).toBe(false);
    // Nothing to do once stored.
    expect(naturalSizeTransaction(e.view, [e.view.dom.querySelector('img:not(.ProseMirror-separator)') as HTMLImageElement])).toBeNull();
  });

  it('ignores images that failed, are not loaded, or show another src', () => {
    const e = mount({});
    const img = e.view.dom.querySelector('img:not(.ProseMirror-separator)') as HTMLImageElement;
    expect(naturalSizeTransaction(e.view, [img])).toBeNull(); // not complete
    loaded(img, 0, 0);
    expect(naturalSizeTransaction(e.view, [img])).toBeNull(); // failed
    loaded(img, 10, 10);
    img.setAttribute('src', 'https://example.com/other.png');
    expect(naturalSizeTransaction(e.view, [img])).toBeNull();
  });

  it('the plugin records sizes when a load event arrives', async () => {
    const e = mount({});
    const img = e.view.dom.querySelector('img:not(.ProseMirror-separator)') as HTMLImageElement;
    loaded(img, 32, 16);
    img.dispatchEvent(new Event('load'));
    await Promise.resolve();
    await Promise.resolve();
    expect(e.state.doc.nodeAt(4)!.attrs).toMatchObject({ width: 32, height: 16 });
  });

  it('does nothing in a read-only view', async () => {
    const e = mount({});
    e.setEditable(false);
    const img = e.view.dom.querySelector('img:not(.ProseMirror-separator)') as HTMLImageElement;
    loaded(img, 32, 16);
    img.dispatchEvent(new Event('load'));
    await Promise.resolve();
    await Promise.resolve();
    expect(e.state.doc.nodeAt(4)!.attrs.width).toBeNull();
  });
});
