// LayoutStatus (P4.8): the "Laying out pages…" indicator for long passes, the waiting state, and
// the layout warnings with their fixes. jsdom + line-model pagination with fake frames.
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import type { Node as PMNode } from '@tiptap/pm/model';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isPaginating } from '../../pagination';
import { mountPaginated, type MountedEditor } from '../../pagination/testEditor';
import { BLOCK, DOC, H, P, PAGE } from '../../pagination/testing';
import { offendingBlock } from '../oversize/oversize';
import { LayoutStatus } from './LayoutStatus';
import { createLayoutStatusStore } from './layoutStatusStore';

function words(tag: string, n: number): string {
  let s = '';
  for (let i = 0; s.length < n; i++) s += `${tag}${i} `;
  return s.slice(0, n);
}

let m: MountedEditor | undefined;
afterEach(() => {
  m?.destroy();
  m = undefined;
  vi.useRealTimers();
});

const tallBlock = () =>
  DOC(PAGE({ columns: 2, pid: 'aaaaaaaa' }, H(2, 'Head'), BLOCK(['monster'], ...Array.from({ length: 12 }, (_, k) => P(`row ${k}`))), P('after')));

function mount(doc: PMNode, settle = true, waiting?: () => boolean, budgetMs?: number): MountedEditor {
  m = mountPaginated(doc, { budgetMs, lines: { columns: 1, ...(waiting ? { waiting: (page) => page.index === 1 && waiting() } : {}) } });
  if (settle) m.settle();
  return m;
}

describe('layout status store', () => {
  it('is busy only after a pass has run longer than the delay, and not after it ends', () => {
    vi.useFakeTimers();
    // One step per frame (budget 0): the pass takes many frames.
    const e = mount(DOC(PAGE({ columns: 1 }, ...Array.from({ length: 30 }, (_, i) => P(words(`p${i}x`, 45))))), false, undefined, 0);
    const store = createLayoutStatusStore(e.editor, { delayMs: 100 });
    const seen: boolean[] = [];
    const unsubscribe = store.subscribe(() => seen.push(store.getSnapshot().busy));
    expect(store.getSnapshot().busy).toBe(false);
    e.frame(); // a few steps, still running
    vi.advanceTimersByTime(50);
    expect(store.getSnapshot().busy).toBe(false);
    vi.advanceTimersByTime(60);
    expect(store.getSnapshot().busy).toBe(true);
    e.settle();
    expect(store.getSnapshot().busy).toBe(false);
    // busy rose once and fell once (other notifications: the page count changing).
    expect(seen.filter((b, i) => b !== (seen[i - 1] ?? false))).toEqual([true, false]);
    // A short pass (settled before the delay) shows nothing.
    e.editor.commands.insertContentAt(3, 'x');
    e.settle();
    vi.advanceTimersByTime(200);
    expect(store.getSnapshot().busy).toBe(false);
    unsubscribe();
  });

  it('is not busy while pagination is paused for IME composition (PGR-15); busy again for a long pass after it', () => {
    vi.useFakeTimers();
    // One step per frame (budget 0), so a full repagination is a long pass.
    const e = mount(DOC(PAGE({ columns: 1, pid: 'aaaaaaaa' }, ...Array.from({ length: 20 }, (_, i) => P(words(`p${i}x`, 45))))), true, undefined, 0);
    const store = createLayoutStatusStore(e.editor, { delayMs: 400 });
    const unsubscribe = store.subscribe(() => {});
    const view = e.editor.view;
    const steps = e.st().stats.steps;
    view.dom.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    expect(view.composing).toBe(true);
    view.dispatch(view.state.tr.insertText('か', 2));
    e.frame();
    vi.advanceTimersByTime(600);
    e.frame();
    expect(isPaginating(e.editor.state)).toBe(true); // pages left to check …
    expect(e.st().stats.steps).toBe(steps); // … but nothing is laid out while composing
    expect(store.getSnapshot().busy).toBe(false);
    view.dom.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: 'か' }));
    vi.advanceTimersByTime(100);
    expect(view.composing).toBe(false);
    // A long pass (every page re-checked, one per frame): busy after the delay.
    view.dispatch(view.state.tr.setMeta('hbRepaginate', 0).setMeta('addToHistory', false));
    e.frame();
    vi.advanceTimersByTime(450);
    expect(store.getSnapshot().busy).toBe(true);
    e.settle();
    expect(store.getSnapshot().busy).toBe(false);
    unsubscribe();
  });

  it('reports waiting pages and oversized pages; the snapshot object only changes when they do', () => {
    let sized = false;
    const e = mount(DOC(PAGE({ columns: 1, pid: 'aaaaaaaa' }, ...Array.from({ length: 4 }, (_, i) => P(words(`p${i}x`, 45))))), true, () => !sized);
    const store = createLayoutStatusStore(e.editor);
    const unsubscribe = store.subscribe(() => {});
    expect(store.getSnapshot()).toMatchObject({ waiting: true, oversized: [] });
    const before = store.getSnapshot();
    e.editor.view.dispatch(e.editor.state.tr.setMeta('some', 'meta'));
    expect(store.getSnapshot()).toBe(before);
    sized = true;
    e.editor.view.dispatch(e.editor.state.tr.setMeta('hbRepaginate', 1).setMeta('addToHistory', false));
    e.settle();
    expect(store.getSnapshot().waiting).toBe(false);
    unsubscribe();
  });
});

// testing-library's *ByRole queries walk the accessibility tree of the whole editor DOM (seconds
// here): the component's own elements are found by test id and their roles checked directly.
describe('<LayoutStatus>', () => {
  it('shows the warnings and applies a fix; the warning clears when the block fits', () => {
    const e = mount(tallBlock());
    render(<LayoutStatus editor={e.editor} />);
    const button = screen.getByTestId('layout-warnings');
    expect(button).toHaveTextContent('1 layout warning');
    expect(button).toHaveAttribute('aria-haspopup', 'dialog');
    expect(screen.getByTestId('layout-status-text')).toHaveAttribute('role', 'status');
    expect(screen.getByTestId('layout-status-text')).toHaveTextContent('1 layout warning');
    fireEvent.click(button);
    const dialog = screen.getByTestId('layout-warnings-popover');
    expect(dialog).toHaveAttribute('role', 'dialog');
    expect(document.getElementById(dialog.getAttribute('aria-labelledby')!)).toHaveTextContent('Layout warnings');
    expect(button).toHaveAttribute('aria-expanded', 'true');
    expect(within(dialog).getByText(/Theme block “monster” is taller than a column/)).toBeInTheDocument();
    expect(within(dialog).getByRole('group', { name: 'Fixes for page 1' })).toBeInTheDocument();
    act(() => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Allow splitting' }));
    });
    expect(screen.queryByTestId('layout-warnings-popover')).toBeNull(); // closed after the action
    expect(String(offendingBlock(e.editor.state.doc, 0)!.node.attrs.style)).toMatch(/break-inside: auto/);
    // The line model doesn't split blocks; remove rows as a layout change that makes it fit.
    act(() => {
      const block = offendingBlock(e.editor.state.doc, 0)!;
      let end = block.pos + 1;
      for (let k = 0; k < 4; k++) end += block.node.child(k).nodeSize;
      e.editor.view.dispatch(e.editor.state.tr.delete(block.pos + 1, end));
      e.settle();
    });
    expect(screen.queryByTestId('layout-warnings')).toBeNull();
  });

  it('a click on a page\'s badge opens that page\'s warnings', () => {
    const e = mount(tallBlock());
    render(<LayoutStatus editor={e.editor} />);
    const page = e.editor.view.dom.querySelector('.page')!;
    const badge = document.createElement('span');
    badge.className = 'hb-oversized-badge';
    page.append(badge); // PageView renders it in the app
    act(() => {
      fireEvent.click(badge);
    });
    const dialog = screen.getByTestId('layout-warnings-popover');
    expect(dialog).toHaveAttribute('role', 'dialog');
    expect(document.getElementById(dialog.getAttribute('aria-labelledby')!)).toHaveTextContent('Layout warnings');
    expect(within(dialog).getAllByRole('listitem')).toHaveLength(1);
    expect(within(dialog).getByRole('button', { name: 'Make wide' })).toBeInTheDocument();
    act(() => {
      fireEvent.keyDown(dialog, { key: 'Escape' });
    });
    expect(screen.queryByTestId('layout-warnings-popover')).toBeNull();
    badge.remove();
  });

  it('renders nothing but an empty live region when all is well', () => {
    const e = mount(DOC(PAGE({ columns: 1 }, P('fine'))));
    render(<LayoutStatus editor={e.editor} />);
    expect(screen.getByTestId('layout-status-text')).toHaveTextContent('');
    expect(screen.queryByTestId('layout-warnings')).toBeNull();
  });
});
