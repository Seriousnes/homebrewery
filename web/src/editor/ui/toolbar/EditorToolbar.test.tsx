// EditorToolbar (plan §6.2, P3.4): state from the editor, actions as single undo steps, the class
// picker / link dialog host, toolbar focus, UI store zoom and spread, and no re-render for
// pagination transactions. Layout, real key events and axe run in web/e2e/toolbar.
import type { Editor, JSONContent } from '@tiptap/core';
import { undoDepth } from '@tiptap/pm/history';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Profiler } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { uiStore } from '@/app/uiStore';
import { PAGINATE } from '../../pagination';
import { docOf, node, p, page, text } from '../../schema/testing';
import { EditorToolbar } from './EditorToolbar';
import { createTestEditor, posOf, press, selectText } from './testing';

let editor: Editor | undefined;
let host: HTMLElement | undefined;
beforeEach(() => uiStore.getState().resetUi());
afterEach(() => {
  editor?.destroy();
  editor = undefined;
  host?.remove();
  host = undefined;
  uiStore.getState().resetUi();
});

const docWith = (...blocks: JSONContent[]) => docOf(page(blocks, { pid: 'testpage' }));
const h = (level: number, value: string) => node('heading', { level, id: value.toLowerCase() }, [text(value)]);

function mount(json: JSONContent, opts: { pagination?: boolean } = {}) {
  host = document.createElement('div');
  document.body.append(host);
  const e = (editor = createTestEditor(json, { element: host, pagination: opts.pagination }));
  let renders = 0;
  const user = userEvent.setup();
  render(
    <Profiler id="toolbar" onRender={() => (renders += 1)}>
      <EditorToolbar editor={e} status={<span role="status">Saved</span>} insertMenu={<button type="button">Insert</button>} />
    </Profiler>,
  );
  return { e, user, renders: () => renders, toolbar: screen.getByRole('toolbar', { name: 'Editing' }) };
}

const act$ = (fn: () => void) => act(() => fn());
const button = (name: string | RegExp) => screen.getByRole('button', { name });

describe('EditorToolbar', () => {
  it('renders the groups, slots and shortcuts', () => {
    const { toolbar } = mount(docWith(p('alpha')));
    for (const group of ['History', 'Block', 'Text', 'Alignment', 'Lists', 'Insert', 'View']) {
      expect(within(toolbar).getByRole('group', { name: group })).toBeInTheDocument();
    }
    expect(button('Bold')).toHaveAttribute('aria-keyshortcuts', 'Control+B');
    expect(button('Superscript')).toHaveAttribute('aria-keyshortcuts', 'Control+Shift+=');
    expect(button('Page break')).toHaveAttribute('aria-keyshortcuts', 'Control+Enter');
    expect(within(toolbar).getByRole('button', { name: 'Insert' })).toBeInTheDocument();
    expect(within(toolbar).getByRole('status')).toHaveTextContent('Saved');
    expect(button('Undo')).toBeDisabled();
  });

  it('shows the selection’s marks, block type, alignment and list', () => {
    const { e } = mount(
      docWith(node('paragraph', { align: 'center' }, [text('plain '), text('strong', [{ type: 'bold' }])]), h(2, 'Title'), node('bulletList', {}, [node('listItem', {}, [p('item')])])),
    );
    act$(() => selectText(e, 'strong'));
    expect(button('Bold')).toHaveAttribute('aria-pressed', 'true');
    expect(button('Italic')).toHaveAttribute('aria-pressed', 'false');
    expect(button('Center')).toHaveAttribute('aria-pressed', 'true');
    expect(button('Block type: Paragraph')).toBeEnabled();
    act$(() => selectText(e, 'Title', 1));
    expect(button('Block type: Heading 2')).toBeInTheDocument();
    expect(button('Bold')).toHaveAttribute('aria-pressed', 'false');
    expect(button('Center')).toBeDisabled(); // headings have no align
    act$(() => selectText(e, 'item', 1));
    expect(button('Bulleted list')).toHaveAttribute('aria-pressed', 'true');
    expect(button('Numbered list')).toHaveAttribute('aria-pressed', 'false');
  });

  it('mark buttons toggle as one undo step each and never take the focus from the editor', async () => {
    const { e, user } = mount(docWith(p('alpha beta')));
    act$(() => selectText(e, 'beta'));
    e.view.focus();
    expect(fireEvent.mouseDown(button('Bold'))).toBe(false); // default prevented
    await user.click(button('Bold'));
    await user.click(button('Italic'));
    expect(e.state.doc.nodeAt(posOf(e.state.doc, 'beta'))!.marks.map((m) => m.type.name)).toEqual(['bold', 'italic']);
    expect(Number(undoDepth(e.state))).toBe(2);
    expect(button('Undo')).toBeEnabled();
    await user.click(button('Undo'));
    expect(e.state.doc.nodeAt(posOf(e.state.doc, 'beta'))!.marks.map((m) => m.type.name)).toEqual(['bold']);
    expect(button('Redo')).toBeEnabled();
    await user.click(button('Redo'));
    expect(button('Italic')).toHaveAttribute('aria-pressed', 'true');
  });

  it('the block type menu sets the type and toggles the blockquote, then returns to the editor', async () => {
    const { e, user } = mount(docWith(p('alpha')));
    act$(() => selectText(e, 'alpha', 1));
    await user.click(button('Block type: Paragraph'));
    const menu = screen.getByRole('menu', { name: 'Block type' });
    expect(within(menu).getByRole('menuitemradio', { name: /Paragraph/ })).toHaveAttribute('aria-checked', 'true');
    await user.click(within(menu).getByRole('menuitemradio', { name: /Heading 3/ }));
    expect(e.state.doc.child(0).child(0).attrs.level).toBe(3);
    expect(e.view.dom).toHaveFocus();
    await user.click(button('Block type: Heading 3'));
    await user.click(within(screen.getByRole('menu')).getByRole('menuitemcheckbox', { name: /Blockquote/ }));
    expect(e.state.doc.child(0).child(0).type.name).toBe('blockquote');
  });

  it('alignment buttons set and reset the paragraph align', async () => {
    const { e, user } = mount(docWith(p('alpha')));
    act$(() => selectText(e, 'alpha', 1));
    await user.click(button('Align right'));
    expect(e.state.doc.child(0).child(0).attrs.align).toBe('right');
    await user.click(button('Align right'));
    expect(e.state.doc.child(0).child(0).attrs.align).toBeNull();
  });

  it('list, page break and column break buttons', async () => {
    const { e, user } = mount(docWith(p('alpha beta')));
    act$(() => selectText(e, 'beta', 0));
    await user.click(button('Column break'));
    expect(e.state.doc.child(0).child(1).type.name).toBe('columnBreak');
    await user.click(button('Page break'));
    expect(e.state.doc.childCount).toBe(2);
    await user.click(button('Numbered list'));
    expect(e.state.doc.child(1).child(0).type.name).toBe('orderedList');
  });

  it('zoom and page layout come from the UI store', async () => {
    const { user } = mount(docWith(p('alpha')));
    expect(button('Zoom: 100%')).toBeInTheDocument();
    await user.click(button('Zoom in'));
    expect(uiStore.getState().zoom).toBe(1.1);
    await user.click(button('Zoom: 110%'));
    await user.click(screen.getByRole('menuitemradio', { name: '50%' }));
    expect(uiStore.getState().zoom).toBe(0.5);
    await user.click(button('Zoom out'));
    expect(uiStore.getState().zoom).toBe(0.25);
    await user.click(button('Page layout: Single pages'));
    await user.click(screen.getByRole('menuitemradio', { name: 'Facing pages' }));
    expect(uiStore.getState().spread).toBe('facing');
  });

  it('Mod-M opens the class picker; applying adds the span in one undo step', async () => {
    const { e, user } = mount(docWith(p('alpha beta')));
    act$(() => selectText(e, 'beta'));
    act$(() => {
      expect(press(e, 'Mod-m')).toBe(true);
    });
    const dialog = await screen.findByRole('dialog', { name: 'Style the selection with classes' });
    await user.type(within(dialog).getByRole('combobox'), 'big{Enter}{Enter}');
    expect(screen.queryByRole('dialog')).toBeNull();
    const mark = e.state.doc.nodeAt(posOf(e.state.doc, 'beta'))!.marks[0]!;
    expect([mark.type.name, mark.attrs.classes]).toEqual(['span', ['big']]);
    expect(Number(undoDepth(e.state))).toBe(1);
    // Again on the span: edit mode, with Remove span.
    act$(() => selectText(e, 'beta', 1));
    await user.click(button('Classes'));
    await user.click(screen.getByRole('menuitem', { name: /Edit span classes/ }));
    await user.click(await screen.findByRole('button', { name: 'Remove span' }));
    expect(e.state.doc.nodeAt(posOf(e.state.doc, 'beta'))!.marks).toEqual([]);
  });

  it('Shift-Mod-M wraps in a theme block; Mod-K adds a link', async () => {
    const { e, user } = mount(docWith(p('alpha'), p('beta')));
    act$(() => selectText(e, 'beta'));
    act$(() => void press(e, 'Shift-Mod-m'));
    const picker = await screen.findByRole('dialog', { name: 'Wrap in a theme block' });
    await user.type(within(picker).getByRole('combobox'), 'note');
    await user.click(within(picker).getByRole('button', { name: 'Wrap' }));
    expect(e.state.doc.child(0).child(1).type.name).toBe('themeBlock');
    expect(e.state.doc.child(0).child(1).attrs.classes).toEqual(['note']);
    act$(() => selectText(e, 'alpha'));
    act$(() => void press(e, 'Mod-k'));
    const link = await screen.findByRole('dialog', { name: 'Add a link' });
    await user.type(within(link).getByRole('textbox', { name: 'Address' }), 'example.com{Enter}');
    expect(e.state.doc.nodeAt(posOf(e.state.doc, 'alpha'))!.marks[0]!.attrs.href).toBe('https://example.com');
    expect(button('Edit link')).toHaveAttribute('aria-pressed', 'true');
  });

  it('Alt+F10 focuses the toolbar; Escape returns to the editor', async () => {
    const { e, user, toolbar } = mount(docWith(p('alpha')));
    e.view.focus();
    act$(() => void press(e, 'Alt-F10'));
    expect(toolbar.contains(document.activeElement)).toBe(true);
    await user.keyboard('{Escape}');
    expect(e.view.dom).toHaveFocus();
  });

  it('pagination transactions do not re-render it; selection changes that matter do', () => {
    const { e, renders } = mount(docWith(p('plain '), p('more')), { pagination: true });
    const before = renders();
    act$(() => {
      for (let i = 0; i < 5; i++) {
        e.view.dispatch(
          e.state.tr
            .setNodeAttribute(0, 'oversized', i % 2 === 0)
            .setMeta(PAGINATE, { dirtyFrom: 0, dirtyTo: 0, action: 'oversized' })
            .setMeta('addToHistory', false),
        );
      }
    });
    expect(renders()).toBe(before);
    act$(() => selectText(e, 'more', 1)); // same state: paragraph, no marks
    expect(renders()).toBe(before);
    act$(() => void press(e, 'Mod-b')); // stored bold: the Bold button changes
    expect(renders()).toBeGreaterThan(before);
  });

  it('a read-only editor disables the editing controls', () => {
    host = document.createElement('div');
    document.body.append(host);
    const e = (editor = createTestEditor(docWith(p('alpha')), { editable: false, element: host }));
    render(<EditorToolbar editor={e} />);
    expect(button('Bold')).toBeDisabled();
    expect(button('Page break')).toBeDisabled();
    expect(button(/Block type/)).toBeDisabled();
    expect(button('Zoom in')).toBeEnabled();
  });
});
