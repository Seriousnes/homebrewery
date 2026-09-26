import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Toaster } from './Toaster';
import { clearToasts, dismissToast, MAX_TOASTS, toast, toastStore } from './toastStore';

afterEach(() => {
  act(() => clearToasts());
  vi.useRealTimers();
});

describe('toast store', () => {
  it('adds, replaces by id and dismisses', () => {
    const id = toast({ title: 'Saved', tone: 'success' });
    expect(toastStore.getState().toasts).toMatchObject([{ id, title: 'Saved', tone: 'success', duration: 5000, version: 1 }]);
    toast({ id, title: 'Saved again' });
    expect(toastStore.getState().toasts).toHaveLength(1);
    expect(toastStore.getState().toasts[0]).toMatchObject({ title: 'Saved again', version: 2, tone: 'info' });
    dismissToast(id);
    expect(toastStore.getState().toasts).toHaveLength(0);
  });

  it('dismissing an unknown id does not notify subscribers', () => {
    const listener = vi.fn();
    const off = toastStore.subscribe(listener);
    dismissToast('nope');
    expect(listener).not.toHaveBeenCalled();
    off();
  });

  it('defaults durations by tone and action, and caps the list', () => {
    expect(toastStore.getState().toasts).toHaveLength(0);
    toast({ title: 'e', tone: 'error' });
    toast({ title: 'a', action: { label: 'Retry', onAction: () => undefined } });
    toast({ title: 'sticky', duration: null });
    expect(toastStore.getState().toasts.map((t) => t.duration)).toEqual([8000, null, null]);
    for (let i = 0; i < MAX_TOASTS + 2; i++) toast({ title: `t${i}` });
    expect(toastStore.getState().toasts).toHaveLength(MAX_TOASTS);
    expect(toastStore.getState().toasts.at(-1)?.title).toBe(`t${MAX_TOASTS + 1}`);
  });
});

describe('Toaster', () => {
  it('announces new toasts through live regions that exist beforehand', () => {
    render(<Toaster />);
    const polite = screen.getByTestId('toast-live-polite');
    const assertive = screen.getByTestId('toast-live-assertive');
    expect(polite).toHaveAttribute('aria-live', 'polite');
    expect(assertive).toHaveAttribute('aria-live', 'assertive');
    act(() => {
      toast({ title: 'Brew saved', description: 'Version 4' });
    });
    expect(polite).toHaveTextContent('Brew saved. Version 4');
    act(() => {
      toast({ title: "Couldn't save", tone: 'error' });
    });
    expect(assertive).toHaveTextContent("Couldn't save");
    expect(screen.getByRole('region', { name: 'Notifications (F8)' })).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });

  it('runs the action and dismisses; the close button dismisses', async () => {
    const user = userEvent.setup();
    const onAction = vi.fn();
    render(<Toaster />);
    act(() => {
      toast({ title: 'Network error', tone: 'error', action: { label: 'Retry', onAction } });
      toast({ title: 'Other' });
    });
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onAction).toHaveBeenCalledOnce();
    expect(within(screen.getByRole('list')).queryByText('Network error')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Dismiss notification' }));
    expect(screen.queryByRole('region')).not.toBeInTheDocument();
  });

  it('dismisses after its duration, pausing while hovered', () => {
    vi.useFakeTimers();
    render(<Toaster />);
    act(() => {
      toast({ title: 'Quick', duration: 1000 });
    });
    const region = screen.getByRole('region');
    fireEvent.pointerEnter(region);
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(within(region).getByText('Quick')).toBeInTheDocument();
    fireEvent.pointerLeave(region);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.queryByRole('region')).not.toBeInTheDocument();
  });

  it('keeps focus in place when a focused toast closes, and timers run again afterwards', async () => {
    const user = userEvent.setup();
    render(
      <>
        <button type="button">Editor</button>
        <Toaster />
      </>,
    );
    const editor = screen.getByRole('button', { name: 'Editor' });
    act(() => {
      toast({ title: 'First', duration: 300 });
      toast({ title: 'Failed', tone: 'error', action: { label: 'Retry', onAction: () => undefined } });
    });
    editor.focus();
    await user.keyboard('{F8}');
    const region = screen.getByRole('region');
    expect(region).toHaveFocus();
    await user.tab(); // Dismiss (First)
    await user.tab(); // Retry
    expect(screen.getByRole('button', { name: 'Retry' })).toHaveFocus();
    await user.keyboard('{Enter}');
    // Another toast remains: focus goes to the list, not to <body>.
    expect(region).toHaveFocus();
    await user.tab();
    await user.keyboard('{Enter}'); // dismiss the last one
    expect(screen.queryByRole('region')).not.toBeInTheDocument();
    expect(editor).toHaveFocus();
    // The list's pause state started fresh: a new toast times out.
    act(() => {
      toast({ title: 'Later', duration: 50 });
    });
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(screen.queryByRole('region')).not.toBeInTheDocument();
  });

  it('F8 moves focus to the toasts', async () => {
    const user = userEvent.setup();
    render(<Toaster />);
    act(() => {
      toast({ title: 'Hello' });
    });
    await user.keyboard('{F8}');
    expect(screen.getByRole('region')).toHaveFocus();
  });
});
