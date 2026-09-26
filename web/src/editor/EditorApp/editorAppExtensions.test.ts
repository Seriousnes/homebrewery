import { Editor } from '@tiptap/core';
import { afterEach, describe, expect, it } from 'vitest';
import { createCanvasGate } from '@/editor/canvas/canvasState';
import { buildEditorExtensions } from '@/editor/editorExtensions';
import { EDITOR_KEYBOARD_HINT, editingExtensions, EDITOR_LABEL, viewingExtensions } from './editorAppExtensions';

const editors: Editor[] = [];
afterEach(() => {
  editors.splice(0).forEach((e) => e.destroy());
});

function mount(extensions: ReturnType<typeof editingExtensions>, editable = true): Editor {
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: buildEditorExtensions({ extensions }),
    editable,
    content: { type: 'doc', content: [{ type: 'page', content: [{ type: 'paragraph' }] }] },
  });
  editors.push(editor);
  return editor;
}

const names = (list: ReturnType<typeof editingExtensions>) => list.map((e) => e.name);

describe('editor app extensions', () => {
  it('the editing set has the keymap, pagination with sections and seams, page objects and a name', () => {
    const list = names(editingExtensions(createCanvasGate()));
    for (const name of ['hbKeymap', 'hbPagination', 'hbSeamEditing', 'hbBlockType', 'hbPageObjects', 'hbEditorAccessibility']) expect(list).toContain(name);
  });

  it('the read-only set paginates but has no editing extensions', () => {
    const list = names(viewingExtensions(createCanvasGate()));
    expect(list).toContain('hbPagination');
    expect(list).toContain('hbEditorAccessibility');
    expect(list).not.toContain('hbKeymap');
    expect(list).not.toContain('hbPageObjects');
  });

  it('names the editor root, and marks a read-only one', () => {
    const editing = mount(editingExtensions(createCanvasGate()));
    expect(editing.view.dom.getAttribute('aria-label')).toBe(EDITOR_LABEL);
    expect(editing.view.dom.getAttribute('role')).toBe('textbox');
    expect(editing.view.dom.hasAttribute('aria-readonly')).toBe(false);

    expect(editing.view.dom.getAttribute('aria-multiline')).toBe('true');
    expect(editing.view.dom.hasAttribute('aria-describedby')).toBe(false);

    const viewing = mount(viewingExtensions(createCanvasGate(), 'Shared brew'), false);
    expect(viewing.view.dom.getAttribute('aria-label')).toBe('Shared brew');
    expect(viewing.view.dom.getAttribute('aria-readonly')).toBe('true');
    expect(viewing.view.dom.getAttribute('contenteditable')).toBe('false');
    expect(viewing.view.dom.hasAttribute('aria-multiline')).toBe(false);
  });

  it('describes the editor with the element given as describedBy (the keyboard hint)', () => {
    const hint = document.createElement('p');
    hint.id = 'editor-hint';
    hint.textContent = EDITOR_KEYBOARD_HINT;
    document.body.append(hint);
    try {
      const editing = mount(editingExtensions(createCanvasGate(), EDITOR_LABEL, 'editor-hint'));
      expect(editing.view.dom.getAttribute('aria-describedby')).toBe('editor-hint');
      expect(EDITOR_KEYBOARD_HINT).toContain('Alt+F10');
    } finally {
      hint.remove();
    }
  });
});
