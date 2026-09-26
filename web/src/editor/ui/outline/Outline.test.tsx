// Outline and PageNav in jsdom with a real TipTap editor (headings get their ids from the
// HeadingIds plugin) and a scripted page tracker. Scrolling in real browsers at several zooms:
// web/e2e/panels/panels.spec.ts.
import { Editor, type JSONContent } from '@tiptap/core';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildEditorExtensions } from '@/editor/editorExtensions';
import { docOf, node, p, page, text } from '@/editor/schema/testing';
import { PageNav } from '@/editor/ui/pageNav/PageNav';
import type { PageTracker, PageTrackingState } from '@/editor/ui/pageNav/pageTracker';
import { Toolbar } from '@/ui';
import { Outline } from './Outline';
import { createOutlineStore } from './useOutline';

const h = (level: number, value: string): JSONContent => node('heading', { level }, [text(value)]);

const content = docOf(
  page([h(1, 'The Inn')], { markers: ['frontCover'] }),
  page([h(1, 'Introduction'), p('Some text.'), h(2, 'Rooms'), p('More text.')]),
  page([p('Plain page.'), node('paragraph', { id: 'anchor' }, [text('Anchored')])]),
);

let editor: Editor;

beforeEach(async () => {
  const element = document.createElement('div');
  document.body.appendChild(element);
  editor = new Editor({ element, extensions: buildEditorExtensions(), content });
  // HeadingIds assigns ids in a microtask after mount.
  await act(() => Promise.resolve());
});

afterEach(() => {
  editor.destroy();
  document.body.innerHTML = '';
});

function fakeTracker(initial: Partial<PageTrackingState> = {}) {
  let state: PageTrackingState = { current: 1, total: 3, visible: [1], atStart: true, atEnd: false, ...initial };
  const listeners = new Set<() => void>();
  const tracker: PageTracker = {
    getState: () => state,
    subscribe: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    goToPage: vi.fn(() => true),
    goToNext: vi.fn(() => true),
    goToPrevious: vi.fn(() => true),
    scrollToElement: vi.fn(() => true),
    pageOf: vi.fn(() => 0),
    refresh: vi.fn(),
  };
  const set = (next: Partial<PageTrackingState>) => {
    state = { ...state, ...next };
    act(() => {
      for (const l of listeners) l();
    });
  };
  return { tracker, set };
}

describe('Outline', () => {
  it('lists pages with upstream labels and the headings of ordinary pages', () => {
    const { tracker } = fakeTracker();
    render(<Outline editor={editor} tracker={tracker} />);
    const nav = screen.getByRole('navigation', { name: 'Outline' });
    const links = within(nav).getAllByRole('link');
    expect(links.map((a) => a.textContent)).toEqual(['Page 1 - Cover: The Inn', 'Page 2', 'Introduction', 'Rooms', 'Page 3', 'Anchored']);
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['#p1', '#p2', '#introduction', '#rooms', '#p3', '#anchor']);
    expect(links[3]).toHaveAttribute('data-depth', '2');
    expect(links[5]).toHaveAttribute('data-depth', '7');
    expect(links[0]).toHaveAttribute('aria-current', 'location');
  });

  it('marks the current page from the tracker', () => {
    const { tracker, set } = fakeTracker();
    render(<Outline editor={editor} tracker={tracker} />);
    set({ current: 3 });
    expect(screen.getByRole('link', { name: 'Page 3' })).toHaveAttribute('aria-current', 'location');
    expect(screen.getByRole('link', { name: 'Page 1 - Cover: The Inn' })).not.toHaveAttribute('aria-current');
  });

  it('a page entry jumps to the page', async () => {
    const user = userEvent.setup();
    const { tracker } = fakeTracker();
    render(<Outline editor={editor} tracker={tracker} />);
    await user.click(screen.getByRole('link', { name: 'Page 3' }));
    expect(tracker.goToPage).toHaveBeenCalledWith(3);
    // Keyboard too (a link activates on Enter).
    screen.getByRole('link', { name: 'Page 2' }).focus();
    await user.keyboard('{Enter}');
    expect(tracker.goToPage).toHaveBeenLastCalledWith(2);
  });

  it('a heading entry scrolls to its element and puts the caret there, with no undo step', async () => {
    const user = userEvent.setup();
    const { tracker } = fakeTracker();
    render(<Outline editor={editor} tracker={tracker} />);
    expect(editor.can().undo()).toBe(false);
    const link = screen.getByRole('link', { name: 'Rooms' });
    await user.click(link);
    const heading = editor.view.dom.querySelector('#rooms');
    expect(heading).not.toBeNull();
    expect(tracker.scrollToElement).toHaveBeenCalledWith(heading);
    const { $from } = editor.state.selection;
    expect($from.parent.type.name).toBe('heading');
    expect($from.parent.textContent).toBe('Rooms');
    expect($from.parentOffset).toBe(0);
    expect(editor.can().undo()).toBe(false);
    // Focus stays in the outline.
    expect(link).toHaveFocus();
  });

  it('follows the document (debounced)', async () => {
    vi.useFakeTimers();
    try {
      const { tracker } = fakeTracker();
      render(<Outline editor={editor} tracker={tracker} />);
      act(() => {
        editor.commands.insertContentAt(editor.state.doc.content.size - 2, h(2, 'Late addition'));
      });
      // Heading ids arrive in an appended transaction; the outline waits for the delay.
      expect(screen.queryByRole('link', { name: 'Late addition' })).toBeNull();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(200);
      });
      expect(screen.getByRole('link', { name: 'Late addition' })).toHaveAttribute('href', '#late-addition');
    } finally {
      vi.useRealTimers();
    }
  });

  it('says so when there is no document', () => {
    render(<Outline editor={null} tracker={null} />);
    expect(screen.getByText('No pages yet.')).toBeInTheDocument();
  });
});

describe('createOutlineStore', () => {
  it('notifies when a heading changes', async () => {
    vi.useFakeTimers();
    try {
      const store = createOutlineStore(editor, 50);
      const listener = vi.fn();
      const unsubscribe = store.subscribe(listener);
      const first = store.getSnapshot();
      act(() => {
        editor.commands.insertContentAt(first[1]!.entries[0]!.pos + 2, 'x');
      });
      await vi.advanceTimersByTimeAsync(60);
      expect(listener).toHaveBeenCalledTimes(1);
      expect(store.getSnapshot()[1]!.entries[0]!.text).toBe('Ixntroduction');
      unsubscribe();
    } finally {
      vi.useRealTimers();
    }
  });

  it('moves positions of later entries when text is typed before them', async () => {
    vi.useFakeTimers();
    try {
      const store = createOutlineStore(editor, 50);
      const listener = vi.fn();
      store.subscribe(listener);
      const first = store.getSnapshot();
      const rooms = first[1]!.entries[1]!;
      const before = rooms.pos;
      act(() => {
        // Into the paragraph between the two headings.
        editor.commands.insertContentAt(before - 2, 'abc');
      });
      await vi.advanceTimersByTimeAsync(60);
      expect(listener).not.toHaveBeenCalled();
      expect(store.getSnapshot()[1]!.entries[1]!.pos).toBe(before + 3);
      expect(editor.state.doc.nodeAt(rooms.pos)?.attrs.id).toBe('rooms');
    } finally {
      vi.useRealTimers();
    }
  });
});


describe('PageNav', () => {
  it('shows the current page and the total, in a labelled group', () => {
    const { tracker } = fakeTracker({ current: 2, total: 12, atStart: false });
    render(
      <Toolbar label="Editor">
        <PageNav tracker={tracker} />
      </Toolbar>,
    );
    const group = screen.getByRole('group', { name: 'Pages' });
    const input = within(group).getByRole('textbox', { name: 'Current page' });
    expect(input).toHaveValue('2');
    expect(input).toHaveAccessibleDescription('of 12 pages');
    expect(within(group).getByTestId('page-total')).toHaveTextContent('/ 12');
  });

  it('previous and next, aria-disabled (still focusable) at the ends', async () => {
    const user = userEvent.setup();
    const { tracker, set } = fakeTracker({ current: 1, total: 3, atStart: true, atEnd: false });
    render(<PageNav tracker={tracker} />);
    const prev = screen.getByRole('button', { name: 'Previous page' });
    const next = screen.getByRole('button', { name: 'Next page' });
    expect(prev).toHaveAttribute('aria-disabled', 'true');
    await user.click(prev);
    expect(tracker.goToPrevious).not.toHaveBeenCalled();
    await user.click(next);
    expect(tracker.goToNext).toHaveBeenCalled();
    set({ current: 3, atStart: false, atEnd: true });
    expect(next).toHaveAttribute('aria-disabled', 'true');
    expect(prev).not.toHaveAttribute('aria-disabled');
    await user.click(prev);
    expect(tracker.goToPrevious).toHaveBeenCalled();
  });

  it('typing a page number and Enter jumps; Escape restores; letters are ignored', async () => {
    const user = userEvent.setup();
    const { tracker, set } = fakeTracker({ current: 1, total: 12 });
    render(<PageNav tracker={tracker} />);
    const input = screen.getByRole('textbox', { name: 'Current page' });
    await user.click(input);
    await user.keyboard('1a0{Enter}');
    expect(tracker.goToPage).toHaveBeenCalledWith(10);
    set({ current: 10 });
    expect(input).toHaveValue('10');
    await user.keyboard('7{Escape}');
    expect(input).toHaveValue('10');
    await user.keyboard('{ArrowDown}');
    expect(tracker.goToNext).toHaveBeenCalled();
    await user.keyboard('{ArrowUp}');
    expect(tracker.goToPrevious).toHaveBeenCalled();
  });

  it('commits a typed page when focus leaves, like upstream', async () => {
    const user = userEvent.setup();
    const { tracker } = fakeTracker({ current: 1, total: 12 });
    render(
      <>
        <PageNav tracker={tracker} />
        <button type="button">elsewhere</button>
      </>,
    );
    await user.click(screen.getByRole('textbox', { name: 'Current page' }));
    await user.keyboard('4');
    await user.click(screen.getByRole('button', { name: 'elsewhere' }));
    expect(tracker.goToPage).toHaveBeenCalledWith(4);
  });

  it('is empty and disabled without pages', () => {
    render(<PageNav tracker={null} />);
    expect(screen.getByRole('textbox', { name: 'Current page' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Next page' })).toHaveAttribute('aria-disabled', 'true');
  });
});
