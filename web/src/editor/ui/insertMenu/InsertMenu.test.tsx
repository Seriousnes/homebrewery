// InsertMenu (P5.1): the snippet gallery (open, preview, pick), busy state and failures. Snippet
// insertion itself is covered by snippets/insertSnippet.test.ts, previews by
// snippets/preview.test.ts, and both by web/e2e/snippets.
import type { Editor } from '@tiptap/core';
import { AllSelection } from '@tiptap/pm/state';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { emitKeymapRequest } from '@/editor/commands/keymap';
import type { ThemeSnippetGroup } from '@/editor/snippets/themeSnippets';
import { docOf, p, page } from '../../schema/testing';
import { createTestEditor } from '../toolbar/testing';
import { InsertMenu } from './InsertMenu';

let editor: Editor | undefined;
beforeAll(() => {
  // jsdom has no layout: the list scrolls its active option into view.
  if (!('scrollIntoView' in Element.prototype)) Object.defineProperty(Element.prototype, 'scrollIntoView', { value: () => {}, configurable: true, writable: true });
  // ProseMirror measures the selection of the focused editor (scrollToSelection).
  if (!('getClientRects' in Range.prototype)) {
    Object.assign(Range.prototype, { getClientRects: () => Object.assign([], { item: () => null }), getBoundingClientRect: () => new DOMRect() });
  }
});
afterEach(() => {
  editor?.destroy();
  editor = undefined;
});

const groups: ThemeSnippetGroup[] = [
  {
    groupName: 'Page',
    icon: 'fas fa-file',
    view: 'text',
    snippets: [
      { name: 'Skip page numbering', icon: '', gen: '{{skipCounting}}' },
      { name: 'Auto page numbers', icon: '', gen: '{{pageNumber,auto}}' },
    ],
  },
];

async function pick(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByTestId('insert-menu'));
  await user.click(await screen.findByRole('option', { name: /Skip page numbering/ }));
}

function mountEditor(content = docOf(page([p('One')]))): Editor {
  const element = document.createElement('div');
  document.body.append(element);
  return (editor = createTestEditor(content, { element }));
}

describe('InsertMenu', () => {
  it('opens the snippet gallery, a dialog that previews the active snippet on the current page', async () => {
    const e = mountEditor();
    const user = userEvent.setup();
    render(<InsertMenu editor={e} groups={groups} theme="5ePHB" />);
    await user.click(screen.getByTestId('insert-menu'));
    const dialog = screen.getByRole('dialog', { name: 'Insert snippet' });
    expect(screen.getByTestId('insert-menu')).toHaveAttribute('aria-expanded', 'true');
    expect(within(dialog).getByRole('combobox', { name: 'Search snippets' })).toHaveFocus();
    expect(within(dialog).getByTestId('insert-menu-dialog-preview')).toHaveAttribute('data-preview-snippet', 'Page › Skip page numbering');
    const view = await within(dialog).findByTestId('insert-menu-dialog-preview-view');
    expect(view).toHaveAccessibleName('Preview of Skip page numbering');
    const pages = view.querySelector('.hb-canvas > .pages')!;
    expect(pages.querySelector(':scope > .page > .skipCounting')).not.toBeNull();
    expect(pages.textContent).toContain('One');
    expect(pages.classList.contains('ProseMirror')).toBe(false);
    // Moving on previews the next snippet; nothing was inserted.
    await user.keyboard('{ArrowDown}');
    await vi.waitFor(() => expect(within(dialog).getByTestId('insert-menu-dialog-preview')).toHaveAttribute('data-preview-snippet', 'Page › Auto page numbers'));
    expect(await within(dialog).findByText('The current page with the change.')).toBeInTheDocument();
    expect(e.state.doc.child(0).attrs.markers).toEqual([]);
    expect(e.state.doc.child(0).attrs.pageNumber).toBe(false);
  });

  it('Insert picks the active snippet; the focus goes to the editor', async () => {
    const e = mountEditor();
    const user = userEvent.setup();
    render(<InsertMenu editor={e} groups={groups} theme="5ePHB" />);
    await user.click(screen.getByTestId('insert-menu'));
    await user.keyboard('{ArrowDown}');
    await user.click(screen.getByTestId('insert-menu-dialog-insert'));
    expect(screen.queryByRole('dialog')).toBeNull();
    await vi.waitFor(() => expect(screen.getByTestId('insert-menu-status')).toHaveTextContent('Auto page numbers applied.'));
    expect(e.state.doc.child(0).attrs.pageNumber).toBe(true);
    expect(e.view.dom).toHaveFocus();
  });

  it("opens on the editor's insertSnippet request; Escape closes it and the focus goes back", async () => {
    const e = mountEditor();
    const user = userEvent.setup();
    render(<InsertMenu editor={e} groups={groups} theme="5ePHB" />);
    e.view.focus();
    await vi.waitFor(() => expect(emitKeymapRequest(e, 'insertSnippet')).toBe(true));
    expect(await screen.findByRole('dialog', { name: 'Insert snippet' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(e.view.dom).toHaveFocus();
  });

  it('declines the insertSnippet request when the menu is disabled', () => {
    const e = mountEditor();
    render(<InsertMenu editor={e} groups={groups} theme="5ePHB" disabled />);
    expect(emitKeymapRequest(e, 'insertSnippet')).toBe(false);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('a native snippet with everything selected (Mod-A) marks the last page, and the menu stays usable (UI-4)', async () => {
    const e = mountEditor(docOf(page([p('One')]), page([p('Two')])));
    e.view.dispatch(e.state.tr.setSelection(new AllSelection(e.state.doc)));
    const user = userEvent.setup();
    render(<InsertMenu editor={e} groups={groups} theme="5ePHB" />);
    await pick(user);
    await vi.waitFor(() => expect(screen.getByTestId('insert-menu-status')).toHaveTextContent('Skip page numbering applied.'));
    expect(e.state.doc.child(1).attrs.markers).toEqual(['skipCounting']);
    expect(screen.getByTestId('insert-menu')).not.toHaveAttribute('aria-busy', 'true');
  });

  it('an insertion that throws at once still ends the busy state, and the menu opens again (UI-4)', async () => {
    const e = mountEditor();
    await new Promise((resolve) => setTimeout(resolve, 0)); // the id plugins' first pass
    // The snippet's transaction fails as it is dispatched (only that one: focus changes dispatch too).
    const dispatch = e.view.dispatch.bind(e.view);
    vi.spyOn(e.view, 'dispatch').mockImplementation((tr) => {
      if (tr.docChanged) throw new RangeError('Index 2 out of range');
      dispatch(tr);
    });
    const user = userEvent.setup();
    render(<InsertMenu editor={e} groups={groups} theme="5ePHB" />);
    await pick(user);
    await vi.waitFor(() => expect(screen.getByTestId('insert-menu-status')).toHaveTextContent('Skip page numbering could not be inserted.'));
    expect(e.state.doc.child(0).attrs.markers).toEqual([]);
    const button = screen.getByTestId('insert-menu');
    expect(button).not.toHaveAttribute('aria-busy', 'true');
    await user.click(button);
    expect(await screen.findByRole('option', { name: /Skip page numbering/ })).toBeInTheDocument();
  });
});
