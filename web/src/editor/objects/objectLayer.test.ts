// ObjectLayer (nodeviews/ObjectLayer.ts): the resize geometry, and the layer's DOM wiring in an
// editor (jsdom has no layout: dragging, measuring and positioning are covered by
// web/e2e/objects/objects.spec.ts).
import { Editor } from '@tiptap/core';
import { afterEach, describe, expect, it } from 'vitest';
import { buildEditorExtensions } from '../editorExtensions';
import { editorNodeViews } from '../nodeviews';
import { clampToPage, resizeGeometry } from '../nodeviews/ObjectLayer';
import { endOfFirstBlock, moveBoundary, pageAt } from '../pagination/boundary';
import { docOf, p, page } from '../schema/testing';
import { selectObject } from './commands';
import { objectLayerOf, PageObjects } from './extension';
import { selectedObject } from './state';

describe('resizeGeometry', () => {
  const start = { left: 100, top: 50, width: 200, height: 100 };

  it('moves the dragged edges only', () => {
    expect(resizeGeometry(start, 'e', 30, 99, false)).toEqual({ left: 100, top: 50, width: 230, height: 100 });
    expect(resizeGeometry(start, 's', 99, 20, false)).toEqual({ left: 100, top: 50, width: 200, height: 120 });
    expect(resizeGeometry(start, 'w', 30, 0, false)).toEqual({ left: 130, top: 50, width: 170, height: 100 });
    expect(resizeGeometry(start, 'n', 0, -10, false)).toEqual({ left: 100, top: 40, width: 200, height: 110 });
  });

  it('keeps the aspect ratio on corners when asked, anchored at the opposite corner', () => {
    expect(resizeGeometry(start, 'se', 100, 5, true)).toEqual({ left: 100, top: 50, width: 300, height: 150 });
    expect(resizeGeometry(start, 'nw', -100, 0, true)).toEqual({ left: 0, top: 0, width: 300, height: 150 });
    // Edges never keep the ratio.
    expect(resizeGeometry(start, 'e', 100, 0, true)).toEqual({ left: 100, top: 50, width: 300, height: 100 });
  });

  it('never goes below the minimum size', () => {
    const g = resizeGeometry(start, 'se', -500, -500, false);
    expect(g.width).toBe(8);
    expect(g.height).toBe(8);
    expect(resizeGeometry(start, 'w', 500, 0, false).left).toBe(292);
  });
});

describe('clampToPage (UI-9)', () => {
  const pageSize = { width: 816, height: 1056 };

  it('keeps a strip of the object inside the page, and allows bleeding past the edges', () => {
    const inside = { left: 100, top: 50, width: 200, height: 100 };
    expect(clampToPage(inside, pageSize)).toEqual({ ...inside, clamped: false });
    // Bleeding: most of the object outside, more than the strip still in.
    const bleed = { left: -150, top: 1000, width: 200, height: 100 };
    expect(clampToPage(bleed, pageSize)).toEqual({ ...bleed, clamped: false });
    // Past the right and bottom edges: 16px stay on the page.
    expect(clampToPage({ left: 1100, top: 2000, width: 200, height: 100 }, pageSize)).toEqual({ left: 800, top: 1040, width: 200, height: 100, clamped: true });
    // Past the left and top edges.
    expect(clampToPage({ left: -1000, top: -500, width: 200, height: 100 }, pageSize)).toEqual({ left: -184, top: -84, width: 200, height: 100, clamped: true });
  });

  it('keeps small objects whole, and does nothing for an unmeasured page', () => {
    expect(clampToPage({ left: 900, top: 0, width: 10, height: 10 }, pageSize)).toMatchObject({ left: 806, clamped: true });
    const g = { left: 5000, top: 5000, width: 10, height: 10 };
    expect(clampToPage(g, { width: 0, height: 0 })).toEqual({ ...g, clamped: false });
  });
});

describe('ObjectLayer in an editor', () => {
  let editor: Editor | null = null;
  afterEach(() => {
    editor?.destroy();
    editor = null;
  });

  function mount() {
    const host = document.createElement('div');
    host.className = 'hb-canvas';
    document.body.append(host);
    editor = new Editor({
      element: host,
      extensions: buildEditorExtensions({ extensions: [...editorNodeViews, PageObjects] }),
      content: docOf(
        page([p('Text')], {
          pid: 'aaaaaaaa',
          objects: [{ id: 'o1', kind: 'text', classes: [], style: 'position: absolute; left: 10px; top: 20px;', text: 'Title' }],
        }),
      ),
    });
    return editor;
  }

  it('sits next to the ProseMirror root, hidden until an object is selected', () => {
    const e = mount();
    const layer = objectLayerOf(e)!;
    expect(layer.root.parentElement).toBe(e.view.dom.parentElement);
    expect(e.view.dom.contains(layer.root)).toBe(false); // outside the pages: no theme selector sees it
    const frame = layer.root.querySelector('[data-testid="object-frame"]') as HTMLElement;
    expect(frame.hidden).toBe(true);
    selectObject({ pagePos: 0, id: 'o1' })(e.state, e.view.dispatch);
    expect(selectedObject(e.state)).toEqual({ pagePos: 0, id: 'o1' });
    expect(frame.hidden).toBe(false);
    expect(frame.getAttribute('role')).toBe('group');
    expect(frame.getAttribute('aria-label')).toMatch(/^Text object “Title” \(1 of 1\)$/);
    expect(frame.tabIndex).toBe(0);
    // Text objects offer "Edit text", not "Put back in text".
    const toolbar = layer.root.querySelector('[role="toolbar"]')!;
    expect((toolbar.querySelector('[data-action="edit"]') as HTMLElement).hidden).toBe(false);
    expect((toolbar.querySelector('[data-action="unplace"]') as HTMLElement).hidden).toBe(true);
    expect((toolbar.querySelector('[data-action="backward"]') as HTMLButtonElement).disabled).toBe(true);
  });

  it('keyboard: Escape deselects, Delete removes the object (one undo step)', () => {
    const e = mount();
    e.view.focus = () => {}; // jsdom can't place a DOM selection (no layout)
    const layer = objectLayerOf(e)!;
    selectObject({ pagePos: 0, id: 'o1' })(e.state, e.view.dispatch);
    const frame = layer.root.querySelector('[data-testid="object-frame"]') as HTMLElement;
    frame.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(selectedObject(e.state)).toBeNull();
    selectObject({ pagePos: 0, id: 'o1' })(e.state, e.view.dispatch);
    frame.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
    expect(e.state.doc.firstChild!.attrs.objects).toEqual([]);
    e.commands.undo();
    expect(e.state.doc.firstChild!.attrs.objects).toHaveLength(1);
  });

  it('keyboard: Ctrl/Cmd+A while editing text selects only the object text and keeps the edit (P8.2)', () => {
    const e = mount();
    e.view.focus = () => {};
    const layer = objectLayerOf(e)!;
    selectObject({ pagePos: 0, id: 'o1' })(e.state, e.view.dispatch);
    layer.startEditing();
    const span = e.view.dom.querySelector('[data-hb-object-editing]') as HTMLElement;
    window.getSelection()!.collapse(span.firstChild, 2);
    const event = new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true, cancelable: true });
    span.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    const selection = window.getSelection()!;
    expect(selection.toString()).toBe('Title');
    expect(span.contains(selection.anchorNode) || selection.anchorNode === span).toBe(true);
    expect(layer.isEditing).toBe(true);
    // Other shortcuts with Ctrl stay native (not taken).
    const other = new KeyboardEvent('keydown', { key: 'b', ctrlKey: true, bubbles: true, cancelable: true });
    span.dispatchEvent(other);
    expect(other.defaultPrevented).toBe(false);
  });

  describe('when page positions move during a gesture (UI-2)', () => {
    const TITLE = { id: 'o1', kind: 'text', classes: [], style: 'position: absolute; left: 10px; top: 20px;', text: 'Title' } as const;

    function mountTwoPages(second: ReturnType<typeof page> = page([p('Second')], { pid: 'bbbbbbbb', objects: [TITLE] })) {
      const host = document.createElement('div');
      host.className = 'hb-canvas';
      document.body.append(host);
      editor = new Editor({
        element: host,
        extensions: buildEditorExtensions({ extensions: [...editorNodeViews, PageObjects] }),
        content: docOf(page([p('First page')], { pid: 'aaaaaaaa' }), second),
      });
      editor.view.focus = () => {};
      const pagePos = editor.state.doc.child(0).nodeSize;
      selectObject({ pagePos, id: 'o1' })(editor.state, editor.view.dispatch);
      return { e: editor, layer: objectLayerOf(editor)!, pagePos };
    }

    const storedText = (e: Editor) => (e.state.doc.child(1).attrs.objects as { text?: string }[])[0]?.text;
    const editingSpan = (e: Editor) => e.view.dom.querySelector('[data-hb-object-editing]') as HTMLElement;
    const shiftPages = (e: Editor) => e.view.dispatch(e.state.tr.insertText('12345', 2).setMeta('addToHistory', false));

    it('an in-place edit commits the typed text after the page moved', () => {
      const { e, layer, pagePos } = mountTwoPages();
      layer.startEditing();
      const span = editingSpan(e);
      span.textContent = 'Chapter One';
      shiftPages(e);
      expect(selectedObject(e.state)).toEqual({ pagePos: pagePos + 5, id: 'o1' });
      span.dispatchEvent(new FocusEvent('blur'));
      expect(layer.isEditing).toBe(false);
      expect(storedText(e)).toBe('Chapter One');
    });

    it('a drag commits the new style after the page moved', () => {
      const { e, layer } = mountTwoPages();
      const frame = layer.root.querySelector('[data-testid="object-frame"]') as HTMLElement;
      const pointer = (type: string, x: number) => frame.dispatchEvent(new PointerEvent(type, { bubbles: true, button: 0, pointerId: 7, clientX: x, clientY: 0 }));
      pointer('pointerdown', 0);
      pointer('pointermove', 40);
      shiftPages(e);
      pointer('pointerup', 40);
      const style = (e.state.doc.child(1).attrs.objects as { style: string }[])[0]!.style;
      expect(style).toMatch(/left: 40px/);
    });

    it("an in-place edit commits the typed text after pagination re-split the object's auto page", async () => {
      const auto = page([p('Second'), p('Third')], { kind: 'auto', pid: 'bbbbbbbb', objects: [TITLE] });
      const { e, layer } = mountTwoPages(auto);
      layer.startEditing();
      editingSpan(e).textContent = 'Chapter One';
      // A pull: page 2 joined into page 1 and split again after its first block (pid kept).
      const tr = e.state.tr.setMeta('addToHistory', false);
      moveBoundary(tr, 0, endOfFirstBlock(pageAt(e.state.doc, 1)!));
      e.view.dispatch(tr);
      expect(e.state.doc.child(1).attrs.pid).toBe('bbbbbbbb');
      expect(selectedObject(e.state)).toEqual({ pagePos: e.state.doc.child(0).nodeSize, id: 'o1' });
      const span = editingSpan(e);
      if (span) span.dispatchEvent(new FocusEvent('blur'));
      await Promise.resolve();
      expect(layer.isEditing).toBe(false);
      expect(storedText(e)).toBe('Chapter One');
    });
  });

  it('is removed with the editor', () => {
    const e = mount();
    const root = objectLayerOf(e)!.root;
    e.destroy();
    editor = null;
    expect(root.isConnected).toBe(false);
  });
});
