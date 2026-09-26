// Inspector (P3.5) in jsdom with a real editor: fields apply validated edits as one undo step each,
// invalid input shows an error and changes nothing, breadcrumbs pick the inspected element, and the
// Page tab edits the section, markers, attributes and objects. Layout, the theme's class
// suggestions and axe run in web/e2e/inspector.
import { Editor, Extension, type JSONContent } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { NodeSelection, TextSelection } from '@tiptap/pm/state';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { uiStore } from '@/app/uiStore';
import { buildEditorExtensions } from '@/editor/editorExtensions';
import { sectionSyncPlugin } from '@/editor/pagination/sections';
import type { PageAttrs } from '@/editor/schema';
import { docOf, node, p, page, text } from '@/editor/schema/testing';
import { UiRoot } from '@/ui';
import { Inspector } from './Inspector';
import type { PageObjectRef } from './objectFocus';

let editor: Editor | null = null;
/** The section sync alone (the Pagination extension includes it; pagination needs a layout). */
const SectionSync = Extension.create({ name: 'testSectionSync', addProseMirrorPlugins: () => [sectionSyncPlugin()] });

beforeEach(() => {
  uiStore.getState().resetUi();
});
afterEach(() => {
  editor?.destroy();
  editor = null;
});

const objects = [
  { id: 'o1', kind: 'image', src: 'https://example.com/art/inn-sketch.png', classes: ['banner'], style: 'position: absolute; top: 0px;' },
  { id: 'o2', kind: 'text', text: 'Art by Somebody', classes: [], style: '' },
];

const content = (): JSONContent =>
  docOf(
    page(
      [
        node('heading', { level: 1 }, [text('The Inn')]),
        p('Alpha'),
        node('themeBlock', { classes: ['note'] }, [p('Inside the note')]),
        node('paragraph', undefined, [text('plain '), text('spanned', [{ type: 'span', attrs: { classes: ['sc'] } }])]),
      ],
      { columns: 2, objects },
    ),
    page([p('Continued page')], { kind: 'auto', columns: 2 }),
    page([p('Second section')], { markers: ['frontCover'] }),
  );

async function setup(props: Partial<Parameters<typeof Inspector>[0]> = {}) {
  editor = new Editor({ extensions: buildEditorExtensions({ extensions: [SectionSync] }), content: content() });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0)); // heading ids, page ids
  });
  const user = userEvent.setup();
  const utils = render(
    <UiRoot>
      <Inspector editor={editor} classSuggestions={['monster', 'frame', 'wide', 'note', 'descriptive']} {...props} />
    </UiRoot>,
  );
  return { ...utils, user, editor };
}

function posOf(doc: PMNode, test: (n: PMNode) => boolean): number {
  let found = -1;
  doc.descendants((n, pos) => {
    if (found < 0 && test(n)) found = pos;
    return found < 0;
  });
  if (found < 0) throw new Error('not found');
  return found;
}
const byText = (value: string) => (n: PMNode) => n.isTextblock && n.textContent === value;

/** Puts the caret inside the textblock with `value` (offset 1). */
function caretIn(e: Editor, value: string, offset = 1) {
  const pos = posOf(e.state.doc, byText(value)) + 1 + offset;
  act(() => {
    e.view.dispatch(e.state.tr.setSelection(TextSelection.create(e.state.doc, pos)));
  });
}
const attrsOf = (e: Editor, value: string) => e.state.doc.nodeAt(posOf(e.state.doc, byText(value)))!.attrs;
const undo = (e: Editor) => act(() => void e.commands.undo());

describe('Element tab', () => {
  it('shows the element chain and the inspected element', async () => {
    const { editor: e } = await setup();
    caretIn(e, 'Inside the note');
    const crumbs = screen.getByRole('navigation', { name: 'Element path' });
    expect(within(crumbs).getAllByRole('button').map((b) => b.textContent)).toEqual(['Theme block.note', 'Paragraph']);
    expect(within(crumbs).getByRole('button', { name: 'Paragraph' })).toHaveAttribute('aria-current', 'true');
    expect(screen.getByTestId('inspector-target')).toHaveTextContent('Paragraph');
  });

  it('adds a class with Enter as one undo step', async () => {
    const { user, editor: e } = await setup();
    caretIn(e, 'Alpha');
    await user.type(screen.getByRole('combobox', { name: 'Add class' }), 'wide{Enter}');
    expect(attrsOf(e, 'Alpha').classes).toEqual(['wide']);
    expect(within(screen.getByTestId('inspector-classes')).getByText('wide')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Add class' })).toHaveValue('');
    undo(e);
    expect(attrsOf(e, 'Alpha').classes).toEqual([]);
    expect(within(screen.getByTestId('inspector-classes')).queryByText('wide')).toBeNull();
  });

  it('suggests classes and adds the picked one', async () => {
    const { user, editor: e } = await setup();
    caretIn(e, 'Alpha');
    const box = screen.getByRole('combobox', { name: 'Add class' });
    await user.type(box, 'mo');
    expect(box).toHaveAttribute('aria-expanded', 'true');
    const list = screen.getByRole('listbox');
    expect(within(list).getAllByRole('option').map((o) => o.textContent)).toEqual(['monster']);
    await user.keyboard('{ArrowDown}');
    expect(box).toHaveAttribute('aria-activedescendant', within(list).getByRole('option').id);
    await user.keyboard('{Enter}');
    expect(attrsOf(e, 'Alpha').classes).toEqual(['monster']);
    expect(box).toHaveAttribute('aria-expanded', 'false');
  });

  it('refuses an invalid class: inline error, announced, nothing changed', async () => {
    const { user, editor: e } = await setup();
    caretIn(e, 'Alpha');
    const before = e.state.doc;
    const box = screen.getByRole('combobox', { name: 'Add class' });
    await user.type(box, 'block{Enter}');
    expect(e.state.doc).toBe(before);
    expect(box).toHaveAttribute('aria-invalid', 'true');
    expect(box).toHaveAccessibleDescription(/added by the editor itself/);
    expect(screen.getByTestId('inspector-announcer')).toHaveTextContent(/Classes: .*added by the editor itself/);
    expect(box).toHaveValue('block');
  });

  it('removes a class with its chip button and moves focus to the next chip', async () => {
    const { user, editor: e } = await setup();
    caretIn(e, 'Alpha');
    await user.type(screen.getByRole('combobox', { name: 'Add class' }), 'one two{Enter}');
    await user.click(screen.getByRole('button', { name: 'Remove class one' }));
    expect(attrsOf(e, 'Alpha').classes).toEqual(['two']);
    expect(screen.getByRole('button', { name: 'Remove class two' })).toHaveFocus();
    await user.click(screen.getByRole('button', { name: 'Remove class two' }));
    expect(screen.getByRole('combobox', { name: 'Add class' })).toHaveFocus();
  });

  it('style: invalid shows an error on blur and changes nothing; Ctrl+Enter applies; Escape reverts', async () => {
    const { user, editor: e } = await setup();
    caretIn(e, 'Alpha');
    const before = e.state.doc;
    const style = screen.getByRole('textbox', { name: 'Style' });
    await user.type(style, 'colr: red');
    await user.tab();
    expect(e.state.doc).toBe(before);
    expect(style).toHaveAttribute('aria-invalid', 'true');
    expect(style).toHaveAccessibleDescription(/Not valid CSS: “colr: red”/);
    await user.clear(style);
    await user.type(style, 'color: red{Control>}{Enter}{/Control}');
    expect(attrsOf(e, 'Alpha').style).toBe('color: red;');
    expect(style).toHaveValue('color: red;');
    expect(style).not.toHaveAttribute('aria-invalid');
    await user.type(style, ' margin: 0');
    await user.keyboard('{Escape}');
    expect(style).toHaveValue('color: red;');
    undo(e);
    expect(attrsOf(e, 'Alpha').style).toBeNull();
  });

  it('id: duplicates are refused; a heading id becomes custom and can go back to the generated one', async () => {
    const { user, editor: e } = await setup();
    caretIn(e, 'Alpha');
    const id = () => screen.getByRole('textbox', { name: 'Id' });
    await user.type(id(), 'the-inn{Enter}');
    expect(id()).toHaveAccessibleDescription(/already uses the id “the-inn”/);
    expect(attrsOf(e, 'Alpha').id).toBeNull();
    await user.clear(id());
    await user.type(id(), 'alpha-para{Enter}');
    expect(attrsOf(e, 'Alpha').id).toBe('alpha-para');

    caretIn(e, 'The Inn');
    expect(id()).toHaveValue('the-inn');
    await user.clear(id());
    await user.type(id(), 'welcome{Enter}');
    expect(attrsOf(e, 'The Inn')).toMatchObject({ id: 'welcome', customId: true });
    await user.click(screen.getByRole('button', { name: 'Use generated id' }));
    expect(attrsOf(e, 'The Inn')).toMatchObject({ id: 'the-inn', customId: false });
  });

  it('attributes: add, edit and remove; unsafe names refused', async () => {
    const { user, editor: e } = await setup();
    caretIn(e, 'Alpha');
    const group = screen.getByRole('group', { name: 'Attributes' });
    await user.type(within(group).getByRole('textbox', { name: 'Name' }), 'onclick');
    await user.type(within(group).getByRole('textbox', { name: 'Value' }), 'x{Enter}');
    expect(within(group).getByRole('textbox', { name: 'Name' })).toHaveAccessibleDescription(/Allowed names/);
    expect(attrsOf(e, 'Alpha').attributes).toEqual({});
    await user.clear(within(group).getByRole('textbox', { name: 'Name' }));
    await user.type(within(group).getByRole('textbox', { name: 'Name' }), 'data-mood');
    await user.click(within(group).getByRole('button', { name: 'Add attribute' }));
    expect(attrsOf(e, 'Alpha').attributes).toEqual({ 'data-mood': 'x' });
    const value = within(group).getByRole('textbox', { name: 'data-mood' });
    await user.clear(value);
    await user.type(value, 'grim{Enter}');
    expect(attrsOf(e, 'Alpha').attributes).toEqual({ 'data-mood': 'grim' });
    await user.click(within(group).getByRole('button', { name: 'Remove attribute data-mood' }));
    expect(attrsOf(e, 'Alpha').attributes).toEqual({});
  });

  it('a breadcrumb pins an ancestor until the selection leaves it', async () => {
    const { user, editor: e } = await setup();
    caretIn(e, 'Inside the note');
    await user.click(screen.getByRole('button', { name: 'Theme block.note' }));
    expect(screen.getByTestId('inspector-target')).toHaveTextContent('Theme block');
    await user.type(screen.getByRole('combobox', { name: 'Add class' }), 'frame{Enter}');
    const blockPos = posOf(e.state.doc, (n) => n.type.name === 'themeBlock');
    expect(e.state.doc.nodeAt(blockPos)!.attrs.classes).toEqual(['note', 'frame']);
    caretIn(e, 'Inside the note', 3); // still inside the theme block: stays pinned
    expect(screen.getByTestId('inspector-target')).toHaveTextContent('Theme block');
    caretIn(e, 'Alpha'); // left it
    expect(screen.getByTestId('inspector-target')).toHaveTextContent('Paragraph');
    caretIn(e, 'Inside the note');
    expect(screen.getByTestId('inspector-target')).toHaveTextContent('Paragraph');
  });

  it('inspects span marks', async () => {
    const { user, editor: e } = await setup();
    caretIn(e, 'plain spanned', 9);
    const crumbs = screen.getByRole('navigation', { name: 'Element path' });
    expect(within(crumbs).getAllByRole('button').map((b) => b.textContent)).toEqual(['Paragraph', 'Span.sc']);
    await user.type(screen.getByRole('combobox', { name: 'Add class' }), 'wide{Enter}');
    const pos = posOf(e.state.doc, byText('plain spanned')) + 1 + 9;
    expect(e.state.doc.resolve(pos).marks()[0]!.attrs.classes).toEqual(['sc', 'wide']);
    expect(screen.getByTestId('inspector-target')).toHaveTextContent('Span');
  });

  it('a selected inline node is inspected', async () => {
    const { editor: e } = await setup();
    const at = posOf(e.state.doc, byText('Alpha')) + 1;
    act(() => {
      e.chain().setTextSelection(at).insertContent({ type: 'inlineBox', attrs: { style: 'width: 10px;' } }).run();
    });
    act(() => {
      e.view.dispatch(e.state.tr.setSelection(NodeSelection.create(e.state.doc, at)));
    });
    expect(screen.getByTestId('inspector-target')).toHaveTextContent('Inline box');
    expect(screen.getByRole('textbox', { name: 'Style' })).toHaveValue('width: 10px;');
  });

  it('a draft is dropped when another element is selected, and kept while the element only moves', async () => {
    const { user, editor: e } = await setup();
    caretIn(e, 'Alpha');
    const style = screen.getByRole('textbox', { name: 'Style' });
    await user.type(style, 'color: blue');
    // Content before the element changes: same element, positions move.
    act(() => {
      e.view.dispatch(e.state.tr.insertText('!', posOf(e.state.doc, byText('The Inn')) + 1));
    });
    expect(screen.getByRole('textbox', { name: 'Style' })).toHaveValue('color: blue');
    caretIn(e, 'Continued page');
    expect(screen.getByRole('textbox', { name: 'Style' })).toHaveValue('');
  });
});

describe('Page tab', () => {
  async function openPage(value = 'Continued page') {
    const utils = await setup(utilsProps);
    caretIn(utils.editor, value);
    await utils.user.click(screen.getByRole('tab', { name: 'Page' }));
    return utils;
  }
  let utilsProps: Partial<Parameters<typeof Inspector>[0]> = {};
  beforeEach(() => {
    utilsProps = {};
  });

  it('describes the page and its section; the tab is remembered', async () => {
    await openPage();
    expect(screen.getByTestId('inspector-page-title')).toHaveTextContent('Page 2 of 3');
    expect(screen.getByTestId('inspector-page-kind')).toHaveTextContent(/pages 1–2, from page 1/);
    expect(uiStore.getState().inspectorTab).toBe('page');
  });

  it('section settings go to the section’s first page (the sync copies them), one undo step each', async () => {
    const { user, editor: e } = await openPage();
    const pages = () => e.state.doc.content.content.map((pg) => pg.attrs as PageAttrs);
    await user.selectOptions(screen.getByRole('combobox', { name: 'Columns' }), '1');
    expect(pages().map((a) => a.columns)).toEqual([1, 1, null]);
    await user.click(screen.getByRole('switch', { name: /Page numbers/ }));
    expect(pages().map((a) => a.pageNumber)).toEqual([true, true, false]);
    await user.type(screen.getByRole('textbox', { name: 'Footer' }), 'Part 1{Enter}');
    expect(pages().map((a) => a.footer)).toEqual(['Part 1', 'Part 1', null]);
    await user.type(screen.getByRole('combobox', { name: 'Add section class' }), 'wide{Enter}');
    expect(pages().map((a) => a.classes)).toEqual([['wide'], ['wide'], []]);
    undo(e);
    undo(e);
    expect(pages().map((a) => a.footer)).toEqual([null, null, null]);
    expect(pages().map((a) => a.pageNumber)).toEqual([true, true, false]);
    undo(e);
    undo(e);
    expect(pages().map((a) => a.columns)).toEqual([2, 2, null]);
    expect(screen.getByRole('combobox', { name: 'Columns' })).toHaveValue('2');
  });

  it('section style is validated', async () => {
    const { user, editor: e } = await openPage();
    const before = e.state.doc;
    const style = screen.getByRole('textbox', { name: 'Section style' });
    await user.click(style);
    await user.paste('.page { color: red }');
    await user.tab();
    expect(e.state.doc).toBe(before);
    expect(style).toHaveAccessibleDescription(/without selectors or braces/);
  });

  it('markers: one cover type, counting switches; only this page', async () => {
    const { user, editor: e } = await openPage('Second section');
    const cover = screen.getByRole('combobox', { name: 'Cover' });
    expect(cover).toHaveValue('frontCover');
    await user.selectOptions(cover, 'backCover');
    await user.click(screen.getByRole('checkbox', { name: 'Skip this page when counting' }));
    expect(e.state.doc.child(2).attrs.markers).toEqual(['backCover', 'skipCounting']);
    expect(e.state.doc.child(0).attrs.markers).toEqual([]);
    await user.selectOptions(cover, '');
    expect(e.state.doc.child(2).attrs.markers).toEqual(['skipCounting']);
    undo(e);
    expect(e.state.doc.child(2).attrs.markers).toEqual(['backCover', 'skipCounting']);
  });

  it('objects: listed, selecting one calls onSelectObject and edits its classes and style', async () => {
    const selected: PageObjectRef[] = [];
    utilsProps = { onSelectObject: (ref) => selected.push(ref) };
    const { user, editor: e } = await openPage('Alpha');
    const list = screen.getByTestId('inspector-objects');
    expect(within(list).getAllByRole('button').map((b) => b.textContent)).toEqual(['inn-sketch.png.banner', 'Art by Somebody']);
    await user.click(within(list).getByRole('button', { name: /Art by Somebody/ }));
    expect(selected).toEqual([{ pageIndex: 0, id: 'o2' }]);
    expect(within(list).getByRole('button', { name: /Art by Somebody/ })).toHaveAttribute('aria-pressed', 'true');
    await user.type(screen.getByRole('combobox', { name: 'Add object class' }), 'artist{Enter}');
    const style = screen.getByRole('textbox', { name: 'Object style' });
    await user.type(style, 'bottom: 10px{Control>}{Enter}{/Control}');
    const o2 = (e.state.doc.child(0).attrs.objects as { id: string; classes: string[]; style: string }[]).find((o) => o.id === 'o2');
    expect(o2).toMatchObject({ classes: ['artist'], style: 'bottom: 10px;' });
  });

  it('page attributes are per page', async () => {
    const { user, editor: e } = await openPage();
    const group = within(screen.getByTestId('inspector-this-page')).getByRole('group', { name: 'Attributes' });
    await user.type(within(group).getByRole('textbox', { name: 'Name' }), 'data-art');
    await user.type(within(group).getByRole('textbox', { name: 'Value' }), 'map{Enter}');
    expect(e.state.doc.child(1).attrs.attributes).toEqual({ 'data-art': 'map' });
    expect(e.state.doc.child(0).attrs.attributes).toEqual({});
  });
});

describe('read-only editor', () => {
  /** Form controls in the tab panel that can change the document (breadcrumbs and the object list only navigate). */
  const editingControls = () =>
    Array.from(screen.getByRole('tabpanel').querySelectorAll<HTMLElement>('input, textarea, select, button')).filter(
      (el) => !el.closest('nav') && !el.closest('ul'),
    );

  it('disables every field while the editor is read-only, and enables them again', async () => {
    const { user, editor: e } = await setup();
    act(() => e.setEditable(false));
    caretIn(e, 'Alpha');
    expect(editingControls().length).toBeGreaterThan(3);
    for (const control of editingControls()) expect(control, control.outerHTML.slice(0, 80)).toBeDisabled();
    const before = e.state.doc;
    await user.type(screen.getByRole('combobox', { name: 'Add class' }), 'wide{Enter}');
    expect(e.state.doc).toBe(before);

    await user.click(screen.getByRole('tab', { name: 'Page' }));
    caretIn(e, 'Alpha');
    expect(editingControls().length).toBeGreaterThan(5);
    for (const control of editingControls()) expect(control, control.outerHTML.slice(0, 80)).toBeDisabled();
    // The objects can still be looked at.
    const list = screen.getByTestId('inspector-objects');
    await user.click(within(list).getByRole('button', { name: /Art by Somebody/ }));
    expect(screen.getByRole('textbox', { name: 'Object style' })).toBeDisabled();
    expect(e.state.doc).toBe(before);

    act(() => e.setEditable(true));
    expect(screen.getByRole('combobox', { name: 'Columns' })).toBeEnabled();
    expect(screen.getByRole('textbox', { name: 'Object style' })).toBeEnabled();
  });
});
