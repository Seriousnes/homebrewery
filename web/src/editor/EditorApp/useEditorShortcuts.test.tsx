import { Editor } from '@tiptap/core';
import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCanvasGate } from '@/editor/canvas/canvasState';
import { emitKeymapRequest } from '@/editor/commands/keymap';
import { buildEditorExtensions } from '@/editor/editorExtensions';
import { editingExtensions } from './editorAppExtensions';
import { useEditorShortcuts } from './useEditorShortcuts';

const editors: Editor[] = [];
afterEach(() => {
  editors.splice(0).forEach((e) => e.destroy());
});

function makeEditor(): Editor {
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: buildEditorExtensions({ extensions: editingExtensions(createCanvasGate()) }),
    content: { type: 'doc', content: [{ type: 'page', content: [{ type: 'paragraph' }] }] },
  });
  editors.push(editor);
  return editor;
}

const press = (init: KeyboardEventInit) => {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  window.dispatchEvent(event);
  return event;
};

describe('useEditorShortcuts', () => {
  it('answers the keymap save and print requests', () => {
    const editor = makeEditor();
    const onSave = vi.fn();
    const onPrint = vi.fn();
    const hook = renderHook(() => useEditorShortcuts({ editor, onSave, onPrint }));
    expect(emitKeymapRequest(editor, 'save')).toBe(true);
    expect(emitKeymapRequest(editor, 'print')).toBe(true);
    expect(emitKeymapRequest(editor, 'link')).toBe(false);
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onPrint).toHaveBeenCalledTimes(1);
    hook.unmount();
    expect(emitKeymapRequest(editor, 'save')).toBe(false);
  });

  it('takes Ctrl+P anywhere on the page, and Ctrl+S only when asked', () => {
    const onSave = vi.fn();
    const onPrint = vi.fn();
    const hook = renderHook(({ window: saveKeyOnWindow }) => useEditorShortcuts({ editor: null, onSave, onPrint, saveKeyOnWindow }), {
      initialProps: { window: false },
    });
    expect(press({ key: 'p', code: 'KeyP', ctrlKey: true }).defaultPrevented).toBe(true);
    expect(onPrint).toHaveBeenCalledTimes(1);
    // Autosave's own listener handles Ctrl+S on the pages that save.
    expect(press({ key: 's', code: 'KeyS', ctrlKey: true }).defaultPrevented).toBe(false);
    expect(onSave).not.toHaveBeenCalled();
    hook.rerender({ window: true });
    expect(press({ key: 's', code: 'KeyS', metaKey: true }).defaultPrevented).toBe(true);
    expect(onSave).toHaveBeenCalledTimes(1);
    hook.unmount();
    press({ key: 'p', code: 'KeyP', ctrlKey: true });
    expect(onPrint).toHaveBeenCalledTimes(1);
  });

  it('leaves keys that something else already handled', () => {
    const onPrint = vi.fn();
    renderHook(() => useEditorShortcuts({ editor: null, onSave: vi.fn(), onPrint }));
    const handled = (event: KeyboardEvent) => event.preventDefault();
    window.addEventListener('keydown', handled, { capture: true });
    try {
      press({ key: 'p', code: 'KeyP', ctrlKey: true });
    } finally {
      window.removeEventListener('keydown', handled, { capture: true });
    }
    expect(onPrint).not.toHaveBeenCalled();
    // The latest callbacks are used without re-subscribing.
    press({ key: 'p', code: 'KeyP', ctrlKey: true, shiftKey: true });
    expect(onPrint).not.toHaveBeenCalled();
  });

  it('uses the latest callbacks', () => {
    const first = vi.fn();
    const second = vi.fn();
    const hook = renderHook(({ onPrint }) => useEditorShortcuts({ editor: null, onSave: vi.fn(), onPrint }), { initialProps: { onPrint: first } });
    hook.rerender({ onPrint: second });
    press({ key: 'p', code: 'KeyP', ctrlKey: true });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    hook.unmount();
  });
});
