// The source dialog in jsdom: opened by the 'editSource' request, Apply replaces the scope as one
// undo step, the parse report comes first ("Apply anyway"), scopes switch, and leaving with edits
// asks first. The browser flow (shortcut, app bar, CodeMirror typing) is web/e2e/panels/edit-source.spec.ts.
import { Editor } from '@tiptap/core';
import { EditorView } from '@codemirror/view';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { emitKeymapRequest, hbKeymapExtensions } from '@/editor/commands/keymap';
import { buildEditorExtensions } from '@/editor/editorExtensions';
import { UiRoot } from '@/ui';
import { SourceEditorHost } from './SourceEditorHost';

// jsdom has no layout: CodeMirror's measuring asks ranges for rects.
beforeAll(() => {
  const proto = Range.prototype as Partial<Pick<Range, 'getClientRects' | 'getBoundingClientRect'>>;
  const empty = { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0, toJSON: () => ({}) } as DOMRect;
  proto.getClientRects ??= () => Object.assign([], { item: () => null });
  proto.getBoundingClientRect ??= () => empty;
});

let editor: Editor | null = null;
afterEach(() => {
  editor?.destroy();
  editor = null;
});

function mount(): Editor {
  editor = new Editor({
    extensions: buildEditorExtensions({ extensions: [...hbKeymapExtensions] }),
    content: {
      type: 'doc',
      content: [
        { type: 'page', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'one' }] }, { type: 'paragraph', content: [{ type: 'text', text: 'two' }] }] },
        { type: 'page', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'three' }] }] },
      ],
    },
  });
  editor.commands.setTextSelection(2);
  render(
    <UiRoot colorScheme="light">
      <SourceEditorHost editor={editor} />
    </UiRoot>,
  );
  return editor;
}

async function open(e: Editor): Promise<EditorView> {
  act(() => {
    expect(emitKeymapRequest(e, 'editSource')).toBe(true);
  });
  const host = await screen.findByTestId('source-code');
  const view = EditorView.findFromDOM(host.querySelector<HTMLElement>('.cm-editor')!);
  if (!view) throw new Error('no CodeMirror view');
  return view;
}

const setCode = (view: EditorView, text: string) => act(() => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } }));
const texts = (e: Editor) => {
  const out: string[] = [];
  e.state.doc.forEach((page) => out.push(page.textContent));
  return out;
};

describe('SourceEditorDialog', () => {
  it('opens on the editSource request with the block at the caret; Apply is one undo step', async () => {
    const e = mount();
    const view = await open(e);
    expect(view.state.doc.toString()).toBe('<p>one</p>');
    expect(screen.getByTestId('source-scope-selection')).toBeChecked();
    setCode(view, '<h2>One</h2>\n<p>and a half</p>');
    await userEvent.click(screen.getByTestId('source-apply'));
    await waitFor(() => expect(screen.queryByTestId('source-editor')).toBeNull());
    expect(texts(e)).toEqual(['Oneand a halftwo', 'three']);
    expect(e.state.doc.child(0).child(0).type.name).toBe('heading');
    e.commands.undo();
    expect(texts(e)).toEqual(['onetwo', 'three']);
  });

  it('lists parse problems first; Apply anyway applies', async () => {
    const e = mount();
    const view = await open(e);
    setCode(view, '<p onclick="x()">safe</p><script>alert(1)</script>');
    await userEvent.click(screen.getByTestId('source-apply'));
    const report = await screen.findByTestId('source-report');
    expect(report).toHaveTextContent('<script> is not allowed and was removed.');
    expect(report).toHaveTextContent('The attribute onclick is not allowed and was removed.');
    expect(texts(e)).toEqual(['onetwo', 'three']);
    await userEvent.click(screen.getByRole('button', { name: 'Apply anyway' }));
    await waitFor(() => expect(screen.queryByTestId('source-editor')).toBeNull());
    expect(texts(e)).toEqual(['safetwo', 'three']);
  });

  it('switches scope; the whole brew shows every section', async () => {
    const e = mount();
    await open(e);
    await userEvent.click(screen.getByTestId('source-scope-brew'));
    const view = EditorView.findFromDOM(screen.getByTestId('source-code').querySelector<HTMLElement>('.cm-editor')!)!;
    expect(view.state.doc.toString()).toBe('<div class="page">\n  <p>one</p>\n  <p>two</p>\n</div>\n\n<div class="page">\n  <p>three</p>\n</div>');
  });

  it('Cancel with edits asks first; discarding changes nothing', async () => {
    const e = mount();
    const view = await open(e);
    setCode(view, '<p>changed</p>');
    await userEvent.click(screen.getByTestId('source-cancel'));
    await userEvent.click(await screen.findByRole('button', { name: 'Keep editing' }));
    expect(screen.getByTestId('source-editor')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('source-cancel'));
    await userEvent.click(await screen.findByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(screen.queryByTestId('source-editor')).toBeNull());
    expect(texts(e)).toEqual(['onetwo', 'three']);
  });

  it('From markdown… inserts the converted HTML at the cursor', async () => {
    const e = mount();
    const view = await open(e);
    act(() => view.dispatch({ selection: { anchor: view.state.doc.length } }));
    await userEvent.click(screen.getByTestId('source-from-markdown'));
    await userEvent.type(await screen.findByRole('textbox', { name: 'Markdown' }), '## Added{enter}{enter}With **bold**.');
    await userEvent.click(screen.getByTestId('source-markdown-insert'));
    await waitFor(() => expect(screen.queryByTestId('source-markdown')).toBeNull());
    expect(view.state.doc.toString()).toBe('<p>one</p><h2>Added</h2>\n<p>With <strong>bold</strong>.</p>');
    await userEvent.click(screen.getByTestId('source-apply'));
    await waitFor(() => expect(screen.queryByTestId('source-editor')).toBeNull());
    expect(texts(e)).toEqual(['oneAddedWith bold.two', 'three']);
  });

  it('a read-only editor declines the request', () => {
    const e = mount();
    e.setEditable(false);
    expect(emitKeymapRequest(e, 'editSource')).toBe(false);
  });
});
