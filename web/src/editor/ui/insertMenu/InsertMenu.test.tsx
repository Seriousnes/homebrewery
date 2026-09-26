// InsertMenu (P5.1): busy state and failures. Snippet insertion itself is covered by
// snippets/insertSnippet.test.ts and web/e2e/snippets.
import type { Editor } from '@tiptap/core';
import { AllSelection } from '@tiptap/pm/state';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ThemeSnippetGroup } from '@/editor/snippets/themeSnippets';
import { docOf, p, page } from '../../schema/testing';
import { createTestEditor } from '../toolbar/testing';
import { InsertMenu } from './InsertMenu';

let editor: Editor | undefined;
beforeAll(() => {
  // jsdom has no layout: the picker scrolls its active option into view.
  if (!('scrollIntoView' in Element.prototype)) Object.defineProperty(Element.prototype, 'scrollIntoView', { value: () => {}, configurable: true, writable: true });
});
afterEach(() => {
  editor?.destroy();
  editor = undefined;
});

const groups: ThemeSnippetGroup[] = [{ groupName: 'Page', icon: 'fas fa-file', view: 'text', snippets: [{ name: 'Skip page numbering', icon: '', gen: '{{skipCounting}}' }] }];

async function pick(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByTestId('insert-menu'));
  await user.click(await screen.findByRole('option', { name: /Skip page numbering/ }));
}

describe('InsertMenu', () => {
  it('a native snippet with everything selected (Mod-A) marks the last page, and the menu stays usable (UI-4)', async () => {
    const e = (editor = createTestEditor(docOf(page([p('One')]), page([p('Two')]))));
    e.view.dispatch(e.state.tr.setSelection(new AllSelection(e.state.doc)));
    const user = userEvent.setup();
    render(<InsertMenu editor={e} groups={groups} theme="5ePHB" />);
    await pick(user);
    await vi.waitFor(() => expect(screen.getByTestId('insert-menu-status')).toHaveTextContent('Skip page numbering applied.'));
    expect(e.state.doc.child(1).attrs.markers).toEqual(['skipCounting']);
    expect(screen.getByTestId('insert-menu')).not.toHaveAttribute('aria-busy', 'true');
  });

  it('an insertion that throws at once still ends the busy state, and the menu opens again (UI-4)', async () => {
    const e = (editor = createTestEditor(docOf(page([p('One')]))));
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
